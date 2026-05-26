package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"sync"
	"time"
)

// chain wraps h with the given middlewares. The first middleware is outermost.
func chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// secureHeaders sets a conservative set of security headers on every response.
// CSP allows inline styles (needed for the single-file stylesheet) but locks
// scripts to same-origin only — no inline <script>, no eval.
func secureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), autoplay=(), payment=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		// frame-src allows YouTube-nocookie embeds for exercise demo videos.
		// We use youtube-nocookie.com (not youtube.com) so no tracking cookies
		// are dropped unless the user actually clicks play. Thumbnails come
		// from i.ytimg.com — needed so the <img-src> preview works.
		// Audit M-02 : style-src-elem strict, style-src-attr loose.
		//   - style-src-elem 'self' : <style> blocks et <link rel=stylesheet>
		//     UNIQUEMENT depuis notre origine. Plus moyen pour un XSS d'injecter
		//     un <style> qui exfiltre via background-image:url(attacker.com).
		//   - style-src-attr 'unsafe-inline' : autorise les style="..." sur les
		//     éléments. On en a ~380 dans le code (générés par templating Go-like
		//     dans app.js — tous via escapeHtml). Migration vers classes possible
		//     mais hors scope ; cette séparation donne déjà la moitié du bénéfice.
		//   - style-src reste comme fallback compatible vieux navigateurs.
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"style-src-elem 'self'; "+
				"style-src-attr 'unsafe-inline'; "+
				"img-src 'self' data: https://i.ytimg.com; "+
				"font-src 'self' data:; "+
				"connect-src 'self'; "+
				"frame-src https://www.youtube-nocookie.com; "+
				"frame-ancestors 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'; "+
				"object-src 'none'; "+
				// Audit L-04 : monitoring des violations CSP. Le navigateur POST
				// un rapport JSON dès qu'une ressource est bloquée par la policy.
				"report-uri /api/csp-report")
		if isHTTPS(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// accessLog logs method, path, status, duration — never body, headers, or cookies.
// Audit L-03 : /healthz est exclu (sinon, 2880 lignes/jour pour rien).
func accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		lrw := &logRW{ResponseWriter: w, status: 200}
		next.ServeHTTP(lrw, r)
		log.Printf("%s %s %s %d %s", clientIP(r), r.Method, r.URL.Path, lrw.status, time.Since(start))
	})
}

