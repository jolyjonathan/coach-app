# Intégrations Wearables & Santé

État courant :

| Provider         | Type                      | État          |
|------------------|---------------------------|---------------|
| **Strava**       | OAuth2 + webhooks push    | ✅ implémenté |
| **Apple Health** | Webhook signé (Shortcut iOS) | ✅ implémenté |

L'utilisateur final n'a **qu'une seule manipulation** à faire par provider :
cliquer le bouton de connexion Strava (popup OAuth officielle) ou copier
l'URL webhook dans son Raccourci iOS. Tout le reste — refresh des tokens,
réception des nouvelles activités, normalisation des métriques — se passe
automatiquement.

Ce document couvre **la configuration côté opérateur** : ce qu'il faut faire
une fois pour activer Strava sur une instance déployée. Apple Health ne
demande aucune configuration serveur (le webhook signé est généré à la
volée pour chaque user au moment où il clique « Configurer Apple Health »).

---

## Configuration Strava (déploiement Docker)

L'app est livrée avec Strava déjà câblé côté code mais désactivé tant que
les variables d'environnement ne sont pas renseignées. Si elles sont
vides, le bouton « Se connecter avec Strava » répond 503
(`Strava non configuré`) sans casser le reste de l'application — c'est
voulu pour qu'une instance puisse boot sans dépendre de Strava.

Il faut **trois étapes** : créer une app Strava, peupler le `.env`, puis
souscrire le webhook une fois l'instance joignable depuis Internet.

### Pré-requis

- L'instance Coach Adaptatif tourne dans un conteneur Docker via le
  `docker-compose.yml` fourni.
- L'instance est exposée sur un domaine HTTPS public (Strava refuse les
  callbacks vers du HTTP en clair sauf `localhost` pour le dev). Mets
  un reverse proxy (Caddy, nginx, Traefik) devant le conteneur pour
  obtenir un certificat. Le compose expose déjà `127.0.0.1:8080` côté
  host, donc proxy → `127.0.0.1:8080`.
- Tu as un compte admin sur l'instance (pour appeler l'endpoint de
  souscription webhook).

### Étape 1 — Créer l'app Strava

1. Connecte-toi sur https://www.strava.com/settings/api avec un compte
   Strava perso (la création d'app est gratuite, pas besoin d'être un
   « partenaire commercial »).
2. Si c'est ton premier accès, Strava te demandera quelques infos pour
   créer ta première application — remplis avec :
   - **Application Name** : `Coach Adaptatif` (ou ce que tu veux)
   - **Category** : `Training`
   - **Club** : laisser vide
   - **Website** : `https://coach.exemple.com` (l'URL publique de ton
     instance)
   - **Application Description** : court résumé en français ou anglais
   - **Authorization Callback Domain** : `coach.exemple.com`
     **⚠️  Domaine seul, sans `https://`, sans port, sans path.**
     Si tu mets `https://coach.exemple.com` ou `coach.exemple.com:8080`,
     Strava rejettera tous tes callbacks plus tard avec une erreur
     opaque. C'est le piège classique.
3. Une fois créée, l'app te donne un **Client ID** (numérique court,
   ex: `123456`) et un **Client Secret** (40 hex chars). Note-les.

Tant que tu y es, ouvre un terminal et génère un `STRAVA_VERIFY_TOKEN`
random :

```sh
openssl rand -hex 16
```

Garde-le précieusement — si tu le changes plus tard il faudra re-souscrire
le webhook (Strava le compare lors du handshake initial).

### Étape 2 — Peupler le `.env`

Dans le `.env` à côté de ton `docker-compose.yml`, ajoute :

```env
STRAVA_CLIENT_ID=123456
STRAVA_CLIENT_SECRET=0000111122223333444455556666777788889999
STRAVA_VERIFY_TOKEN=ab12cd34ef56...                # ce que tu viens de générer
STRAVA_WEBHOOK_URL=https://coach.exemple.com/api/strava/webhook
# STRAVA_REDIRECT_URI=...   # optionnel, voir plus bas
```

`STRAVA_WEBHOOK_URL` doit pointer sur `/api/strava/webhook` de ton
instance, joignable depuis Internet (Strava ping cette URL pour push les
events).

