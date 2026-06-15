package main

import (
	"context"
	"crypto/subtle"
	"log"
	"net/http"
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
	// LastExtendedAt horodate la dernière prolongation sliding — throttle
	// pour ne pas prendre le write lock à chaque requête authentifiée une
	// fois passée la mi-vie de la session (voir currentUser).
	LastExtendedAt time.Time `json:"lastExtendedAt,omitempty"`
}

/* =============================================================
 * Audit modularité (action 7) — SessionStore.
 *
 * Première brique du passage « globals + mutex » → « stores encapsulés ».
 * Le map de sessions et son mutex ne sont plus des variables de package
 * éparpillées : tout accès passe par les méthodes du store, qui portent
 * chacune leur invariant (expiry, sliding TTL, comptage). Les fonctions
 * historiques (createSession, destroySession, currentUser…) deviennent des
 * wrappers fins — AUCUN call site extérieur n'a changé.
 *
 * Recette à répliquer pour users (UserStore) puis rate-limit : mêmes
 * méthodes, mêmes wrappers, tests parallélisables à la clé.
 * ============================================================= */

// SessionStore encapsule le map sid → Session et son verrou.
type SessionStore struct {
	mu sync.RWMutex
	m  map[string]Session
}

var sessionStore = &SessionStore{m: map[string]Session{}}

// Reset vide le store — usage tests uniquement.
func (st *SessionStore) Reset() {
	st.mu.Lock()
	st.m = map[string]Session{}
	st.mu.Unlock()
}

// Seed remplace le contenu du store — usage tests uniquement.
func (st *SessionStore) Seed(m map[string]Session) {
	st.mu.Lock()
	st.m = m
	st.mu.Unlock()
}

// Get renvoie la session et un booléen d'existence.
func (st *SessionStore) Get(sid string) (Session, bool) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	s, ok := st.m[sid]
	return s, ok
}

// Snapshot copie le map pour une sérialisation hors verrou.
func (st *SessionStore) Snapshot() map[string]Session {
	st.mu.RLock()
	defer st.mu.RUnlock()
	cp := make(map[string]Session, len(st.m))
	for k, v := range st.m {
		cp[k] = v
	}
	return cp
}

// Create mint une session de TTL standard et renvoie le sid opaque.
func (st *SessionStore) Create(userID string) string {
	id := randHex(32) // 256 bits
	st.mu.Lock()
	st.m[id] = Session{
		UserID:    userID,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(sessionTTL),
	}
	st.mu.Unlock()
	return id
}

// Destroy supprime une session (no-op si absente).
func (st *SessionStore) Destroy(id string) {
	st.mu.Lock()
	delete(st.m, id)
	st.mu.Unlock()
}

// DestroyAllFor supprime toutes les sessions d'un utilisateur.
func (st *SessionStore) DestroyAllFor(userID string) {
	st.mu.Lock()
	for k, s := range st.m {
		if s.UserID == userID {
			delete(st.m, k)
		}
	}
	st.mu.Unlock()
}

// PurgeExpired supprime les sessions expirées, renvoie le nombre purgé.
func (st *SessionStore) PurgeExpired() int {
	now := time.Now()
	n := 0
	st.mu.Lock()
	for k, s := range st.m {
		if s.ExpiresAt.Before(now) {
			delete(st.m, k)
			n++
		}
	}
	st.mu.Unlock()
	return n
}

// CountActiveFor compte les sessions non expirées d'un utilisateur
// (vue admin) sans exposer les sids.
func (st *SessionStore) CountActiveFor(userID string) int {
	now := time.Now()
	n := 0
	st.mu.RLock()
	for _, s := range st.m {
		if s.UserID == userID && s.ExpiresAt.After(now) {
			n++
		}
	}
	st.mu.RUnlock()
	return n
}

// Resolve résout un sid vers un userID. Applique l'expiry (purge à l'accès)
// et le sliding TTL throttlé (au plus une prolongation/heure, cf. Audit L-01).
// Renvoie "" pour une session inconnue ou expirée.
func (st *SessionStore) Resolve(sid string) string {
	st.mu.RLock()
	s, ok := st.m[sid]
	st.mu.RUnlock()
	if !ok {
		return ""
	}
	now := time.Now()
	if s.ExpiresAt.Before(now) {
		st.Destroy(sid)
		markSessionsDirty()
		return ""
	}
	half := sessionTTL / 2
	if now.Sub(s.CreatedAt) > half && now.Sub(s.LastExtendedAt) > time.Hour {
		st.mu.Lock()
		if s2, ok := st.m[sid]; ok {
			s2.ExpiresAt = now.Add(sessionTTL)
			s2.LastExtendedAt = now
			st.m[sid] = s2
		}
		st.mu.Unlock()
		markSessionsDirty()
	}
	return s.UserID
}

var (
	sessionTTL = 30 * 24 * time.Hour
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
	loaded, err := dbLoadSessions()
	if err != nil {
		log.Printf("sessions load (sql): %v", err)
		return
	}
	// Purge any that expired while we were down.
	now := time.Now()
	for k, s := range loaded {
		if s.ExpiresAt.Before(now) {
			delete(loaded, k)
		}
	}
	sessionStore.Seed(loaded)
	log.Printf("loaded %d sessions", len(loaded))
}

func saveSessions() {
	if err := dbSaveAllSessions(sessionStore.Snapshot()); err != nil {
		log.Printf("sessions save (sql): %v", err)
	}
}

// sessionJanitor periodically prunes expired sessions from memory and disk.
func sessionJanitor() {
	t := time.NewTicker(1 * time.Hour)
	defer t.Stop()
	for range t.C {
		sessionStore.PurgeExpired()
		saveSessions()
	}
}

/* Wrappers historiques — l'API des call sites est inchangée. Audit
 * modularité (action 1) : les `go saveSessions()` fire-and-forget sont
 * remplacés par markSessionsDirty() — même garantie de durabilité
 * (asynchrone dans les deux cas) mais les écritures rapprochées sont
 * coalescées par le flusher de store.go au lieu de réécrire le fichier
 * une fois par mutation. */

func createSession(userID string) string {
	id := sessionStore.Create(userID)
	markSessionsDirty()
	return id
}

func destroySession(id string) {
	sessionStore.Destroy(id)
	markSessionsDirty()
}

func destroyAllSessionsFor(userID string) {
	sessionStore.DestroyAllFor(userID)
	markSessionsDirty()
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
	// Toute la logique (expiry, sliding TTL throttlé) vit dans le store.
	return sessionStore.Resolve(sid)
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
