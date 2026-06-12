package main

/*
metrics.go — Observabilité (audit produit).

Avant : aucune métrique exposée, le debug se faisait « à l'aveugle dans les
logs ». On ajoute :

  - des COMPTEURS in-memory atomiques sur les événements clés (logins ok/ko,
    usages de code de récupération, syncs physio, erreurs webhook, panics
    récupérés). Coût négligeable, aucune PII.
  - GET /api/admin/metrics : exposition format Prometheus text (scrappable)
    ET un bloc JSON pratique pour l'admin UI. Derrière requireAdmin —
    l'opérateur seul y a accès, pas d'endpoint public qui fuiterait la
    taille de la base.
  - un healthcheck PROFOND optionnel : vérifie réellement que le data dir
    est inscriptible et que la clé de chiffrement déchiffre, pas seulement
    que le process répond 200.

Les compteurs sont cumulés depuis le démarrage (un restart les remet à 0,
comme tout exporter Prometheus sans persistance — c'est le scraper qui gère
les resets via les rates).
*/

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

// deepHealth effectue un check de santé en profondeur : écriture témoin dans
// le data dir (volume réellement inscriptible ?) + round-trip de chiffrement
// (clé exploitable ?). Renvoie nil si tout va bien.
func deepHealth() error {
	probe := filepath.Join(dataDir, ".health-probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		return errors.New("data dir non inscriptible")
	}
	_ = os.Remove(probe)
	// Round-trip chiffrement si une clé est configurée (sinon mode cleartext
	// assumé — on ne le compte pas comme une panne).
	if initTokenAEAD() == nil {
		enc := encryptToken("healthcheck")
		if dec, err := decryptToken(enc); err != nil || dec != "healthcheck" {
			return errors.New("round-trip chiffrement échoué")
		}
	}
	return nil
}

// Compteurs atomiques — incrémentés depuis les handlers concernés.
var (
	metricLoginOK         atomic.Int64
	metricLoginFail       atomic.Int64
	metricRecoveryUsed    atomic.Int64
	metricRegister        atomic.Int64
	metricPhysioSync      atomic.Int64
	metricWebhookOK       atomic.Int64
	metricWebhookErr      atomic.Int64
	metricPanicsRecovered atomic.Int64
)

var processStart = time.Now()

// handleAdminMetrics expose les métriques. Format : si le client envoie
// Accept: application/json on renvoie du JSON, sinon le format texte
// Prometheus (défaut — c'est ce qu'un scraper attend).
func handleAdminMetrics(w http.ResponseWriter, r *http.Request) {
	users := userStore.Count()
	sessions := len(sessionStore.Snapshot())
	uptime := int64(time.Since(processStart).Seconds())

	loginOK := metricLoginOK.Load()
	loginFail := metricLoginFail.Load()
	recovery := metricRecoveryUsed.Load()
	register := metricRegister.Load()
	physioSync := metricPhysioSync.Load()
	whOK := metricWebhookOK.Load()
	whErr := metricWebhookErr.Load()
	panics := metricPanicsRecovered.Load()

	if r.Header.Get("Accept") == "application/json" {
		writeJSON(w, http.StatusOK, map[string]any{
			"uptimeSeconds":   uptime,
			"users":           users,
			"activeSessions":  sessions,
			"loginSuccess":    loginOK,
			"loginFailure":    loginFail,
			"recoveryUsed":    recovery,
			"registrations":   register,
			"physioSyncs":     physioSync,
			"webhookSuccess":  whOK,
			"webhookErrors":   whErr,
			"panicsRecovered": panics,
		})
		return
	}

	// Format Prometheus text exposition.
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprintf(w, "# HELP coach_uptime_seconds Process uptime.\n# TYPE coach_uptime_seconds gauge\ncoach_uptime_seconds %d\n", uptime)
	fmt.Fprintf(w, "# HELP coach_users Total user accounts.\n# TYPE coach_users gauge\ncoach_users %d\n", users)
	fmt.Fprintf(w, "# HELP coach_active_sessions Live sessions.\n# TYPE coach_active_sessions gauge\ncoach_active_sessions %d\n", sessions)
	fmt.Fprintf(w, "# HELP coach_login_total Login attempts by result.\n# TYPE coach_login_total counter\ncoach_login_total{result=\"success\"} %d\ncoach_login_total{result=\"failure\"} %d\n", loginOK, loginFail)
	fmt.Fprintf(w, "# HELP coach_recovery_used_total Recovery codes consumed.\n# TYPE coach_recovery_used_total counter\ncoach_recovery_used_total %d\n", recovery)
	fmt.Fprintf(w, "# HELP coach_registrations_total New accounts.\n# TYPE coach_registrations_total counter\ncoach_registrations_total %d\n", register)
	fmt.Fprintf(w, "# HELP coach_physio_sync_total Physio sync calls.\n# TYPE coach_physio_sync_total counter\ncoach_physio_sync_total %d\n", physioSync)
	fmt.Fprintf(w, "# HELP coach_webhook_total Inbound webhook calls by result.\n# TYPE coach_webhook_total counter\ncoach_webhook_total{result=\"success\"} %d\ncoach_webhook_total{result=\"error\"} %d\n", whOK, whErr)
	fmt.Fprintf(w, "# HELP coach_panics_recovered_total Handler panics caught by recoverPanic.\n# TYPE coach_panics_recovered_total counter\ncoach_panics_recovered_total %d\n", panics)
}
