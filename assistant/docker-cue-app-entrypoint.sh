#!/usr/bin/env sh
# Combined Cue app entrypoint (Render single-service): run the assistant daemon
# and the gateway in one container so the gateway can reach the daemon over the
# Unix socket in the shared workspace. Used via render.yaml `dockerCommand`; the
# image's default CMD remains the standalone daemon.
set -eu

export VELLUM_WORKSPACE_DIR="${VELLUM_WORKSPACE_DIR:-/workspace}"
SOCK="${VELLUM_WORKSPACE_DIR}/assistant.sock"

# Both processes share the one Render disk mounted at the workspace; the gateway
# keeps its JWT/principal key material under it too.
mkdir -p "${VELLUM_WORKSPACE_DIR}" "${GATEWAY_SECURITY_DIR:-${VELLUM_WORKSPACE_DIR}/gateway-security}"

echo "[cue-app] starting daemon (workspace=${VELLUM_WORKSPACE_DIR})" >&2
# Daemon via its normal entrypoint (kata/apt prep, workspace hooks), backgrounded.
( cd /app/assistant && exec /app/assistant/docker-entrypoint.sh ) &
DAEMON_PID=$!

# Wait for the daemon's IPC socket — the gateway connects to it on boot.
i=0
while [ ! -S "$SOCK" ]; do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[cue-app] daemon exited before creating $SOCK" >&2
    wait "$DAEMON_PID" 2>/dev/null || true
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 180 ]; then
    echo "[cue-app] timed out after ${i}s waiting for $SOCK" >&2
    exit 1
  fi
  sleep 1
done
echo "[cue-app] assistant socket ready; starting gateway" >&2

# Seed the provider API key from the env into the daemon's secure store. A
# self-hosted BYO inference connection (e.g. anthropic-personal) resolves an
# EXPLICIT credential (credential/anthropic/api_key) which the bare
# ANTHROPIC_API_KEY env var does not populate — so without this step the daemon
# reports "No API key configured for anthropic" even though the env var is set.
# `keys set` writes via the daemon IPC socket (now ready). Idempotent: it
# silently overwrites. The key value never leaves the container — it goes
# straight from the env into the local encrypted store.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[cue-app] seeding anthropic key from env into secure store" >&2
  ( cd /app/assistant && exec bun run src/index.ts keys set anthropic "$ANTHROPIC_API_KEY" ) \
    || echo "[cue-app] WARN: failed to seed anthropic key (chat may need a key set in Settings)" >&2
fi

# Gateway in the foreground = the public service. On container stop it receives
# SIGTERM and shuts down cleanly; the daemon is torn down with the container
# (its SQLite WAL replays on next boot).
cd /app/gateway
exec bun --smol run src/index.ts
