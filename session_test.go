package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCreateAndResolveSession(t *testing.T) {
	sessionStore.Reset()

	sid := createSession("user-abc")
	if len(sid) < 32 {
		t.Errorf("createSession: sid too short, got len=%d", len(sid))
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sid})
	if got := currentUser(req); got != "user-abc" {
		t.Errorf("currentUser: got %q, want user-abc", got)
	}

	destroySession(sid)
	if got := currentUser(req); got != "" {
		t.Errorf("after destroy: currentUser=%q, want empty", got)
	}
}

func TestExpiredSessionPurged(t *testing.T) {
	sessionStore.Seed(map[string]Session{
		"stale": {
			UserID:    "ghost",
			CreatedAt: time.Now().Add(-48 * time.Hour),
			ExpiresAt: time.Now().Add(-1 * time.Hour),
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "stale"})
	if got := currentUser(req); got != "" {
		t.Errorf("expired sid should resolve to empty, got %q", got)
	}
	// Side-effect: currentUser should have deleted the record.
	if _, still := sessionStore.Get("stale"); still {
		t.Errorf("expired sid should have been purged on access")
	}
}

func TestDestroyAllSessionsFor(t *testing.T) {
	sessionStore.Seed(map[string]Session{
		"a": {UserID: "u1", ExpiresAt: time.Now().Add(time.Hour)},
		"b": {UserID: "u1", ExpiresAt: time.Now().Add(time.Hour)},
		"c": {UserID: "u2", ExpiresAt: time.Now().Add(time.Hour)},
	})

	destroyAllSessionsFor("u1")

	if _, ok := sessionStore.Get("a"); ok {
		t.Errorf("session a (u1) not destroyed")
	}
	if _, ok := sessionStore.Get("b"); ok {
		t.Errorf("session b (u1) not destroyed")
	}
	if _, ok := sessionStore.Get("c"); !ok {
		t.Errorf("session c (u2) wrongly destroyed")
	}
}

func TestCheckCSRF(t *testing.T) {
	// Header must match cookie value exactly. Missing either → fail.
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	if checkCSRF(req) {
		t.Errorf("no cookie, no header: should fail")
	}

	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "abc123"})
	if checkCSRF(req) {
		t.Errorf("cookie only: should fail")
	}

	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set(csrfHeaderName, "abc123")
	if checkCSRF(req) {
		t.Errorf("header only: should fail")
	}

	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "abc123"})
	req.Header.Set(csrfHeaderName, "abc123")
	if !checkCSRF(req) {
		t.Errorf("matching cookie+header: should pass")
	}

	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "abc123"})
	req.Header.Set(csrfHeaderName, "mismatch")
	if checkCSRF(req) {
		t.Errorf("mismatched cookie/header: should fail")
	}
}

func TestCookieFlags(t *testing.T) {
	// Session cookie must be HttpOnly + SameSite=Strict. Secure depends on
	// isHTTPS(r) which needs TLS or trusted proxy.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	setSessionCookie(rec, req, "abc")
	c := findCookie(rec.Result().Cookies(), sessionCookieName)
	if c == nil {
		t.Fatal("no session cookie set")
	}
	if !c.HttpOnly {
		t.Error("session cookie must be HttpOnly")
	}
	if c.SameSite != http.SameSiteStrictMode {
		t.Errorf("session cookie SameSite=%v want Strict", c.SameSite)
	}
	if c.Secure {
		t.Error("session cookie should NOT be Secure over plain HTTP (localhost dev)")
	}

	// CSRF cookie must be readable by JS (not HttpOnly) — that's the whole
	// point of the double-submit pattern.
	rec = httptest.NewRecorder()
	setCSRFCookie(rec, req)
	c = findCookie(rec.Result().Cookies(), csrfCookieName)
	if c == nil {
		t.Fatal("no csrf cookie set")
	}
	if c.HttpOnly {
		t.Error("csrf cookie must NOT be HttpOnly (JS needs to read it)")
	}
	if c.SameSite != http.SameSiteStrictMode {
		t.Errorf("csrf cookie SameSite=%v want Strict", c.SameSite)
	}
}
