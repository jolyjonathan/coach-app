package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/crypto/bcrypt"
)

// User is persisted in data/users.json. We never store the raw password; only a bcrypt hash.
type User struct {
	ID           string    `json:"id"`
	EmailLower   string    `json:"emailLower"`
	PasswordHash string    `json:"passwordHash"`
	CreatedAt    time.Time `json:"createdAt"`
	IsAdmin      bool      `json:"isAdmin,omitempty"`
	// TOTPSecret is empty when 2FA is disabled. When set, login must include a
	// valid 6-digit code from an Authenticator app (Google/Authy/etc.).
	//
	// Audit H-03 : chiffré at-rest via encryptToken/decryptToken (AES-256-GCM
	// avec COACH_TOKEN_KEY). Le fichier stocké contient `ENC:v1:...` ; les
	// anciens enregistrements en cleartext base32 sont migrés au load via
	// reencryptTotpSecret (idempotent). Les helpers getUserTotpSecret /
	// setUserTotpSecret encapsulent le chiffrement — TOUJOURS passer par eux,
	// jamais lire/écrire u.TOTPSecret directement après l'introduction de
	// cette enveloppe (sinon bug de migration partielle).
	TOTPSecret string `json:"totpSecret,omitempty"`

	// HealthConsent records the user's explicit consent to process health data
	// (Article 9 GDPR). Nil = not yet consented; the SPA gates the onboarding
	// form on this flag and the server refuses to write profile/history without
	// it. We store the policy version so a future material change to the
	// privacy policy can re-prompt.
	HealthConsent *Consent `json:"healthConsent,omitempty"`

	// AlgoOptOut is the user's exercise of the Article 22 right to object to
	// automated decisions. When true the client hides generated adjustments
	// (deload, swap, modulation) and the server tags the export so it's
	// auditable. The data is still computed for display continuity but never
	// surfaced as a recommendation.
	AlgoOptOut bool `json:"algoOptOut,omitempty"`

	// PhysioTokens stores personal access tokens (PAT) for connected
	// wearable APIs (Oura, Polar, Fitbit, etc.). Same protection level
	// as PasswordHash : file mode 0o600, dir 0o700. Never serialized
	// outbound — handlers strip this field from any user view.
	// Encryption-at-rest with a server-derived key is a follow-up if we
	// ship multi-tenant.
	PhysioTokens map[string]string `json:"physioTokens,omitempty"`

	// PhysioWebhookSecret is a per-user secret that authenticates incoming
	// webhook calls (push from Apple Health Auto Export, Tasker, custom
	// scripts). Generated lazily on first use. Long-form (32 hex chars).
	// Rotation is supported via DELETE /api/physio/integrations/webhook.
	PhysioWebhookSecret string `json:"physioWebhookSecret,omitempty"`

	// PhysioLastSync tracks last successful sync per integration. Surfaced
	// to the client so the UI can show "synced X min ago".
	PhysioLastSync map[string]time.Time `json:"physioLastSync,omitempty"`
}

// Consent is a dated record of explicit consent to a specific policy version.
// Versioned so a future material update to the privacy policy can invalidate
// stale consents and re-prompt.
type Consent struct {
	ConsentedAt time.Time `json:"consentedAt"`
	Version     string    `json:"version"`
}

// CurrentPrivacyVersion is bumped whenever the privacy policy changes
// substantively (purpose, retention, recipient, basis). Stored in each
// User.HealthConsent so we can detect stale consents and re-prompt.
const CurrentPrivacyVersion = "1.0"

var (
	usersByID = map[string]*User{}
	usersByEm = map[string]*User{}
	usersMu   sync.RWMutex

	// dummyHash is compared against when a user doesn't exist, to keep the
	// login response time ~constant and avoid leaking whether an email exists.
	// Generated once at startup.
	dummyHash []byte
)

func usersFile() string { return filepath.Join(dataDir, "users.json") }

