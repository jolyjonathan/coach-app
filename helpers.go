package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
)

// getenvOrFile lit une variable d'environnement, OU si <NAME>_FILE est défini,
// le contenu du fichier référencé (pattern Docker secrets / Compose secrets
// standard). Trim final, ignore le \n des fichiers générés par `printf`/`echo`.
//
// Audit H-02 : permet de garder COACH_TOKEN_KEY hors de `docker inspect` et
// `/proc/PID/environ` — un opérateur peut monter un tmpfs ou un Docker secret
// dans /run/secrets/coach_token_key et exporter COACH_TOKEN_KEY_FILE=/run/secrets/coach_token_key.
//
// Ordre de priorité :
//  1. <NAME>_FILE non vide → lit le fichier
//  2. <NAME> non vide       → utilise directement
//  3. defaultVal (si fourni, sinon "")
func getenvOrFile(name, defaultVal string) string {
	if path := strings.TrimSpace(os.Getenv(name + "_FILE")); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			log.Printf("getenvOrFile: cannot read %s (%s): %v", name+"_FILE", path, err)
			return defaultVal
		}
		return strings.TrimRight(string(b), "\r\n\t ")
	}
	if v := os.Getenv(name); v != "" {
		return v
	}
	return defaultVal
}

// hashEmailForLog renvoie un identifiant non-réversible (sha256 préfixe 8 chars)
// de l'email, tout en gardant le domaine en clair pour qu'un admin puisse
// distinguer "@gmail.com" de "@protonmail.com" lors d'un debug légitime.
// Exemple : "jonathan@protonmail.com" → "abc12345@protonmail.com".
//
// À utiliser dans tous les log.Printf qui sortent vers systemd journal
// (rétention potentiellement longue, hors contrôle de l'app) et dans les
// notes du journal d'audit qui pourraient fuiter par sauvegarde.
func hashEmailForLog(email string) string {
	if email == "" {
		return "(vide)"
	}
	low := strings.ToLower(strings.TrimSpace(email))
	at := strings.LastIndex(low, "@")
	domain := ""
	user := low
	if at >= 0 {
		user = low[:at]
		domain = low[at:]
	}
	sum := sha256.Sum256([]byte(user))
	return hex.EncodeToString(sum[:4]) + domain
}

// readJSON decodes r.Body into v, rejecting unknown top-level fields. On
// failure it writes a 400 to w and returns false; callers should just return.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "json invalide")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// newBytesReader wraps a []byte as an io.Reader for reusing json.NewDecoder
// after we've already read the full body for length-checking.
func newBytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

/* =============================================================
 * Chiffrement at-rest des secrets API (tokens Oura, etc.).
 * AES-256-GCM, clé dérivée de COACH_TOKEN_KEY (32 bytes hex).
 *
 * Format stocké : "ENC:v1:" + base64url(nonce ‖ ciphertext+tag)
 *   - Préfixe versionné pour migration future (rotation de clé, autre algo).
 *   - Texte clair (pas préfixé "ENC:") accepté en lecture pour rétro-
 *     compat lors de la migration depuis l'ancien format. Les writes
 *     produisent toujours du chiffré.
 * ============================================================= */

const encPrefix = "ENC:v1:"

var (
	tokenAEAD     cipher.AEAD
	tokenAEADOnce sync.Once
	tokenAEADErr  error
)

