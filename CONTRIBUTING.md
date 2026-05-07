# Contribuer à Coach Adaptatif

Merci de l'intérêt porté au projet. Ce guide résume le workflow attendu
pour contribuer du code, de la documentation ou un bug report.

## Signaler un bug

1. Vérifier qu'aucun ticket existant n'en parle déjà.
2. Ouvrir une issue avec :
   - **Version** (commit hash ou tag).
   - **OS / runtime** (bare metal Linux, Docker, navigateur si frontend).
   - **Étapes de reproduction** minimales.
   - **Comportement attendu vs observé**.
   - Logs pertinents (sans secret ni donnée perso).

Pour une faille de sécurité, suivre la procédure dans `SECURITY.md` —
**ne pas ouvrir d'issue publique**.

## Proposer un changement

### Avant d'écrire du code

Pour un changement non-trivial (nouvelle feature, refacto large), ouvrir
d'abord une issue pour valider l'approche. Évite les PR rejetées pour
raisons de scope.

### Workflow

1. Fork du repo, branche dédiée à partir de `main` :
   ```bash
   git checkout -b feat/ma-feature
   ```
2. Coder, en respectant les conventions ci-dessous.
3. Lancer les tests :
   ```bash
   go test ./...
   go vet ./...
   ```
4. Commit avec un message descriptif (voir plus bas).
5. Push sur ton fork et ouvrir une PR vers `main`.
6. La CI doit passer (build + test + lint).
7. Au moins une review approuvée avant merge.

### Conventions de code

**Backend (Go)**
- `gofmt` obligatoire (la CI rejette tout fichier non formaté).
- `go vet` doit passer.
- Pas de framework externe sans discussion préalable. Stack actuelle :
  `net/http` + `golang.org/x/crypto`. C'est volontaire.
- Tests unitaires pour toute logique non-triviale, dans des fichiers
  `*_test.go` à côté du code.
- Les commentaires sont en français ou en anglais — rester cohérent
  dans un même fichier.

**Frontend (vanilla JS)**
- Pas de bundler, pas de npm. Code servi tel quel.
- Modules en IIFE ou ESM selon ce qui existe déjà dans le fichier.
- Pas de dépendance externe ajoutée sans discussion.

**Stockage**
- Toute nouvelle clé persistée dans le data file utilisateur doit être
  ajoutée à la whitelist dans `data.go`. Sinon elle sera rejetée.

### Messages de commit

Format suggéré (pas obligatoire mais préféré) :
```
<type>: <description courte>

<corps optionnel — pourquoi, pas quoi>
```

Types : `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `security`.

Exemple :
```
fix: rejeter les sessions expirées dans middleware.go

Le check d'expiration était fait après la lecture du user, ce qui permettait
à une session morte d'accéder au profil pendant 1 requête. Corrigé en
déplaçant le check avant le chargement du user.
```

## Domaines où l'aide est bienvenue

- Tests d'intégration end-to-end (frontend + backend).
- Documentation : exemples de déploiement (Caddy, Traefik, k8s).
- Audit de sécurité, pentests informels.
- i18n : la majorité du frontend est en FR, il y a un fallback EN partiel.
- Revue des modèles statistiques (`bayesian.js`, `banister.js`,
  `programming.js`) par des praticiens / chercheurs.

## Code of conduct

Sois respectueux. Pas de discrimination, pas d'attaques personnelles.
Les discussions techniques peuvent être directes mais doivent rester
constructives. Tout comportement abusif entraîne un ban du repo.
