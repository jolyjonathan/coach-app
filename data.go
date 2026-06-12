package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

var (
	// One mutex per user id, lazily created, to serialize writes to that user's file.
	userFileLocks sync.Map

	// Defense in depth: we only construct paths from server-generated hex ids,
	// but we still validate the id shape before touching the filesystem.
	validUserID = regexp.MustCompile(`^[a-f0-9]{16,64}$`)
)

// dataPath resolves the file for a given user. The user ID is validated to
// prevent path traversal even though we never accept it from client input.
func dataPath(userID string) string {
	if !validUserID.MatchString(userID) {
		return filepath.Join(dataDir, "workouts", "_invalid.json")
	}
	return filepath.Join(dataDir, "workouts", userID+".json")
}

func userLock(id string) *sync.Mutex {
	v, _ := userFileLocks.LoadOrStore(id, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// deleteUserDataFiles supprime le data file utilisateur ET son backup .bak.
// RGPD art. 17 : le droit à l'effacement doit couvrir les backups générés
// par writeJSONAtomic, sinon les données de santé survivent sur disque
// jusqu'à 24h+ après la suppression du compte. Best-effort sur le .bak —
// son absence n'est pas une erreur.
func deleteUserDataFiles(uid string) {
	p := dataPath(uid)
	_ = os.Remove(p)
	_ = os.Remove(p + ".bak")
}

// --- Handlers ---

func handleLoadData(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	path := dataPath(uid)

	lock := userLock(uid)
	lock.Lock()
	b, err := os.ReadFile(path)
	lock.Unlock()

	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusOK, map[string]any{"data": nil})
			return
		}
		writeErr(w, http.StatusInternalServerError, "lecture impossible")
		return
	}
	// Audit modularité action 8 : ETag fort sur le contenu du fichier.
	// Le client renvoie If-None-Match → 304 sans re-parse ni re-transfert
	// du payload (jusqu'à 512 KiB) — surtout utile en 4G. Le hash couvre
	// les octets bruts : toute écriture via writeJSONAtomic change l'ETag.
	sum := sha256.Sum256(b)
	etag := `"` + hex.EncodeToString(sum[:16]) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache") // revalidation systématique, jamais de cache aveugle
	if match := r.Header.Get("If-None-Match"); match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		writeErr(w, http.StatusInternalServerError, "données corrompues")
		return
	}
	// Pas de writeJSON ici : il forcerait Cache-Control: no-store, ce qui
	// interdirait au navigateur de stocker la réponse et tuerait la
	// revalidation If-None-Match. no-cache = stockable mais TOUJOURS
	// revalidé auprès du serveur avant usage.
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{"data": v})
}

