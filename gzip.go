package main

/*
gzip.go — compression à la volée des assets statiques (plan P2).

Pourquoi : en mode « HTTP direct » (docker-compose.yml sans reverse proxy),
rien ne compresse — app.js part en ~380 Ko au lieu de ~120 Ko gzip. Derrière
Caddy (docker-compose.tls.yml) la compression est déjà faite par le proxy ;
ce middleware détecte alors un contenu déjà encodé et ne fait rien.

Périmètre VOLONTAIREMENT limité aux ressources statiques (tout sauf /api/) :
compresser des réponses API qui mélangent secrets (token CSRF) et contenu
influencé par l'attaquant ouvrirait la porte aux attaques par oracle de
compression type BREACH. Les statiques sont identiques pour tous → zéro risque.

Implémentation stdlib pure (compress/gzip), pool de writers réutilisés,
décision différée au premier Write pour connaître le Content-Type réel posé
par http.FileServer. Les requêtes Range sont exclues (un octet-range sur un
corps recompressé n'aurait pas de sens).
*/

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

var gzPool = sync.Pool{
	New: func() any {
		// BestSpeed : les gros assets (app.js) se compressent déjà ~3× à ce
		// niveau ; le CPU économisé compte plus que les ~5 % de taille en plus
		// par rapport à DefaultCompression sur un petit serveur self-hosted.
		w, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed)
		return w
	},
}

// gzCompressibleTypes : types de contenu texte servis par l'app. Tout le
// reste (images bitmap, fonts woff2, déjà compressés) passe tel quel.
func gzCompressible(contentType string) bool {
	ct := contentType
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	switch strings.TrimSpace(ct) {
	case "text/html", "text/css", "text/plain", "text/javascript",
		"application/javascript", "application/json",
		"application/manifest+json", "image/svg+xml":
		return true
	}
	return false
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz      *gzip.Writer
	decided bool // premier Write/WriteHeader passé ?
	active  bool // compression en cours ?
}

// decide choisit (une seule fois) de compresser ou non, en fonction des
// headers posés par le handler interne. Doit être appelé avant d'émettre le
// status : une fois compressé, Content-Length n'est plus valable.
func (w *gzipResponseWriter) decide() {
	if w.decided {
		return
	}
	w.decided = true
	h := w.Header()
	if h.Get("Content-Encoding") != "" || !gzCompressible(h.Get("Content-Type")) {
		return // déjà encodé (proxy, pré-compressé) ou non compressible
	}
	h.Del("Content-Length") // la taille change — chunked encoding prendra le relais
	h.Set("Content-Encoding", "gzip")
	gz := gzPool.Get().(*gzip.Writer)
	gz.Reset(w.ResponseWriter)
	w.gz = gz
	w.active = true
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	w.decide()
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	if !w.decided {
		// Mimique net/http : si le handler n'a pas posé de Content-Type,
		// il faut le sniffer AVANT de compresser (sinon on sniffe du gzip).
		if w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", http.DetectContentType(b))
		}
		w.decide()
	}
	if w.active {
		return w.gz.Write(b)
	}
	return w.ResponseWriter.Write(b)
}

func (w *gzipResponseWriter) close() {
	if w.active {
		_ = w.gz.Close()
		gzPool.Put(w.gz)
		w.gz = nil
		w.active = false
	}
}

// gzipStatic compresse les réponses statiques quand le client l'accepte.
// Les chemins /api/ sont exclus (voir en-tête de fichier : BREACH).
func gzipStatic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") ||
			!strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			r.Header.Get("Range") != "" {
			next.ServeHTTP(w, r)
			return
		}
		// Le cache (navigateur ou proxy) doit séparer les variantes.
		w.Header().Add("Vary", "Accept-Encoding")
		gw := &gzipResponseWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}
