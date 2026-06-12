package main

/*
physio.go — Intégrations API physiologiques (HRV / sommeil / FC repos).

Fournisseur supporté en v1 :
  * Oura Ring (api.ouraring.com/v2) via personal access token

Endpoints exposés (voir main.go pour le wiring) :
  GET    /api/physio/integrations               → liste enabled (sans tokens)
  POST   /api/physio/integrations/oura          → set token + valide
  DELETE /api/physio/integrations/oura          → retire token
  POST   /api/physio/sync                       → fetch toutes les intégrations
  POST   /api/physio/integrations/webhook       → génère/rotate le secret webhook
  POST   /api/physio/webhook/{uid}/{secret}     → endpoint push (sans auth, validé par secret)

Sécurité :
  * Tokens stockés dans User.PhysioTokens (users.json, 0o600).
  * Webhook secret unique par user, valide path-level (constant-time compare).
  * Outbound calls Go → Oura : pas d'exposition de l'IP utilisateur.
  * Timeouts 10s par requête, retry 0 (pas de backoff sophistiqué pour v1).
  * Rate-limited côté serveur via le rate limiter existant pour /api/physio/*.
*/

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const ouraBase = "https://api.ouraring.com/v2"

// httpClientPhysio est partagé entre tous les appels outbound — réutilise
// les connexions et impose un timeout total de 10s.
var httpClientPhysio = &http.Client{
	Timeout: 10 * time.Second,
}

// physioMu sérialise les modifications du User.PhysioTokens / PhysioLastSync
// pour éviter les writes concurrents qui pourraient corrompre la map.
var physioMu sync.Mutex

// PhysioEntry est le format unifié interne après parsing fournisseur-spécifique.
// Identique au shape stocké côté client dans S.body.physio.
//
// Les champs core (HRV, Sleep, RHR) alimentent le composite readiness et la
// charge Banister. Les champs étendus (ActiveEnergy, VO2Max, Steps, AvgHR,
// BodyMass, BodyFat) sont stockés pour usage futur (calcul de charge plus
// fin, dashboard détaillé) — actuellement seulement persistés sans calcul.
type PhysioEntry struct {
	Date string `json:"date"` // ISO-8601 YYYY-MM-DD

	// Core — utilisés par les modèles statistiques :
	HRV   float64 `json:"hrv,omitempty"`   // ms (RMSSD ou similar)
	Sleep float64 `json:"sleep,omitempty"` // heures totales
	RHR   float64 `json:"rhr,omitempty"`   // bpm (resting HR)

	// Étendus — captés pour analyse future, pas encore consommés par les modèles :
	ActiveEnergy float64 `json:"activeEnergy,omitempty"` // kcal brûlées en activité
	VO2Max       float64 `json:"vo2Max,omitempty"`       // ml/kg/min
	Steps        float64 `json:"steps,omitempty"`        // count
	AvgHR        float64 `json:"avgHR,omitempty"`        // bpm moyenne 24h
	BodyMassKg   float64 `json:"bodyMassKg,omitempty"`   // kg
	BodyFatPct   float64 `json:"bodyFatPct,omitempty"`   // 0-100
	RespRate     float64 `json:"respRate,omitempty"`     // breaths/min nuit
	MindfulMin   float64 `json:"mindfulMin,omitempty"`   // minutes méditation
}

