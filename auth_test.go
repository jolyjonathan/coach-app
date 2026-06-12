package main

import (
	"net/http"
	"strings"
	"testing"
)

// Pure-function tests: no HTTP plumbing needed.

func TestValidEmail(t *testing.T) {
	cases := []struct {
		in string
		ok bool
	}{
		{"alice@example.com", true},
		{"ALICE+tag@example.CO.uk", true},
		{"", false},
		{"not-an-email", false},
		{strings.Repeat("a", 260) + "@b.com", false},
	}
	for _, tc := range cases {
		if got := validEmail(tc.in); got != tc.ok {
			t.Errorf("validEmail(%q) = %v, want %v", tc.in, got, tc.ok)
		}
	}
}

func TestValidPassword(t *testing.T) {
	cases := []struct {
		in      string
		wantErr bool
		why     string
	}{
		{"abc", true, "too short"},
		{"abcdefghij", true, "no non-letter"},
		{"1234567890", true, "no letter"},
		{"correct-horse-battery-staple-9", false, "good"},
		{"Abcdefghi1", false, "mixed, length 10"},
		{"password123456", true, "contains 'password'"},
		{"AZERTYUIOP!!", true, "contains 'azertyuiop'"},
		{strings.Repeat("a1", 100), true, "too long"},
	}
	for _, tc := range cases {
		err := validPassword(tc.in)
		if (err != nil) != tc.wantErr {
			t.Errorf("validPassword(%q) err=%v, wantErr=%v (%s)", tc.in, err, tc.wantErr, tc.why)
		}
	}
}

func TestRegisterAndLogin(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()

	// --- Happy path: register issues session + CSRF, login after logout works.
	reg := doJSON(t, mux, http.MethodPost, "/api/register", map[string]string{
		"email": "alice@example.com", "password": "Correct-horse-9",
	}, nil, "")
	if reg.status != http.StatusOK {
		t.Fatalf("register: status=%d body=%v", reg.status, reg.body)
	}
	if findCookie(reg.cookies, sessionCookieName) == nil {
		t.Error("register: missing session cookie")
	}
	if findCookie(reg.cookies, csrfCookieName) == nil {
		t.Error("register: missing CSRF cookie")
	}

	// Duplicate email → 409.
	dup := doJSON(t, mux, http.MethodPost, "/api/register", map[string]string{
		"email": "ALICE@example.com", "password": "Correct-horse-9",
	}, nil, "")
	if dup.status != http.StatusConflict {
		t.Errorf("duplicate register: status=%d want 409", dup.status)
	}

	// Login with correct password.
	login := doJSON(t, mux, http.MethodPost, "/api/login", map[string]string{
		"email": "alice@example.com", "password": "Correct-horse-9",
	}, nil, "")
	if login.status != http.StatusOK {
		t.Fatalf("login: status=%d body=%v", login.status, login.body)
	}
	if login.body["isAdmin"] != false {
		t.Errorf("login: fresh user should not be admin, got %v", login.body["isAdmin"])
	}

	// Wrong password → 401.
	bad := doJSON(t, mux, http.MethodPost, "/api/login", map[string]string{
		"email": "alice@example.com", "password": "wrong-horse-99",
	}, nil, "")
	if bad.status != http.StatusUnauthorized {
		t.Errorf("bad login: status=%d want 401", bad.status)
	}

	// Unknown user → 401 with indistinguishable response shape (dummyHash path).
	unknown := doJSON(t, mux, http.MethodPost, "/api/login", map[string]string{
		"email": "nobody@example.com", "password": "Correct-horse-9",
	}, nil, "")
	if unknown.status != http.StatusUnauthorized {
		t.Errorf("unknown login: status=%d want 401", unknown.status)
	}
	if unknown.body["error"] != bad.body["error"] {
		t.Errorf("unknown vs bad-password should have identical error messages, got %q vs %q",
			unknown.body["error"], bad.body["error"])
	}
}

func TestRegisterClosedWhenAllowRegFalse(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	allowReg = false
	res := doJSON(t, mux, http.MethodPost, "/api/register", map[string]string{
		"email": "alice@example.com", "password": "Correct-horse-9",
	}, nil, "")
	if res.status != http.StatusForbidden {
		t.Errorf("register closed: status=%d want 403", res.status)
	}
}

