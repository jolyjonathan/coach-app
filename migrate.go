package main

/*
migrate.go — migration des stores fichiers (data/*.json) vers une base SQL
(MariaDB/MySQL). Stratégie « lift & shift » : une ligne par enregistrement,
blobs et maps conservés en colonnes JSON (cf. db/schema.sql).

Deux modes, exposés en sous-commandes du binaire (l'image runtime est
distroless, sans shell — l'import DOIT être un mode du binaire) :

  coach-app --import            lit data/*.json → écrit dans COACH_DB
  coach-app --import --dry-run  parse et compte seulement, aucune écriture DB
  coach-app --verify            recompte et compare DB ↔ fichiers (intégrité)

La DSN est lue depuis COACH_DB, ex :
  coach:motdepasse@tcp(db:3306)/coach?parseTime=true&charset=utf8mb4

L'import est idempotent (INSERT ... ON DUPLICATE KEY UPDATE) : on peut le
rejouer sans créer de doublon. Il crée le schéma au besoin
(CREATE TABLE IF NOT EXISTS), donc un `up` peut partir d'une base vierge.
*/

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

// schemaDDL est joué avant tout import : la base peut donc être totalement
// vierge au premier `docker compose up`. Idempotent.
const schemaDDL = `
CREATE TABLE IF NOT EXISTS users (
  id                    VARCHAR(64)  NOT NULL PRIMARY KEY,
  email_lower           VARCHAR(320) NOT NULL,
  password_hash         VARCHAR(255) NOT NULL,
  created_at            DATETIME(6)  NOT NULL,
  is_admin              TINYINT(1)   NOT NULL DEFAULT 0,
  totp_secret           TEXT         NULL,
  health_consent        JSON         NULL,
  algo_opt_out          TINYINT(1)   NOT NULL DEFAULT 0,
  physio_tokens         JSON         NULL,
  physio_webhook_secret VARCHAR(128) NULL,
  physio_last_sync      JSON         NULL,
  recovery_codes        JSON         NULL,
  UNIQUE KEY uniq_email (email_lower)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS sessions (
  sid              VARCHAR(128) NOT NULL PRIMARY KEY,
  user_id          VARCHAR(64)  NOT NULL,
  created_at       DATETIME(6)  NOT NULL,
  expires_at       DATETIME(6)  NOT NULL,
  last_extended_at DATETIME(6)  NULL,
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS workouts (
  user_id    VARCHAR(64) NOT NULL PRIMARY KEY,
  data       JSON        NOT NULL,
  updated_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

// openDB ouvre la connexion SQL depuis COACH_DB et la ping.
func openDB() (*sql.DB, error) {
	dsn := os.Getenv("COACH_DB")
	if strings.TrimSpace(dsn) == "" {
		return nil, errors.New("COACH_DB non défini (DSN MariaDB attendue)")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetConnMaxLifetime(2 * time.Minute)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping base: %w", err)
	}
	return db, nil
}

// readUsersFile lit data/users.json → []*User (réutilise le type du package).
func readUsersFile() ([]*User, error) {
	b, err := os.ReadFile(usersFile())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var list []*User
	if err := json.Unmarshal(b, &list); err != nil {
		return nil, fmt.Errorf("parse users.json: %w", err)
	}
	return list, nil
}

// readSessionsFile lit data/sessions.json → map[sid]Session.
func readSessionsFile() (map[string]Session, error) {
	b, err := os.ReadFile(sessionsFile())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	m := map[string]Session{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("parse sessions.json: %w", err)
	}
	return m, nil
}

// workoutFiles liste les data files utilisateur valides (uid → chemin),
// en ignorant .bak/.tmp et le sentinel _invalid.json.
func workoutFiles() (map[string]string, error) {
	dir := filepath.Join(dataDir, "workouts")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	out := map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		uid := strings.TrimSuffix(name, ".json")
		if uid == "_invalid" || !validUserID.MatchString(uid) {
			continue
		}
		out[uid] = filepath.Join(dir, name)
	}
	return out, nil
}

// jsonColOrNil sérialise v en JSON pour une colonne JSON nullable. Renvoie nil
// (→ SQL NULL) quand v est vide/nil, pour ne pas stocker "null"/"{}"/"[]".
func jsonColOrNil(v any) (any, error) {
	switch t := v.(type) {
	case nil:
		return nil, nil
	case map[string]string:
		if len(t) == 0 {
			return nil, nil
		}
	case map[string]time.Time:
		if len(t) == 0 {
			return nil, nil
		}
	case []string:
		if len(t) == 0 {
			return nil, nil
		}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return b, nil
}

func strColOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// runImport effectue la migration fichiers → SQL. dryRun = parse + compte
// uniquement (aucune connexion en écriture, aucune table créée).
func runImport(dryRun bool) error {
	users, err := readUsersFile()
	if err != nil {
		return err
	}
	sessions, err := readSessionsFile()
	if err != nil {
		return err
	}
	wf, err := workoutFiles()
	if err != nil {
		return err
	}

	if dryRun {
		log.Printf("[dry-run] à importer : %d users, %d sessions, %d workouts — aucune écriture",
			len(users), len(sessions), len(wf))
		return nil
	}

	db, err := openDB()
	if err != nil {
		return err
	}
	defer db.Close()

	// Schéma (idempotent) — la base peut être vierge.
	for _, stmt := range strings.Split(schemaDDL, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("schéma: %w", err)
		}
	}

	// --- users ---
	const upUser = `INSERT INTO users
  (id,email_lower,password_hash,created_at,is_admin,totp_secret,health_consent,
   algo_opt_out,physio_tokens,physio_webhook_secret,physio_last_sync,recovery_codes)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON DUPLICATE KEY UPDATE
   email_lower=VALUES(email_lower), password_hash=VALUES(password_hash),
   created_at=VALUES(created_at), is_admin=VALUES(is_admin),
   totp_secret=VALUES(totp_secret), health_consent=VALUES(health_consent),
   algo_opt_out=VALUES(algo_opt_out), physio_tokens=VALUES(physio_tokens),
   physio_webhook_secret=VALUES(physio_webhook_secret),
   physio_last_sync=VALUES(physio_last_sync), recovery_codes=VALUES(recovery_codes)`
	for _, u := range users {
		consent, err := jsonColOrNil(u.HealthConsent)
		if err != nil {
			return fmt.Errorf("user %s consent: %w", u.ID, err)
		}
		tokens, err := jsonColOrNil(u.PhysioTokens)
		if err != nil {
			return fmt.Errorf("user %s tokens: %w", u.ID, err)
		}
		lastSync, err := jsonColOrNil(u.PhysioLastSync)
		if err != nil {
			return fmt.Errorf("user %s lastSync: %w", u.ID, err)
		}
		codes, err := jsonColOrNil(u.RecoveryCodes)
		if err != nil {
			return fmt.Errorf("user %s recovery: %w", u.ID, err)
		}
		if _, err := db.Exec(upUser,
			u.ID, u.EmailLower, u.PasswordHash, u.CreatedAt.UTC(), u.IsAdmin,
			strColOrNil(u.TOTPSecret), consent, u.AlgoOptOut, tokens,
			strColOrNil(u.PhysioWebhookSecret), lastSync, codes,
		); err != nil {
			return fmt.Errorf("insert user %s: %w", u.ID, err)
		}
	}

	// --- sessions ---
	const upSess = `INSERT INTO sessions (sid,user_id,created_at,expires_at,last_extended_at)
  VALUES (?,?,?,?,?)
  ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), created_at=VALUES(created_at),
   expires_at=VALUES(expires_at), last_extended_at=VALUES(last_extended_at)`
	for sid, s := range sessions {
		var ext any
		if !s.LastExtendedAt.IsZero() {
			ext = s.LastExtendedAt.UTC()
		}
		if _, err := db.Exec(upSess, sid, s.UserID, s.CreatedAt.UTC(), s.ExpiresAt.UTC(), ext); err != nil {
			return fmt.Errorf("insert session %s: %w", sid, err)
		}
	}

	// --- workouts (blob opaque conservé tel quel) ---
	const upWk = `INSERT INTO workouts (user_id,data,updated_at)
  VALUES (?,?,?)
  ON DUPLICATE KEY UPDATE data=VALUES(data), updated_at=VALUES(updated_at)`
	for uid, path := range wf {
		b, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read workout %s: %w", uid, err)
		}
		if !json.Valid(b) {
			return fmt.Errorf("workout %s: JSON invalide", uid)
		}
		info, _ := os.Stat(path)
		mtime := time.Now().UTC()
		if info != nil {
			mtime = info.ModTime().UTC()
		}
		if _, err := db.Exec(upWk, uid, b, mtime); err != nil {
			return fmt.Errorf("insert workout %s: %w", uid, err)
		}
	}

	log.Printf("import OK : %d users, %d sessions, %d workouts", len(users), len(sessions), len(wf))
	return nil
}

// runVerify recompte et compare la base aux fichiers. Échoue (exit != 0) au
// moindre écart de cardinalité ou de contenu workout.
func runVerify() error {
	users, err := readUsersFile()
	if err != nil {
		return err
	}
	sessions, err := readSessionsFile()
	if err != nil {
		return err
	}
	wf, err := workoutFiles()
	if err != nil {
		return err
	}

	db, err := openDB()
	if err != nil {
		return err
	}
	defer db.Close()

	var nUsers, nSess, nWk int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&nUsers); err != nil {
		return err
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&nSess); err != nil {
		return err
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM workouts`).Scan(&nWk); err != nil {
		return err
	}

	var problems []string
	if nUsers != len(users) {
		problems = append(problems, fmt.Sprintf("users: fichier=%d base=%d", len(users), nUsers))
	}
	if nSess != len(sessions) {
		problems = append(problems, fmt.Sprintf("sessions: fichier=%d base=%d", len(sessions), nSess))
	}
	if nWk != len(wf) {
		problems = append(problems, fmt.Sprintf("workouts: fichier=%d base=%d", len(wf), nWk))
	}

	// Intégrité de contenu des workouts : on compare le JSON canonicalisé
	// (Go json.Marshal trie les clés de map → comparaison stable malgré la
	// reformulation par la colonne JSON de MariaDB).
	uids := make([]string, 0, len(wf))
	for uid := range wf {
		uids = append(uids, uid)
	}
	sort.Strings(uids)
	for _, uid := range uids {
		fileCanon, err := canonJSONFile(wf[uid])
		if err != nil {
			problems = append(problems, fmt.Sprintf("workout %s: lecture fichier: %v", uid, err))
			continue
		}
		var raw []byte
		err = db.QueryRow(`SELECT data FROM workouts WHERE user_id=?`, uid).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			problems = append(problems, fmt.Sprintf("workout %s: absent en base", uid))
			continue
		}
		if err != nil {
			return err
		}
		dbCanon, err := canonJSONBytes(raw)
		if err != nil {
			problems = append(problems, fmt.Sprintf("workout %s: JSON base illisible: %v", uid, err))
			continue
		}
		if fileCanon != dbCanon {
			problems = append(problems, fmt.Sprintf("workout %s: contenu divergent (sha fichier=%s base=%s)",
				uid, shortSha(fileCanon), shortSha(dbCanon)))
		}
	}

	if len(problems) > 0 {
		for _, p := range problems {
			log.Printf("ÉCART: %s", p)
		}
		return fmt.Errorf("%d écart(s) détecté(s)", len(problems))
	}
	log.Printf("verify OK : users=%d sessions=%d workouts=%d, contenus identiques, 0 écart",
		len(users), len(sessions), len(wf))
	return nil
}

func canonJSONFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return canonJSONBytes(b)
}

func canonJSONBytes(b []byte) (string, error) {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return "", err
	}
	out, err := json.Marshal(v) // Go trie les clés → forme canonique
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func shortSha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:4])
}