// fetchOuraSleep récupère les périodes de sommeil sur la fenêtre [start, end].
// Endpoint v2 : GET /v2/usercollection/sleep?start_date=&end_date=
// Retourne le RMSSD moyen, durée de sommeil, et FC moyenne nuit.
func fetchOuraSleep(token, startDate, endDate string) ([]PhysioEntry, error) {
	if token == "" {
		return nil, errors.New("token vide")
	}
	url := fmt.Sprintf("%s/usercollection/sleep?start_date=%s&end_date=%s",
		ouraBase, startDate, endDate)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClientPhysio.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oura: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 {
		return nil, errors.New("token Oura invalide ou expiré")
	}
	if resp.StatusCode == 429 {
		return nil, errors.New("Oura rate limit atteint, réessaie plus tard")
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("oura status %d: %s", resp.StatusCode, string(body))
	}
	var payload struct {
		Data []struct {
			Day                string  `json:"day"`
			AverageHRV         float64 `json:"average_hrv"`
			TotalSleepDuration float64 `json:"total_sleep_duration"` // seconds
			AverageHeartRate   float64 `json:"average_heart_rate"`
			LowestHeartRate    float64 `json:"lowest_heart_rate"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("oura parse: %w", err)
	}
	// Agrégation par jour : un user peut avoir plusieurs sleep periods
	// (sieste + nuit). HRV = moyenne pondérée par durée (Audit F3), Sleep =
	// somme des durées, RHR = le plus bas observé (plus représentatif du
	// repos profond).
	type sleepAgg struct {
		hrvWeighted float64 // Σ(hrv · durée)
		hrvWeight   float64 // Σ(durée des sessions avec hrv)
		hrvSimple   float64 // Σ(hrv) — fallback si toutes les durées sont nulles
		hrvN        float64
		sleepHours  float64
		rhrMin      float64
	}
	byDay := map[string]*sleepAgg{}
	for _, s := range payload.Data {
		if s.Day == "" {
			continue
		}
		a := byDay[s.Day]
		if a == nil {
			a = &sleepAgg{}
			byDay[s.Day] = a
		}
		if s.AverageHRV > 0 {
			// Pondération par durée de la session : une nuit complète pèse plus
			// qu'une sieste. Si la durée est inconnue (0), on alimente quand même
			// le fallback moyenne simple pour ne pas perdre la mesure.
			if s.TotalSleepDuration > 0 {
				a.hrvWeighted += s.AverageHRV * s.TotalSleepDuration
				a.hrvWeight += s.TotalSleepDuration
			}
			a.hrvSimple += s.AverageHRV
			a.hrvN++
		}
		if s.TotalSleepDuration > 0 {
			a.sleepHours += s.TotalSleepDuration / 3600.0 // sec → heures
		}
		// RHR : prendre le plus bas observé (= vrai resting).
		if s.LowestHeartRate > 0 && (a.rhrMin == 0 || s.LowestHeartRate < a.rhrMin) {
			a.rhrMin = s.LowestHeartRate
		}
	}
	out := make([]PhysioEntry, 0, len(byDay))
	for day, a := range byDay {
		e := PhysioEntry{Date: day}
		if a.hrvWeight > 0 {
			e.HRV = a.hrvWeighted / a.hrvWeight // vraie moyenne pondérée
		} else if a.hrvN > 0 {
			e.HRV = a.hrvSimple / a.hrvN // fallback : durées toutes inconnues
		}
		e.Sleep = a.sleepHours
		e.RHR = a.rhrMin
		out = append(out, e)
	}
	return out, nil
}

// Audit F2 : fetchOuraReadiness a été retirée. Elle était documentée comme un
// « fallback HRV » mais l'endpoint daily_readiness d'Oura ne renvoie que des
// scores 0-100 (hrv_balance, resting_heart_rate…), PAS les valeurs absolues
// HRV/RHR dont nos modèles ont besoin. La fonction retournait donc toujours
// (nil, nil) et n'était appelée nulle part — du code mort trompeur. La source
// de vérité pour HRV/RHR reste fetchOuraSleep (endpoint /usercollection/sleep).

// parseAppleHealthAutoExport accepte le format JSON émis par l'app
// "Health Auto Export" (https://www.healthyapps.dev/auto-export) qui est
// la voie standard pour pousser des données Apple Health vers un webhook.
//
// Schéma type :
//
//	{
//	  "data": {
//	    "metrics": [
//	      {
//	        "name":  "heart_rate_variability",
//	        "units": "ms",
//	        "data":  [ { "date": "2026-04-30 02:00:00 +0000", "qty": 52.3 }, ... ]
//	      },
//	      { "name": "sleep_analysis", "data": [...] },
//	      ...
//	    ]
//	  }
//	}
//
// On agrège par jour ISO (YYYY-MM-DD).
//
// Métriques supportées (le `name` exporté par AHAE est listé) :
//
//	Core (utilisés par les modèles) :
//	  heart_rate_variability,                                → HRV (moyenne, ms)
//	  heart_rate_variability_sdnn,
//	    heart_rate_variability_rmssd                          alias acceptés
//	  sleep_analysis                                          → Sleep (somme h)
//	  resting_heart_rate                                      → RHR (min, bpm)
//
//	Étendus (stockés pour analyse future) :
//	  active_energy_burned, active_energy                     → ActiveEnergy (kcal)
//	  vo2_max                                                  → VO2Max (ml/kg/min)
//	  step_count, steps                                        → Steps
//	  heart_rate (mean over period)                            → AvgHR (bpm)
//	  body_mass, weight                                        → BodyMassKg
//	  body_fat_percentage                                      → BodyFatPct (0-100)
//	  respiratory_rate                                         → RespRate
//	  mindful_session, mindfulness                             → MindfulMin
//
// Toute autre métrique est ignorée silencieusement (pour ne pas spammer
// les logs). Un futur contributeur peut ajouter une `case` dans le switch
// pour étendre la couverture (e.g. blood_oxygen, environmental_audio_exposure).
func parseAppleHealthAutoExport(raw []byte) ([]PhysioEntry, error) {
	var payload struct {
		Data struct {
			Metrics []struct {
				Name  string            `json:"name"`
				Units string            `json:"units"`
				Data  []json.RawMessage `json:"data"`
			} `json:"metrics"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, errors.New("structure inattendue (data.metrics manquant ?)")
	}
	if len(payload.Data.Metrics) == 0 {
		return nil, errors.New("aucune métrique trouvée")
	}
	type aggDay struct {
		// Core
		hrvSum, hrvN float64
		sleepHours   float64
		rhrMin       float64 // 0 = pas encore vu
		// Étendus (sommes/agrégats par jour)
		activeEnergyKcal float64 // somme journée
		vo2MaxMax        float64 // max valeur du jour (vo2 ne change pas dans la journée)
		stepsTotal       float64 // somme journée
		hrSum, hrN       float64 // moyenne journée
		bodyMassMin      float64 // 0 = pas vu (matin avant petit-dej idéalement)
		bodyFatPct       float64 // dernier observé
		respRateAvg      float64 // moyenne, calculée à partir des sommes
		respRateN        float64
		mindfulSec       float64 // somme secondes
	}
	byDay := map[string]*aggDay{}
	get := func(d string) *aggDay {
		a := byDay[d]
		if a == nil {
			a = &aggDay{}
			byDay[d] = a
		}
		return a
	}
	// Helper : extrait { date, qty } d'une entrée standard.
	parseQtyEntry := func(raw json.RawMessage) (string, float64, bool) {
		var s struct {
			Date string  `json:"date"`
			Qty  float64 `json:"qty"`
		}
		if json.Unmarshal(raw, &s) != nil {
			return "", 0, false
		}
		return s.Date, s.Qty, true
	}
	for _, m := range payload.Data.Metrics {
		switch m.Name {
		// ---- Core ----
		case "heart_rate_variability",
			"heart_rate_variability_sdnn",
			"heart_rate_variability_rmssd":
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				a := get(day)
				a.hrvSum += qty
				a.hrvN++
			}
		case "sleep_analysis":
			for _, raw := range m.Data {
				var s struct {
					StartDate string  `json:"startDate"`
					EndDate   string  `json:"endDate"`
					Asleep    float64 `json:"asleep"`
					InBed     float64 `json:"inBed"`
					Date      string  `json:"date"`
				}
				if json.Unmarshal(raw, &s) != nil {
					continue
				}
				day := isoDayFromAHAE(s.StartDate)
				if day == "" {
					day = isoDayFromAHAE(s.Date)
				}
				if day == "" {
					continue
				}
				dur := s.Asleep
				if dur == 0 && s.InBed > 0 {
					dur = s.InBed * 0.92
				}
				if dur > 0 {
					get(day).sleepHours += dur
				}
			}
		case "resting_heart_rate":
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				a := get(day)
				if a.rhrMin == 0 || qty < a.rhrMin {
					a.rhrMin = qty
				}
			}
		// ---- Étendus ----
		case "active_energy_burned", "active_energy":
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				get(day).activeEnergyKcal += qty
			}
		case "vo2_max":
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				a := get(day)
				if qty > a.vo2MaxMax {
					a.vo2MaxMax = qty
				}
			}
		case "step_count", "steps":
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				get(day).stepsTotal += qty
			}
		case "heart_rate":
			// Moyenne journalière (samples agrégés). Distinct de resting_heart_rate
			// qui est une mesure spécifique au repos. Utile pour surveiller
			// l'effort cardiaque global.
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				a := get(day)
				a.hrSum += qty
				a.hrN++
			}
		case "body_mass", "weight":
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				a := get(day)
				// Garde la valeur la plus basse du jour (pesée du matin
				// idéalement). Une seconde pesée plus haute = repas/eau,
				// moins représentative.
				if a.bodyMassMin == 0 || qty < a.bodyMassMin {
					a.bodyMassMin = qty
				}
			}
		case "body_fat_percentage":
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				get(day).bodyFatPct = qty
			}
		case "respiratory_rate":
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				a := get(day)
				a.respRateAvg += qty
				a.respRateN++
			}
		case "mindful_session", "mindfulness":
			// Souvent en secondes ou minutes selon l'export. AHAE pousse
			// généralement des durées en minutes pour les sessions.
			for _, raw := range m.Data {
				dt, qty, ok := parseQtyEntry(raw)
				if !ok || qty <= 0 {
					continue
				}
				day := isoDayFromAHAE(dt)
				if day == "" {
					continue
				}
				get(day).mindfulSec += qty * 60 // assume minutes → secondes pour additionner
			}
		default:
			// Métrique non gérée — silently ignored.
		}
	}
	out := make([]PhysioEntry, 0, len(byDay))
	for day, a := range byDay {
		e := PhysioEntry{Date: day}
		if a.hrvN > 0 {
			e.HRV = a.hrvSum / a.hrvN
		}
		if a.sleepHours > 0 {
			e.Sleep = a.sleepHours
		}
		if a.rhrMin > 0 {
			e.RHR = a.rhrMin
		}
		if a.activeEnergyKcal > 0 {
			e.ActiveEnergy = a.activeEnergyKcal
		}
		if a.vo2MaxMax > 0 {
			e.VO2Max = a.vo2MaxMax
		}
		if a.stepsTotal > 0 {
			e.Steps = a.stepsTotal
		}
		if a.hrN > 0 {
			e.AvgHR = a.hrSum / a.hrN
		}
		if a.bodyMassMin > 0 {
			e.BodyMassKg = a.bodyMassMin
		}
		if a.bodyFatPct > 0 {
			e.BodyFatPct = a.bodyFatPct
		}
		if a.respRateN > 0 {
			e.RespRate = a.respRateAvg / a.respRateN
		}
		if a.mindfulSec > 0 {
			e.MindfulMin = a.mindfulSec / 60.0
		}
		// Skip si tout est zéro.
		if e.HRV == 0 && e.Sleep == 0 && e.RHR == 0 && e.ActiveEnergy == 0 &&
			e.VO2Max == 0 && e.Steps == 0 && e.AvgHR == 0 && e.BodyMassKg == 0 &&
			e.BodyFatPct == 0 && e.RespRate == 0 && e.MindfulMin == 0 {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// isoDayFromAHAE convertit les date-time strings d'Apple Health Auto
// Export (formats variables : "2026-04-30 02:00:00 +0000",
// "2026-04-30T02:00:00Z", "2026-04-30") vers "YYYY-MM-DD".
func isoDayFromAHAE(s string) string {
	if len(s) < 10 {
		return ""
	}
	// Le préfixe YYYY-MM-DD est souvent extractible directement. Tolère
	// les exports qui mettent un T au lieu d'un espace.
	if s[4] == '-' && s[7] == '-' {
		return s[:10]
	}
	// Fallback : essai parse Go.
	for _, layout := range []string{
		"2006-01-02 15:04:05 -0700",
		time.RFC3339,
		"2006-01-02T15:04:05",
		"2006-01-02",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Format("2006-01-02")
		}
	}
	return ""
}

// computeSyncWindow détermine combien de jours en arrière on fetch, selon :
//   - override explicite du client (clamp [7, 365])
//   - lastSync connu : (now - lastSync) + 2 jours d'overlap, clampé [7, 90]
//   - jamais sync : 30 jours par défaut (utile pour avoir une baseline pour
//     le score composite readiness qui calcule sur 28j)
func computeSyncWindow(u *User, override int) int {
	if override > 0 {
		if override < 7 {
			return 7
		}
		if override > 365 {
			return 365
		}
		return override
	}
	if u.PhysioLastSync == nil {
		return 30
	}
	last, ok := u.PhysioLastSync["oura"]
	if !ok || last.IsZero() {
		return 30
	}
	days := int(time.Since(last).Hours()/24) + 2 // +2 jours overlap
	if days < 7 {
		return 7
	}
	if days > 90 {
		return 90
	}
	return days
}

// validateOuraToken — appel léger pour vérifier que le token est valide.
// Hit le endpoint personal_info qui ne consomme pas le quota lourd.
func validateOuraToken(token string) error {
	if len(token) < 16 || len(token) > 200 {
		return errors.New("longueur de token suspecte")
	}
	url := ouraBase + "/usercollection/personal_info"
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpClientPhysio.Do(req)
	if err != nil {
		return fmt.Errorf("oura unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 {
		return errors.New("token Oura refusé (401)")
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("oura validation status %d", resp.StatusCode)
	}
	return nil
}

/* ========================================================================
 * HANDLERS HTTP
 * ====================================================================== */

// integrationsView retourne le statut public des intégrations sans exposer
// les tokens. Inclut l'URL webhook (qui contient le secret — c'est par
// design, l'utilisateur a besoin de cette URL pour configurer ses
// services push).
func handlePhysioListIntegrations(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	usersMu.RLock()
	u := usersByID[uid]
	usersMu.RUnlock()
	if u == nil {
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	out := map[string]any{
		"oura":    map[string]any{"enabled": false},
		"strava":  stravaStatusForUser(u),
		"webhook": map[string]any{"enabled": false},
	}
	if u.PhysioTokens != nil && u.PhysioTokens["oura"] != "" {
		ouraOut := map[string]any{"enabled": true}
		if u.PhysioLastSync != nil {
			if t, ok := u.PhysioLastSync["oura"]; ok && !t.IsZero() {
				ouraOut["lastSync"] = t.UTC()
			}
		}
		out["oura"] = ouraOut
	}
	if u.PhysioWebhookSecret != "" {
		// L'URL est suffisante — pas besoin d'exposer le secret seul.
		// Le client construit l'URL à partir de l'origine courante.
		out["webhook"] = map[string]any{
			"enabled": true,
			"path":    fmt.Sprintf("/api/physio/webhook/%s/%s", u.ID, u.PhysioWebhookSecret),
			"hint":    "POST JSON {date, hrv, sleep, rhr} (single ou array). Secret immutable jusqu'à rotation.",
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"integrations": out})
}

func handlePhysioSetOura(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	var req struct {
		Token string `json:"token"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	tok := strings.TrimSpace(req.Token)
	if tok == "" {
		writeErr(w, http.StatusBadRequest, "token vide")
		return
	}
	if err := validateOuraToken(tok); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	physioMu.Lock()
	usersMu.Lock()
	u := usersByID[uid]
	if u == nil {
		usersMu.Unlock()
		physioMu.Unlock()
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	if u.PhysioTokens == nil {
		u.PhysioTokens = map[string]string{}
	}
	// Chiffrement at-rest : on stocke le format "ENC:v1:..." si COACH_TOKEN_KEY
	// est défini, sinon cleartext en mode dégradé (avec warning log).
	u.PhysioTokens["oura"] = encryptToken(tok)
	usersMu.Unlock()
	physioMu.Unlock()
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handlePhysioRemoveOura(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	physioMu.Lock()
	usersMu.Lock()
	u := usersByID[uid]
	if u != nil && u.PhysioTokens != nil {
		delete(u.PhysioTokens, "oura")
		if u.PhysioLastSync != nil {
			delete(u.PhysioLastSync, "oura")
		}
	}
	usersMu.Unlock()
	physioMu.Unlock()
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handlePhysioSync — fetch toutes les intégrations actives et retourne les
// entrées au client. Le client se charge de merger dans S.body.physio
// (côté data file) — le serveur ne touche pas au data utilisateur.
//
// Fenêtre adaptative : on calcule depuis lastSync moins 2 jours d'overlap
// (pour rattraper d'éventuelles entrées manquées). Bornes : minimum 7
// jours (rattrapage léger), maximum 90 jours (premier sync ou rattrapage
// après une longue absence). Le client peut forcer une fenêtre custom via
// {windowDays: N} dans le body — utile pour rattraper plus loin si l'app
// n'a pas été ouverte pendant des mois.
func handlePhysioSync(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	usersMu.RLock()
	u := usersByID[uid]
	usersMu.RUnlock()
	if u == nil || u.PhysioTokens == nil {
		writeJSON(w, http.StatusOK, map[string]any{"entries": []any{}, "synced": []string{}})
		return
	}
	// Lecture optionnelle du body (windowDays explicite). Body vide = OK.
	var bodyOpts struct {
		WindowDays int `json:"windowDays"`
	}
	if r.Body != nil {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1024))
		if len(body) > 0 {
			_ = json.Unmarshal(body, &bodyOpts)
		}
	}
	// Calcul de la fenêtre.
	windowDays := computeSyncWindow(u, bodyOpts.WindowDays)
	endDate := time.Now().UTC().Format("2006-01-02")
	startDate := time.Now().UTC().AddDate(0, 0, -windowDays).Format("2006-01-02")
	merged := []PhysioEntry{}
	synced := []string{}
	errs := map[string]string{}

	if encTok, ok := u.PhysioTokens["oura"]; ok && encTok != "" {
		tok, derr := decryptToken(encTok)
		if derr != nil {
			errs["oura"] = "token illisible : " + derr.Error()
			writeJSON(w, http.StatusOK, map[string]any{
				"entries": merged, "synced": synced, "errors": errs,
				"window": map[string]string{"start": startDate, "end": endDate},
			})
			return
		}
		entries, err := fetchOuraSleep(tok, startDate, endDate)
		if err != nil {
			errs["oura"] = err.Error()
		} else {
			merged = append(merged, entries...)
			synced = append(synced, "oura")
			metricPhysioSync.Add(1)
			physioMu.Lock()
			usersMu.Lock()
			if u2 := usersByID[uid]; u2 != nil {
				if u2.PhysioLastSync == nil {
					u2.PhysioLastSync = map[string]time.Time{}
				}
				u2.PhysioLastSync["oura"] = time.Now().UTC()
			}
			usersMu.Unlock()
			physioMu.Unlock()
			markUsersDirty()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": merged,
		"synced":  synced,
		"errors":  errs,
		"window":  map[string]string{"start": startDate, "end": endDate},
	})
}

// handlePhysioRotateWebhook génère (ou rotate) le secret webhook.
// Aucun body requis.
func handlePhysioRotateWebhook(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	newSecret := randHex(16) // 32 chars hex
	physioMu.Lock()
	usersMu.Lock()
	u := usersByID[uid]
	if u == nil {
		usersMu.Unlock()
		physioMu.Unlock()
		writeErr(w, http.StatusUnauthorized, "non connecté")
		return
	}
	u.PhysioWebhookSecret = newSecret
	usersMu.Unlock()
	physioMu.Unlock()
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"path": fmt.Sprintf("/api/physio/webhook/%s/%s", uid, newSecret),
	})
}

func handlePhysioRevokeWebhook(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	physioMu.Lock()
	usersMu.Lock()
	if u := usersByID[uid]; u != nil {
		u.PhysioWebhookSecret = ""
	}
	usersMu.Unlock()
	physioMu.Unlock()
	saveUsers()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handlePhysioWebhook — endpoint push, validé par {uid, secret} dans l'URL.
// Pas d'auth de session — c'est la signature de l'URL qui authentifie.
//
// Body accepté :
//   - Single object : { "date": "2026-04-30", "hrv": 52, "sleep": 7.5, "rhr": 60 }
//   - Array         : [ {...}, {...} ]
//
// Persiste dans le data file utilisateur (S.body.physio côté shape interne).
// Sécurité :
//   - URL contient un secret 32-hex unique par user, comparé en constant time.
//   - Cap à 1000 entrées par requête pour éviter abuse.
//   - Rate limited via le middleware standard côté router.
func handlePhysioWebhook(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	secret := r.PathValue("secret")
	if uid == "" || secret == "" {
		writeErr(w, http.StatusNotFound, "introuvable")
		return
	}
	usersMu.RLock()
	u := usersByID[uid]
	// Copie sous le lock — PhysioWebhookSecret / HealthConsent sont mutés par
	// d'autres handlers sous usersMu (data race sinon).
	var storedSecret string
	hasConsent := false
	if u != nil {
		storedSecret = u.PhysioWebhookSecret
		hasConsent = u.HealthConsent != nil && u.HealthConsent.Version == CurrentPrivacyVersion
	}
	usersMu.RUnlock()
	if u == nil || storedSecret == "" {
		// Réponse identique pour un user inexistant ou un user sans webhook
		// — évite l'oracle "ce uid existe-t-il?".
		writeErr(w, http.StatusNotFound, "introuvable")
		return
	}
	if subtle.ConstantTimeCompare([]byte(secret), []byte(storedSecret)) != 1 {
		writeErr(w, http.StatusForbidden, "secret invalide")
		return
	}
	// RGPD art. 9 : même garde-fou que PUT /api/data (handleSaveData) — on
	// n'écrit pas de données de santé pour un compte qui n'a pas (re)donné
	// son consentement explicite à la version courante de la politique. Sans
	// ce check, le webhook contournait silencieusement la gate de consentement.
	if !hasConsent {
		writeErr(w, http.StatusForbidden, "consentement aux données de santé requis")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 256*1024))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "body illisible")
		return
	}
	// Détection automatique du format. Trois cas supportés :
	//   1. Single object   : { date, hrv, sleep, rhr }
	//   2. Array d'objets  : [ {...}, {...} ]
	//   3. Apple Health Auto Export : { data: { metrics: [...] } } — voir
	//      parseAppleHealthAutoExport pour le détail des mappings.
	var raw json.RawMessage = body
	var entries []PhysioEntry
	if len(raw) == 0 {
		writeErr(w, http.StatusBadRequest, "body vide")
		return
	}
	switch raw[0] {
	case '[':
		if err := json.Unmarshal(raw, &entries); err != nil {
			writeErr(w, http.StatusBadRequest, "JSON invalide (array)")
			return
		}
	case '{':
		// Sniff la présence de "data.metrics" qui est la signature AHAE.
		var probe map[string]json.RawMessage
		if err := json.Unmarshal(raw, &probe); err != nil {
			writeErr(w, http.StatusBadRequest, "JSON invalide (objet)")
			return
		}
		if d, hasData := probe["data"]; hasData {
			var dataObj map[string]json.RawMessage
			if json.Unmarshal(d, &dataObj) == nil {
				if _, hasMetrics := dataObj["metrics"]; hasMetrics {
					ahae, err := parseAppleHealthAutoExport(raw)
					if err != nil {
						writeErr(w, http.StatusBadRequest, "Apple Health format : "+err.Error())
						return
					}
					entries = ahae
					break
				}
			}
		}
		// Sinon : simple PhysioEntry.
		var single PhysioEntry
		if err := json.Unmarshal(raw, &single); err != nil {
			writeErr(w, http.StatusBadRequest, "JSON invalide (objet)")
			return
		}
		entries = []PhysioEntry{single}
	default:
		writeErr(w, http.StatusBadRequest, "format attendu : objet, array ou Apple Health Auto Export")
		return
	}
	if len(entries) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"received": 0})
		return
	}
	if len(entries) > 1000 {
		writeErr(w, http.StatusRequestEntityTooLarge, "max 1000 entries / requête")
		return
	}
	// Filtre les entrées invalides (date manquante/malformée ou tout vide).
	// La date DOIT être un jour ISO strict : chaque date distincte devient une
	// clé dans body.physio, accepter des chaînes arbitraires permettrait de
	// faire gonfler le data file avec des clés indéfiniment variées.
	clean := make([]PhysioEntry, 0, len(entries))
	for _, e := range entries {
		if e.Date == "" || !physioDateRe.MatchString(e.Date) {
			continue
		}
		// Au moins un champ non-nul attendu.
		if e.HRV <= 0 && e.Sleep <= 0 && e.RHR <= 0 &&
			e.ActiveEnergy <= 0 && e.VO2Max <= 0 && e.Steps <= 0 &&
			e.AvgHR <= 0 && e.BodyMassKg <= 0 && e.BodyFatPct <= 0 &&
			e.RespRate <= 0 && e.MindfulMin <= 0 {
			continue
		}
		clean = append(clean, e)
	}
	if err := mergePhysioIntoData(uid, clean); err != nil {
		metricWebhookErr.Add(1)
		writeErr(w, http.StatusInternalServerError, "écriture impossible")
		return
	}
	physioMu.Lock()
	usersMu.Lock()
	if u2 := usersByID[uid]; u2 != nil {
		if u2.PhysioLastSync == nil {
			u2.PhysioLastSync = map[string]time.Time{}
		}
		u2.PhysioLastSync["webhook"] = time.Now().UTC()
	}
	usersMu.Unlock()
	physioMu.Unlock()
	markUsersDirty()
	writeJSON(w, http.StatusOK, map[string]any{
		"received": len(clean),
		"ignored":  len(entries) - len(clean),
	})
}

// physioDateRe : jour ISO-8601 strict (YYYY-MM-DD) — seul format accepté
// comme clé d'agrégation dans body.physio.
var physioDateRe = regexp.MustCompile("^\\d{4}-\\d{2}-\\d{2}$")

// mergePhysioIntoData lit le data file utilisateur, merge les nouvelles
// entrées physio dans body.physio (replace si même date), et réécrit
// atomiquement. Utilisé par le webhook qui n'a pas de session client
// pour faire le merge côté JS.
func mergePhysioIntoData(uid string, incoming []PhysioEntry) error {
	if !validUserID.MatchString(uid) {
		return errors.New("uid invalide")
	}
	lock := userLock(uid)
	lock.Lock()
	defer lock.Unlock()
	path := dataPath(uid)
	var data map[string]any
	if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
		if err := json.Unmarshal(b, &data); err != nil {
			data = nil
		}
	}
	if data == nil {
		data = map[string]any{}
	}
	body, _ := data["body"].(map[string]any)
	if body == nil {
		body = map[string]any{}
		data["body"] = body
	}
	physArr, _ := body["physio"].([]any)
	byDate := map[string]map[string]any{}
	for _, p := range physArr {
		if pm, ok := p.(map[string]any); ok {
			if d, ok2 := pm["date"].(string); ok2 {
				byDate[d] = pm
			}
		}
	}
	for _, e := range incoming {
		entry := byDate[e.Date]
		if entry == nil {
			entry = map[string]any{"date": e.Date}
		}
		// Core
		if e.HRV > 0 {
			entry["hrv"] = e.HRV
		}
		if e.Sleep > 0 {
			entry["sleep"] = e.Sleep
		}
		if e.RHR > 0 {
			entry["rhr"] = e.RHR
		}
		// Étendus
		if e.ActiveEnergy > 0 {
			entry["activeEnergy"] = e.ActiveEnergy
		}
		if e.VO2Max > 0 {
			entry["vo2Max"] = e.VO2Max
		}
		if e.Steps > 0 {
			entry["steps"] = e.Steps
		}
		if e.AvgHR > 0 {
			entry["avgHR"] = e.AvgHR
		}
		if e.BodyMassKg > 0 {
			entry["bodyMassKg"] = e.BodyMassKg
		}
		if e.BodyFatPct > 0 {
			entry["bodyFatPct"] = e.BodyFatPct
		}
		if e.RespRate > 0 {
			entry["respRate"] = e.RespRate
		}
		if e.MindfulMin > 0 {
			entry["mindfulMin"] = e.MindfulMin
		}
		byDate[e.Date] = entry
	}
	// Cap : même plafond que la validation de PUT /api/data (data.go, audit
	// M-06). Sans ça, le webhook contournait la limite et pouvait faire
	// gonfler body.physio indéfiniment (parse JSON de plusieurs MiB à chaque
	// /api/data). On garde les 2000 dates les plus récentes — le tri
	// lexicographique équivaut au tri chronologique sur des dates ISO.
	const maxPhysioEntries = 2000
	dates := make([]string, 0, len(byDate))
	for d := range byDate {
		dates = append(dates, d)
	}
	sort.Strings(dates)
	if len(dates) > maxPhysioEntries {
		dates = dates[len(dates)-maxPhysioEntries:]
	}
	out := make([]any, 0, len(dates))
	for _, d := range dates {
		out = append(out, byDate[d])
	}
	body["physio"] = out
	return writeJSONAtomic(path, data, 0o600)
}
