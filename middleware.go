package main

import (
	"log"
	"net/http"
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
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: https://i.ytimg.com; "+
				"font-src 'self' data:; "+
				"connect-src 'self'; "+
				"frame-src https://www.youtube-nocookie.com; "+
				"frame-ancestors 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'; "+
				"object-src 'none'")
		if isHTTPS(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// accessLog logs method, path, status, duration — never body, headers, or cookies.
func accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lrw := &logRW{ResponseWriter: w, status: 200}
		next.ServeHTTP(lrw, r)
		log.Printf("%s %s %s %d %s", clientIP(r), r.Method, r.URL.Path, lrw.status, time.Since(start))
	})
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