func TestMeEndpoint(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()

	// Anonymous /api/me returns { user: null } with 200.
	anon := doJSON(t, mux, http.MethodGet, "/api/me", nil, nil, "")
	if anon.status != http.StatusOK {
		t.Fatalf("anon /me: status=%d", anon.status)
	}
	if u, ok := anon.body["user"]; !ok || u != nil {
		t.Errorf("anon /me: expected user=null, got %v", anon.body)
	}

	// Post-login /api/me identifies the user.
	cookies, _ := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")
	me := doJSON(t, mux, http.MethodGet, "/api/me", nil, cookies, "")
	if me.status != http.StatusOK {
		t.Fatalf("auth /me: status=%d", me.status)
	}
	u, ok := me.body["user"].(map[string]any)
	if !ok {
		t.Fatalf("auth /me: expected user object, got %v", me.body)
	}
	if u["email"] != "alice@example.com" {
		t.Errorf("auth /me: wrong email %v", u["email"])
	}
	if u["isAdmin"] != false {
		t.Errorf("auth /me: admin flag should be false, got %v", u["isAdmin"])
	}
}

func TestLogoutDestroysSession(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	out := doJSON(t, mux, http.MethodPost, "/api/logout", nil, cookies, csrf)
	if out.status != http.StatusOK {
		t.Fatalf("logout: status=%d", out.status)
	}

	// The sid cookie should still be sent by the client until the browser
	// applies the clear — but the server-side record is gone, so /api/me returns anonymous.
	me := doJSON(t, mux, http.MethodGet, "/api/me", cookies, nil, "")
	u := me.body["user"]
	if u != nil {
		t.Errorf("post-logout /me should see anonymous, got %v", u)
	}
}

func TestDeleteAccount(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	// Save some data first so the delete has something to clean up.
	save := doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data": map[string]any{"profile": map[string]any{"goal": "muscle"}},
	}, cookies, csrf)
	if save.status != http.StatusOK {
		t.Fatalf("pre-delete save: status=%d", save.status)
	}

	// delete-account exige le mot de passe courant (défense contre le vol de
	// session) — on le fournit dans le body.
	del := doJSON(t, mux, http.MethodPost, "/api/delete-account", map[string]string{
		"password": "Correct-horse-9",
	}, cookies, csrf)
	if del.status != http.StatusOK {
		t.Fatalf("delete-account: status=%d body=%v", del.status, del.body)
	}

	// User record gone → login must now fail.
	login := doJSON(t, mux, http.MethodPost, "/api/login", map[string]string{
		"email": "alice@example.com", "password": "Correct-horse-9",
	}, nil, "")
	if login.status != http.StatusUnauthorized {
		t.Errorf("post-delete login: status=%d want 401", login.status)
	}
}

func TestChangePassword(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	// Wrong old password → 401.
	bad := doJSON(t, mux, http.MethodPost, "/api/change-password", map[string]string{
		"oldPassword": "Wrong-horse-9",
		"newPassword": "Brand-new-pass-99",
	}, cookies, csrf)
	if bad.status != http.StatusUnauthorized {
		t.Errorf("wrong old pw: status=%d want 401", bad.status)
	}

	// Weak new password → 400.
	weak := doJSON(t, mux, http.MethodPost, "/api/change-password", map[string]string{
		"oldPassword": "Correct-horse-9",
		"newPassword": "abc",
	}, cookies, csrf)
	if weak.status != http.StatusBadRequest {
		t.Errorf("weak new pw: status=%d want 400", weak.status)
	}

	// Happy path.
	ok := doJSON(t, mux, http.MethodPost, "/api/change-password", map[string]string{
		"oldPassword": "Correct-horse-9",
		"newPassword": "Brand-new-pass-99",
	}, cookies, csrf)
	if ok.status != http.StatusOK {
		t.Fatalf("change pw: status=%d body=%v", ok.status, ok.body)
	}

	// Old password no longer authenticates; new one does.
	loginOld := doJSON(t, mux, http.MethodPost, "/api/login", map[string]string{
		"email": "alice@example.com", "password": "Correct-horse-9",
	}, nil, "")
	if loginOld.status != http.StatusUnauthorized {
		t.Errorf("login with old pw: status=%d want 401", loginOld.status)
	}
	loginNew := doJSON(t, mux, http.MethodPost, "/api/login", map[string]string{
		"email": "alice@example.com", "password": "Brand-new-pass-99",
	}, nil, "")
	if loginNew.status != http.StatusOK {
		t.Errorf("login with new pw: status=%d want 200", loginNew.status)
	}
}