func loadUsers() {
	// Seed dummy hash for timing-safe "unknown user" path.
	h, err := bcrypt.GenerateFromPassword([]byte(randHex(16)), 12)
	if err != nil {
		log.Fatalf("bcrypt dummy: %v", err)
	}
	dummyHash = h

	b, err := os.ReadFile(usersFile())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("users read: %v", err)
		}
		return
	}
	var list []*User
	if err := json.Unmarshal(b, &list); err != nil {
		log.Fatalf("users parse: %v", err)
	}
	migratedTok := 0
	migratedTotp := 0
	for _, u := range list {
		usersByID[u.ID] = u
		usersByEm[u.EmailLower] = u
		// Migration : tokens cleartext (legacy) → chiffrés AES-GCM.
		// Si la clé COACH_TOKEN_KEY n'est pas dispo, le re-encrypt
		// loggue un warning et garde cleartext (mode dégradé).
		if reencryptUserTokens(u) {
			migratedTok++
		}
		// Audit H-03 : migration TOTPSecret cleartext base32 → chiffré.
		if reencryptTotpSecret(u) {
			migratedTotp++
		}
	}
	if migratedTok > 0 || migratedTotp > 0 {
		go saveUsers() // flush sans bloquer le boot
		log.Printf("loaded %d users (migrated %d cleartext API tokens, %d cleartext TOTP secrets)",
			len(list), migratedTok, migratedTotp)
	} else {
		log.Printf("loaded %d users", len(list))
	}
}

func saveUsers() {
	usersMu.RLock()
	list := make([]*User, 0, len(usersByID))
	for _, u := range usersByID {
		list = append(list, u)
	}
	usersMu.RUnlock()
	if err := writeJSONAtomic(usersFile(), list, 0o600); err != nil {
		log.Printf("users save: %v", err)
	}
}

func validEmail(s string) bool {
	if len(s) == 0 || len(s) > 256 {
		return false
	}
	_, err := mail.ParseAddress(s)
	return err == nil
}

// validPassword: minimum 10 chars, must mix letters and non-letters, reject a
// handful of obvious patterns. Length beats complexity, but we want *some* resistance.
func validPassword(s string) error {
	if len(s) < 10 {
		return errors.New("mot de passe trop court (min 10 caractères)")
	}
	if len(s) > 128 {
		return errors.New("mot de passe trop long (max 128)")
	}
	var hasLetter, hasOther bool
	for _, r := range s {
		if unicode.IsLetter(r) {
			hasLetter = true
		} else {
			hasOther = true
		}
	}
	if !hasLetter || !hasOther {
		return errors.New("mélange lettres + chiffres/symboles requis")
	}
	lower := strings.ToLower(s)
	bad := []string{"password", "motdepasse", "123456789", "qwertyuiop", "azertyuiop", "iloveyou"}
	for _, b := range bad {
		if strings.Contains(lower, b) {
			return errors.New("mot de passe trop commun")
		}
	}
	return nil
}

/* =============================================================
 * Audit L-02 : journal d'audit des événements d'authentification.
 *
 * Format JSON Lines dans data/auth-audit.log :
 *   {"ts":"2026-05-24T10:00:00Z","event":"login","user":"abc12345@example.com","ip":"1.2.3.4","success":true}
 *
 * Events traçés :
 *   - login (success / failure / reason)
 *   - logout
 *   - register
 *   - change_password
 *   - 2fa_setup, 2fa_verify, 2fa_disable
 *
 * Toutes les valeurs sont passées par hashEmailForLog → l'email cleartext ne
 * fuit jamais dans le journal. Rotation déléguée à logrotate côté hôte
 * (ou au janitor de admin-audit.log pour un setup conteneur). Permissions
 * 0600 sur le fichier.
 * ============================================================= */

type authAuditEntry struct {
	TS      string `json:"ts"`
	Event   string `json:"event"`
	UserRef string `json:"user,omitempty"`  // hashEmailForLog ou userID
	IP      string `json:"ip,omitempty"`
	Success bool   `json:"success"`
	Reason  string `json:"reason,omitempty"`
}

var authAuditMu sync.Mutex

func authAuditFile() string { return filepath.Join(dataDir, "auth-audit.log") }

