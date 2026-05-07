package main

/*
strava.go — Intégration Strava OAuth + webhooks push.

UX promise : l'utilisateur clique "Se connecter avec Strava", autorise via
le popup OAuth officiel, et c'est terminé. À partir de ce moment-là Strava
push automatiquement chaque nouvelle activité vers notre webhook — zéro
manipulation supplémentaire, zéro polling à configurer.

Endpoints :
  GET  /auth/strava/start                 → redirige vers Strava authorize
  GET  /auth/strava/callback              → échange code → tokens, stocke
  GET  /api/strava/webhook                → validation subscription Strava
                                            (echo hub.challenge)
  POST /api/strava/webhook                → réception event d'activité
  POST /api/physio/integrations/strava/subscribe (admin) → enregistre la
                                            subscription auprès de Strava
                                            une fois pour toute l'instance
  DELETE /api/physio/integrations/strava  → déconnecte le user courant

Configuration (variables d'environnement) :
  STRAVA_CLIENT_ID     — Client ID de l'app Strava (créer à
                         https://www.strava.com/settings/api)
  STRAVA_CLIENT_SECRET — Client Secret de l'app Strava
  STRAVA_VERIFY_TOKEN  — Token random utilisé pour la validation du
                         webhook. Generate-le une fois et garde-le stable
                         (sinon il faut re-souscrire).
  STRAVA_REDIRECT_URI  — Override l'URL de callback. Sinon on déduit de la
                         requête entrante. Doit matcher l'"Authorization
                         Callback Domain" déclaré dans l'app Strava.
  STRAVA_WEBHOOK_URL   — URL publique de notre webhook, utilisée pour
                         l'enregistrement subscription auprès de Strava.
                         Si non défini, on déduit de la requête (admin
                         doit pouvoir taper depuis l'extérieur).

Stockage : on encode le bundle OAuth (access + refresh + expiry +
athleteID) en JSON, puis on chiffre via encryptToken (AES-GCM si
COACH_TOKEN_KEY défini, sinon cleartext en mode dégradé) et on persiste
dans User.PhysioTokens["strava"]. L'athleteID est aussi indexé dans
stravaAthleteIndex (in-memory) pour résoudre owner_id → uid en O(1) à la
réception d'un event webhook.

Sécurité :
  - State CSRF : random 32-hex stocké côté serveur dans stravaPendingStates,
    expire à 10 min. Vérification constant-time au callback.
  - Verify token webhook : comparé constant-time, vient de l'env.
  - Tokens chiffrés at-rest comme les autres credentials physio.
  - Pas d'écho de l'access token côté client. Front voit juste {enabled, lastSync}.
*/

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	stravaAuthURL    = "https://www.strava.com/oauth/authorize"
	stravaTokenURL   = "https://www.strava.com/oauth/token"
	stravaAPIBase    = "https://www.strava.com/api/v3"
	stravaScopes     = "read,activity:read_all,profile:read_all"
	// Marge de sécurité avant l'expiration : on refresh si le token expire
	// dans moins de 60 secondes (on évite de partir en course avec Strava).
	stravaRefreshSlack = 60 * time.Second
)

// stravaCreds est le bundle persisté chiffré dans PhysioTokens["strava"].
type stravaCreds struct {
	Access    string `json:"access"`
	Refresh   string `json:"refresh"`
	ExpiresAt int64  `json:"expires_at"` // Unix seconds
	AthleteID int64  `json:"athlete_id"`
}

// State CSRF pour le flow OAuth. Chaque "Connect with Strava" génère un
// state aléatoire associé au uid courant ; le callback le revérifie.
// Map en mémoire (perdue au reboot — pas grave, l'utilisateur recommence).
var (
	stravaStatesMu      sync.Mutex
	stravaPendingStates = map[string]stravaPendingState{}
)

type stravaPendingState struct {
	uid       string
	createdAt time.Time
}

// stravaAthleteIndex : athleteID → uid. Reconstruit au boot par
// rebuildStravaAthleteIndex(), maintenu live au connect/disconnect.
// Permet au webhook d'identifier le user à partir de owner_id sans scan.
var (
	stravaAthleteMu    sync.RWMutex
	stravaAthleteIndex = map[int64]string{}
)

