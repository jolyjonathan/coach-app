# =============================================================
# Coach Adaptatif — Dockerfile multi-stage
# =============================================================
# Build : binaire statique Go (CGO_ENABLED=0)
# Runtime : distroless/static (image minimale, pas de shell, pas de package
# manager → surface d'attaque réduite).
#
# Usage recommandé : `docker compose up -d` (voir docker-compose.yml).
# Le compose gère le volume de données, le .env et le port exposé.
#
# Build manuel : docker build -t coach-app:latest .
# =============================================================

# ---------- Builder stage ----------
# Audit M-01 : tags `golang:1.22-alpine` et `distroless/static-debian12:nonroot`
# sont mutables → un registry compromis peut servir une image trojanisée sans
# que le build s'en rende compte.
#
# Pour une posture supply-chain solide, remplacer ces lignes par un digest
# SHA256 :
#   FROM golang:1.22-alpine@sha256:<DIGEST> AS builder
#   FROM gcr.io/distroless/static-debian12:nonroot@sha256:<DIGEST>
#
# Récupération du digest courant :
#   docker pull golang:1.22-alpine
#   docker inspect --format='{{index .RepoDigests 0}}' golang:1.22-alpine
#
# Procédure recommandée : `make pin-images` (cf. scripts/pin-images.sh) une
# fois par mois ou avant chaque release. Les digests vivent en commit signé,
# pas dans le runtime.
FROM golang:1.22-alpine AS builder
WORKDIR /src

# Cache les modules avant le source (couches Docker réutilisables).
COPY go.mod go.sum ./
RUN go mod download

# Copie le source et build.
COPY . .

# CGO_ENABLED=0 → binaire statique, GOOS=linux pour distroless,
# -trimpath pour reproductibilité, -ldflags pour stripper les symboles
# de debug et réduire la taille.
RUN CGO_ENABLED=0 GOOS=linux \
    go build -trimpath -ldflags="-s -w" -o /out/coach-app .

# Pré-créer /data avec ownership nonroot. Indispensable parce que :
#   - distroless/static n'a NI shell NI mkdir/chown → impossible de
#     faire `RUN mkdir /data` dans le runtime stage.
#   - Quand Docker monte un volume nommé sur /data au premier run, il
#     copie le contenu du répertoire de l'image dans le volume nouveau-né
#     ET hérite des permissions. Sans cette étape, le volume hérite de
#     root:root et le binaire (qui tourne en UID 65532) se prend un EPERM
#     sur MkdirAll("/data/workouts") → log.Fatalf → restart loop.
RUN mkdir -p /out/datadir

# ---------- Runtime stage ----------
# distroless/static : pas de shell, pas de libc, juste de quoi exécuter
# un binaire statique. UID 65532 par défaut (nonroot).
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=builder /out/coach-app /app/coach-app
COPY --chown=nonroot:nonroot public /app/public
# Voir le commentaire du builder stage : on copie un répertoire vide
# `/data` appartenant à nonroot pour que le volume nommé hérite des
# bonnes permissions au premier mount.
COPY --from=builder --chown=nonroot:nonroot /out/datadir /data

# Le data dir est externalisé en volume.
ENV COACH_DATA=/data
ENV COACH_PUBLIC=/app/public
ENV COACH_LISTEN=0.0.0.0:8080

# Volume déclaré pour rappel — le compose le bind manuellement.
VOLUME ["/data"]

EXPOSE 8080
USER nonroot:nonroot

# Healthcheck : on réutilise le binaire avec --healthcheck (sub-mode qui
# fait un GET interne sur /privacy et exit 0/1). Évite d'avoir besoin de
# curl/wget dans l'image distroless.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/app/coach-app", "--healthcheck"]

ENTRYPOINT ["/app/coach-app"]