// Audit L-04 : handler des rapports CSP. Format browser standard :
//   { "csp-report": { "document-uri", "violated-directive", "blocked-uri", ... } }
// On log juste les champs utiles pour détection — pas de PII utilisateur dedans
// par construction (CSP ne capture pas le contenu, juste les ressources bloquées).
// Body capé à 8 KiB (rapport CSP est typiquement < 1 KiB).
func handleCSPReport(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8*1024)
	var payload struct {
		Report map[string]any `json:"csp-report"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if payload.Report != nil {
		log.Printf("CSP-VIOLATION ip=%s violated=%v blocked=%v doc=%v",
			clientIP(r),
			payload.Report["violated-directive"],
			payload.Report["blocked-uri"],
			payload.Report["document-uri"])
	}
	w.WriteHeader(http.StatusNoContent)
}

type logRW struct {
	http.ResponseWriter
	status int
}

func (l *logRW) WriteHeader(c int) {
	l.status = c
	l.ResponseWriter.WriteHeader(c)
}

// maxBody caps the request body to `max` bytes. Anything larger returns 413
// once the handler tries to read past the limit.
func maxBody(max int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, max)
			next.ServeHTTP(w, r)
		})
	}
}

// recoverPanic turns any panic inside a handler into a 500 without leaking
// internals to the client. Stack trace goes to the log only.
func recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic %s %s: %v\n%s", r.Method, r.URL.Path, rec, debug.Stack())
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// --- Rate limiting (fixed window, per-IP per-bucket) ---

type rlKey struct{ bucket, ip string }
type rlRec struct {
	count   int
	resetAt time.Time
}

var (
	rlMu  sync.Mutex
	rlMap = map[rlKey]*rlRec{}
)

func rateLimit(bucket string, max int, window time.Duration, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		k := rlKey{bucket, clientIP(r)}
		now := time.Now()
		rlMu.Lock()
		rec, ok := rlMap[k]
		if !ok || now.After(rec.resetAt) {
			rec = &rlRec{resetAt: now.Add(window)}
			rlMap[k] = rec
		}
		rec.count++
		over := rec.count > max
		remaining := max - rec.count
		if remaining < 0 {
			remaining = 0
		}
		wait := time.Until(rec.resetAt)
		rlMu.Unlock()

		w.Header().Set("X-RateLimit-Limit", strconv.Itoa(max))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
		if over {
			secs := int(wait.Seconds())
			if secs < 1 {
				secs = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			writeErr(w, http.StatusTooManyRequests, "trop de tentatives — réessaie plus tard")
			return
		}
		next(w, r)
	}
}

// rateLimitJanitor frees memory for IPs whose windows have long expired.
func rateLimitJanitor() {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		rlMu.Lock()
		for k, v := range rlMap {
			if now.After(v.resetAt) {
				delete(rlMap, k)
			}
		}
		rlMu.Unlock()
	}
}

/* =============================================================
 * Audit M-04 : rate limit persistant
 * =============================================================
 * La map rlMap est purement in-memory → un attaquant qui peut restart le
 * container reset les compteurs et reprend son bruteforce. On la snapshote
 * dans data/ratelimit.json toutes les 60s + au shutdown, et on la recharge
 * au boot. Coût : un write JSON petit (rarement >50 lignes en pratique).
 *
 * Format on-disk (versionné pour migration future) :
 *   { "v": 1, "ts": <unix>, "buckets": [ {bucket, ip, count, resetAt}, ... ] }
 *
 * Sécurité : ne stocke jamais les corps de requête, juste IP + bucket + count.
 * Si data/ratelimit.json est compromis, l'attaquant n'apprend rien d'utile.
 * ============================================================= */

func rateLimitFile() string { return filepath.Join(dataDir, "ratelimit.json") }

type rlSnapEntry struct {
	Bucket  string    `json:"bucket"`
	IP      string    `json:"ip"`
	Count   int       `json:"count"`
	ResetAt time.Time `json:"resetAt"`
}

type rlSnapshot struct {
	V       int           `json:"v"`
	TS      time.Time     `json:"ts"`
	Buckets []rlSnapEntry `json:"buckets"`
}

func loadRateLimit() {
	b, err := os.ReadFile(rateLimitFile())
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("ratelimit load: %v", err)
		}
		return
	}
	var snap rlSnapshot
	if err := json.Unmarshal(b, &snap); err != nil {
		log.Printf("ratelimit parse: %v", err)
		return
	}
	now := time.Now()
	rlMu.Lock()
	defer rlMu.Unlock()
	loaded := 0
	for _, e := range snap.Buckets {
		if e.ResetAt.Before(now) {
			continue // déjà expiré
		}
		rlMap[rlKey{bucket: e.Bucket, ip: e.IP}] = &rlRec{count: e.Count, resetAt: e.ResetAt}
		loaded++
	}
	log.Printf("ratelimit: loaded %d active buckets", loaded)
}

func saveRateLimit() {
	rlMu.Lock()
	snap := rlSnapshot{V: 1, TS: time.Now(), Buckets: make([]rlSnapEntry, 0, len(rlMap))}
	now := time.Now()
	for k, v := range rlMap {
		if v.resetAt.Before(now) {
			continue // ne snapshote pas les expirés
		}
		snap.Buckets = append(snap.Buckets, rlSnapEntry{
			Bucket: k.bucket, IP: k.ip, Count: v.count, ResetAt: v.resetAt,
		})
	}
	rlMu.Unlock()
	if err := writeJSONAtomic(rateLimitFile(), snap, 0o600); err != nil {
		log.Printf("ratelimit save: %v", err)
	}
}

// rateLimitSnapshotter tourne en goroutine en background : snapshot toutes
// les 60s. Idempotent : sûr d'appeler plusieurs fois.
func rateLimitSnapshotter() {
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for range t.C {
		saveRateLimit()
	}
}
