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

# One-time re-pairing: /v1/guardian/init writes a `guardian-init.lock` after the
# first bootstrap and then refuses forever ("Bootstrap already completed"). To
# re-pair a fresh remote client (e.g. a new mobile install) set
# CUE_RESET_GUARDIAN_LOCK=1, redeploy once to clear the lock + consumed-secret
# file, mint a token via guardian/init, then unset the var so normal boots keep
# the lock in place. The guardian binding itself is preserved.
if [ "${CUE_RESET_GUARDIAN_LOCK:-}" = "1" ]; then
  _SECDIR="${GATEWAY_SECURITY_DIR:-${VELLUM_WORKSPACE_DIR}/gateway-security}"
  rm -f "${_SECDIR}/guardian-init.lock" "${_SECDIR}/guardian-init-consumed.json" 2>/dev/null || true
  echo "[cue-app] guardian-init lock reset (CUE_RESET_GUARDIAN_LOCK=1) — re-pairing enabled this boot" >&2
fi

echo "[cue-app] starting daemon (workspace=${VELLUM_WORKSPACE_DIR})" >&2
# Daemon via its normal entrypoint (kata/apt prep, workspace hooks), backgrounded.
# DEBUG_STDOUT_LOGS=1: the daemon's pino logger writes to its rotating file
# ONLY when stdout is not a TTY (src/util/logger.ts), so without this opt-in
# none of the daemon's structured logs reach container stdout — Render's log
# stream showed gateway + raw echo lines but no daemon output. Scoped to the
# daemon subshell (the `keys set` seeding below discards its output anyway)
# and overridable: set DEBUG_STDOUT_LOGS=0 in the service env to go back to
# file-only logging.
( cd /app/assistant && DEBUG_STDOUT_LOGS="${DEBUG_STDOUT_LOGS:-1}" exec /app/assistant/docker-entrypoint.sh ) &
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
  # Run in the background with retries: the socket FILE exists once the daemon
  # binds, but its IPC server only starts accepting a few seconds later (the
  # gateway hits the same race and retries). Backgrounding keeps the gateway —
  # and Render's /healthz check — from waiting on the daemon's IPC readiness.
  # The store write itself works (encrypted file store: store.key + keys.enc),
  # so once a connect succeeds the key persists and every later chat resolves it.
  (
    j=0
    while [ "$j" -lt 30 ]; do
      if ( cd /app/assistant && bun run src/index.ts keys set anthropic "$ANTHROPIC_API_KEY" ) >/dev/null 2>&1; then
        echo "[cue-app] anthropic key seeded from env into secure store" >&2
        exit 0
      fi
      j=$((j + 1))
      sleep 3
    done
    echo "[cue-app] WARN: could not seed anthropic key after retries (set it in Settings → API Keys)" >&2
  ) &
fi

# Same pattern for OpenRouter: the canonical `openrouter` connection
# (seedCanonicalConnections) resolves an EXPLICIT credential
# (credential/openrouter/api_key) via `resolve-auth`, which reads the secure
# store only — it does NOT fall back to the bare OPENROUTER_API_KEY env var. So
# without this step the DeepSeek-via-OpenRouter managed profiles report
# "credential not found". `keys set openrouter` writes that credential.
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  (
    j=0
    while [ "$j" -lt 30 ]; do
      if ( cd /app/assistant && bun run src/index.ts keys set openrouter "$OPENROUTER_API_KEY" ) >/dev/null 2>&1; then
        echo "[cue-app] openrouter key seeded from env into secure store" >&2
        exit 0
      fi
      j=$((j + 1))
      sleep 3
    done
    echo "[cue-app] WARN: could not seed openrouter key after retries (set it in Settings → API Keys)" >&2
  ) &
fi

# Tooling providers (Replicate, Apify): `replicate_run` falls back to the env
# var, but the skill_execute/CES credential path reads the secure store only —
# so a store wiped by a restart makes those skills prompt the user for a token
# that is already configured. Re-seed from env like the LLM keys above.
for pair in "replicate:REPLICATE_API_TOKEN" "apify:APIFY_API_TOKEN"; do
  service="${pair%%:*}"
  var="${pair#*:}"
  eval "value=\${${var}:-}"
  if [ -n "$value" ]; then
    (
      j=0
      while [ "$j" -lt 30 ]; do
        if ( cd /app/assistant && bun run src/index.ts keys set "$service" "$value" ) >/dev/null 2>&1; then
          echo "[cue-app] $service key seeded from env into secure store" >&2
          exit 0
        fi
        j=$((j + 1))
        sleep 3
      done
      echo "[cue-app] WARN: could not seed $service key after retries" >&2
    ) &
  fi
done

# Gateway in the background too — this shell stays alive to SUPERVISE both
# processes. Without supervision, a daemon OOM-kill (seen live during the
# first-boot burst on 1GB machines: qdrant download + embedding worker) leaves
# the gateway serving /healthz 200 — a healthy-looking zombie that errors on
# every chat/mission. Exiting 1 as soon as EITHER process dies lets the
# platform restart policy (Fly "always" / Render) reboot the whole machine
# cleanly.
cd /app/gateway
bun --smol run src/index.ts &
GATEWAY_PID=$!

# Clean shutdown: forward SIGTERM/SIGINT (docker stop / platform stop) to both
# processes and wait for them, so a container stop is never treated as a
# crash.
_shutdown() {
  trap '' TERM INT
  echo "[cue-app] stop signal — shutting down gateway and daemon" >&2
  kill "$GATEWAY_PID" "$DAEMON_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  exit 0
}
trap _shutdown TERM INT

# Supervise: debian-slim /bin/sh is dash, which lacks bash's `wait -n`, so
# poll both PIDs. `sleep` runs backgrounded + `wait`ed so the TERM/INT trap
# fires immediately instead of after the current sleep completes.
while :; do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[cue-app] daemon exited — restarting container" >&2
    kill "$GATEWAY_PID" 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "[cue-app] gateway exited — restarting container" >&2
    kill "$DAEMON_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 5 &
  wait $! || true
done
