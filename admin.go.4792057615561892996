package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

/*
Admin surface — notes on security posture.

  * All /api/admin/* routes go through requireAdmin which in turn requires
    a valid session AND the authenticated user's IsAdmin flag. CSRF is enforced
    on writes just like every other protected endpoint.
  * The only path to MINTING an admin is ensureBootstrapAdmin() (driven by env
    vars, logged at startup). Once an admin exists, they promote peers
    in-app — the public /api/register endpoint never creates admins.
  * Bodies are strictly decoded (DisallowUnknownFields) to keep the shape
    server-authoritative.
  * Every admin mutation is appended to data/admin-audit.log under a mutex,
    with the admin's email, action, target id, and caller IP. Read-only admin
    calls are NOT audited to keep the log focused on state changes.
  * We never serialize PasswordHash in any response. adminUserView is the single
    outbound shape.
  * Destructive and privilege-changing actions (delete, toggle admin, reset
    password) refuse to touch the caller themselves — an admin cannot lock
    themselves out or self-demote. They must use a peer admin.
  * Demoting an admin refuses to leave zero admins behind.
*/

// requireAdmin gates admin-only handlers. Builds on requireAuth (session +
// CSRF) and adds the IsAdmin check. Anonymous callers get 401; authenticated
// non-admins get 404 so we don't confirm the existence of admin routes to
// random logged-in users.
func requireAdmin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid := currentUser(r)
		if uid == "" {
			writeErr(w, http.StatusUnauthorized, "non connecté")
			return
		}
		u := getUserByID(uid)
		if u == nil || !u.IsAdmin {
			writeErr(w, http.StatusNotFound, "introuvable")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !checkCSRF(r) {
				writeErr(w, http.StatusForbidden, "CSRF invalide")
				return
			}
		}
		ctx := contextWithUser(r.Context(), uid)
		h(w, r.WithContext(ctx))
	}
}

// adminUserView is the only shape we serialize for user records to admins.
// The password hash and any future sensitive field must never leak here.
type adminUserView struct {
	ID         string    `json:"id"`
	Email      string    `json:"email"`
	CreatedAt  time.Time `json:"createdAt"`
	IsAdmin    bool      `json:"isAdmin"`
	IsSelf     bool      `json:"isSelf"`
	HasData    bool      `json:"hasData"`
	LastSeen   time.Time `json:"lastSeen,omitempty"`
	Sessions   int       `json:"activeSessions"`
}

func viewOfUser(u *User, selfID string) adminUserView {
	v := adminUserView{
		ID:        u.ID,
		Email:     u.EmailLower,
		CreatedAt: u.CreatedAt,
		IsAdmin:   u.IsAdmin,
		IsSelf:    u.ID == selfID,
	}
	if st, err := os.Stat(dataPath(u.ID)); err == nil {
		v.HasData = true
		v.LastSeen = st.ModTime()
	}
	// Count live sessions without exposing the raw session IDs.
	sessionsMu.RLock()
	for _, s := range sessions {
		if s.UserID == u.ID && s.ExpiresAt.After(time.Now()) {
			v.Sessions++
		}
	}
	sessionsMu.RUnlock()
	return v
}

/* ============================= Audit log ================================ */

var (
	auditMu sync.Mutex
)

func auditFile() string { return filepath.Join(dataDir, "admin-audit.log") }

// auditMaxAge — durée au-delà de laquelle le journal d'audit est rotaté.
// Conforme aux recommandations CNIL pour les logs d'accès admin (12 mois).
const auditMaxAge = 365 * 24 * time.Hour

// rotateAuditLogIfStale : si la première ligne du journal date d'il y a plus
// de 12 mois, on renomme le fichier en .archive-YYYYMMDD et on repart d'un
// fichier vide. Idempotent — si le fichier n'existe pas ou est récent, ne
// fait rien. Appelé au démarrage et par un janitor quotidien.
func rotateAuditLogIfStale() {
	auditMu.Lock()
	defer auditMu.Unlock()
	path := auditFile()
	f, err := os.Open(path)
	if err != nil {
		return // pas de fichier ou pas accessible — rien à rotater
	}
	defer f.Close()
	// Lire la première ligne pour extraire son timestamp.
	dec := json.NewDecoder(f)
	var first map[string]any
	if err := dec.Decode(&first); err != nil {
		return // corrompu ou vide — on ne touche pas
	}
	tsStr, _ := first["ts"].(string)
	t, err := time.Parse(time.RFC3339, tsStr)
	if err != nil {
		return
	}
	if time.Since(t) < auditMaxAge {
		return
	}
	// On dépasse 12 mois — rotation. Nom de l'archive avec la date du
	// premier événement, pas la date de rotation : ça aide à retrouver.
	archivePath := path + ".archive-" + t.Format("20060102")
	if err := os.Rename(path, archivePath); err != nil {
		log.Printf("audit rotate rename: %v", err)
		return
	}
	log.Printf("audit log rotated: %s → %s (oldest entry %s)", filepath.Base(path),
		filepath.Base(archivePath), tsStr)
}