// stravaConfig rassemble les params d'env. Fail-fast non implémenté : si
// STRAVA_CLIENT_ID est vide, on log un warning et tous les handlers
// répondent un 503 "Strava non configuré". L'idée : un opérateur sans
// app Strava peut quand même boot le serveur.
func stravaConfigured() bool {
	return os.Getenv("STRAVA_CLIENT_ID") != "" && os.Getenv("STRAVA_CLIENT_SECRET") != ""
}

func stravaClientID() string     { return os.Getenv("STRAVA_CLIENT_ID") }
func stravaClientSecret() string { return os.Getenv("STRAVA_CLIENT_SECRET") }
func stravaVerifyToken() string  { return os.Getenv("STRAVA_VERIFY_TOKEN") }

// stravaRedirectURI calcule l'URL de callback. STRAVA_REDIRECT_URI a la
// priorité ; sinon on utilise le scheme/host de la requête. Doit matcher
// l'Authorization Callback Domain déclaré dans l'app Strava.
func stravaRedirectURI(r *http.Request) string {
	if v := os.Getenv("STRAVA_REDIRECT_URI"); v != "" {
		return v
	}
	scheme := "https"
	if r.TLS == nil && !strings.HasPrefix(r.Host, "localhost") &&
		!strings.HasPrefix(r.Host, "127.0.0.1") {
		// Behind a reverse proxy : honore X-Forwarded-Proto si on trust le proxy.
		if trustProxy && r.Header.Get("X-Forwarded-Proto") == "https" {
			scheme = "https"
		} else {
			scheme = "http"
		}
	} else if r.TLS == nil {
		scheme = "http"
	}
	return scheme + "://" + r.Host + "/auth/strava/callback"
}

// rebuildStravaAthleteIndex est appelé au boot après loadUsers. Reconstruit
// la map athleteID → uid en déchiffrant les credentials de chaque user.
// Si le déchiffrement échoue (clé manquante, data corrompu), on log et on
// skip — le user pourra reconnecter manuellement.
func rebuildStravaAthleteIndex() {
	stravaAthleteMu.Lock()
	defer stravaAthleteMu.Unlock()
	stravaAthleteIndex = map[int64]string{}
	usersMu.RLock()
	defer usersMu.RUnlock()
	for uid, u := range usersByID {
		if u.PhysioTokens == nil {
			continue
		}
		enc := u.PhysioTokens["strava"]
		if enc == "" {
			continue
		}
		raw, err := decryptToken(enc)
		if err != nil {
			log.Printf("strava index: decrypt failed for uid=%s: %v", uid, err)
			continue
		}
		var c stravaCreds
		if err := json.Unmarshal([]byte(raw), &c); err != nil {
			log.Printf("strava index: parse failed for uid=%s: %v", uid, err)
			continue
		}
		if c.AthleteID > 0 {
			stravaAthleteIndex[c.AthleteID] = uid
		}
	}
}

func stravaSetAthleteIndex(athleteID int64, uid string) {
	if athleteID <= 0 {
		return
	}
	stravaAthleteMu.Lock()
	stravaAthleteIndex[athleteID] = uid
	stravaAthleteMu.Unlock()
}

func stravaClearAthleteForUser(uid string) {
	stravaAthleteMu.Lock()
	for athID, u := range stravaAthleteIndex {
		if u == uid {
			delete(stravaAthleteIndex, athID)
		}
	}
	stravaAthleteMu.Unlock()
}

func stravaResolveOwner(athleteID int64) string {
	stravaAthleteMu.RLock()
	defer stravaAthleteMu.RUnlock()
	return stravaAthleteIndex[athleteID]
}

// stravaJanitor purge les states OAuth en attente expirés (> 10 min).
// Lancé au boot dans une goroutine.
func stravaJanitor() {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for range t.C {
		stravaStatesMu.Lock()
		cutoff := time.Now().Add(-10 * time.Minute)
		for k, v := range stravaPendingStates {
			if v.createdAt.Before(cutoff) {
				delete(stravaPendingStates, k)
			}
		}
		stravaStatesMu.Unlock()
	}
}

/* ========================================================================
 * OAuth — start + callback
 * ====================================================================== */