func handleSaveData(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)

	// RGPD art. 9 gate — refuse to persist health data without explicit
	// consent. The SPA prompts for consent before reaching this code path,
	// but we enforce server-side too so a stale tab or a scripted client
	// cannot bypass the prompt. Stale-version consents (after a policy
	// update) are also rejected so the user is forced to re-acknowledge.
	usersMu.RLock()
	u := usersByID[uid]
	hasConsent := u != nil && u.HealthConsent != nil && u.HealthConsent.Version == CurrentPrivacyVersion
	usersMu.RUnlock()
	if !hasConsent {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":         "consentement aux données de santé requis",
			"needsConsent":  true,
			"policyVersion": CurrentPrivacyVersion,
		})
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "body invalide")
		return
	}
	// Extra per-endpoint cap (global cap is 1 MiB; this is tighter).
	if len(body) > 512*1024 {
		writeErr(w, http.StatusRequestEntityTooLarge, "payload trop gros (max 512 KiB)")
		return
	}

	var payload struct {
		Data map[string]any `json:"data"`
	}
	dec := json.NewDecoder(newBytesReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&payload); err != nil {
		writeErr(w, http.StatusBadRequest, "json invalide")
		return
	}
	if payload.Data == nil {
		writeErr(w, http.StatusBadRequest, "champ 'data' manquant")
		return
	}

	// Whitelist top-level keys — anything unknown is silently dropped so a
	// compromised or buggy client cannot poison the stored shape. The
	// `rehab` blob holds the rehabilitation-mode state (active flag,
	// injury date, affected zones, manual-phase override, disclaimer
	// acceptance). It's an opaque JSON object — the Go side doesn't
	// inspect its shape, just persists it.
	allowed := map[string]bool{
		"profile": true, "history": true, "currentSession": true,
		"formScore": true, "adjustments": true, "notes": true,
		"rehab": true,
		// `body` : pesées + mensurations (suivi corporel). Shape :
		//   { weights: [{date, kg}], measurements: [{date, waistCm, ...}] }
		// Idem rehab : opaque côté serveur, juste persisté.
		"body": true,
		// `macrocycle` : périodisation par blocs (Issurin). Shape :
		//   { startDate, focus } — programming.js pilote la rotation.
		"macrocycle": true,
	}
	for k := range payload.Data {
		if !allowed[k] {
			delete(payload.Data, k)
		}
	}

	// Audit M-06 : validation de cardinalité sur les sous-arrays de `body`
	// (hooper, lifestyle, pvt, intentions, weights, measurements, physio).
	// Le content shape reste opaque côté serveur, mais on cap chaque array
	// pour éviter un client malveillant qui ferait gonfler le data file
	// jusqu'à dégrader les perfs (parse JSON de plusieurs MiB à chaque
	// /api/data). Limite suffisamment large pour un usage normal (~5 ans
	// de check-ins quotidiens), assez serrée pour bloquer l'abus.
	if rawBody, ok := payload.Data["body"]; ok {
		if body, ok := rawBody.(map[string]any); ok {
			const maxEntries = 2000
			subArrays := []string{
				"hooper", "lifestyle", "pvt", "intentions",
				"weights", "measurements", "physio",
			}
			for _, key := range subArrays {
				if arr, ok := body[key].([]any); ok && len(arr) > maxEntries {
					writeErr(w, http.StatusRequestEntityTooLarge,
						"trop d'entrées dans body."+key+" (max "+strconv.Itoa(maxEntries)+")")
					return
				}
			}
		}
	}

	lock := userLock(uid)
	lock.Lock()
	defer lock.Unlock()
	if err := writeJSONAtomic(dataPath(uid), payload.Data, 0o600); err != nil {
		writeErr(w, http.StatusInternalServerError, "écriture impossible")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleExport returns a complete portable dump of the user's data
// (RGPD art. 20). Wraps the workout JSON file together with the account
// metadata the user has a right to receive: email, creation date, 2FA
// status, consent record, opt-out flag, and policy version. The format is
// open JSON so the user can re-import it elsewhere.
func handleExport(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r)
	path := dataPath(uid)
	lock := userLock(uid)
	lock.Lock()
	b, err := os.ReadFile(path)
	lock.Unlock()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		writeErr(w, http.StatusInternalServerError, "export impossible")
		return
	}
	var workouts any
	if len(b) > 0 {
		if err := json.Unmarshal(b, &workouts); err != nil {
			// Don't refuse the export over a parse error — fall back to raw bytes
			// so the user still gets *something*. We log the issue server-side.
			workouts = json.RawMessage(b)
		}
	}

	usersMu.RLock()
	u := usersByID[uid]
	var account map[string]any
	if u != nil {
		account = map[string]any{
			"id":           u.ID,
			"email":        u.EmailLower,
			"createdAt":    u.CreatedAt,
			"isAdmin":      u.IsAdmin,
			"twofaEnabled": u.TOTPSecret != "",
			"algoOptOut":   u.AlgoOptOut,
		}
		if u.HealthConsent != nil {
			account["healthConsent"] = map[string]any{
				"consentedAt": u.HealthConsent.ConsentedAt,
				"version":     u.HealthConsent.Version,
			}
		}
	}
	usersMu.RUnlock()

	bundle := map[string]any{
		"_export": map[string]any{
			"generatedAt":   time.Now().UTC(),
			"policyVersion": CurrentPrivacyVersion,
			"format":        "coach-adaptatif/v1",
			"description":   "Portable export of all data this app stores about you (RGPD art. 20).",
		},
		"account":  account,
		"workouts": workouts,
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="coach-export.json"`)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(bundle)
}

// writeJSONAtomic writes via a tmp file + rename so a crash mid-write cannot
// leave a partially-written file. The parent directory is created with 0700
// and the file itself with the given mode (typically 0600).
//
// Backup quotidien : si le fichier cible existe ET que sa dernière modif
// date de > 24h, on le copie en .bak AVANT de l'écraser. Ça protège contre
// une corruption silencieuse côté client (le user envoie un payload qui
// efface tout son historique, par exemple) — l'opérateur peut restaurer le
// .bak à la main. Une seule génération de backup ; les corruptions étalées
// sur plusieurs jours ne sont pas couvertes.
func writeJSONAtomic(path string, v any, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// Backup .bak best-effort. Pas d'erreur fatale si ça rate — le write
	// principal doit toujours réussir.
	if info, err := os.Stat(path); err == nil {
		if time.Since(info.ModTime()) >= 24*time.Hour {
			bakPath := path + ".bak"
			if src, err := os.ReadFile(path); err == nil {
				_ = os.WriteFile(bakPath, src, mode)
			}
		}
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(f)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}