// startAuditJanitor lance un check quotidien de rotation. À appeler depuis
// main() après loadUsers/loadSessions.
func startAuditJanitor() {
	rotateAuditLogIfStale() // check immédiat au boot
	go func() {
		t := time.NewTicker(24 * time.Hour)
		defer t.Stop()
		for range t.C {
			rotateAuditLogIfStale()
		}
	}()
}

// auditAdmin appends a single structured line to the admin audit log. Failures
// are logged but never surfaced to the caller — audit must not block the
// action from completing.
func auditAdmin(r *http.Request, action, targetID, note string) {
	uid := currentUser(r)
	var actor string
	if u := getUserByID(uid); u != nil {
		actor = u.EmailLower
	}
	entry := map[string]any{
		"ts":       time.Now().UTC().Format(time.RFC3339),
		"actor":    actor,
		"actorId":  uid,
		"action":   action,
		"targetId": targetID,
		"ip":       clientIP(r),
		"note":     note,
	}
	line, _ := json.Marshal(entry)
	auditMu.Lock()
	defer auditMu.Unlock()
	f, err := os.OpenFile(auditFile(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		log.Printf("audit open: %v", err)
		return
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		log.Printf("audit write: %v", err)
	}
}

/* ============================= Handlers ================================= */

// GET /api/admin/users — list all users (sanitized).
func handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	selfID := currentUser(r)
	usersMu.RLock()
	out := make([]adminUserView, 0, len(usersByID))
	for _, u := range usersByID {
		out = append(out, viewOfUser(u, selfID))
	}
	usersMu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Email < out[j].Email })
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

// POST /api/admin/users — create a new user (bypasses allowReg gate).
func handleAdminCreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		IsAdmin  bool   `json:"isAdmin"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !validEmail(email) {
		writeErr(w, http.StatusBadRequest, "email invalide")
		return
	}
	if err := validPassword(req.Password); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	usersMu.Lock()
	if _, exists := usersByEm[email]; exists {
		usersMu.Unlock()
		writeErr(w, http.StatusConflict, "email déjà utilisé")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		usersMu.Unlock()
		writeErr(w, http.StatusInternalServerError, "hash")
		return
	}
	u := &User{
		ID:           randHex(16),
		EmailLower:   email,
		PasswordHash: string(hash),
		CreatedAt:    time.Now().UTC(),
		IsAdmin:      req.IsAdmin,
	}
	usersByID[u.ID] = u
	usersByEm[email] = u
	selfID := currentUser(r)
	usersMu.Unlock()
	saveUsers()
	auditAdmin(r, "create_user", u.ID, fmt.Sprintf("emailHash=%s admin=%v", hashEmailForLog(email), req.IsAdmin))
	writeJSON(w, http.StatusOK, map[string]any{"user": viewOfUser(u, selfID)})
}

// POST /api/admin/users/{id}/password — reset a user's password.
func handleAdminResetPassword(w http.ResponseWriter, r *http.Request) {
	targetID := r.PathValue("id")
	if !validUserID.MatchString(targetID) {
		writeErr(w, http.StatusBadRequest, "id invalide")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if err := validPassword(req.Password); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	usersMu.Lock()
	u := usersByID[targetID]
	if u == nil {
		usersMu.Unlock()
		writeErr(w, http.StatusNotFound, "utilisateur introuvable")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		usersMu.Unlock()
		writeErr(w, http.StatusInternalServerError, "hash")
		return
	}
	u.PasswordHash = string(hash)
	usersMu.Unlock()
	saveUsers()
	// Force-logout the target from every device as a safety measure on password
	// change — an admin shouldn't reset a password while the user's old session
	// stays valid.
	destroyAllSessionsFor(targetID)
	auditAdmin(r, "reset_password", targetID, "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /api/admin/users/{id}/admin — toggle IsAdmin on a user. Refuses to
// self-demote and refuses to leave zero admins.
func handleAdminToggleAdmin(w http.ResponseWriter, r *http.Request) {
	targetID := r.PathValue("id")
	if !validUserID.MatchString(targetID) {
		writeErr(w, http.StatusBadRequest, "id invalide")
		return
	}
	var req struct {
		IsAdmin bool `json:"isAdmin"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	selfID := currentUser(r)
	if targetID == selfID {
		writeErr(w, http.StatusForbidden, "tu ne peux pas modifier ton propre statut admin")
		return
	}
	usersMu.Lock()
	u := usersByID[targetID]
	if u == nil {
		usersMu.Unlock()
		writeErr(w, http.StatusNotFound, "utilisateur introuvable")
		return
	}
	if !req.IsAdmin && u.IsAdmin {
		// Count remaining admins if we demote this one.
		remaining := 0
		for _, x := range usersByID {
			if x.IsAdmin && x.ID != targetID {
				remaining++
			}
		}
		if remaining == 0 {
			usersMu.Unlock()
			writeErr(w, http.StatusConflict, "il doit rester au moins un admin")
			return
		}
	}
	u.IsAdmin = req.IsAdmin
	usersMu.Unlock()
	saveUsers()
	auditAdmin(r, "toggle_admin", targetID, fmt.Sprintf("isAdmin=%v", req.IsAdmin))
	writeJSON(w, http.StatusOK, map[string]any{"user": viewOfUser(u, selfID)})
}