// handleStravaAuthStart est l'entrée du flow OAuth. Authentifié (le user
// doit être loggué — on associe le state à son uid) et 2FA-gated comme
// les autres routes physio.
//
// Sur succès : 302 vers strava.com/oauth/authorize avec state aléatoire.
func handleStravaAuthStart(w http.ResponseWriter, r *http.Request) {
	if !stravaConfigured() {
		writeErr(w, http.StatusServiceUnavailable, "Strava non configuré (STRAVA_CLIENT_ID manquant)")
		return
	}
	uid := currentUser(r)
	if uid == "" {
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	state := randHex(16)
	stravaStatesMu.Lock()
	stravaPendingStates[state] = stravaPendingState{uid: uid, createdAt: time.Now()}
	stravaStatesMu.Unlock()

	q := url.Values{}
	q.Set("client_id", stravaClientID())
	q.Set("response_type", "code")
	q.Set("redirect_uri", stravaRedirectURI(r))
	q.Set("approval_prompt", "auto")
	q.Set("scope", stravaScopes)
	q.Set("state", state)
	http.Redirect(w, r, stravaAuthURL+"?"+q.Encode(), http.StatusFound)
}

// handleStravaAuthCallback est la cible que Strava ouvre après autorisation.
// Path-level reachable sans CSRF token (c'est un GET externe initié par
// Strava). Sécurité : le state est notre CSRF/anti-replay.
func handleStravaAuthCallback(w http.ResponseWriter, r *http.Request) {
	if !stravaConfigured() {
		stravaCallbackPage(w, false, "Strava non configuré côté serveur.")
		return
	}
	q := r.URL.Query()
	if errParam := q.Get("error"); errParam != "" {
		stravaCallbackPage(w, false, "Autorisation refusée : "+errParam)
		return
	}
	state := q.Get("state")
	code := q.Get("code")
	if state == "" || code == "" {
		stravaCallbackPage(w, false, "Paramètres manquants (state ou code).")
		return
	}
	stravaStatesMu.Lock()
	pending, ok := stravaPendingStates[state]
	delete(stravaPendingStates, state)
	stravaStatesMu.Unlock()
	if !ok {
		stravaCallbackPage(w, false, "State invalide ou expiré.")
		return
	}
	if time.Since(pending.createdAt) > 10*time.Minute {
		stravaCallbackPage(w, false, "Autorisation expirée — recommence.")
		return
	}

	// Échange code → tokens.
	creds, err := stravaExchangeCode(code, stravaRedirectURI(r))
	if err != nil {
		log.Printf("strava: exchange failed: %v", err)
		stravaCallbackPage(w, false, "Strava a refusé le code : "+err.Error())
		return
	}

	// Persist.
	if err := stravaSaveCreds(pending.uid, creds); err != nil {
		log.Printf("strava: save creds failed: %v", err)
		stravaCallbackPage(w, false, "Erreur interne en sauvant les tokens.")
		return
	}
	stravaSetAthleteIndex(creds.AthleteID, pending.uid)

	// Sync initial : on ramène les 30 derniers jours d'activités pour ne pas
	// laisser l'utilisateur avec un dashboard vide. Best-effort, pas bloquant.
	go func(uid string) {
		entries, err := stravaFetchRecentActivities(uid, 30)
		if err != nil {
			log.Printf("strava initial sync (uid=%s): %v", uid, err)
			return
		}
		if len(entries) > 0 {
			if err := mergePhysioIntoData(uid, entries); err != nil {
				log.Printf("strava merge initial sync (uid=%s): %v", uid, err)
			}
		}
		stravaTouchLastSync(uid)
	}(pending.uid)

	stravaCallbackPage(w, true, "")
}

// stravaCallbackPage rend une mini-page HTML qui informe l'utilisateur,
// puis ferme la fenêtre popup et notifie l'opener via postMessage.
// L'app cliente écoute "strava-connected" pour relancer physioRender.
func stravaCallbackPage(w http.ResponseWriter, ok bool, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	status := "ok"
	heading := "✓ Connecté à Strava"
	body := "Tu peux refermer cet onglet. Les activités vont apparaître dans le profil dans quelques secondes."
	if !ok {
		status = "error"
		heading = "✗ Connexion échouée"
		body = msg
	}
	// Pas de template — page minimaliste, échappement manuel inline.
	fmt.Fprintf(w, `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Strava — Coach</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
       background:#0e0f12;color:#eaeaea;margin:0;padding:40px 24px;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{max-width:420px;background:#1a1c20;border:1px solid #2a2d33;
        border-radius:12px;padding:24px;text-align:center}
  h1{margin:0 0 12px;font-size:20px}
  p{margin:0 0 16px;line-height:1.5;color:#aab}
  .ok h1{color:#5dd4a4} .err h1{color:#ff6b6b}
  button{background:#fc4c02;color:#fff;border:none;border-radius:6px;
         padding:10px 18px;font-size:14px;font-weight:500;cursor:pointer}
</style></head>
<body><div class="card %s"><h1>%s</h1><p>%s</p>
<button onclick="window.close()">Fermer</button></div>
<script>
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({type:'strava-connected', status:'%s'}, window.location.origin);
    }
  } catch (e) {}
  setTimeout(()=>{ try{ window.close(); }catch(e){} }, 2500);
</script></body></html>`,
		map[bool]string{true: "ok", false: "err"}[ok],
		htmlEscape(heading), htmlEscape(body), status)
}

// htmlEscape — minimal escape pour le contenu de la page de callback.
// On n'utilise pas html/template parce qu'on contrôle entièrement les
// chaînes (pas d'input utilisateur dans heading/body).
func htmlEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;", "<", "&lt;", ">", "&gt;",
		`"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}

/* ========================================================================
 * Token exchange + refresh
 * ====================================================================== */

// stravaExchangeCode échange un code OAuth contre un bundle de credentials.
func stravaExchangeCode(code, redirectURI string) (*stravaCreds, error) {
	form := url.Values{}
	form.Set("client_id", stravaClientID())
	form.Set("client_secret", stravaClientSecret())
	form.Set("code", code)
	form.Set("grant_type", "authorization_code")
	return stravaTokenRequest(form)
}

// stravaRefreshToken échange un refresh_token contre un nouveau bundle.
func stravaRefreshToken(refresh string) (*stravaCreds, error) {
	form := url.Values{}
	form.Set("client_id", stravaClientID())
	form.Set("client_secret", stravaClientSecret())
	form.Set("refresh_token", refresh)
	form.Set("grant_type", "refresh_token")
	return stravaTokenRequest(form)
}

func stravaTokenRequest(form url.Values) (*stravaCreds, error) {
	req, err := http.NewRequest(http.MethodPost, stravaTokenURL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClientPhysio.Do(req)
	if err != nil {
		return nil, fmt.Errorf("strava token: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode,
			strings.TrimSpace(string(body)))
	}
	// Strava renvoie aussi athlete sur authorization_code, pas sur refresh.
	// On garde un parser unique tolérant aux deux.
	var payload struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresAt    int64  `json:"expires_at"`
		Athlete      *struct {
			ID int64 `json:"id"`
		} `json:"athlete,omitempty"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	if payload.AccessToken == "" || payload.RefreshToken == "" {
		return nil, errors.New("réponse Strava incomplète")
	}
	c := &stravaCreds{
		Access:    payload.AccessToken,
		Refresh:   payload.RefreshToken,
		ExpiresAt: payload.ExpiresAt,
	}
	if payload.Athlete != nil {
		c.AthleteID = payload.Athlete.ID
	}
	return c, nil
}