// logAuthEvent append une ligne au journal. Best-effort : échoue silencieux
// si on ne peut pas écrire (le service doit continuer de fonctionner même si
// le disque est plein — la sécurité applicative n'en dépend pas).
func logAuthEvent(event, userRef, ip string, success bool, reason string) {
	e := authAuditEntry{
		TS:      time.Now().UTC().Format(time.RFC3339),
		Event:   event,
		UserRef: userRef,
		IP:      ip,
		Success: success,
		Reason:  reason,
	}
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	authAuditMu.Lock()
	defer authAuditMu.Unlock()
	f, err := os.OpenFile(authAuditFile(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}

// getUserTotpSecret renvoie le secret TOTP en clair (base32), déchiffré si
// nécessaire. Renvoie "" si pas de 2FA configurée ou si la clé est indispo
// (mode dégradé : le check 2FA échouera mais on évite le panic).
func getUserTotpSecret(u *User) string {
	if u == nil || u.TOTPSecret == "" {
		return ""
	}
	plain, err := decryptToken(u.TOTPSecret)
	if err != nil {
		log.Printf("getUserTotpSecret: decrypt failed for user %s: %v", u.ID, err)
		return ""
	}
	return plain
}

// setUserTotpSecret stocke le secret TOTP chiffré. Doit être appelé sous
// usersMu.Lock(). Si la clé n'est pas dispo, fallback cleartext (loggé) pour
// ne pas bloquer le setup 2FA.
func setUserTotpSecret(u *User, plainSecret string) {
	if u == nil {
		return
	}
	if plainSecret == "" {
		u.TOTPSecret = ""
		return
	}
	u.TOTPSecret = encryptToken(plainSecret)
}

// reencryptTotpSecret migre un secret stocké en cleartext (legacy base32) vers
// la forme chiffrée AES-GCM. Idempotent : déjà chiffré → no-op. Renvoie true
// si une migration a eu lieu pour que loadUsers puisse compter.
func reencryptTotpSecret(u *User) bool {
	if u == nil || u.TOTPSecret == "" {
		return false
	}
	if strings.HasPrefix(u.TOTPSecret, encPrefix) {
		return false  // déjà chiffré
	}
	// On a un secret legacy en clair. Le chiffrer.
	u.TOTPSecret = encryptToken(u.TOTPSecret)
	return strings.HasPrefix(u.TOTPSecret, encPrefix)  // confirme que le chiffrement a marché
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	if !allowReg {
		writeErr(w, http.StatusForbidden, "inscriptions fermées")
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
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
		// We accept the small enumeration leak here because a helpful UX ("email
		// déjà utilisé") matters for a tool the user owns. The login endpoint
		// stays timing-safe via dummyHash.
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
	}
	usersByID[u.ID] = u
	usersByEm[email] = u
	usersMu.Unlock()
	saveUsers()

	// Destroy any pre-existing session cookie the caller might bring, so a
	// successful register always starts a fresh server-side session. Prevents
	// session fixation where an attacker pre-plants a known sid.
	if old := sessionID(r); old != "" {
		destroySession(old)
	}
	sid := createSession(u.ID)
	setSessionCookie(w, r, sid)
	setCSRFCookie(w, r)
	logAuthEvent("register", hashEmailForLog(email), clientIP(r), true, "")
	// Newly-registered users have no TOTPSecret yet, so when 2FA is required
	// they will see needsEnroll2FA=true and the SPA will route them to the
	// enrollment screen on first paint.
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "userId": u.ID, "email": email,
		"twofaEnabled":   false,
		"needsEnroll2FA": twofaRequired,
	})
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		// Optional 2FA code. When the user has TOTP enabled, the first call may
		// omit it; we respond 401 with {"need2fa": true} so the client knows to
		// prompt and re-submit.
		TOTPCode string `json:"totpCode"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))

	usersMu.RLock()
	u := usersByEm[email]
	usersMu.RUnlock()

	// Always run bcrypt to keep timing roughly constant.
	hash := dummyHash
	if u != nil {
		hash = []byte(u.PasswordHash)
	}
	err := bcrypt.CompareHashAndPassword(hash, []byte(req.Password))
	if u == nil || err != nil {
		logAuthEvent("login", hashEmailForLog(email), clientIP(r), false, "bad_credentials")
		writeErr(w, http.StatusUnauthorized, "identifiants invalides")
		return
	}

	// 2FA gate. We deliberately only check this AFTER password is valid — that
	// way an attacker without password gets the same "identifiants invalides"
	// response and can't enumerate which accounts have 2FA enabled.
	if u.TOTPSecret != "" {
		if req.TOTPCode == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"error": "code 2FA requis", "need2fa": true,
			})
			return
		}
		if !verifyTOTP(getUserTotpSecret(u), strings.TrimSpace(req.TOTPCode)) {
			logAuthEvent("login", hashEmailForLog(email), clientIP(r), false, "bad_totp")
			writeErr(w, http.StatusUnauthorized, "code 2FA invalide")
			return
		}
	}

	// Session fixation defense: kill any sid the caller presented before we
	// mint a new one. Prevents an attacker who pre-plants a sid cookie in the
	// victim's browser from riding the resulting authenticated session.
	if old := sessionID(r); old != "" {
		destroySession(old)
	}
	sid := createSession(u.ID)
	setSessionCookie(w, r, sid)
	setCSRFCookie(w, r)
	logAuthEvent("login", hashEmailForLog(u.EmailLower), clientIP(r), true, "")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"userId":         u.ID,
		"email":          u.EmailLower,
		"isAdmin":        u.IsAdmin,
		"twofaEnabled":   u.TOTPSecret != "",
		"needsEnroll2FA": twofaRequired && u.TOTPSecret == "",
	})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	if sid := sessionID(r); sid != "" {
		destroySession(sid)
	}
	clearSessionCookie(w, r)
	clearCSRFCookie(w, r)
	if uid != "" {
		if u := getUserByID(uid); u != nil {
			logAuthEvent("logout", hashEmailForLog(u.EmailLower), clientIP(r), true, "")
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	if uid == "" {
		writeJSON(w, http.StatusOK, map[string]any{"user": nil})
		return
	}
	usersMu.RLock()
	u := usersByID[uid]
	usersMu.RUnlock()
	if u == nil {
		clearSessionCookie(w, r)
		writeJSON(w, http.StatusOK, map[string]any{"user": nil})
		return
	}
	// needsEnroll2FA tells the SPA to lock down to the enrollment screen until
	// the user has set up TOTP. Server still enforces this on every protected
	// endpoint via require2FA — the client flag is purely UX.
	needsEnroll := twofaRequired && u.TOTPSecret == ""
	// healthConsent and algoOptOut are surfaced so the SPA can:
	//   - block onboarding/save until consent is recorded (RGPD art. 9)
	//   - hide algorithmic adjustments when the user has opted out (art. 22)
	// Stale consent (version mismatch) is treated as "not consented" — the
	// server forces a re-prompt on a material policy update.
	hasConsent := u.HealthConsent != nil && u.HealthConsent.Version == CurrentPrivacyVersion
	consentInfo := map[string]any{
		"given":         hasConsent,
		"policyVersion": CurrentPrivacyVersion,
	}
	if u.HealthConsent != nil {
		consentInfo["consentedAt"] = u.HealthConsent.ConsentedAt
		consentInfo["consentedVersion"] = u.HealthConsent.Version
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id":             u.ID,
			"email":          u.EmailLower,
			"isAdmin":        u.IsAdmin,
			"twofaEnabled":   u.TOTPSecret != "",
			"needsEnroll2FA": needsEnroll,
			"healthConsent":  consentInfo,
			"algoOptOut":     u.AlgoOptOut,
			"createdAt":      u.CreatedAt,
		},
	})
}

// handleHealthConsent records the user's explicit consent to process health
// data (RGPD art. 9.2.a). We require an explicit boolean payload — there is no
// "default true" path. The client must check the box AND submit. If the user
// later wants to withdraw consent (art. 7.3) they should delete their account,
// since the entire app's purpose depends on processing this category of data.
func handleHealthConsent(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	if uid == "" {
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	var req struct {
		Accept bool `json:"accept"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if !req.Accept {
		writeErr(w, http.StatusBadRequest, "consentement explicite requis (case à cocher)")
		return
	}
	usersMu.Lock()
	if u := usersByID[uid]; u != nil {
		u.HealthConsent = &Consent{
			ConsentedAt: time.Now().UTC(),
			Version:     CurrentPrivacyVersion,
		}
	}
	usersMu.Unlock()
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"policyVersion": CurrentPrivacyVersion,
	})
}

