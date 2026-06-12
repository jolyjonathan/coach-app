package main

// Shared test helpers. Tests in this package share global state (usersByID,
// sessions, rate-limiter map, config globals), so every test that touches
// those must call resetGlobals() or the per-test harness below. Running tests
// with -parallel is NOT safe until the server state is refactored to be
// instanced — for now tests run serially.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// newTestServer returns an *http.ServeMux wired like main() but with state
// scoped to a fresh temp data dir. Each caller gets a clean slate: no users,
// no sessions, no rate-limit counters. Registration is opened so we can test
// the register path; toggle t-local env if you need a different mode.
func newTestServer(t *testing.T) (*http.ServeMux, func()) {
	t.Helper()
	tmp := t.TempDir()
	// Reset package globals. These are normally set once at process start.
	dataDir = tmp
	publicDir = tmp + "/public"
	listenAddr = "127.0.0.1:0"
	trustProxy = false
	allowReg = true
	// 2FA is mandatory in production but disabled in the default test
	// fixture so legacy data/admin tests still hit their endpoints.
	// Tests that need to verify the gate flip this to true themselves.
	twofaRequired = false

	// Wipe shared maps. Tests that run in sequence must not leak state.
	usersMu.Lock()
	usersByID = map[string]*User{}
	usersByEm = map[string]*User{}
	usersMu.Unlock()

	sessionStore.Reset()

	rlMu.Lock()
	rlMap = map[rlKey]*rlRec{}
	rlMu.Unlock()

	// B3 : les autres maps globales doivent AUSSI être remises à zéro, sinon
	// l'état d'un test fuit dans le suivant et la suite devient flaky / ordre-
	// dépendante (ex. un counter TOTP consommé, un state OAuth en attente, ou
	// un athleteID Strava résolu vers un uid désormais inexistant).
	totpLastUsedMu.Lock()
	totpLastUsed = map[string]int64{}
	totpLastUsedMu.Unlock()

	pending2FAMu.Lock()
	pending2FA = map[string]pending2FAEntry{}
	pending2FAMu.Unlock()

	stravaStatesMu.Lock()
	stravaPendingStates = map[string]stravaPendingState{}
	stravaStatesMu.Unlock()

	stravaAthleteMu.Lock()
	stravaAthleteIndex = map[int64]string{}
	stravaAthleteMu.Unlock()

	// userFileLocks est un sync.Map de mutex par-uid ; on le réinitialise pour
	// ne pas conserver des locks pointant vers des fichiers de tmp dirs détruits.
	userFileLocks = sync.Map{}

	// loadUsers also seeds dummyHash, which we need for login timing-safety.
	loadUsers()

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/register", handleRegister)
	mux.HandleFunc("POST /api/login", handleLogin)
	mux.HandleFunc("POST /api/logout", handleLogout)
	mux.HandleFunc("GET /api/me", handleMe)
	mux.HandleFunc("GET /api/csrf", handleCSRF)
	// Mirror production wiring: data + admin sit behind both auth and the
	// 2FA gate. With twofaRequired=false (test default) the gate is a
	// no-op; tests that flip it true exercise the lockout.
	mux.HandleFunc("GET /api/data", requireAuth(require2FA(handleLoadData)))
	mux.HandleFunc("PUT /api/data", requireAuth(require2FA(handleSaveData)))
	mux.HandleFunc("GET /api/export", requireAuth(require2FA(handleExport)))
	mux.HandleFunc("POST /api/delete-account", requireAuth(require2FA(handleDeleteAccount)))
	mux.HandleFunc("POST /api/consent", requireAuth(require2FA(handleHealthConsent)))
	mux.HandleFunc("POST /api/algo-optout", requireAuth(require2FA(handleAlgoOptOut)))
	mux.HandleFunc("POST /api/change-password", requireAuth(handleChangePassword))
	mux.HandleFunc("GET /api/2fa/status", requireAuth(handle2FAStatus))
	mux.HandleFunc("POST /api/2fa/setup", requireAuth(handle2FASetup))
	mux.HandleFunc("POST /api/2fa/verify", requireAuth(handle2FAVerify))
	mux.HandleFunc("POST /api/2fa/disable", requireAuth(handle2FADisable))
	mux.HandleFunc("GET /api/admin/users", requireAdmin(require2FA(handleAdminListUsers)))
	mux.HandleFunc("POST /api/admin/users", requireAdmin(require2FA(handleAdminCreateUser)))
	mux.HandleFunc("POST /api/admin/users/{id}/password", requireAdmin(require2FA(handleAdminResetPassword)))
	mux.HandleFunc("POST /api/admin/users/{id}/admin", requireAdmin(require2FA(handleAdminToggleAdmin)))
	mux.HandleFunc("POST /api/admin/users/{id}/revoke-sessions", requireAdmin(require2FA(handleAdminRevokeSessions)))
	mux.HandleFunc("DELETE /api/admin/users/{id}", requireAdmin(require2FA(handleAdminDeleteUser)))
	mux.HandleFunc("GET /api/admin/users/{id}/data", requireAdmin(require2FA(handleAdminGetUserData)))

	// Plusieurs handlers lancent les écritures disque en goroutine
	// (`go saveUsers()`, `go saveSessions()`). Si l'une d'elles s'exécute
	// pendant que t.TempDir() fait son RemoveAll de fin de test, le nettoyage
	// échoue avec « directory not empty ». On laisse une petite fenêtre aux
	// goroutines pour se vider AVANT le retour du test (donc avant le cleanup
	// TempDir, qui tourne en t.Cleanup après le corps du test).
	cleanup := func() { time.Sleep(100 * time.Millisecond) }
	return mux, cleanup
}