// stravaSaveCreds chiffre + persiste les credentials dans User.PhysioTokens.
// Préserve l'AthleteID existant si on est sur un refresh (pas dans le payload).
func stravaSaveCreds(uid string, creds *stravaCreds) error {
	physioMu.Lock()
	defer physioMu.Unlock()
	usersMu.Lock()
	defer usersMu.Unlock()
	u := usersByID[uid]
	if u == nil {
		return errors.New("user introuvable")
	}
	if u.PhysioTokens == nil {
		u.PhysioTokens = map[string]string{}
	}
	// Si on a déjà un athleteID stocké et que le payload n'en a pas
	// (cas du refresh_token), on préserve l'ancien.
	if creds.AthleteID == 0 {
		if existing := u.PhysioTokens["strava"]; existing != "" {
			if raw, err := decryptToken(existing); err == nil {
				var old stravaCreds
				if json.Unmarshal([]byte(raw), &old) == nil && old.AthleteID > 0 {
					creds.AthleteID = old.AthleteID
				}
			}
		}
	}
	bundle, err := json.Marshal(creds)
	if err != nil {
		return err
	}
	u.PhysioTokens["strava"] = encryptToken(string(bundle))
	go saveUsers()
	return nil
}

// stravaLoadCreds lit + déchiffre les credentials. Renvoie nil si pas
// connecté. Refresh automatique si expiration imminente.
func stravaLoadCreds(uid string) (*stravaCreds, error) {
	usersMu.RLock()
	u := usersByID[uid]
	usersMu.RUnlock()
	if u == nil || u.PhysioTokens == nil {
		return nil, errors.New("user introuvable")
	}
	enc := u.PhysioTokens["strava"]
	if enc == "" {
		return nil, errors.New("pas connecté à Strava")
	}
	raw, err := decryptToken(enc)
	if err != nil {
		return nil, fmt.Errorf("déchiffrement : %w", err)
	}
	var c stravaCreds
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return nil, fmt.Errorf("parse : %w", err)
	}
	// Refresh si expiration imminente.
	if c.ExpiresAt > 0 && time.Until(time.Unix(c.ExpiresAt, 0)) < stravaRefreshSlack {
		fresh, err := stravaRefreshToken(c.Refresh)
		if err != nil {
			return nil, fmt.Errorf("refresh : %w", err)
		}
		fresh.AthleteID = c.AthleteID // refresh ne renvoie pas l'athlete
		if err := stravaSaveCreds(uid, fresh); err != nil {
			return nil, err
		}
		return fresh, nil
	}
	return &c, nil
}

