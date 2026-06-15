package main

/*
sqlstore.go — persistance MariaDB (unique backend).

Les données utilisateur (users, sessions, workouts) vivent en base. Le modèle
runtime ne change pas : les maps en mémoire (usersByID, sessionStore) restent la
source de vérité pendant l'exécution ; ce fichier est le support de persistance.

COACH_DB (DSN) est OBLIGATOIRE — le binaire refuse de démarrer sans (main.go).
Il n'y a plus de backend fichiers ni d'étape de migration : le schéma est
garanti idempotemment au boot, une base vierge est créée à la volée.

Stratégie « lift & shift » :
  - users / sessions : réécriture du snapshot complet à chaque save
    (DELETE + INSERT en transaction) — sémantique identique à l'ancienne
    réécriture de fichier, aucun call site de mutation ne change.
  - workouts : déjà par-utilisateur → lecture/écriture d'une seule ligne.

Note : ratelimit.json et les journaux d'audit (auth-audit.log, admin-audit.log)
restent des fichiers — ce sont des artefacts opérationnels, pas des données
utilisateur, et ils ne transitent jamais par ce store.
*/

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

var (
	dbConn *sql.DB
	// Sérialise les réécritures complètes (DELETE+INSERT) pour éviter
	// l'entrelacement de deux transactions de snapshot.
	dbUsersWriteMu sync.Mutex
	dbSessWriteMu  sync.Mutex
)

// schemaDDL est joué à l'init : la base peut être totalement vierge au premier
// démarrage. Idempotent.
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

// initSQL ouvre la connexion et garantit le schéma. Appelé au boot (main.go)
// et par le harnais de test.
func initSQL() error {
	db, err := openDB()
	if err != nil {
		return err
	}
	for _, stmt := range strings.Split(schemaDDL, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return fmt.Errorf("schéma: %w", err)
		}
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxIdleTime(5 * time.Minute)
	dbConn = db
	return nil
}

// closeSQL ferme la connexion (appelé au shutdown).
func closeSQL() {
	if dbConn != nil {
		_ = dbConn.Close()
	}
}

// jsonColOrNil sérialise v pour une colonne JSON nullable. Renvoie nil
// (→ SQL NULL) quand v est vide/nil.
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

// ---------- users ----------

const userSelectCols = `id,email_lower,password_hash,created_at,is_admin,totp_secret,
 health_consent,algo_opt_out,physio_tokens,physio_webhook_secret,physio_last_sync,recovery_codes`

func dbLoadUsers() ([]*User, error) {
	rows, err := dbConn.Query(`SELECT ` + userSelectCols + ` FROM users`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []*User
	for rows.Next() {
		u := &User{}
		var totp, webhook sql.NullString
		var consent, tokens, lastSync, codes []byte
		if err := rows.Scan(
			&u.ID, &u.EmailLower, &u.PasswordHash, &u.CreatedAt, &u.IsAdmin, &totp,
			&consent, &u.AlgoOptOut, &tokens, &webhook, &lastSync, &codes,
		); err != nil {
			return nil, err
		}
		if totp.Valid {
			u.TOTPSecret = totp.String
		}
		if webhook.Valid {
			u.PhysioWebhookSecret = webhook.String
		}
		if len(consent) > 0 {
			_ = json.Unmarshal(consent, &u.HealthConsent)
		}
		if len(tokens) > 0 {
			_ = json.Unmarshal(tokens, &u.PhysioTokens)
		}
		if len(lastSync) > 0 {
			_ = json.Unmarshal(lastSync, &u.PhysioLastSync)
		}
		if len(codes) > 0 {
			_ = json.Unmarshal(codes, &u.RecoveryCodes)
		}
		list = append(list, u)
	}
	return list, rows.Err()
}

const upUserSQL = `INSERT INTO users
 (id,email_lower,password_hash,created_at,is_admin,totp_secret,health_consent,
  algo_opt_out,physio_tokens,physio_webhook_secret,physio_last_sync,recovery_codes)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`

func dbSaveAllUsers(users []*User) error {
	dbUsersWriteMu.Lock()
	defer dbUsersWriteMu.Unlock()
	tx, err := dbConn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM users`); err != nil {
		return err
	}
	stmt, err := tx.Prepare(upUserSQL)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, u := range users {
		consent, err := jsonColOrNil(u.HealthConsent)
		if err != nil {
			return err
		}
		tokens, err := jsonColOrNil(u.PhysioTokens)
		if err != nil {
			return err
		}
		lastSync, err := jsonColOrNil(u.PhysioLastSync)
		if err != nil {
			return err
		}
		codes, err := jsonColOrNil(u.RecoveryCodes)
		if err != nil {
			return err
		}
		if _, err := stmt.Exec(
			u.ID, u.EmailLower, u.PasswordHash, u.CreatedAt.UTC(), u.IsAdmin,
			strColOrNil(u.TOTPSecret), consent, u.AlgoOptOut, tokens,
			strColOrNil(u.PhysioWebhookSecret), lastSync, codes,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---------- sessions ----------

func dbLoadSessions() (map[string]Session, error) {
	rows, err := dbConn.Query(`SELECT sid,user_id,created_at,expires_at,last_extended_at FROM sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Session{}
	for rows.Next() {
		var sid string
		var s Session
		var ext sql.NullTime
		if err := rows.Scan(&sid, &s.UserID, &s.CreatedAt, &s.ExpiresAt, &ext); err != nil {
			return nil, err
		}
		if ext.Valid {
			s.LastExtendedAt = ext.Time
		}
		out[sid] = s
	}
	return out, rows.Err()
}

func dbSaveAllSessions(m map[string]Session) error {
	dbSessWriteMu.Lock()
	defer dbSessWriteMu.Unlock()
	tx, err := dbConn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM sessions`); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO sessions (sid,user_id,created_at,expires_at,last_extended_at) VALUES (?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for sid, s := range m {
		var ext any
		if !s.LastExtendedAt.IsZero() {
			ext = s.LastExtendedAt.UTC()
		}
		if _, err := stmt.Exec(sid, s.UserID, s.CreatedAt.UTC(), s.ExpiresAt.UTC(), ext); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---------- workouts (blob par utilisateur) ----------

// loadWorkout renvoie le JSON brut des données workout (nil si absent).
func loadWorkout(uid string) ([]byte, error) {
	var data []byte
	err := dbConn.QueryRow(`SELECT data FROM workouts WHERE user_id=?`, uid).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return data, err
}

// saveWorkout persiste l'objet workout (déjà validé/filtré par l'appelant).
func saveWorkout(uid string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = dbConn.Exec(
		`INSERT INTO workouts (user_id,data,updated_at) VALUES (?,?,?)
		 ON DUPLICATE KEY UPDATE data=VALUES(data), updated_at=VALUES(updated_at)`,
		uid, b, time.Now().UTC())
	return err
}

// deleteWorkout efface les données workout de l'utilisateur (RGPD art. 17).
func deleteWorkout(uid string) {
	_, _ = dbConn.Exec(`DELETE FROM workouts WHERE user_id=?`, uid)
}

// workoutMeta indique si l'utilisateur a des données workout et la date de
// dernière écriture (sert à la vue admin : HasData / LastSeen).
func workoutMeta(uid string) (bool, time.Time) {
	var t time.Time
	if err := dbConn.QueryRow(`SELECT updated_at FROM workouts WHERE user_id=?`, uid).Scan(&t); err != nil {
		return false, time.Time{}
	}
	return true, t
}