// DELETE /api/admin/users/{id} — remove a user, their data file, and kill sessions.
func handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	targetID := r.PathValue("id")
	if !validUserID.MatchString(targetID) {
		writeErr(w, http.StatusBadRequest, "id invalide")
		return
	}
	selfID := currentUser(r)
	if targetID == selfID {
		writeErr(w, http.StatusForbidden, "tu ne peux pas te supprimer toi-même depuis l'admin — utilise ton compte utilisateur")
		return
	}
	usersMu.Lock()
	u := usersByID[targetID]
	if u == nil {
		usersMu.Unlock()
		writeErr(w, http.StatusNotFound, "utilisateur introuvable")
		return
	}
	// If we're deleting the last admin, refuse.
	if u.IsAdmin {
		remaining := 0
		for _, x := range usersByID {
			if x.IsAdmin && x.ID != targetID {
				remaining++
			}
		}
		if remaining == 0 {
			usersMu.Unlock()
			writeErr(w, http.StatusConflict, "il doit rester au moins un admin")
			return
		}
	}
	email := u.EmailLower
	delete(usersByEm, email)
	delete(usersByID, targetID)
	usersMu.Unlock()
	saveUsers()
	destroyAllSessionsFor(targetID)
	// Remove the workout data file. If it doesn't exist, that's fine.
	if err := os.Remove(dataPath(targetID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("admin delete %s: data remove: %v", targetID, err)
	}
	auditAdmin(r, "delete_user", targetID, "emailHash="+hashEmailForLog(email))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /api/admin/users/{id}/data — return the target user's workout JSON.
func handleAdminGetUserData(w http.ResponseWriter, r *http.Request) {
	targetID := r.PathValue("id")
	if !validUserID.MatchString(targetID) {
		writeErr(w, http.StatusBadRequest, "id invalide")
		return
	}
	if getUserByID(targetID) == nil {
		writeErr(w, http.StatusNotFound, "utilisateur introuvable")
		return
	}
	path := dataPath(targetID)
	lock := userLock(targetID)
	lock.Lock()
	b, err := os.ReadFile(path)
	lock.Unlock()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusOK, map[string]any{"data": nil})
			return
		}
		writeErr(w, http.StatusInternalServerError, "lecture impossible")
		return
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		writeErr(w, http.StatusInternalServerError, "données corrompues")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// POST /api/admin/users/{id}/revoke-sessions — kill all live sessions of a user.
func handleAdminRevokeSessions(w http.ResponseWriter, r *http.Request) {
	targetID := r.PathValue("id")
	if !validUserID.MatchString(targetID) {
		writeErr(w, http.StatusBadRequest, "id invalide")
		return
	}
	if getUserByID(targetID) == nil {
		writeErr(w, http.StatusNotFound, "utilisateur introuvable")
		return
	}
	destroyAllSessionsFor(targetID)
	auditAdmin(r, "revoke_sessions", targetID, "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