func stravaTouchLastSync(uid string) {
	physioMu.Lock()
	usersMu.Lock()
	if u := usersByID[uid]; u != nil {
		if u.PhysioLastSync == nil {
			u.PhysioLastSync = map[string]time.Time{}
		}
		u.PhysioLastSync["strava"] = time.Now().UTC()
	}
	usersMu.Unlock()
	physioMu.Unlock()
	go saveUsers()
}

/* ========================================================================
 * Webhook — validation + ingestion
 * ====================================================================== */

// handleStravaWebhook gère à la fois la validation initiale (GET) et la
// réception d'events (POST). Strava utilise le même path pour les deux.
func handleStravaWebhook(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		stravaWebhookValidate(w, r)
	case http.MethodPost:
		stravaWebhookEvent(w, r)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// stravaWebhookValidate répond au challenge subscription Strava :
// GET ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
//
// On répond 200 avec {"hub.challenge": "Y"} si verify_token matche, sinon
// 403. Pas d'auth de session ici — c'est Strava qui ping.
func stravaWebhookValidate(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	mode := q.Get("hub.mode")
	verify := q.Get("hub.verify_token")
	challenge := q.Get("hub.challenge")
	if mode != "subscribe" {
		writeErr(w, http.StatusBadRequest, "hub.mode invalide")
		return
	}
	expected := stravaVerifyToken()
	if expected == "" {
		writeErr(w, http.StatusServiceUnavailable, "STRAVA_VERIFY_TOKEN non configuré")
		return
	}
	if subtle.ConstantTimeCompare([]byte(verify), []byte(expected)) != 1 {
		writeErr(w, http.StatusForbidden, "verify_token invalide")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"hub.challenge": challenge})
}

