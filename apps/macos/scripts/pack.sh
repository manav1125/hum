#!/usr/bin/env bash
# pack.sh — Build and package the Electron app for the target architecture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: pack.sh [flags]

Build and package the Electron app for the target architecture.

Flags:
  --environment, --env <name>  Set VELLUM_ENVIRONMENT (default: local)
  --publish                    Publish artifacts to the update feed
                               (GitHub Releases; requires GH_TOKEN — see
                               docs/DISTRIBUTION.md)
  --open                       Launch the built .app when done
  --help, -h                   Show this help

Environment:
  ELECTRON_TARGET_ARCH         arm64 | x64 (default: arm64)
  APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
                               Notarization credentials (skipped when unset)
  GH_TOKEN                     GitHub token used by --publish
EOF
}

OPEN_AFTER_BUILD=false
PUBLISH=never
while [ $# -gt 0 ]; do
  case "$1" in
    --environment|--env)
      [ $# -ge 2 ] || { echo "ERROR: $1 requires a value" >&2; exit 1; }
      export VELLUM_ENVIRONMENT="$2"
      shift 2
      ;;
    --environment=*|--env=*)
      export VELLUM_ENVIRONMENT="${1#*=}"
      shift
      ;;
    --publish)
      PUBLISH=always
      shift
      ;;
    --open)
      OPEN_AFTER_BUILD=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

export VELLUM_ENVIRONMENT="${VELLUM_ENVIRONMENT:-local}"

ARCH="${ELECTRON_TARGET_ARCH:-arm64}"
case "$ARCH" in
  arm64) BUN_ARCH=aarch64 ;;
  x64)   BUN_ARCH=x64 ;;
  *)
    echo "ERROR: unsupported ELECTRON_TARGET_ARCH: $ARCH (use arm64 or x64)" >&2
    exit 1
    ;;
esac

cd "$APP_DIR"

# Resolve a stable code-signing identity for the whole app + bundled helper.
# "Apple Development" runs on the signing machine and yields a stable,
# team-based designated requirement, so macOS TCC persists the helper's
# Accessibility grant across launches instead of re-prompting every time
# (an ad-hoc signature's DR is the volatile cdhash). Honor an explicit
# CUE_MAC_SIGN_IDENTITY override; otherwise auto-pick the local Apple
# Development identity when present. On hosts with no identity (CI) leave it
# unset so electron-builder's ad-hoc arm64 fallback still produces a build.
DEFAULT_MAC_SIGN_IDENTITY="Apple Development: Manav Gupta (9CL7ZPZ325)"
if [ -z "${CUE_MAC_SIGN_IDENTITY:-}" ]; then
  if command -v security >/dev/null 2>&1 &&
     security find-identity -v -p codesigning 2>/dev/null |
       grep -qF "$DEFAULT_MAC_SIGN_IDENTITY"; then
    export CUE_MAC_SIGN_IDENTITY="$DEFAULT_MAC_SIGN_IDENTITY"
  fi
fi
if [ -n "${CUE_MAC_SIGN_IDENTITY:-}" ]; then
  # afterPack.js (Quick Look appex) and afterSign.js (nested re-sign) both read
  # CSC_NAME; keep it in lockstep with the identity electron-builder uses.
  export CSC_NAME="$CUE_MAC_SIGN_IDENTITY"
  # build-mac-helper.sh signs the helper with the same identity by default;
  # keep it explicit so a helper rebuilt during pack matches the app.
  export MAC_HELPER_SIGN_IDENTITY="${MAC_HELPER_SIGN_IDENTITY:-$CUE_MAC_SIGN_IDENTITY}"
  echo "pack: signing with identity=\"$CUE_MAC_SIGN_IDENTITY\""
else
  echo "pack: no signing identity found — building ad-hoc (TCC grants will not persist)"
fi

# Local builds run the repo CLI source at runtime (see getLocalCliEntry in
# src/main/cli-installer.ts); install its deps so the checkout is runnable.
if [ "$VELLUM_ENVIRONMENT" = "local" ]; then
  (cd "$APP_DIR/../../cli" && bun install)
fi

bash scripts/fetch-bun.sh --arch "$BUN_ARCH"
bash scripts/generate-icon.sh
bash scripts/build-mac-helper.sh
bun run build:web
bash scripts/generate-cli-lockfile.sh
electron-vite build
# --publish never by default: with the GitHub provider, "always" would try to
# upload every local pack (and fail without GH_TOKEN). Release builds opt in
# with pack.sh --publish (see docs/DISTRIBUTION.md).
electron-builder --config electron-builder.config.cjs --publish "$PUBLISH"

if [ "$OPEN_AFTER_BUILD" = true ]; then
  # Newest .app wins — dist/ may hold stale apps from prior envs.
  APP_PATH="$(ls -dt "$APP_DIR"/dist/mac*/*.app 2>/dev/null | head -n 1 || true)"
  if [ -n "$APP_PATH" ]; then
    echo "Launching $APP_PATH"
    open "$APP_PATH"
  else
    echo "ERROR: no .app found under $APP_DIR/dist" >&2
    exit 1
  fi
fi
