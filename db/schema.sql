-- =============================================================
-- Coach Adaptatif — schéma SQL (MariaDB), stratégie « lift & shift »
-- =============================================================
-- Une table par store de fichiers actuel. Les blobs opaques (workouts) et
-- les champs map/array (consentement, tokens, codes de secours) restent du
-- JSON — la forme côté client ne change pas. Normaliser viendra plus tard,
-- table par table, si le requêtage le justifie.
--
-- Ce fichier est fourni pour référence / revue. Tu n'as PAS besoin de le
-- jouer à la main : la sous-commande `coach-app --import` crée ces tables
-- (CREATE TABLE IF NOT EXISTS) avant d'insérer. Le `up` peut donc lancer
-- une base totalement vierge.
-- =============================================================

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
