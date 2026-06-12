package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDataSaveLoadRoundTrip(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	// Save a representative shape.
	payload := map[string]any{
		"profile":   map[string]any{"goal": "muscle", "gear": []any{"barre"}},
		"history":   []any{map[string]any{"date": "2026-01-01T00:00:00Z", "sets": []any{}}},
		"formScore": float64(72),
	}
	save := doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data": payload,
	}, cookies, csrf)
	if save.status != http.StatusOK {
		t.Fatalf("save: status=%d body=%v", save.status, save.body)
	}

	// Reload and compare the whitelisted keys.
	load := doJSON(t, mux, http.MethodGet, "/api/data", nil, cookies, "")
	if load.status != http.StatusOK {
		t.Fatalf("load: status=%d body=%v", load.status, load.body)
	}
	got, _ := load.body["data"].(map[string]any)
	if got == nil {
		t.Fatalf("load: data missing, body=%v", load.body)
	}
	prof, _ := got["profile"].(map[string]any)
	if prof == nil || prof["goal"] != "muscle" {
		t.Errorf("load: profile lost, got %v", got["profile"])
	}
	if got["formScore"] != float64(72) {
		t.Errorf("load: formScore lost, got %v", got["formScore"])
	}
}

func TestDataTopLevelKeyWhitelist(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	// "secret" is NOT in the whitelist — server must silently drop it.
	save := doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data": map[string]any{
			"profile": map[string]any{"goal": "muscle"},
			"secret":  "you should not store this",
			"isAdmin": true, // attempt to poison privilege flag client-side
		},
	}, cookies, csrf)
	if save.status != http.StatusOK {
		t.Fatalf("save: status=%d body=%v", save.status, save.body)
	}

	load := doJSON(t, mux, http.MethodGet, "/api/data", nil, cookies, "")
	got, _ := load.body["data"].(map[string]any)
	if got == nil {
		t.Fatal("load returned nil data")
	}
	if _, bad := got["secret"]; bad {
		t.Errorf("load: 'secret' leaked past whitelist")
	}
	if _, bad := got["isAdmin"]; bad {
		t.Errorf("load: 'isAdmin' leaked past whitelist — privilege escalation vector")
	}
	if _, ok := got["profile"]; !ok {
		t.Errorf("load: expected 'profile' to be retained")
	}
}

func TestDataRequiresAuth(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()

	res := doJSON(t, mux, http.MethodGet, "/api/data", nil, nil, "")
	if res.status != http.StatusUnauthorized {
		t.Errorf("anon /api/data GET: status=%d want 401", res.status)
	}

	// Put without auth → 401 before CSRF is even checked.
	res = doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data": map[string]any{"profile": "x"},
	}, nil, "")
	if res.status != http.StatusUnauthorized {
		t.Errorf("anon /api/data PUT: status=%d want 401", res.status)
	}
}

func TestDataCSRFRequiredOnWrite(t *testing.T) {
	// Authenticated but no CSRF header → 403. Even with SameSite=Strict acting as
	// primary defense, the double-submit check must still fire.
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, _ := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	res := doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data": map[string]any{"profile": map[string]any{"goal": "muscle"}},
	}, cookies, "" /* no csrf header */)
	if res.status != http.StatusForbidden {
		t.Errorf("missing CSRF: status=%d want 403", res.status)
	}

	// Wrong CSRF value → 403.
	res = doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data": map[string]any{"profile": map[string]any{"goal": "muscle"}},
	}, cookies, "not-the-real-token")
	if res.status != http.StatusForbidden {
		t.Errorf("bad CSRF: status=%d want 403", res.status)
	}
}

func TestDataUnknownFieldsRejected(t *testing.T) {
	// DisallowUnknownFields is set on the outer envelope. A wrapper key outside
	// {"data": ...} should return 400.
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	res := doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data":  map[string]any{"profile": "x"},
		"extra": "should-reject",
	}, cookies, csrf)
	if res.status != http.StatusBadRequest {
		t.Errorf("unknown envelope field: status=%d want 400", res.status)
	}
}

func TestExportReturnsJSONAttachment(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "alice@example.com", "Correct-horse-9")

	_ = doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data": map[string]any{"profile": map[string]any{"goal": "strength"}},
	}, cookies, csrf)

	exp := doJSON(t, mux, http.MethodGet, "/api/export", nil, cookies, "")
	if exp.status != http.StatusOK {
		t.Fatalf("export: status=%d", exp.status)
	}
	ct := exp.headers.Get("Content-Type")
	if ct == "" || ct[:16] != "application/json" {
		t.Errorf("export: content-type=%q want application/json*", ct)
	}
	cd := exp.headers.Get("Content-Disposition")
	if cd == "" {
		t.Errorf("export: missing Content-Disposition for download")
	}
}

func TestDataPathValidation(t *testing.T) {
	// Direct unit test of dataPath — the user id comes from server-generated
	// sids, but defense-in-depth regex must still catch path traversal.
	dataDir = t.TempDir()
	p := dataPath("../../etc/passwd")
	if p[len(p)-13:] != "_invalid.json" {
		t.Errorf("dataPath must reject traversal id, got %q", p)
	}
	good := dataPath("a1b2c3d4e5f60718") // 16 hex chars
	// 16 hex + ".json" = 21 chars.
	if good[len(good)-21:] != "a1b2c3d4e5f60718.json" {
		t.Errorf("dataPath valid id: got %q", good)
	}
}

// TestDataETag — audit modularité action 8 : GET /api/data émet un ETag
// fort ; If-None-Match identique → 304 sans corps ; une écriture change
// l'ETag.
func TestDataETag(t *testing.T) {
	mux, cleanup := newTestServer(t)
	defer cleanup()
	cookies, csrf := registerAndLogin(t, mux, "etag@example.com", "Correct-horse-9")

	save := doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data": map[string]any{"profile": map[string]any{"goal": "muscle"}},
	}, cookies, csrf)
	if save.status != http.StatusOK {
		t.Fatalf("save: status=%d", save.status)
	}

	r1 := doJSON(t, mux, http.MethodGet, "/api/data", nil, cookies, "")
	etag := r1.headers.Get("ETag")
	if etag == "" {
		t.Fatal("GET /api/data: ETag manquant")
	}

	// Re-GET avec If-None-Match → 304.
	req := httptest.NewRequest(http.MethodGet, "/api/data", nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	req.Header.Set("If-None-Match", etag)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Errorf("If-None-Match identique: status=%d want 304", rec.Code)
	}

	// Une écriture doit changer l'ETag.
	save2 := doJSON(t, mux, http.MethodPut, "/api/data", map[string]any{
		"data": map[string]any{"profile": map[string]any{"goal": "force"}},
	}, cookies, csrf)
	if save2.status != http.StatusOK {
		t.Fatalf("save2: status=%d", save2.status)
	}
	r2 := doJSON(t, mux, http.MethodGet, "/api/data", nil, cookies, "")
	if r2.headers.Get("ETag") == etag {
		t.Errorf("ETag inchangé après écriture — il doit refléter le contenu")
	}
}