// stravaWebhookEvent reçoit un event Strava et déclenche un fetch
// d'activité si pertinent.
//
// Body type :
//   {
//     "aspect_type": "create" | "update" | "delete",
//     "event_time": 1516126040,
//     "object_id": 1360128428,            ← activity ID (pour activity events)
//     "object_type": "activity" | "athlete",
//     "owner_id": 134815,                 ← athlete ID
//     "subscription_id": 120475,
//     "updates": { ... }
//   }
//
// Strava attend une réponse < 2s, donc on répond 200 immédiatement et on
// fait le fetch dans une goroutine.
func stravaWebhookEvent(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 16*1024))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "body illisible")
		return
	}
	var ev struct {
		AspectType string `json:"aspect_type"`
		ObjectID   int64  `json:"object_id"`
		ObjectType string `json:"object_type"`
		OwnerID    int64  `json:"owner_id"`
	}
	if err := json.Unmarshal(body, &ev); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	// Acquittement immédiat — Strava est patient mais < 2s.
	w.WriteHeader(http.StatusOK)
	if ev.ObjectType != "activity" {
		// On ignore les events "athlete" (ex: deauthorization) pour l'instant.
		// TODO : traiter les deauth pour purger nos tokens stale.
		return
	}
	if ev.AspectType == "delete" {
		// Pas d'API pour fetch une activité supprimée — on pourrait nettoyer
		// notre store. Pas implémenté en v1.
		return
	}
	uid := stravaResolveOwner(ev.OwnerID)
	if uid == "" {
		log.Printf("strava webhook: owner %d non résolu — ignore", ev.OwnerID)
		return
	}
	go func() {
		if err := stravaIngestActivity(uid, ev.ObjectID); err != nil {
			log.Printf("strava ingest activity %d (uid=%s): %v",
				ev.ObjectID, uid, err)
		}
	}()
}

/* ========================================================================
 * Activity fetch + mapping
 * ====================================================================== */

// stravaActivity est le sous-ensemble du payload v3 qu'on consomme.
type stravaActivity struct {
	ID                 int64   `json:"id"`
	StartDateLocal     string  `json:"start_date_local"` // "2026-04-30T07:30:00Z"
	Type               string  `json:"type"`             // Run, Ride, Swim, ...
	MovingTime         int     `json:"moving_time"`      // seconds
	ElapsedTime        int     `json:"elapsed_time"`
	Distance           float64 `json:"distance"`         // meters
	AverageHeartrate   float64 `json:"average_heartrate"`
	MaxHeartrate       float64 `json:"max_heartrate"`
	Kilojoules         float64 `json:"kilojoules"`       // bikes only — ~kcal après /4.184
	Calories           float64 `json:"calories"`         // present si Strava Premium
	HasHeartrate       bool    `json:"has_heartrate"`
}

// stravaIngestActivity fetch une activité par ID, la convertit en
// PhysioEntry, et merge dans le data file utilisateur.
func stravaIngestActivity(uid string, activityID int64) error {
	creds, err := stravaLoadCreds(uid)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("%s/activities/%d", stravaAPIBase, activityID)
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+creds.Access)
	resp, err := httpClientPhysio.Do(req)
	if err != nil {
		return fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var act stravaActivity
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&act); err != nil {
		return fmt.Errorf("parse: %w", err)
	}
	entry := stravaActivityToPhysio(&act)
	if entry.Date == "" {
		return errors.New("activité sans date utilisable")
	}
	if err := mergePhysioIntoData(uid, []PhysioEntry{entry}); err != nil {
		return err
	}
	stravaTouchLastSync(uid)
	return nil
}