func TestChangePasswordRequiresAuth(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	res := doJSON(t, mux, http.MethodPost, "/api/change-password", map[string]string{
		"oldPassword": "anything", "newPassword": "Brand-new-pass-99",
	}, nil, "")
	if res.status != http.StatusUnauthorized {
		t.Errorf("anon change-password: status=%d want 401", res.status)
	}
}

// TestRequire2FAGate verifies that when twofaRequired is on and the user
// hasn't enrolled, /api/data is locked out with 403 + needsEnroll2FA, while
// /api/2fa/setup, /api/me, and /api/change-password remain reachable so the
// user can actually complete enrollment (or rotate a weak password first).
func TestRequire2FAGate(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()

	// Flip the gate on for this test only. cleanup() runs after we restore.
	prev := twofaRequired
	twofaRequired = true
	defer func() { twofaRequired = prev }()

	cookies, csrf := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	// /api/data must be 403 with needsEnroll2FA=true.
	got := doJSON(t, mux, http.MethodGet, "/api/data", nil, cookies, "")
	if got.status != http.StatusForbidden {
		t.Errorf("locked /api/data GET: status=%d want 403", got.status)
	}
	if v, _ := got.body["needsEnroll2FA"].(bool); !v {
		t.Errorf("expected needsEnroll2FA=true, got body=%v", got.body)
	}

	// /api/me should still resolve (so the SPA can render the enroll screen)
	// and report needsEnroll2FA on the user object.
	me := doJSON(t, mux, http.MethodGet, "/api/me", nil, cookies, "")
	if me.status != http.StatusOK {
		t.Errorf("/api/me locked too tightly: status=%d", me.status)
	}
	if u, _ := me.body["user"].(map[string]any); u != nil {
		if v, _ := u["needsEnroll2FA"].(bool); !v {
			t.Errorf("user.needsEnroll2FA=true expected, got %v", u)
		}
	} else {
		t.Errorf("/api/me missing user field: %v", me.body)
	}

	// /api/2fa/setup must succeed — this is how the user escapes the gate.
	setup := doJSON(t, mux, http.MethodPost, "/api/2fa/setup", map[string]any{}, cookies, csrf)
	if setup.status != http.StatusOK {
		t.Errorf("/api/2fa/setup blocked by gate: status=%d body=%v", setup.status, setup.body)
	}

	// /api/change-password must also stay reachable (user may want to rotate
	// pw before enrolling 2FA — locking this would create a frustrating UX
	// without any real security benefit, since they're already authenticated).
	cp := doJSON(t, mux, http.MethodPost, "/api/change-password", map[string]string{
		"oldPassword": "Correct-horse-9", "newPassword": "Brand-new-pass-99",
	}, cookies, csrf)
	if cp.status != http.StatusOK {
		t.Errorf("/api/change-password blocked by gate: status=%d body=%v", cp.status, cp.body)
	}
}

func TestSessionFixationResistance(t *testing.T) {
	// If a caller presents a pre-existing sid cookie, register/login must mint a
	// new one (and invalidate the old). Ensures an attacker can't pre-plant a sid
	// in the victim's browser and ride their authenticated session afterwards.
	mux, cleanup := newTestServer(t)
	defer cleanup()

	// Fake sid planted by "attacker".
	fake := &http.Cookie{Name: sessionCookieName, Value: "attacker-pre-planted-sid", Path: "/"}
	reg := doJSON(t, mux, http.MethodPost, "/api/register", map[string]string{
		"email": "bob@example.com", "password": "Correct-horse-9",
	}, []*http.Cookie{fake}, "")
	if reg.status != http.StatusOK {
		t.Fatalf("register: status=%d", reg.status)
	}
	got := findCookie(reg.cookies, sessionCookieName)
	if got == nil || got.Value == fake.Value {
		t.Errorf("register must issue a fresh sid, got %v", got)
	}
}