// newAEADFromHexKey construit un AEAD AES-256-GCM depuis une clé 32 bytes hex.
// Extrait pour être réutilisable avec une clé arbitraire (rotation de clé :
// on doit tenir l'ancienne ET la nouvelle en même temps — cf. rotate.go).
func newAEADFromHexKey(key string) (cipher.AEAD, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(key))
	if err != nil {
		return nil, errors.New("clé non hex")
	}
	if len(raw) != 32 {
		return nil, errors.New("clé invalide : 32 bytes (64 hex chars) requis")
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// initTokenAEAD lit COACH_TOKEN_KEY au premier appel. Idempotent.
// Renvoie nil si la clé est définie et valide ; sinon une erreur claire.
func initTokenAEAD() error {
	tokenAEADOnce.Do(func() {
		// Audit H-02 : supporte aussi COACH_TOKEN_KEY_FILE (pattern Docker secret).
		key := strings.TrimSpace(getenvOrFile("COACH_TOKEN_KEY", ""))
		if key == "" {
			tokenAEADErr = errors.New("COACH_TOKEN_KEY non défini")
			return
		}
		gcm, err := newAEADFromHexKey(key)
		if err != nil {
			tokenAEADErr = errors.New("COACH_TOKEN_KEY : " + err.Error())
			return
		}
		tokenAEAD = gcm
	})
	return tokenAEADErr
}

// encryptWithAEAD chiffre plain au format stocké "ENC:v1:…" avec un AEAD
// arbitraire. Renvoie une erreur (pas de fallback cleartext — les appelants
// qui veulent le mode dégradé passent par encryptToken).
func encryptWithAEAD(a cipher.AEAD, plain string) (string, error) {
	nonce := make([]byte, a.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := a.Seal(nil, nonce, []byte(plain), nil)
	out := make([]byte, 0, len(nonce)+len(ct))
	out = append(out, nonce...)
	out = append(out, ct...)
	return encPrefix + base64.RawURLEncoding.EncodeToString(out), nil
}

// decryptWithAEAD déchiffre une valeur au format "ENC:v1:…" avec un AEAD
// arbitraire. Contrairement à decryptToken, N'ACCEPTE PAS le plaintext :
// l'appelant décide quoi faire d'une valeur non préfixée.
func decryptWithAEAD(a cipher.AEAD, stored string) (string, error) {
	if !strings.HasPrefix(stored, encPrefix) {
		return "", errors.New("pas au format ENC")
	}
	raw, err := base64.RawURLEncoding.DecodeString(stored[len(encPrefix):])
	if err != nil {
		return "", errors.New("token format invalide (base64)")
	}
	ns := a.NonceSize()
	if len(raw) < ns {
		return "", errors.New("token format invalide (taille)")
	}
	nonce, ct := raw[:ns], raw[ns:]
	pt, err := a.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", errors.New("déchiffrement échoué (clé incorrecte ou data corrompu)")
	}
	return string(pt), nil
}

// encryptToken chiffre une chaîne et retourne le format stocké.
// Si la clé n'est pas configurée, retourne le plaintext tel quel après
// avoir loggé un warning (mode dégradé : on évite de bloquer le service
// pour l'usage personnel sans secret).
func encryptToken(plain string) string {
	if plain == "" {
		return ""
	}
	if err := initTokenAEAD(); err != nil {
		log.Printf("encryptToken: cleartext fallback (%v)", err)
		return plain
	}
	enc, err := encryptWithAEAD(tokenAEAD, plain)
	if err != nil {
		log.Printf("encryptToken: %v", err)
		return plain
	}
	return enc
}

// decryptToken déchiffre une chaîne stockée. Accepte aussi du plaintext
// (rétro-compat migration). Renvoie une erreur si le format est ENC mais
// déchiffrable.
func decryptToken(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	if !strings.HasPrefix(stored, encPrefix) {
		// Legacy plaintext — accepté en lecture, sera ré-écrit chiffré
		// au prochain save.
		return stored, nil
	}
	if err := initTokenAEAD(); err != nil {
		return "", errors.New("token chiffré mais COACH_TOKEN_KEY indisponible : " + err.Error())
	}
	return decryptWithAEAD(tokenAEAD, stored)
}

// reencryptUserTokens parcourt les tokens d'un User et les ré-écrit
// chiffrés s'ils sont en cleartext (legacy). Idempotent. Appelé depuis
// loadUsers et lors d'un save pour assurer la migration progressive.
func reencryptUserTokens(u *User) bool {
	if u == nil || u.PhysioTokens == nil {
		return false
	}
	changed := false
	for k, v := range u.PhysioTokens {
		if !strings.HasPrefix(v, encPrefix) && v != "" {
			u.PhysioTokens[k] = encryptToken(v)
			changed = true
		}
	}
	return changed
}
