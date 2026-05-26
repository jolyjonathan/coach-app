#!/bin/sh
# =============================================================
# pin-images.sh — Pin les images Docker du Dockerfile par digest
# =============================================================
# Audit M-01 : remplace les tags mutables (`golang:1.22-alpine`,
# `gcr.io/distroless/static-debian12:nonroot`) par leur digest SHA256
# actuel dans le Dockerfile.
#
# À lancer :
#   - une fois par mois (drift normal des images de base)
#   - avant chaque release / tag
#   - après un incident sécu chez Google / Docker Hub
#
# Le script édite le Dockerfile en place. Si le résultat te convient,
# commit. Sinon, `git checkout Dockerfile` et investigation manuelle.
# =============================================================
set -eu

DOCKERFILE="${DOCKERFILE:-Dockerfile}"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker requis dans le PATH" >&2
  exit 1
fi
if [ ! -f "$DOCKERFILE" ]; then
  echo "error: $DOCKERFILE introuvable" >&2
  exit 1
fi

pin_image() {
  # $1 = image:tag, $2 = pattern à remplacer dans le Dockerfile
  image="$1"
  pattern="$2"
  echo "→ pull $image"
  docker pull --quiet "$image" >/dev/null
  digest=$(docker inspect --format='{{index .RepoDigests 0}}' "$image" 2>/dev/null | sed 's/.*@//')
  if [ -z "$digest" ]; then
    echo "error: pas de digest pour $image" >&2
    return 1
  fi
  echo "  digest: $digest"
  # Sed compatible BSD/GNU : on backup, on remplace, on supprime le backup.
  sed -i.bak "s|^FROM $pattern.*|FROM ${image}@${digest}|" "$DOCKERFILE"
  rm -f "$DOCKERFILE.bak"
}

pin_image "golang:1.22-alpine" "golang:1\\.22-alpine"
pin_image "gcr.io/distroless/static-debian12:nonroot" "gcr\\.io/distroless/static-debian12:nonroot"

echo ""
echo "Dockerfile pinné. Diff :"
git diff --no-color "$DOCKERFILE" 2>/dev/null || diff "$DOCKERFILE" /dev/null || true
echo ""
echo "Si OK : git add Dockerfile && git commit -m 'pin: bump base image digests'"
