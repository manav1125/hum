#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/native/mac-helper"
OUTPUT_DIR="$ROOT_DIR/resources"
OUTPUT_BUNDLE="$OUTPUT_DIR/cue-mac-helper.app"
OUTPUT="$OUTPUT_BUNDLE/Contents/MacOS/cue-mac-helper"
OUTPUT_INFO_PLIST="$OUTPUT_BUNDLE/Contents/Info.plist"
INFO_PLIST="$PACKAGE_DIR/Sources/MacHelperExecutable/Info.plist"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-mac-helper: skipping non-macOS host"
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "build-mac-helper: xcrun not found; install Xcode command line tools" >&2
  exit 1
fi

# Signing identities, most preferred first. The packaged app's afterSign hook
# signs the helper with "Developer ID Application", so dev builds MUST prefer
# the same identity: TCC keys the Accessibility grant on (bundle id + code
# requirement), and the requirement embeds the signing team. Signing dev
# builds with a different team (the old "Apple Development" default, team
# 9CL7ZPZ325 vs Developer ID's XU8BLQACGU) made every dev↔installed switch
# invalidate the recorded grant — the Settings toggle stayed ON but validated
# against a dead signature, so the helper re-prompted on every launch.
# "Apple Development" remains as a fallback: still a stable, team-based DR,
# just not the one shipped builds use. (An ad-hoc DR is the volatile cdhash →
# re-prompt every launch.)
PREFERRED_MAC_HELPER_SIGN_IDENTITIES=(
  "Developer ID Application: Manav Gupta (XU8BLQACGU)"
  "Apple Development: Manav Gupta (9CL7ZPZ325)"
)

# Resolve the code-signing identity for the helper:
#   1. MAC_HELPER_SIGN_IDENTITY env override (honored verbatim, incl. "-").
#   2. The first preferred identity present in the keychain.
#   3. Ad-hoc ("-") on hosts with no usable signing identity (CI / non-signing).
resolve_sign_identity() {
  if [ -n "${MAC_HELPER_SIGN_IDENTITY:-}" ]; then
    printf '%s' "$MAC_HELPER_SIGN_IDENTITY"
    return
  fi
  if command -v security >/dev/null 2>&1; then
    local available identity
    available="$(security find-identity -v -p codesigning 2>/dev/null || true)"
    for identity in "${PREFERRED_MAC_HELPER_SIGN_IDENTITIES[@]}"; do
      if printf '%s' "$available" | grep -qF "$identity"; then
        printf '%s' "$identity"
        return
      fi
    done
  fi
  printf '%s' "-"
}

BUILD_ARGS=(--package-path "$PACKAGE_DIR" -c release)
if [ -n "${ELECTRON_TARGET_ARCH:-}" ]; then
  case "$ELECTRON_TARGET_ARCH" in
    arm64) BUILD_ARGS+=(--triple arm64-apple-macosx15.0) ;;
    x64)   BUILD_ARGS+=(--triple x86_64-apple-macosx15.0) ;;
  esac
fi

# Embed Info.plist (bundle id + microphone / speech-recognition usage
# strings) into the bare executable so TCC can attribute permission
# prompts for the dictation-partials session without a full .app bundle.
INFO_PLIST="$PACKAGE_DIR/Sources/MacHelperExecutable/Info.plist"
BUILD_ARGS+=(
  -Xlinker -sectcreate
  -Xlinker __TEXT
  -Xlinker __info_plist
  -Xlinker "$INFO_PLIST"
)

mkdir -p "$OUTPUT_DIR"
# Legacy layouts (bare binary / old name / old .app + hash marker) — always clear.
rm -f "$OUTPUT_DIR/hotkey-helper" "$OUTPUT_DIR/vellum-mac-helper" "$OUTPUT_DIR/Info.plist"
rm -rf "$OUTPUT_DIR/vellum-mac-helper.app"
rm -f "$OUTPUT_DIR/.vellum-mac-helper.source-hash"
xcrun swift build "${BUILD_ARGS[@]}"
BUILD_DIR="$(xcrun swift build "${BUILD_ARGS[@]}" --show-bin-path)"

# Skip the install when the build output is unchanged: replacing and
# re-signing churns nothing semantically, but a fresh bundle invalidates
# the CDHash that TCC keys the helper's mic/speech grants on, so every
# no-op rebuild (e.g. `bun run dev`'s postinstall) would re-prompt. The
# signed binary never byte-matches the unsigned build output, so compare
# against a hash marker of the inputs recorded at install time.
# The signing identity is part of the input hash: switching identities must
# re-sign (the DR the TCC grant keys on changes), even if the binary is byte-
# identical to a prior build.
MAC_HELPER_SIGN_IDENTITY="$(resolve_sign_identity)"
SOURCE_HASH="$(cat "$BUILD_DIR/cue-mac-helper" "$INFO_PLIST" "$ROOT_DIR/scripts/entitlements/helper.plist" <(printf '%s' "$MAC_HELPER_SIGN_IDENTITY") | shasum -a 256 | cut -d' ' -f1)"
HASH_MARKER="$OUTPUT_DIR/.cue-mac-helper.source-hash"
if [ -x "$OUTPUT" ] && [ -f "$HASH_MARKER" ] && [ "$(cat "$HASH_MARKER")" = "$SOURCE_HASH" ]; then
  echo "build-mac-helper: bundle unchanged; keeping existing copy"
else
  # Remove before installing: overwriting a signed Mach-O in place reuses
  # the inode, and the kernel's stale signature cache SIGKILLs the next
  # spawn (exit 137). A fresh bundle sidesteps it.
  rm -rf "$OUTPUT_BUNDLE"
  mkdir -p "$OUTPUT_BUNDLE/Contents/MacOS"
  cp "$BUILD_DIR/cue-mac-helper" "$OUTPUT"
  cp "$INFO_PLIST" "$OUTPUT_INFO_PLIST"
  chmod 755 "$OUTPUT"
  # Sign with a real (team-based) identity when one is available so the
  # designated requirement is stable and TCC's Accessibility grant persists
  # across launches. Ad-hoc DRs are the unstable cdhash, so the grant never
  # sticks and every launch re-prompts. Fall back to ad-hoc ("-") on hosts
  # without a signing identity (CI) so those builds keep working.
  CODESIGN_ARGS=(--force --options runtime --sign "$MAC_HELPER_SIGN_IDENTITY" \
    --entitlements "$ROOT_DIR/scripts/entitlements/helper.plist")
  if [ "$MAC_HELPER_SIGN_IDENTITY" != "-" ]; then
    CODESIGN_ARGS+=(--timestamp)
  fi
  codesign "${CODESIGN_ARGS[@]}" "$OUTPUT_BUNDLE"
  echo "build-mac-helper: signed with identity=\"$MAC_HELPER_SIGN_IDENTITY\""
  printf '%s' "$SOURCE_HASH" > "$HASH_MARKER"
fi
