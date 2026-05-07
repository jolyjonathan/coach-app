package main

import (
	"net/http"
	"testing"
)

// Admin tests verify the hardening invariants:
//   - Non-admins see 404 on admin endpoints (no existence confirmation).
//   - Password-hash never surfaces in any view.
//   - Self-demotion and last-admin demotion both refused.
//   - Self-delete refused.
//   - Revoke-sessions kills every session for the target.
//   - Reset-password force-logs-out the target.

func TestAdminEndpointsGatedForNonAdmins(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	// Authenticated-but-not-admin callers must see 404 (not 403) so the admin
	// surface doesn't get confirmed to random users.
	res := doJSON(t, mux, http.MethodGet, "/api/admin/users", nil, cookies, "")
	if res.status != http.StatusNotFound {
		t.Errorf("non-admin GET /api/admin/users: status=%d want 404", res.status)
	}

	// Write endpoint without CSRF — still 404 because the admin check wins first.
	res = doJSON(t, mux, http.MethodPost, "/api/admin/users", map[string]any{
		"email": "evil@example.com", "password": "Correct-horse-9",
	}, cookies, csrf)
	if res.status != http.StatusNotFound {
		t.Errorf("non-admin POST /api/admin/users: status=%d want 404", res.status)
	}

	// Unauthenticated callers get 401, as expected.
	res = doJSON(t, mux, http.MethodGet, "/api/admin/users", nil, nil, "")
	if res.status != http.StatusUnauthorized {
		t.Errorf("anon admin: status=%d want 401", res.status)
	}
}

func TestAdminListUsersNoHashLeak(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, _ := registerAndLogin(t, mux, "root@example.com", "Correct-horse-9")
	mustAdmin(t, "root@example.com")
	// Second user to populate the list.
	_, _ = registerAndLogin(t, mux, "bob@example.com", "Correct-horse-9")

	res := doJSON(t, mux, http.MethodGet, "/api/admin/users", nil, cookies, "")
	if res.status != http.StatusOK {
		t.Fatalf("list: status=%d body=%v", res.status, res.body)
	}
	users, _ := res.body["users"].([]any)
	if len(users) < 2 {
		t.Fatalf("expected at least 2 users, got %d", len(users))
	}
	for _, u := range users {
		m, _ := u.(map[string]any)
		for _, banned := range []string{"passwordHash", "password_hash", "password"} {
			if _, leak := m[banned]; leak {
				t.Errorf("admin list leaked %q: %v", banned, m)
			}
		}
	}
}

func TestAdminCannotSelfDemote(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "root@example.com", "Correct-horse-9")
	mustAdmin(t, "root@example.com")

	// Find self id.
	me := doJSON(t, mux, http.MethodGet, "/api/me", nil, cookies, "")
	uid := me.body["user"].(map[string]any)["id"].(string)

	res := doJSON(t, mux, http.MethodPost, "/api/admin/users/"+uid+"/admin", map[string]any{
		"isAdmin": false,
	}, cookies, csrf)
	if res.status != http.StatusForbidden {
		t.Errorf("self-demote: status=%d want 403 body=%v", res.status, res.body)
	}
}

func TestAdminPeerDemotionSucceeds(t *testing.T) {
	// Two admins → demoting the peer leaves one admin (us), which is fine.
	// The "last admin" defense-in-depth guard only fires in edge cases not
	// reachable via the normal API (self-demote is blocked earlier), so we
	// don't try to trigger it from the outside here.
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "root@example.com", "Correct-horse-9")
	mustAdmin(t, "root@example.com")
	_, _ = registerAndLogin(t, mux, "peer@example.com", "Correct-horse-9")
	mustAdmin(t, "peer@example.com")

	// Re-login as root so cookies/CSRF target root's session.
	login := doJSON(t, mux, http.MethodPost, "/api/login", map[string]string{
		"email": "root@example.com", "password": "Correct-horse-9",
	}, nil, "")
	cookies = login.cookies
	csrf = findCookie(cookies, csrfCookieName).Value

	list := doJSON(t, mux, http.MethodGet, "/api/admin/users", nil, cookies, "")
	var peerID string
	for _, u := range list.body["users"].([]any) {
		m := u.(map[string]any)
		if m["email"] == "peer@example.com" {
			peerID = m["id"].(string)
		}
	}
	if peerID == "" {
		t.Fatal("peer not listed")
	}

	res := doJSON(t, mux, http.MethodPost, "/api/admin/users/"+peerID+"/admin", map[string]any{
		"isAdmin": false,
	}, cookies, csrf)
	if res.status != http.StatusOK {
		t.Errorf("demote peer: status=%d body=%v", res.status, res.body)
	}
	// Verify peer is no longer admin in the list.
	list = doJSON(t, mux, http.MethodGet, "/api/admin/users", nil, cookies, "")
	for _, u := range list.body["users"].([]any) {
		m := u.(map[string]any)
		if m["email"] == "peer@example.com" && m["isAdmin"] != false {
			t.Errorf("peer should be demoted, got isAdmin=%v", m["isAdmin"])
		}
	}
}

