# Politique de sécurité

## Versions supportées

Seule la branche `main` reçoit des correctifs de sécurité. Les tags
publiés sont versionnés en SemVer ; les correctifs sont rétroportés
uniquement sur la version mineure courante.

| Version | Supportée |
| ------- | :-------: |
| latest (`main`) | ✅ |
| dernière mineure | ✅ |
| versions antérieures | ❌ |

## Signaler une vulnérabilité

**Ne pas ouvrir d'issue publique pour une faille de sécurité.**

Préférer l'un de ces canaux privés :

1. **GitHub Security Advisory** — onglet `Security` du repo →
   *Report a vulnerability*. C'est la voie privilégiée : ça crée un
   draft privé que seul le mainteneur voit, et ça permet de coordonner
   la divulgation.
2. **Email** : signalement chiffré bienvenu, contact via le profil
   GitHub du mainteneur.

Inclure dans le rapport :
- Description de la faille et de l'impact.
- Étapes de reproduction (PoC si possible).
- Version concernée (commit ou tag).
- Suggestion de correctif si tu en as une.

## Délais

| Étape | Délai cible |
| ----- | ----------- |
| Accusé de réception | 72h |
| Évaluation initiale (sévérité, périmètre) | 7 jours |
| Correctif proposé | dépend de la sévérité (cf. ci-dessous) |
| Divulgation publique coordonnée | après release du correctif |

Sévérité indicative :
- **Critique** (RCE, contournement auth, fuite de données massive) :
  correctif sous 7 jours, advisory immédiat.
- **Haute** (escalade de privilège, XSS authentifié, IDOR) : correctif
  sous 30 jours.
- **Moyenne / Basse** : intégré au cycle normal.

## Périmètre

**Inclus** :
- Le binaire backend (Go) et toute son API HTTP.
- Le frontend statique servi par le binaire.
- Les fichiers de déploiement fournis (Dockerfile, compose, nginx,
  systemd unit) **dans leur configuration par défaut**.

**Hors périmètre** :
- Les déploiements custom (configs nginx/Caddy modifiées, reverse proxy
  mal configuré côté utilisateur).
- Les attaques nécessitant un accès physique à la machine ou root sur
  l'hôte.
- Les dépendances en amont (`golang.org/x/crypto`, image distroless,
  etc.) — à signaler à leurs mainteneurs respectifs.
- Les bugs purement fonctionnels sans impact sécurité.

## Bonnes pratiques pour les utilisateurs

- Toujours déployer derrière un reverse proxy avec TLS (Caddy/nginx).
- Garder `COACH_TOKEN_KEY` secret. La perdre rend les tokens API
  chiffrés (Strava, Oura, etc.) illisibles, mais la divulguer permet
  de les déchiffrer.

### Rotation de `COACH_TOKEN_KEY`

En cas de fuite (ou par hygiène périodique), la sous-commande
`--rotate-key` ré-encrypte tous les secrets at-rest (TOTP + tokens API)
de l'ancienne clé vers la nouvelle, en une transaction, tout-ou-rien :

```bash
docker compose stop coach-app          # l'app doit être arrêtée
docker compose run --rm \
  -e COACH_TOKEN_KEY_OLD="<ancienne clé>" \
  -e COACH_TOKEN_KEY="$(openssl rand -hex 32)" \
  coach-app --rotate-key
# → noter la nouvelle clé affichée dans la commande ci-dessus,
#   la reporter dans .env (COACH_TOKEN_KEY=…)
docker compose up -d coach-app
```

Idempotent (re-run sans danger). Faire un backup avant
(`docker compose run --rm db-backup once`).
- Garder `COACH_2FA_REQUIRED=1` (défaut) en production.
- Garder `COACH_ALLOW_REGISTRATION=0` (défaut) sauf usage explicitement
  public.
- Suivre les releases : les advisories sont publiés via le mécanisme
  GitHub Security Advisories.

## Hall of fame

Les chercheurs ayant signalé responsablement seront crédités ici (avec
leur accord), une fois la faille corrigée et publiquement divulguée.

— *(vide pour l'instant)*