// doJSON performs a JSON request against mux, optionally attaching cookies.
// For POST/PUT/DELETE we auto-fetch a CSRF cookie first if one isn't already
// present, mirroring how the real SPA works. Returns parsed response + cookies
// carried by the handler.
type jsonResp struct {
	status  int
	body    map[string]any
	cookies []*http.Cookie
	headers http.Header
}

func doJSON(t *testing.T, mux http.Handler, method, path string, body any, cookies []*http.Cookie, csrf string) jsonResp {
	t.Helper()
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = strings.NewReader(string(b))
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	if csrf != "" && (method != http.MethodGet && method != http.MethodHead) {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	res := rec.Result()
	defer res.Body.Close()
	var data map[string]any
	raw, _ := io.ReadAll(res.Body)
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &data)
	}
	return jsonResp{
		status:  res.StatusCode,
		body:    data,
		cookies: res.Cookies(),
		headers: res.Header,
	}
}

// findCookie returns the cookie by name from a cookie slice, or nil.
func findCookie(cs []*http.Cookie, name string) *http.Cookie {
	for _, c := range cs {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// mergeCookies applies new Set-Cookie output on top of an existing slice,
// honoring MaxAge<0 as "delete". Emulates what a browser would do.
func mergeCookies(existing, newCookies []*http.Cookie) []*http.Cookie {
	byName := map[string]*http.Cookie{}
	for _, c := range existing {
		byName[c.Name] = c
	}
	for _, c := range newCookies {
		if c.MaxAge < 0 {
			delete(byName, c.Name)
			continue
		}
		byName[c.Name] = c
	}
	out := make([]*http.Cookie, 0, len(byName))
	for _, c := range byName {
		out = append(out, c)
	}
	return out
}

// registerAndLogin is a convenience that signs up a fresh user and returns the
// auth cookies + CSRF token ready for authenticated requests. We set allowReg
// for the duration of the call.
func registerAndLogin(t *testing.T, mux http.Handler, email, password string) (cookies []*http.Cookie, csrf string) {
	t.Helper()
	prev := allowReg
	allowReg = true
	defer func() { allowReg = prev }()

	res := doJSON(t, mux, http.MethodPost, "/api/register", map[string]string{
		"email": email, "password": password,
	}, nil, "")
	if res.status != http.StatusOK {
		t.Fatalf("register: status=%d body=%v", res.status, res.body)
	}
	cookies = res.cookies
	if c := findCookie(cookies, csrfCookieName); c != nil {
		csrf = c.Value
	}
	// Grant the health-data consent (RGPD art. 9) directly on the User struct
	// so /api/data PUT isn't blocked. Tests that specifically exercise the
	// consent gate should call this helper without `mustGrantConsent` or
	// override afterwards.
	mustGrantConsent(t, email)
	return
}

// mustGrantConsent stamps a fresh CurrentPrivacyVersion consent on the named
// user. Used by tests that don't go through the consent UI but still need
// /api/data to accept writes.
func mustGrantConsent(t *testing.T, email string) {
	t.Helper()
	usersMu.Lock()
	defer usersMu.Unlock()
	u := usersByEm[strings.ToLower(email)]
	if u == nil {
		t.Fatalf("mustGrantConsent: user %q not found", email)
	}
	u.HealthConsent = &Consent{
		ConsentedAt: time.Now().UTC(),
		Version:     CurrentPrivacyVersion,
	}
}

// mustAdmin flips the is-admin bit on a user directly (no API path exists for
// that; real admins are bootstrapped at start-up).
func mustAdmin(t *testing.T, email string) {
	t.Helper()
	usersMu.Lock()
	defer usersMu.Unlock()
	u := usersByEm[strings.ToLower(email)]
	if u == nil {
		t.Fatalf("mustAdmin: user %q not found", email)
	}
	u.IsAdmin = true
}

// waitABit gives async goroutines (saveUsers, saveSessions) a tiny window to
// flush to disk. Most assertions don't need it, but file-based ones do.
func waitABit() { time.Sleep(20 * time.Millisecond) }