// handleAlgoOptOut sets or clears the Article 22 RGPD opt-out flag. The
// client toggles this from the "Mes données et droits" panel. The server
// honours the flag in handleExport (audit) and the SPA hides generated
// adjustments client-side when it's set.
func handleAlgoOptOut(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	if uid == "" {
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	var req struct {
		OptOut bool `json:"optOut"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	usersMu.Lock()
	if u := usersByID[uid]; u != nil {
		u.AlgoOptOut = req.OptOut
	}
	usersMu.Unlock()
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "optOut": req.OptOut})
}

// ensureBootstrapAdmin promotes or creates the admin account referenced by the
// COACH_ADMIN_EMAIL / COACH_ADMIN_PASSWORD env vars at startup. This is the
// ONLY server-side path that can mint an admin; once a real admin exists, they
// promote/demote peers through the admin API.
//
// Audit H-02 : COACH_ADMIN_PASSWORD_FILE supporté pour éviter le secret dans
// l'environnement du process (cf. helpers.go > getenvOrFile).
//
// Audit M-05 : sentinelle data/.admin-bootstrap-done évite la rotation
// silencieuse du mot de passe à chaque restart si l'opérateur oublie de
// retirer COACH_ADMIN_PASSWORD du .env. Une fois le sentinel posé, on logge
// un warning et on n'écrase plus le password. Pour forcer une re-rotation :
// supprimer manuellement data/.admin-bootstrap-done.
func ensureBootstrapAdmin() {
	email := strings.ToLower(strings.TrimSpace(getenvOrFile("COACH_ADMIN_EMAIL", "")))
	pass := getenvOrFile("COACH_ADMIN_PASSWORD", "")
	if email == "" || pass == "" {
		return
	}
	if !validEmail(email) {
		log.Printf("bootstrap admin skipped: COACH_ADMIN_EMAIL invalid")
		return
	}
	if err := validPassword(pass); err != nil {
		log.Printf("bootstrap admin skipped: COACH_ADMIN_PASSWORD weak (%v)", err)
		return
	}
	sentinel := filepath.Join(dataDir, ".admin-bootstrap-done")
	if _, err := os.Stat(sentinel); err == nil {
		// Déjà bootstrapé. On ne touche pas au mot de passe pour ne pas écraser
		// silencieusement une rotation faite via l'admin UI. L'opérateur peut
		// supprimer manuellement le fichier pour forcer une re-rotation.
		log.Printf("bootstrap admin: sentinel present, ignoring COACH_ADMIN_PASSWORD (remove %s to force re-rotation)", sentinel)
		return
	}
	usersMu.Lock()
	defer usersMu.Unlock()
	if u, ok := usersByEm[email]; ok {
		changed := false
		if !u.IsAdmin {
			u.IsAdmin = true
			changed = true
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(pass), 12)
		if err == nil {
			u.PasswordHash = string(hash)
			changed = true
		}
		if changed {
			go saveUsers()
			// Audit M-05 : on tue aussi les autres sessions de cet admin pour
			// qu'une éventuelle session active hijackée avant la rotation ne
			// survive pas à la rotation.
			go destroyAllSessionsFor(u.ID)
			log.Printf("bootstrap admin: existing user %s promoted/rotated (other sessions destroyed)", hashEmailForLog(email))
		}
		// Pose le sentinel pour ne plus rotater au prochain boot.
		_ = os.WriteFile(sentinel, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o600)
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(pass), 12)
	if err != nil {
		log.Printf("bootstrap admin failed: bcrypt: %v", err)
		return
	}
	u := &User{
		ID:           randHex(16),
		EmailLower:   email,
		PasswordHash: string(hash),
		CreatedAt:    time.Now().UTC(),
		IsAdmin:      true,
	}
	usersByID[u.ID] = u
	usersByEm[email] = u
	go saveUsers()
	// Sentinel posé après création réussie.
	_ = os.WriteFile(sentinel, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o600)
	log.Printf("bootstrap admin: created admin user %s (sentinel posted at %s)", hashEmailForLog(email), sentinel)
}

// getUserByID returns a user record pointer under a read lock, or nil.
func getUserByID(id string) *User {
	usersMu.RLock()
	defer usersMu.RUnlock()
	return usersByID[id]
}

// isAdminRequest returns true if the current request is authenticated as an admin.
func isAdminRequest(r *http.Request) bool {
	uid := currentUser(r)
	if uid == "" {
		return false
	}
	u := getUserByID(uid)
	return u != nil && u.IsAdmin
}

// handleChangePassword lets a logged-in user rotate their password.
//   - requires the old password (defense against drive-by session hijack
//     of an unattended browser — attacker still doesn't know the old pw)
//   - validates the new password against validPassword (length, mix, blacklist)
//   - re-hashes with bcrypt cost 12
//   - destroys ALL sessions for this user except the current one (force re-login
//     elsewhere) — this is the security upside of the rotation
//
// Note: full SMTP-backed forgot-password flow is intentionally not implemented
// here (the project has no SMTP relay). Operators can use the admin
// reset-password endpoint as the recovery channel.
func handleChangePassword(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	if uid == "" {
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	var req struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	usersMu.RLock()
	u := usersByID[uid]
	var hash []byte
	if u != nil {
		hash = []byte(u.PasswordHash)
	}
	usersMu.RUnlock()
	if u == nil {
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	if err := bcrypt.CompareHashAndPassword(hash, []byte(req.OldPassword)); err != nil {
		logAuthEvent("change_password", hashEmailForLog(u.EmailLower), clientIP(r), false, "bad_old_password")
		writeErr(w, http.StatusUnauthorized, "ancien mot de passe incorrect")
		return
	}
	if err := validPassword(req.NewPassword); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 12)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "bcrypt indisponible")
		return
	}
	usersMu.Lock()
	if u2 := usersByID[uid]; u2 != nil {
		u2.PasswordHash = string(newHash)
	}
	usersMu.Unlock()
	saveUsers()
	// Kill every other session — keep the current one so the user stays logged in
	// in this tab. We do this by destroying all for uid, then issuing a fresh sid.
	destroyAllSessionsFor(uid)
	sid := createSession(uid)
	setSessionCookie(w, r, sid)
	setCSRFCookie(w, r)
	logAuthEvent("change_password", hashEmailForLog(u.EmailLower), clientIP(r), true, "other_sessions_killed")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handle2FAStatus returns whether 2FA is currently enabled on this account.
// No secret leaks — just a boolean for the UI to render the right toggle state.
func handle2FAStatus(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	usersMu.RLock()
	u := usersByID[uid]
	enabled := u != nil && u.TOTPSecret != ""
	usersMu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"enabled": enabled})
}

// handle2FASetup generates a fresh secret, stores it in a server-side pending
// map (keyed by uid), and returns the secret + otpauth URL so the client can
// render a QR code (or paste the secret manually). The secret is NOT persisted
// to disk yet — only handle2FAVerify does that, gated on a valid first code.
// This avoids a half-enrolled state where the secret exists but the user hasn't
// proven they can read codes from it.
var (
	pending2FA   = map[string]string{}
	pending2FAMu sync.Mutex
)

func handle2FASetup(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	usersMu.RLock()
	u := usersByID[uid]
	usersMu.RUnlock()
	if u == nil {
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	if u.TOTPSecret != "" {
		writeErr(w, http.StatusConflict, "2FA déjà activé — désactive d'abord")
		return
	}
	secret, err := generateTOTPSecret()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "rand indisponible")
		return
	}
	pending2FAMu.Lock()
	pending2FA[uid] = secret
	pending2FAMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"secret":     secret,
		"otpauthUrl": otpauthURL(u.EmailLower, secret),
	})
}

// handle2FAVerify confirms the secret by checking the user can produce a valid
// code. On success, persists the secret on the user record and clears the
// pending entry. Sessions are NOT invalidated — the user is mid-setup.
func handle2FAVerify(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	var req struct {
		Code string `json:"code"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	pending2FAMu.Lock()
	secret, ok := pending2FA[uid]
	pending2FAMu.Unlock()
	if !ok {
		writeErr(w, http.StatusBadRequest, "aucune procédure 2FA en cours — recommence")
		return
	}
	if !verifyTOTP(secret, strings.TrimSpace(req.Code)) {
		writeErr(w, http.StatusUnauthorized, "code invalide — réessaie")
		return
	}
	usersMu.Lock()
	var emailLower string
	if u := usersByID[uid]; u != nil {
		setUserTotpSecret(u, secret)
		emailLower = u.EmailLower
	}
	usersMu.Unlock()
	saveUsers()
	pending2FAMu.Lock()
	delete(pending2FA, uid)
	pending2FAMu.Unlock()
	logAuthEvent("2fa_setup", hashEmailForLog(emailLower), clientIP(r), true, "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handle2FADisable removes the secret. Requires the user to provide either a
// valid current TOTP code OR their password — defense against an attacker who
// hijacks an authenticated session and tries to drop 2FA before draining data.
// We use password since the attacker presumably has the session but not the pw.
func handle2FADisable(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	var req struct {
		Password string `json:"password"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	usersMu.RLock()
	u := usersByID[uid]
	var hash []byte
	if u != nil {
		hash = []byte(u.PasswordHash)
	}
	usersMu.RUnlock()
	if u == nil {
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	if err := bcrypt.CompareHashAndPassword(hash, []byte(req.Password)); err != nil {
		logAuthEvent("2fa_disable", hashEmailForLog(u.EmailLower), clientIP(r), false, "bad_password")
		writeErr(w, http.StatusUnauthorized, "mot de passe incorrect")
		return
	}
	usersMu.Lock()
	if u2 := usersByID[uid]; u2 != nil {
		setUserTotpSecret(u2, "")
	}
	usersMu.Unlock()
	saveUsers()
	logAuthEvent("2fa_disable", hashEmailForLog(u.EmailLower), clientIP(r), true, "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteAccount: destroys the user's data file, removes the user, kills sessions.
func handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	if uid == "" {
		writeErr(w, 401, "non connecté")
		return
	}
	// remove data file
	_ = os.Remove(dataPath(uid))
	// remove user
	usersMu.Lock()
	if u := usersByID[uid]; u != nil {
		delete(usersByEm, u.EmailLower)
		delete(usersByID, uid)
	}
	usersMu.Unlock()
	saveUsers()
	// kill all sessions for this user
	destroyAllSessionsFor(uid)
	clearSessionCookie(w, r)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// requireAuth wraps handlers that require a logged-in user. It also enforces
// CSRF on state-changing methods via the double-submit cookie pattern.
func requireAuth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid := currentUser(r)
		if uid == "" {
			writeErr(w, http.StatusUnauthorized, "non connecté")
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

// require2FA enforces that, when 2FA is mandatory (twofaRequired=true) and the
// caller hasn't enrolled a TOTP secret yet, the request is denied with a
// structured 403 the client can react to. We intentionally use 403 rather than
// 401 so the SPA distinguishes "log in again" from "enroll 2FA". Wrap with
// requireAuth FIRST so the user context is set when this runs.
//
// Endpoints that MUST stay reachable during pre-enrollment (so the user can
// actually enroll):
//   - /api/me, /api/csrf, /api/logout, /api/login, /api/register
//   - /api/2fa/status, /api/2fa/setup, /api/2fa/verify
//   - /api/change-password (changing your own pw shouldn't need 2FA enrolled)
//
// Everything else (data, export, delete-account, admin) goes behind require2FA.
func require2FA(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !twofaRequired {
			h(w, r)
			return
		}
		uid := currentUser(r)
		if uid == "" {
			// Should never happen if requireAuth ran first, but fail closed.
			writeErr(w, http.StatusUnauthorized, "non connecté")
			return
		}
		usersMu.RLock()
		u := usersByID[uid]
		usersMu.RUnlock()
		if u == nil || u.TOTPSecret == "" {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error":          "2FA requis",
				"needsEnroll2FA": true,
			})
			return
		}
		h(w, r)
	}
}
