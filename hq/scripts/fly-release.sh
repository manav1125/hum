#!/usr/bin/env bash
set -euo pipefail

# Cue HQ — build the Cue image ONCE and push it to the Fly registry, so the
# fly driver can run the same image in every customer app ("build once,
# deploy many": images under registry.fly.io/<app> are pullable by any app
# in the same org — https://fly.io/docs/blueprints/using-the-fly-docker-registry/).
#
# Strategy: a dedicated registry app (never deployed, it only owns the
# image namespace) + `flyctl deploy --build-only --push` so the build runs
# on Fly's remote builder — no local Docker needed, and the push is
# authenticated by flyctl itself.
#
# Usage:
#   FLY_ORG_SLUG=<org> hq/scripts/fly-release.sh [label]
#     label defaults to v<short git sha> of HEAD.
#
# Env:
#   FLY_ORG_SLUG      — org that owns the registry app (required)
#   FLY_RELEASES_APP  — registry app name (default: cue-releases)
#   FLY_API_TOKEN     — optional; flyctl also honors `flyctl auth login`
#   HQ_APP            — HQ app whose CUE_IMAGE_REF is repointed at the new
#                       image (default: cue-hq). Set HQ_APP="" to skip and
#                       only build+push.
#
# Output: prints the image ref, and (unless HQ_APP="") points HQ's
# CUE_IMAGE_REF at it so newly provisioned customers get the build that was
# just shipped. Leaving that to a human is what let HQ sit two days behind
# production while every new joiner silently landed on the older image.
#
# Fallback (if the remote builder misbehaves): local Docker push —
#   flyctl auth docker
#   docker build -f assistant/Dockerfile -t registry.fly.io/$APP:$LABEL .
#   docker push registry.fly.io/$APP:$LABEL

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${FLY_RELEASES_APP:-cue-releases}"
LABEL="${1:-v$(git -C "${REPO_ROOT}" rev-parse --short HEAD)}"
IMAGE_REF="registry.fly.io/${APP}:${LABEL}"

if ! command -v flyctl >/dev/null 2>&1; then
  echo "error: flyctl not found — https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi
if [[ -z "${FLY_ORG_SLUG:-}" ]]; then
  echo "error: FLY_ORG_SLUG is required" >&2
  exit 1
fi

# Create the registry app if it doesn't exist yet (idempotent; it is never
# deployed — it exists solely to own registry.fly.io/<APP>).
if ! flyctl apps list --org "${FLY_ORG_SLUG}" --json 2>/dev/null \
    | grep -q "\"${APP}\""; then
  echo "▶ creating registry app ${APP} in org ${FLY_ORG_SLUG}"
  flyctl apps create "${APP}" --org "${FLY_ORG_SLUG}"
fi

# Build on Fly's remote builder and push — no deploy, no machines touched.
# Context is the repo root (assistant/Dockerfile expects repo-root context,
# same as render.yaml's dockerContext: .).
echo "▶ building ${IMAGE_REF} (remote builder)"
# `--config` is required: the registry app is never deployed, so it owns no
# machines, and without a config file flyctl tries to reconstruct fly.toml
# from running machines and fails with "No machines configured for this app".
flyctl deploy "${REPO_ROOT}" \
  --config "${REPO_ROOT}/fly-release.toml" \
  --app "${APP}" \
  --dockerfile "${REPO_ROOT}/assistant/Dockerfile" \
  --build-only \
  --push \
  --image-label "${LABEL}" \
  --remote-only

echo
echo "✅ pushed ${IMAGE_REF}"

# Repoint HQ at what we just shipped. This is deliberately part of the
# release, not a follow-up step: the image is only half the ship — until
# CUE_IMAGE_REF moves, every customer provisioned from here on gets the
# PREVIOUS build. Note this does not touch instances that already exist;
# rolling the live fleet is still `POST /admin/fleet/update`.
HQ_APP="${HQ_APP-cue-hq}"
if [[ -n "${HQ_APP}" ]]; then
  echo "▶ pointing ${HQ_APP} CUE_IMAGE_REF at ${IMAGE_REF}"
  flyctl secrets set "CUE_IMAGE_REF=${IMAGE_REF}" --app "${HQ_APP}"
  echo "✅ ${HQ_APP} now provisions new instances from ${IMAGE_REF}"
  echo "   existing instances are unchanged — roll them with POST /admin/fleet/update"
else
  echo "   (HQ_APP empty — skipping the CUE_IMAGE_REF update)"
  echo "   export CUE_IMAGE_REF=${IMAGE_REF}"
fi