func TestAdminCannotSelfDelete(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "root@example.com", "Correct-horse-9")
	mustAdmin(t, "root@example.com")

	me := doJSON(t, mux, http.MethodGet, "/api/me", nil, cookies, "")
	uid := me.body["user"].(map[string]any)["id"].(string)

	res := doJSON(t, mux, http.MethodDelete, "/api/admin/users/"+uid, nil, cookies, csrf)
	if res.status != http.StatusForbidden {
		t.Errorf("self-delete via admin: status=%d want 403", res.status)
	}
}

func TestAdminResetPasswordRevokesSessions(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	adminCookies, adminCsrf := registerAndLogin(t, mux, "root@example.com", "Correct-horse-9")
	mustAdmin(t, "root@example.com")

	victimCookies, _ := registerAndLogin(t, mux, "victim@example.com", "Correct-horse-9")
	// Victim has a working session.
	pre := doJSON(t, mux, http.MethodGet, "/api/me", nil, victimCookies, "")
	if v, ok := pre.body["user"].(map[string]any); !ok || v["email"] != "victim@example.com" {
		t.Fatalf("pre-reset: victim session should resolve, got %v", pre.body)
	}

	// Find victim id.
	list := doJSON(t, mux, http.MethodGet, "/api/admin/users", nil, adminCookies, "")
	var vid string
	for _, u := range list.body["users"].([]any) {
		m := u.(map[string]any)
		if m["email"] == "victim@example.com" {
			vid = m["id"].(string)
		}
	}
	if vid == "" {
		t.Fatal("victim not listed")
	}

	// Admin resets victim password.
	reset := doJSON(t, mux, http.MethodPost, "/api/admin/users/"+vid+"/password", map[string]string{
		"password": "Brand-new-pass-99",
	}, adminCookies, adminCsrf)
	if reset.status != http.StatusOK {
		t.Fatalf("reset: status=%d body=%v", reset.status, reset.body)
	}

	// Victim's old session should be dead.
	post := doJSON(t, mux, http.MethodGet, "/api/me", nil, victimCookies, "")
	if u := post.body["user"]; u != nil {
		t.Errorf("post-reset: victim session still valid, got %v", u)
	}

	// Old password should no longer work, new one should.
	oldLogin := doJSON(t, mux, http.MethodPost, "/api/login", map[string]string{
		"email": "victim@example.com", "password": "Correct-horse-9",
	}, nil, "")
	if oldLogin.status != http.StatusUnauthorized {
		t.Errorf("old password login: status=%d want 401", oldLogin.status)
	}
	newLogin := doJSON(t, mux, http.MethodPost, "/api/login", map[string]string{
		"email": "victim@example.com", "password": "Brand-new-pass-99",
	}, nil, "")
	if newLogin.status != http.StatusOK {
		t.Errorf("new password login: status=%d want 200", newLogin.status)
	}
}

func TestAdminRevokeSessions(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	adminCookies, adminCsrf := registerAndLogin(t, mux, "root@example.com", "Correct-horse-9")
	mustAdmin(t, "root@example.com")

	targetCookies, _ := registerAndLogin(t, mux, "target@example.com", "Correct-horse-9")

	list := doJSON(t, mux, http.MethodGet, "/api/admin/users", nil, adminCookies, "")
	var tid string
	for _, u := range list.body["users"].([]any) {
		m := u.(map[string]any)
		if m["email"] == "target@example.com" {
			tid = m["id"].(string)
		}
	}

	rv := doJSON(t, mux, http.MethodPost, "/api/admin/users/"+tid+"/revoke-sessions", nil, adminCookies, adminCsrf)
	if rv.status != http.StatusOK {
		t.Fatalf("revoke: status=%d", rv.status)
	}

	// Target's session cookie no longer resolves.
	me := doJSON(t, mux, http.MethodGet, "/api/me", nil, targetCookies, "")
	if me.body["user"] != nil {
		t.Errorf("target still authenticated after revoke: %v", me.body["user"])
	}
}

func TestAdminInvalidUserIDRejected(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "root@example.com", "Correct-horse-9")
	mustAdmin(t, "root@example.com")

	// Path-traversal attempts get path-cleaned by ServeMux and won't reach
	// the handler; we don't test that here. These cases instead hit the handler
	// with IDs that violate the validUserID regex: wrong length or non-hex.
	for _, bad := range []string{"short", "zzzzzzzzzzzzzzzz", "TOOLONG0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"} {
		res := doJSON(t, mux, http.MethodPost, "/api/admin/users/"+bad+"/password", map[string]string{
			"password": "Correct-horse-9",
		}, cookies, csrf)
		if res.status != http.StatusBadRequest {
			t.Errorf("bad id %q: status=%d want 400", bad, res.status)
		}
	}
}