`STRAVA_REDIRECT_URI` est **optionnel**. Le serveur le déduit de la
requête entrante avec `X-Forwarded-Proto`. Si ton reverse proxy ne forwarde
pas correctement le scheme, ou que tu veux figer la valeur, set la
variable explicitement :

```env
STRAVA_REDIRECT_URI=https://coach.exemple.com/auth/strava/callback
```

Cette URL doit avoir le même domaine (sans préfixe `www.` ou autre) que
le « Authorization Callback Domain » que tu as déclaré à l'étape 1.

Relance ensuite le conteneur pour qu'il prenne les nouvelles variables :

```sh
docker compose up -d
```

À ce stade, le bouton « Se connecter avec Strava » dans le panneau profil
de l'app fonctionne pour le flow OAuth — l'utilisateur peut autoriser et
ses tokens sont stockés. Mais **les nouvelles activités n'arriveront pas
encore en push** tant qu'on n'a pas dit à Strava où les envoyer.

### Étape 3 — Souscrire le webhook

Strava ne push pas spontanément les events : il faut lui dire une fois
« voici l'URL où tu dois m'envoyer les events de mes utilisateurs ». L'app
expose un endpoint admin qui fait l'appel sortant pour toi :

`POST /api/admin/strava/subscribe`

Comme c'est un endpoint authentifié (admin + 2FA + CSRF double-submit), le
plus simple est de le déclencher depuis le navigateur, connecté en tant
qu'admin :

1. Ouvre les DevTools (F12) sur ton instance, onglet **Console**.
2. Récupère le token CSRF :
   ```js
   const { token } = await fetch('/api/csrf').then(r => r.json());
   ```
3. Appelle l'endpoint :
   ```js
   const r = await fetch('/api/admin/strava/subscribe', {
     method: 'POST',
     headers: { 'X-CSRF-Token': token },
     credentials: 'same-origin',
   });
   console.log(r.status, await r.text());
   ```
4. Tu dois voir une réponse 200 avec un payload JSON contenant un `id`
   (l'ID de la subscription côté Strava). Note-le quelque part — utile
   pour debugger ou supprimer la subscription plus tard via l'API Strava.

Sous le capot, le serveur fait un `POST` vers
`https://www.strava.com/api/v3/push_subscriptions` avec ton `client_id`,
`client_secret`, `STRAVA_WEBHOOK_URL`, et `STRAVA_VERIFY_TOKEN`. Strava
vérifie l'URL en faisant un `GET` avec un challenge (que notre handler
reconnaît et echo automatiquement).

Si la réponse n'est pas 200 :
- **400 « callback_url not verifiable »** : Strava n'arrive pas à joindre
  ton webhook. Vérifie que `STRAVA_WEBHOOK_URL` est bien publique en
  HTTPS, sans firewall sortant qui bloque, et que `STRAVA_VERIFY_TOKEN`
  est défini (sinon le handler répond 503).
- **400 « already exists »** : il y a déjà une subscription active pour
  ton app. Une seule app Strava = une seule subscription globale (pas
  par-user). C'est OK, tu peux passer à l'étape suivante.

Une seule subscription suffit pour toute l'instance — elle reçoit les
events de tous les athletes connectés via OAuth.

### Vérifier que ça marche

