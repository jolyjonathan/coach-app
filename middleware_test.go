package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSecureHeaders(t *testing.T) {
	// Wrap a no-op handler and verify every expected header is present and set
	// to the expected value. If we ever loosen CSP by accident, this will catch it.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	secureHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(rec, req)

	got := rec.Result().Header
	wantExact := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
	}
	for k, want := range wantExact {
		if got.Get(k) != want {
			t.Errorf("%s = %q, want %q", k, got.Get(k), want)
		}
	}

	// CSP sanity: default-src 'self', no unsafe-eval, frame-src locked to youtube-nocookie.
	csp := got.Get("Content-Security-Policy")
	mustContain := []string{
		"default-src 'self'",
		"frame-ancestors 'none'",
		"frame-src https://www.youtube-nocookie.com",
		"object-src 'none'",
	}
	for _, m := range mustContain {
		if !contains(csp, m) {
			t.Errorf("CSP missing fragment %q, got %q", m, csp)
		}
	}
	if contains(csp, "unsafe-eval") {
		t.Errorf("CSP must not allow unsafe-eval, got %q", csp)
	}
}

func TestRecoverPanic(t *testing.T) {
	// A panicking handler must return 500, not crash the server.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/boom", nil)
	recoverPanic(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("surprise")
	})).ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("panic recovery: status=%d want 500", rec.Code)
	}
}

func TestMaxBody(t *testing.T) {
	rec := httptest.NewRecorder()
	// Build a 100-byte body and cap at 10.
	req := httptest.NewRequest(http.MethodPost, "/", stringReader("1234567890123456789012345678901234567890"))
	maxBody(10)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 200)
		_, err := r.Body.Read(buf)
		// Read past the cap — MaxBytesReader returns an error once exceeded.
		// We surface a 413-ish state by writing the read error length; assertion
		// is that the handler does NOT see the full body.
		if err == nil {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusRequestEntityTooLarge)
	})).ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("maxBody: status=%d want 413", rec.Code)
	}
}

func TestRateLimit(t *testing.T) {
	// Reset rate-limit state so other tests don't pollute us.
	rlMu.Lock()
	rlMap = map[rlKey]*rlRec{}
	rlMu.Unlock()

	called := 0
	h := rateLimit("testbucket", 3, time.Minute, func(w http.ResponseWriter, r *http.Request) {
		called++
		w.WriteHeader(http.StatusOK)
	})

	// 3 allowed, 4th blocked.
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/ep", nil)
		req.RemoteAddr = "10.0.0.1:1234"
		h(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("req %d: status=%d want 200", i+1, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/ep", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	h(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("4th req: status=%d want 429", rec.Code)
	}
	if rec.Result().Header.Get("Retry-After") == "" {
		t.Error("429 response missing Retry-After header")
	}
	if called != 3 {
		t.Errorf("handler called %d times, expected 3", called)
	}

	// Different IP → fresh bucket.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/ep", nil)
	req.RemoteAddr = "10.0.0.2:1234"
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("different IP: status=%d want 200", rec.Code)
	}
}

func TestClientIPTrustProxy(t *testing.T) {
	// With trustProxy=false (default), X-Forwarded-For must be ignored — else
	// any attacker can spoof an IP and defeat rate limiting.
	trustProxy = false
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.1.2.3:9999"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := clientIP(req); got != "10.1.2.3" {
		t.Errorf("trustProxy=false: clientIP=%q want 10.1.2.3", got)
	}

	// With trustProxy=true, first hop in X-Forwarded-For wins.
	trustProxy = true
	defer func() { trustProxy = false }()
	if got := clientIP(req); got != "1.2.3.4" {
		t.Errorf("trustProxy=true: clientIP=%q want 1.2.3.4", got)
	}
}

// tiny helpers

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// stringReader returns an io.Reader over a string; used to craft oversized bodies.
func stringReader(s string) io.Reader { return strings.NewReader(s) }
