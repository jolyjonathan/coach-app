package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func gzServe(t *testing.T, inner http.HandlerFunc, path string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	h := gzipStatic(inner)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGzipStatic(t *testing.T) {
	bigJS := strings.Repeat("function add(a,b){return a+b} ", 200)
	jsHandler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		_, _ = w.Write([]byte(bigJS))
	}

	t.Run("JS compressé quand le client accepte gzip", func(t *testing.T) {
		rec := gzServe(t, jsHandler, "/static/app.js", map[string]string{"Accept-Encoding": "gzip, br"})
		if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("Content-Encoding=%q want gzip", got)
		}
		if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
			t.Error("Vary: Accept-Encoding manquant")
		}
		gr, err := gzip.NewReader(rec.Body)
		if err != nil {
			t.Fatalf("gzip reader: %v", err)
		}
		out, _ := io.ReadAll(gr)
		if string(out) != bigJS {
			t.Error("round-trip gzip ≠ original")
		}
		if rec.Body.Len() >= len(bigJS) {
			t.Errorf("compressé (%d) devrait être < original (%d)", rec.Body.Len(), len(bigJS))
		}
	})

	t.Run("pas de gzip sans Accept-Encoding", func(t *testing.T) {
		rec := gzServe(t, jsHandler, "/static/app.js", nil)
		if rec.Header().Get("Content-Encoding") != "" {
			t.Error("ne doit pas compresser sans Accept-Encoding: gzip")
		}
		if rec.Body.String() != bigJS {
			t.Error("corps modifié sans compression demandée")
		}
	})

	t.Run("les chemins /api/ ne sont JAMAIS compressés (BREACH)", func(t *testing.T) {
		api := func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"csrf":"secret"}`))
		}
		rec := gzServe(t, api, "/api/csrf", map[string]string{"Accept-Encoding": "gzip"})
		if rec.Header().Get("Content-Encoding") != "" {
			t.Error("réponse API compressée — risque BREACH")
		}
	})

	t.Run("contenu non compressible laissé tel quel", func(t *testing.T) {
		png := func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte{0x89, 'P', 'N', 'G'})
		}
		rec := gzServe(t, png, "/static/icon.png", map[string]string{"Accept-Encoding": "gzip"})
		if rec.Header().Get("Content-Encoding") != "" {
			t.Error("image/png ne doit pas être recompressée")
		}
	})

	t.Run("Content-Encoding déjà posé (proxy) → passthrough", func(t *testing.T) {
		pre := func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/css")
			w.Header().Set("Content-Encoding", "br")
			_, _ = w.Write([]byte("fake-brotli"))
		}
		rec := gzServe(t, pre, "/static/app.css", map[string]string{"Accept-Encoding": "gzip"})
		if got := rec.Header().Get("Content-Encoding"); got != "br" {
			t.Errorf("Content-Encoding=%q want br (inchangé)", got)
		}
		if rec.Body.String() != "fake-brotli" {
			t.Error("corps double-compressé")
		}
	})

	t.Run("requête Range → passthrough", func(t *testing.T) {
		rec := gzServe(t, jsHandler, "/static/app.js", map[string]string{
			"Accept-Encoding": "gzip", "Range": "bytes=0-100",
		})
		if rec.Header().Get("Content-Encoding") != "" {
			t.Error("une requête Range ne doit pas être compressée")
		}
	})

	t.Run("status non-200 propagé", func(t *testing.T) {
		nf := func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("not found"))
		}
		rec := gzServe(t, nf, "/static/missing.js", map[string]string{"Accept-Encoding": "gzip"})
		if rec.Code != http.StatusNotFound {
			t.Errorf("status=%d want 404", rec.Code)
		}
	})
}
