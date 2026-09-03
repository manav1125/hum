#!/usr/bin/env bash
set -euo pipefail

# Cue HQ — build the FLEET Learn sidecar image once and push it to the Fly
# registry (same build-once-deploy-many model as fly-release.sh). Built from
# the monorepo's `learn/` tree (the Cue Learn fork subtree).
#
# The fleet image enables server persistence WITHOUT a compiled-in token:
# the sidecar's runtime OPENMAIC_TRUST_PROXY_AUTH accepts requests that the
# per-customer OPENMAIC_ACCESS_SECRET middleware already gated, so the
# per-tenant credential lives in runtime env (HQ mints it per customer), not
# in the shared client bundle. (Manav's own sidecar app, cue-learn-manav, is
# still built separately from ~/OpenMAIC with its own token.)
#
# Usage:
#   FLY_ORG_SLUG=<org> hq/scripts/learn-release.sh [label]
#     label defaults to learn-sidecar-<short git sha> of HEAD.
#
# Env:
#   FLY_ORG_SLUG      — org that owns the registry app (required)
#   FLY_RELEASES_APP  — registry app name (default: cue-releases)
#   HQ_APP            — HQ app whose HQ_LEARN_IMAGE_REF is repointed at the
#                       new image (default: cue-hq). HQ_APP="" skips.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEARN_DIR="${REPO_ROOT}/learn"
APP="${FLY_RELEASES_APP:-cue-releases}"
LABEL="${1:-learn-sidecar-$(git -C "${REPO_ROOT}" rev-parse --short HEAD)}"
IMAGE_REF="registry.fly.io/${APP}:${LABEL}"
HQ_APP="${HQ_APP-cue-hq}"

if [[ ! -f "${LEARN_DIR}/Dockerfile" ]]; then
  echo "error: ${LEARN_DIR}/Dockerfile not found — is the learn/ subtree present?" >&2
  exit 1
fi
if [[ -z "${FLY_ORG_SLUG:-}" ]]; then
  echo "error: FLY_ORG_SLUG is required" >&2
  exit 1
fi

echo "▶ building ${IMAGE_REF} from ${LEARN_DIR} (remote builder)"
# --depot=false: the managed depot builder OOM-kills this Next build silently;
# the classic org builder is 8GB and survives it (plus the Dockerfile's
# NODE_OPTIONS heap ceiling).
(cd "${LEARN_DIR}" && env -u DOCKER_HOST flyctl deploy \
  --app "${APP}" \
  --build-only --push --remote-only --depot=false \
  --image-label "${LABEL}" \
  --build-arg OPENMAIC_BASE_PATH=/learn \
  --build-arg NEXT_PUBLIC_PERSISTENCE=1)

echo "✅ pushed ${IMAGE_REF}"

if [[ -n "${HQ_APP}" ]]; then
  echo "▶ pointing ${HQ_APP} HQ_LEARN_IMAGE_REF at ${IMAGE_REF}"
  flyctl secrets set "HQ_LEARN_IMAGE_REF=${IMAGE_REF}" --app "${HQ_APP}"
else
  echo "   (HQ_APP empty — skipping the HQ_LEARN_IMAGE_REF update)"
  echo "   export HQ_LEARN_IMAGE_REF=${IMAGE_REF}"
fi
