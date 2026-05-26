package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Session is a server-side session record. The cookie value is an opaque,
// unguessable 256-bit hex token that maps to one of these records.
type Session struct {
	UserID    string    `json:"userId"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

var (
	sessions   = map[string]Session{}
	sessionsMu sync.RWMutex

	sessionTTL          = 30 * 24 * time.Hour
	// Audit M-03 : sur HTTPS, on émet __Host-coach_sid / __Host-coach_csrf
	// (prefixe qui force Secure + Path=/ + pas de Domain → durcissement
	// supplémentaire contre l'injection de cookie depuis un sous-domaine).
	// Sur HTTP (dev local), on garde les noms sans prefix car __Host- exige Secure.
	// La lecture supporte les deux noms (rétro-compat lors du switch HTTP↔HTTPS).
	sessionCookieName       = "coach_sid"
	sessionCookieNameSecure = "__Host-coach_sid"
	csrfCookieName          = "coach_csrf"
	csrfCookieNameSecure    = "__Host-coach_csrf"
	csrfHeaderName          = "X-CSRF-Token"
)

// pickCookieName retourne le nom de cookie à utiliser selon le contexte HTTPS.
// Sur HTTPS, on préfère __Host- (sécurité renforcée). Sur HTTP, on garde le
// nom legacy car __Host- exige Secure (incompatible).
func pickCookieName(r *http.Request, secureName, legacyName string) string {
	if isHTTPS(r) {
		return secureName
	}
	return legacyName
}

type ctxKey int

const userCtxKey ctxKey = 1

func sessionsFile() string { return filepath.Join(dataDir, "sessions.json") }

func loadSessions() {
	b, err := os.ReadFile(sessionsFile())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("sessions read: %v", err)
		}
		return
	}
	_ = json.Unmarshal(b, &sessions)
	// Purge any that expired while we were down.
	now := time.Now()
	for k, s := range sessions {
		if s.ExpiresAt.Before(now) {
			delete(sessions, k)
		}
	}
	log.Printf("loaded %d sessions", len(sessions))
}

func saveSessions() {
	sessionsMu.RLock()
	cp := make(map[string]Session, len(sessions))
	for k, v := range sessions {
		cp[k] = v
	}
	sessionsMu.RUnlock()
	if err := writeJSONAtomic(sessionsFile(), cp, 0o600); err != nil {
		log.Printf("sessions save: %v", err)
	}
}

// sessionJanitor periodically prunes expired sessions from memory and disk.
func sessionJanitor() {
	t := time.NewTicker(1 * time.Hour)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		sessionsMu.Lock()
		for k, s := range sessions {
			if s.ExpiresAt.Before(now) {
				delete(sessions, k)
			}
		}
		sessionsMu.Unlock()
		saveSessions()
	}
}

func createSession(userID string) string {
	id := randHex(32) // 256 bits
	sessionsMu.Lock()
	sessions[id] = Session{
		UserID:    userID,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(sessionTTL),
	}
	sessionsMu.Unlock()
	go saveSessions()
	return id
}

func destroySession(id string) {
	sessionsMu.Lock()
	delete(sessions, id)
	sessionsMu.Unlock()
	go saveSessions()
}

func destroyAllSessionsFor(userID string) {
	sessionsMu.Lock()
	for k, s := range sessions {
		if s.UserID == userID {
			delete(sessions, k)
		}
	}
	sessionsMu.Unlock()
	go saveSessions()
}

func sessionID(r *http.Request) string {
	// Audit M-03 : lit les deux noms pour tolérer le switch HTTP↔HTTPS
	// (cookie sans prefix posé en HTTP, puis migration vers HTTPS).
	if c, err := r.Cookie(sessionCookieNameSecure); err == nil && c.Value != "" {
		return c.Value
	}
	if c, err := r.Cookie(sessionCookieName); err == nil && c.Value != "" {
		return c.Value
	}
	return ""
}

// currentUser resolves the request to a user id, or "" if anonymous.
// Consults context cache first (populated by requireAuth) to avoid re-looking up.
//
// Audit L-01 : sliding TTL — quand une session est utilisée et qu'il reste
// moins de la moitié du TTL avant expiration, on prolonge. Cap : on ne va
// jamais au-delà de sessionTTL après le dernier accès (pas d'accumulation
// infinie). Sans sliding, un user actif tous les jours verrait sa session
// expirer pile à 30j sans warning ; avec sliding, l'inactivité prolongée
// expire correctement mais l'usage régulier prolonge l'authentification.
func currentUser(r *http.Request) string {
	if v, ok := r.Context().Value(userCtxKey).(string); ok && v != "" {
		return v
	}
	sid := sessionID(r)
	if sid == "" {
		return ""
	}
	sessionsMu.RLock()
	s, ok := sessions[sid]
	sessionsMu.RUnlock()
	if !ok {
		return ""
	}
	now := time.Now()
	if s.ExpiresAt.Before(now) {
		destroySession(sid)
		return ""
	}
	// Sliding : si on est dans la seconde moitié de la fenêtre, prolonger.
	// Pas de write disque ici (saveSessions est async dans le janitor) pour
	// ne pas alourdir chaque requête authentifiée.
	half := sessionTTL / 2
	if now.Sub(s.CreatedAt) > half {
		sessionsMu.Lock()
		if s2, ok := sessions[sid]; ok {
			s2.ExpiresAt = now.Add(sessionTTL)
			sessions[sid] = s2
		}
		sessionsMu.Unlock()
	}
	return s.UserID
}

func contextWithUser(ctx context.Context, uid string) context.Context {
	return context.WithValue(ctx, userCtxKey, uid)
}

// isHTTPS returns true when the request is TLS or came through a trusted proxy
// that terminated TLS. We gate Secure cookies on this.
func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if trustProxy && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		return true
	}
	return false
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, sid string) {
	name := pickCookieName(r, sessionCookieNameSecure, sessionCookieName)
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    sid,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode, // primary CSRF defense
		Secure:   isHTTPS(r),
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	// On efface les DEUX variantes pour que le passage HTTPS↔HTTP nettoie tout.
	for _, n := range []string{sessionCookieName, sessionCookieNameSecure} {
		http.SetCookie(w, &http.Cookie{
			Name: n, Value: "", Path: "/", HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
			// __Host- exige Secure même pour clear ; pour le nom legacy on suit isHTTPS.
			Secure: n == sessionCookieNameSecure || isHTTPS(r),
			MaxAge: -1,
		})
	}
}

// clearCSRFCookie wipes the CSRF double-submit cookie. Called on logout so a
// stale token can't linger in the browser after the session is gone.
func clearCSRFCookie(w http.ResponseWriter, r *http.Request) {
	for _, n := range []string{csrfCookieName, csrfCookieNameSecure} {
		http.SetCookie(w, &http.Cookie{
			Name: n, Value: "", Path: "/", HttpOnly: false,
			SameSite: http.SameSiteStrictMode,
			Secure:   n == csrfCookieNameSecure || isHTTPS(r),
			MaxAge:   -1,
		})
	}
}

// setCSRFCookie issues a non-HttpOnly cookie holding a random token. The
// frontend reads it and echoes it in the X-CSRF-Token header on state-changing
// requests (double-submit pattern). Combined with SameSite=Strict on the
// session cookie, this gives two independent CSRF defenses.
func setCSRFCookie(w http.ResponseWriter, r *http.Request) {
	name := pickCookieName(r, csrfCookieNameSecure, csrfCookieName)
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    randHex(24),
		Path:     "/",
		HttpOnly: false,
		SameSite: http.SameSiteStrictMode,
		Secure:   isHTTPS(r),
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

func handleCSRF(w http.ResponseWriter, r *http.Request) {
	// Safe (GET) endpoint — issues/refreshes the CSRF token. Called on page
	// boot and after login. The token is useful only when paired with the
	// session cookie (double-submit), so handing one out to anonymous callers
	// is harmless; we still gate noise with the global rate limiter.
	w.Header().Set("Cache-Control", "no-store")
	setCSRFCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func checkCSRF(r *http.Request) bool {
	// Lit les deux noms (Audit M-03 : tolère HTTP↔HTTPS).
	var cookieVal string
	if c, err := r.Cookie(csrfCookieNameSecure); err == nil && c.Value != "" {
		cookieVal = c.Value
	} else if c, err := r.Cookie(csrfCookieName); err == nil && c.Value != "" {
		cookieVal = c.Value
	}
	if cookieVal == "" {
		return false
	}
	h := r.Header.Get(csrfHeaderName)
	if h == "" {
		return false
	}
	// Constant-time compare to avoid timing leaks.
	return subtle.ConstantTimeCompare([]byte(cookieVal), []byte(h)) == 1
}
