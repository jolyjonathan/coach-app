# Estimation — migration vers une base SQL

_Coach Adaptatif — 14 juin 2026_

Hypothèses : un seul développeur Go expérimenté, instance self-hosted mono-binaire conservée, **reprise intégrale des données prod existantes (zéro perte)** comme contrainte dure.

---

## 1. État actuel (surface à migrer)

La source de vérité est **en mémoire** ; les fichiers ne sont que des snapshots. Tout passe par `writeJSONAtomic` (tmp+rename, `.bak` quotidien) et, pour users/sessions, par le flusher à dirty-flag (`store.go`, fenêtre ~2 s).

Arborescence `./data/` à reprendre :

| Fichier | Contenu | Mécanisme |
|---|---|---|
| `users.json` | tableau de `User` (auth bcrypt, TOTP chiffré, consentement RGPD, `PhysioTokens` chiffrés dont Strava, webhook secret, `RecoveryCodes` bcrypt) | mémoire + flusher |
| `sessions.json` | `map[sid]Session` | mémoire + flusher |
| `workouts/<uid>.json` | blob **opaque** par utilisateur : `profile`, `history`, `currentSession`, `formScore`, `adjustments`, `notes`, `rehab`, `body{hooper,lifestyle,pvt,intentions,weights,measurements,physio}`, `macrocycle` | lecture/écriture fichier complet, mutex par user, ETag |
| `workouts/<uid>.json.bak` | backup quotidien best-effort | `writeJSONAtomic` |
| `admin-audit.log` / `auth-audit.log` | JSON Lines append-only, rotation 12 mois | append sous mutex |
| `ratelimit.json` | snapshot éphémère | périodique |
| `.admin-bootstrap-done`, sentinelles | marqueurs | one-shot |

Points structurants pour l'effort :
- Le blob `workouts` est **produit et consommé par ~24 k lignes de JS** (front sans framework). Sa forme vit côté client → le normaliser côté serveur est coûteux.
- Champs chiffrés (TOTP, tokens) avec migration au load (`reencrypt…`) : à préserver tels quels.
- ~7,5 k lignes de Go, persistance concentrée dans `data.go`, `auth.go`, `session.go`, `store.go`, `physio.go`, `admin.go`.

---

## 2. Décisions qui pilotent le coût

**Moteur — SQLite, driver pur-Go (`modernc.org/sqlite`).** Reste embarqué dans le binaire, pas de CGO, cross-compilation et `docker compose up -d` intacts. Postgres casserait le mono-binaire → écarté à ce stade.

**Modèle de données — deux niveaux de scope :**
- **Lift & shift** : une ligne par user avec le blob en colonne `JSON`/`TEXT`. Conserve la forme opaque, le front ne bouge pas. Gain : transactions, requêtes cross-users, durabilité immédiate, fin de la fenêtre 2 s.
- **Normalisé** : vraies tables `history`, `sets`, `physio`, `body_metrics`… Gain réel (requêtes serveur, écritures partielles, pagination), mais impose une couche décompose/recompose côté serveur **ou** une réécriture front.

**Source de vérité :** users/sessions restent en mémoire en *write-through* (petits, déjà conçus ainsi) ; `workouts` passe DB-backed par requête (c'est là qu'est la douleur du blob qui grossit).

---

## 3. Estimation chiffrée

### Option A — Lift & shift (recommandée en premier)

| Lot | Détail | Jours-dev |
|---|---|---|
| Socle DB | driver, ouverture `*sql.DB`, WAL + `busy_timeout`, framework de migrations (`PRAGMA user_version`) | 1–2 |
| Users + sessions | réécrire `loadUsers/saveUsers/loadSessions/saveSessions`, retirer le flusher `store.go`, garder write-through | 2–3 |
| Workouts | `handleLoadData/handleSaveData/handleExport`, merge physio webhook, ETag recalculé depuis `updated_at`/checksum | 2–3 |
| **Importeur prod** | sous-commande `--import` lisant `./data`, idempotente, + vérif comptes & checksums | 2–3 |
| RGPD | export art. 20 (requête), effacement art. 17 (`DELETE` + `VACUUM`), remplacement des `.bak` par `VACUUM INTO` | 1–2 |
| Tests | bascule des helpers (`dataDir = t.TempDir()` → SQLite temp/mémoire), `data_test`, `physio_test`, store | 2–3 |
| Ops & cutover | volume Docker (`.db`), scripts backup, runbook de bascule + rollback, dry-run staging | 1–2 |
| Intégration / QA / buffer | | 2–3 |
| **Total** | | **13–21 j** (~3–4 semaines calendaires) |

### Option B — Schéma normalisé

Tout l'Option A **plus** : design du schéma relationnel, décomposition du blob opaque (mapping piloté aujourd'hui par le JS), endpoints granulaires ou couche de recompose serveur, requêtes serveur, et **modifications front** (le blob est l'objet pivot du SPA).

Surcoût : **+10–20 j**, dont une part non triviale côté front. **Total ≈ 5–8 semaines.**

---

## 4. Reprise des données prod (zéro perte)

1. **Importeur idempotent** : `coach --import ./data` insère users, sessions, chaque `workouts/<uid>.json`, et (si retenu) les logs d'audit. Réexécutable sans doublon (upsert par clé).
2. **Dry-run staging** : import sur une copie, vérification automatique = nombre d'users/sessions + checksum par blob comparé au JSON source. Aucun écart toléré.
3. **Fenêtre de maintenance courte** : stop des écritures → import → vérif → démarrage du binaire pointant la DB.
4. **Rollback instantané** : l'arborescence `./data` reste **intacte en lecture seule** N jours ; revenir = relancer l'ancien binaire.
5. **Option max-sécurité (dual-write)** : phase transitoire où l'app écrit fichiers **et** DB → rollback sans perte même après reprise du trafic. Ajoute ~2–3 j mais supprime le risque de cutover.

Les champs chiffrés migrent tels quels (l'enveloppe `ENC:v1:` est conservée colonne par colonne) ; la migration `reencrypt…` au load tourne une dernière fois dans l'importeur.

---

## 5. Risques principaux

- **Perte au cutover** → mitigé par import-vérifie-bascule + fichiers gardés en read-only (et dual-write si on veut le zéro-risque).
- **`SQLITE_BUSY` sous concurrence** → WAL + `busy_timeout`, un seul `*sql.DB`. La logique de mutex par user de `data.go` peut disparaître (la DB sérialise).
- **Corruption de forme du blob** → évitée en Option A (forme préservée).
- **Build CGO** → évité par `modernc.org/sqlite` (pur Go).
- **Durabilité** : la fenêtre de 2 s disparaît (commits durables) — gain de correction, mais il faut retirer proprement le pattern dirty-flag.

Faible enjeu, peuvent rester en fichiers au début : `ratelimit.json` (éphémère) et les deux `*-audit.log` (append-only, jamais lus à chaud).

---

## 6. Recommandation

Faire **Option A d'abord** : on passe sur une vraie base (ACID, requêtes, durabilité) avec un risque maîtrisé et zéro perte de données, sans toucher au front. Puis **normaliser au coup par coup** les sous-ensembles où le requêtage paie vraiment — typiquement `body.physio` et `history` extraits en tables — une fois la base SQLite en place. Ce phasage étale le risque et livre le gros du bénéfice (fin du blob réécrit en entier, transactions, requêtes admin) dès la première étape.

Si l'instance est mono-utilisateur ou à faible volume d'historique, le coût d'Option A ne se justifie pas encore : le déclencheur, c'est la taille de l'historique par user et le besoin de requêtes serveur.
