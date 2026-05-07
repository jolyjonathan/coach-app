# =============================================================
# Coach Adaptatif — Dockerfile multi-stage
# =============================================================
# Build : binaire statique Go (CGO_ENABLED=0)
# Runtime : distroless/static (image minimale, pas de shell, pas de package
# manager → surface d'attaque réduite).
#
# Pour build :  docker build -t coach-app:latest .
# Pour run   :  voir docker-compose.yml (recommandé pour le volume + env).
# =============================================================

# ---------- Builder stage ----------
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

# ---------- Runtime stage ----------
# distroless/static : pas de shell, pas de libc, juste de quoi exécuter
# un binaire statique. UID 65532 par défaut (nonroot).
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=builder /out/coach-app /app/coach-app
COPY --chown=nonroot:nonroot public /app/public

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