1. Sur l'instance, va dans le panneau profil → carte Strava → clique
   « Se connecter avec Strava ». Tu dois voir la popup d'autorisation
   officielle Strava (pas une page d'erreur).
2. Autorise. La popup affiche « ✓ Connecté à Strava » puis se referme
   toute seule.
3. Le panneau se rafraîchit, la card Strava passe à « ✓ Connecté » avec
   un timestamp « sync il y a quelques secondes ».
4. Va faire une activité Strava (ou édite une activité existante). Dans
   les ~30 secondes, regarde les logs du conteneur :
   ```sh
   docker compose logs -f coach-app | grep -i strava
   ```
   Tu dois voir l'event arriver. L'activité apparaît ensuite dans
   `S.body.physio` du data file utilisateur (avgHR + activeEnergy).

### Limites connues

- **Strava ne fournit ni HRV ni sommeil** — uniquement des activités
  cardio. Notre mapping extrait `average_heartrate` (en `avgHR`) et
  `calories` ou `kilojoules` (en `activeEnergy`). Le reste est ignoré
  pour rester compatible avec le shape `PhysioEntry` existant.
- **Une seule subscription webhook par app Strava.** Si tu opérais
  plusieurs instances Coach Adaptatif sur la même app Strava, il
  faudrait créer une app Strava distincte par instance.
- **Rate limit Strava** : 200 requêtes / 15 min, 2000 / jour pour la
  Read API. Le sync initial après connexion (30 jours d'activités) coûte
  une seule requête (`/athlete/activities?after=...&per_page=200`). Les
  events webhook coûtent une requête de fetch d'activité chacun. En usage
  perso normal, on est large.

---

## Apple Health (rappel pour mémoire)

Pas de configuration opérateur — chaque utilisateur génère son propre
webhook signé en cliquant « Configurer Apple Health » dans le panneau
profil. La modale lui donne un guide pas-à-pas pour créer un Raccourci
iOS gratuit (app Raccourcis native d'iOS) qui POSTe HRV / sommeil / RHR
chaque nuit sur son URL personnelle.

L'URL est de la forme
`https://coach.exemple.com/api/physio/webhook/{uid}/{secret}` — le secret
est unique par user, comparé en constant time côté serveur, et peut être
rotaté à tout moment.

Le serveur reconnaît trois formats de body sur cet endpoint, dans cet
ordre de préférence :

1. **Apple Health Auto Export** — `{ data: { metrics: [...] } }`. Toujours
   accepté pour rétro-compat avec les utilisateurs qui auraient déjà
   acheté l'app payante AHAE avant cette release.
2. **Array de PhysioEntry** — `[ { date, hrv, sleep, rhr, ... }, ... ]`.
3. **Single PhysioEntry** — `{ date, hrv, sleep, rhr, ... }`. C'est ce
   format qu'utilise le Raccourci iOS guidé.

Champs supportés (tous optionnels sauf `date`) : `hrv`, `sleep`, `rhr`,
`activeEnergy`, `vo2Max`, `steps`, `avgHR`, `bodyMassKg`, `bodyFatPct`,
`respRate`, `mindfulMin`. Une entrée avec `date` mais aucun autre champ
> 0 est silencieusement ignorée.

---

## Architecture (pour qui voudrait étendre)

Le code de Strava vit dans `strava.go` (~570 lignes). Le code générique
des intégrations physio (Oura legacy, webhook signé, format AHAE) vit
dans `physio.go`. Les credentials chiffrés sont stockés dans
`User.PhysioTokens[provider]` ; pour Strava on encode un bundle JSON
`{access, refresh, expires_at, athlete_id}` puis on chiffre via
`encryptToken` (AES-256-GCM si `COACH_TOKEN_KEY` est défini, plaintext
en mode dégradé avec warning log).

Pour ajouter un nouveau provider OAuth dans le futur (Polar, Whoop, etc.)
le pattern à suivre est celui de `strava.go` :

1. Routes `/auth/<provider>/start` et `/auth/<provider>/callback` avec
   state CSRF aléatoire stocké en mémoire et purgé par un janitor.
2. Stockage du bundle dans `PhysioTokens[<provider>]` chiffré.
3. Refresh automatique avec slack 60s avant expiration dans le helper
   `<provider>LoadCreds`.
4. Si l'API supporte les webhooks push, route `/api/<provider>/webhook`
   avec le mécanisme de validation propre au provider (verify_token chez
   Strava, signature HMAC chez Whoop, etc.).
5. Mapping `<provider>Activity → PhysioEntry` qui extrait ce qui rentre
   dans le shape commun et passe par `mergePhysioIntoData`.

Les principes RGPD à respecter pour tout nouveau provider :
- **Minimisation des scopes** : ne demander que ce qu'on consomme.
- **Disclosure UI** : l'utilisateur doit voir avant l'OAuth quelles
  données vont être lues. La card du provider sert d'écran de
  disclosure (description courte) ; pour des données plus sensibles,
  ajouter un confirm modal avant le redirect.
- **Révocation** : un bouton « Déconnecter » qui supprime le bundle et
  appelle l'endpoint de revocation du provider si dispo.
