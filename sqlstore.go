package main

/*
sqlstore.go — backend de persistance SQL (MariaDB).

Bascule de stockage SANS toucher au modèle runtime : les maps en mémoire
(usersByID, sessionStore) restent la source de vérité pendant l'exécution ;
ce fichier ne change QUE le support de persistance — fichiers JSON ⇄ MariaDB.

Activation : si COACH_DB (DSN) est défini, initSQL() ouvre la connexion et
dbConn != nil → tous les chemins de persistance passent par la base. Sinon
dbConn == nil → comportement fichiers historique inchangé (et les tests, qui
n'ont pas de base, continuent de tourner sur tmpdir).

Stratégie « lift & shift » :
  - users / sessions : on réécrit l'ensemble du snapshot à chaque save
    (DELETE + INSERT en transaction). Sémantique identique à l'ancienne
    réécriture complète de users.json / sessions.json, donc aucun call site
    de mutation ne change. Coût négligeable pour une instance self-hosted ;
    une écriture par-ligne viendra avec la normalisation, plus tard.
  - workouts : déjà par-utilisateur → lecture/écriture d'une seule ligne.

Le driver mysql est enregistré via l'import blank de migrate.go.
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
)

var (
	dbConn *sql.DB
	// Sérialise les réécritures complètes (DELETE+INSERT) pour éviter
	// l'entrelacement de deux transactions de snapshot.
	dbUsersWriteMu sync.Mutex
	dbSessWriteMu  sync.Mutex
)

// storageIsSQL indique si le backend base est actif.
func storageIsSQL() bool { return dbConn != nil }

// initSQL ouvre la connexion (COACH_DB) et garantit le schéma (idempotent).
func initSQL() error {
	db, err := openDB() // défini dans migrate.go
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

// loadWorkout renvoie le JSON brut du data file utilisateur (nil si absent).
// Unifie les deux backends pour les handlers de data.go / physio.go.
func loadWorkout(uid string) ([]byte, error) {
	if storageIsSQL() {
		var data []byte
		err := dbConn.QueryRow(`SELECT data FROM workouts WHERE user_id=?`, uid).Scan(&data)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return data, err
	}
	b, err := os.ReadFile(dataPath(uid))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return b, err
}

// saveWorkout persiste l'objet workout (déjà validé/filtré par l'appelant).
func saveWorkout(uid string, v any) error {
	if storageIsSQL() {
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
	return writeJSONAtomic(dataPath(uid), v, 0o600)
}

// deleteWorkout efface les données workout de l'utilisateur (RGPD art. 17).
func deleteWorkout(uid string) {
	if storageIsSQL() {
		_, _ = dbConn.Exec(`DELETE FROM workouts WHERE user_id=?`, uid)
		return
	}
	p := dataPath(uid)
	_ = os.Remove(p)
	_ = os.Remove(p + ".bak")
}