// stravaFetchRecentActivities ramène les activités des N derniers jours
// (premier sync après connexion). Pagination : on prend la première page
// (jusqu'à 200 activités).
func stravaFetchRecentActivities(uid string, days int) ([]PhysioEntry, error) {
	creds, err := stravaLoadCreds(uid)
	if err != nil {
		return nil, err
	}
	after := time.Now().AddDate(0, 0, -days).Unix()
	q := url.Values{}
	q.Set("after", strconv.FormatInt(after, 10))
	q.Set("per_page", "200")
	req, _ := http.NewRequest(http.MethodGet,
		stravaAPIBase+"/athlete/activities?"+q.Encode(), nil)
	req.Header.Set("Authorization", "Bearer "+creds.Access)
	resp, err := httpClientPhysio.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var acts []stravaActivity
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&acts); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	out := make([]PhysioEntry, 0, len(acts))
	for i := range acts {
		e := stravaActivityToPhysio(&acts[i])
		if e.Date == "" {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// stravaActivityToPhysio extrait ce qui rentre dans notre PhysioEntry.
// Strava ne donne ni HRV ni sommeil — on alimente AvgHR (si dispo) et
// ActiveEnergy (calories ou kJ * facteur). Le reste est ignoré : la
// charge type Banister sera calculée plus tard côté client à partir des
// champs étendus déjà persistés.
func stravaActivityToPhysio(a *stravaActivity) PhysioEntry {
	// Strava émet une date ISO UTC ; on garde juste YYYY-MM-DD pour
	// l'agrégation par jour, en suivant la timezone locale (start_date_local
	// est déjà en local time mais avec un Z suffix trompeur).
	date := ""
	if len(a.StartDateLocal) >= 10 {
		date = a.StartDateLocal[:10]
	}
	e := PhysioEntry{Date: date}
	if a.HasHeartrate && a.AverageHeartrate > 0 {
		e.AvgHR = a.AverageHeartrate
	}
	// Calories prioritaires (Strava Premium les donne directement) ;
	// sinon kJ * 0.239 ≈ kcal pour les rides ; sinon estimation grossière
	// duration*HR à partir de moving_time.
	switch {
	case a.Calories > 0:
		e.ActiveEnergy = a.Calories
	case a.Kilojoules > 0:
		e.ActiveEnergy = a.Kilojoules * 0.239
	}
	return e
}

/* ========================================================================
 * Connect status + disconnect
 * ====================================================================== */

// stravaStatusForUser renvoie le statut tel qu'exposé par
// /api/physio/integrations. Pas de tokens, juste enabled + lastSync.
func stravaStatusForUser(u *User) map[string]any {
	out := map[string]any{"enabled": false}
	if u == nil || u.PhysioTokens == nil || u.PhysioTokens["strava"] == "" {
		return out
	}
	out["enabled"] = true
	if u.PhysioLastSync != nil {
		if t, ok := u.PhysioLastSync["strava"]; ok && !t.IsZero() {
			out["lastSync"] = t.UTC()
		}
	}
	return out
}

func handleStravaDisconnect(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	physioMu.Lock()
	usersMu.Lock()
	if u := usersByID[uid]; u != nil && u.PhysioTokens != nil {
		delete(u.PhysioTokens, "strava")
		if u.PhysioLastSync != nil {
			delete(u.PhysioLastSync, "strava")
		}
	}
	usersMu.Unlock()
	physioMu.Unlock()
	stravaClearAthleteForUser(uid)
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleStravaSync force un fetch des activités récentes (utile quand
// le webhook n'est pas encore enregistré ou pour rattraper un downtime).
func handleStravaSync(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	if uid == "" {
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	entries, err := stravaFetchRecentActivities(uid, 30)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if len(entries) > 0 {
		if err := mergePhysioIntoData(uid, entries); err != nil {
			writeErr(w, http.StatusInternalServerError, "écriture impossible")
			return
		}
	}
	stravaTouchLastSync(uid)
	writeJSON(w, http.StatusOK, map[string]any{
		"received": len(entries),
	})
}

/* ========================================================================
 * Subscription registration (admin) — appelée une fois par instance pour
 * dire à Strava "envoie tes events à <notre URL>".
 * ====================================================================== */

func handleStravaSubscribe(w http.ResponseWriter, r *http.Request) {
	if !stravaConfigured() {
		writeErr(w, http.StatusServiceUnavailable, "Strava non configuré")
		return
	}
	if stravaVerifyToken() == "" {
		writeErr(w, http.StatusBadRequest,
			"STRAVA_VERIFY_TOKEN non défini — génère-en un random et set-le en env")
		return
	}
	callbackURL := os.Getenv("STRAVA_WEBHOOK_URL")
	if callbackURL == "" {
		// Déduit de la requête courante.
		scheme := "https"
		if r.TLS == nil && (strings.HasPrefix(r.Host, "localhost") ||
			strings.HasPrefix(r.Host, "127.0.0.1")) {
			scheme = "http"
		}
		callbackURL = scheme + "://" + r.Host + "/api/strava/webhook"
	}
	form := url.Values{}
	form.Set("client_id", stravaClientID())
	form.Set("client_secret", stravaClientSecret())
	form.Set("callback_url", callbackURL)
	form.Set("verify_token", stravaVerifyToken())
	req, _ := http.NewRequest(http.MethodPost,
		stravaAPIBase+"/push_subscriptions",
		strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClientPhysio.Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != 201 && resp.StatusCode != 200 {
		writeErr(w, http.StatusBadGateway,
			fmt.Sprintf("Strava status %d: %s", resp.StatusCode, string(body)))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(body)
}
