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

# ── Daemon supervision policy ───────────────────────────────────────────
# The daemon can be OOM-killed (SIGKILL/137) or crash on 1GB machines during
# the first-boot burst (qdrant download + embedding worker). Rather than
# recycle the whole container on the first death — which throws away the
# gateway, its warm state, and the platform's slow reschedule — we RESPAWN the
# daemon in place with exponential backoff and a bounded restart budget.
#
# Budget: allow at most CUE_DAEMON_MAX_RESTARTS respawns inside a rolling
# CUE_DAEMON_RESTART_WINDOW_S window. A hard crash-loop (daemon dies faster
# than it can boot) burns the budget quickly; once exhausted we exit non-zero
# so the orchestrator (Fly "always" / Render) recycles the machine — a fresh
# container may land on a healthier host or clear a wedged volume. This bounds
# the in-container respawn so we never spin forever fighting an unrecoverable
# fault.
CUE_DAEMON_MAX_RESTARTS="${CUE_DAEMON_MAX_RESTARTS:-5}"
CUE_DAEMON_RESTART_WINDOW_S="${CUE_DAEMON_RESTART_WINDOW_S:-600}"
CUE_DAEMON_BACKOFF_BASE_S="${CUE_DAEMON_BACKOFF_BASE_S:-2}"
CUE_DAEMON_BACKOFF_MAX_S="${CUE_DAEMON_BACKOFF_MAX_S:-60}"

# Per-boot stderr tail of the most recent daemon process. The supervisor reads
# it after a death to tell a *contention* exit (another daemon already holds
# the IPC socket / DB — src/daemon/startup-error.ts emits DAEMON_ERROR: with
# category PORT_IN_USE or DB_LOCKED) apart from an OOM/crash. Contention must
# NOT be respawned: per assistant/CLAUDE.md "Daemon startup philosophy", a
# daemon with no transport exits on purpose; respawning it just spins a doomed
# duplicate that runs background jobs against the shared DB. So contention →
# exit; everything else → respawn.
DAEMON_STDERR_TAIL="${VELLUM_WORKSPACE_DIR}/.daemon-stderr.log"
# FIFO carrying the daemon's stderr to a tee that fans it out to BOTH the
# container log stream (>&2) and DAEMON_STDERR_TAIL. debian /bin/sh is dash,
# which lacks bash process substitution (`2> >(...)`), so we use a POSIX named
# pipe instead — and it keeps DAEMON_PID pointing at the daemon entrypoint
# rather than at a pipeline's tail element.
DAEMON_STDERR_FIFO="${VELLUM_WORKSPACE_DIR}/.daemon-stderr.fifo"
DAEMON_TEE_PID=""

# ── Daemon privilege drop (CUE_DROP_DAEMON_PRIVILEGES=1) ────────────────
# Everything in this container runs as uid 0 by default, and the daemon is the
# process that executes agent-authored commands — six paths reach a shell
# (bash, host_bash, the skill sandbox runner, inline skill commands, scheduled
# scripts, the debug bash route). At uid 0 a prompt-injected turn can read the
# gateway's trust material out of another process (/proc/<pid>/mem, /proc/<pid>/fd)
# or straight off the volume, no matter what the file modes say. File-level
# denials narrow the obvious paths; only dropping the uid removes the capability.
#
# So: the GATEWAY stays root (it owns the security directory and must keep sole
# access to it), and the DAEMON — and therefore every command it spawns — runs
# as the unprivileged `assistant` user built into the image.
#
# Deliberately env-gated rather than unconditional. This changes the uid every
# skill runs under on a single production box; the flag makes the rehearsal
# real (turn it on for a scratch machine, exercise the skill surface, then
# enable it on prod) and makes rollback an env change rather than a rebuild.
CUE_DAEMON_UID="${CUE_DAEMON_UID:-1001}"
CUE_DAEMON_GID="${CUE_DAEMON_GID:-1001}"
DROP_DAEMON_PRIVILEGES=0
if [ "${CUE_DROP_DAEMON_PRIVILEGES:-}" = "1" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "[cue-app] CUE_DROP_DAEMON_PRIVILEGES=1 but the container is not root — daemon already unprivileged, nothing to drop" >&2
  elif ! command -v setpriv >/dev/null 2>&1; then
    # Fail loudly rather than silently continuing as root: a security control
    # that quietly does nothing is worse than one that is plainly off.
    echo "[cue-app] FATAL: CUE_DROP_DAEMON_PRIVILEGES=1 but setpriv is unavailable; refusing to run the daemon as root under a flag that promises otherwise" >&2
    exit 1
  else
    DROP_DAEMON_PRIVILEGES=1
  fi
fi

# prepare_daemon_workspace: hand the workspace to the daemon's uid so it can
# still read and write everything it owns. The gateway's security directory is
# pruned — that is the material the drop exists to put out of reach, and the
# gateway (root) is its only legitimate reader.
#
# Only files not already owned are touched, so the first boot after enabling
# pays a full pass and later boots are close to free.
prepare_daemon_workspace() {
  _secdir="${GATEWAY_SECURITY_DIR:-${VELLUM_WORKSPACE_DIR}/gateway-security}"
  echo "[cue-app] preparing workspace ownership for uid ${CUE_DAEMON_UID} (excluding ${_secdir})" >&2
  find "${VELLUM_WORKSPACE_DIR}" -path "${_secdir}" -prune -o \
    ! -user "${CUE_DAEMON_UID}" -exec chown -h "${CUE_DAEMON_UID}:${CUE_DAEMON_GID}" {} + \
    2>/dev/null || true
  # The FIFO and stderr tail are recreated per daemon spawn by root; the daemon
  # writes to them, so they must be owned by it too.
  for _f in "$DAEMON_STDERR_FIFO" "$DAEMON_STDERR_TAIL"; do
    [ -e "$_f" ] && chown "${CUE_DAEMON_UID}:${CUE_DAEMON_GID}" "$_f" 2>/dev/null || true
  done
}

# Word-split deliberately at the call site: empty means "run as root", so the
# unflagged path is byte-for-byte the behaviour that shipped before this.
DAEMON_PRIVILEGE_PREFIX=""
if [ "$DROP_DAEMON_PRIVILEGES" = "1" ]; then
  prepare_daemon_workspace
  DAEMON_PRIVILEGE_PREFIX="setpriv --reuid=${CUE_DAEMON_UID} --regid=${CUE_DAEMON_GID} --clear-groups --inh-caps=-all"
  echo "[cue-app] daemon will run as uid ${CUE_DAEMON_UID} (agent shell commands inherit it); gateway stays root" >&2
fi

# start_daemon: launch the daemon backgrounded via its normal entrypoint
# (kata/apt prep, workspace hooks), setting DAEMON_PID to the new process.
# DEBUG_STDOUT_LOGS=1: the daemon's pino logger writes to its rotating file
# ONLY when stdout is not a TTY (src/util/logger.ts), so without this opt-in
# none of the daemon's structured logs reach container stdout — Render's log
# stream showed gateway + raw echo lines but no daemon output. Overridable: set
# DEBUG_STDOUT_LOGS=0 in the service env to go back to file-only logging.
#
# The daemon's stderr flows through DAEMON_STDERR_FIFO into a tee so the
# container log stream still sees it (>&2) AND the supervisor can inspect the
# death cause in DAEMON_STDERR_TAIL. Each spawn truncates the tail so a prior
# boot's DAEMON_ERROR: line can't be misread as this boot's death cause.
start_daemon() {
  : > "$DAEMON_STDERR_TAIL" 2>/dev/null || true
  # (Re)create the FIFO and start a fresh tee reader for this daemon instance.
  rm -f "$DAEMON_STDERR_FIFO" 2>/dev/null || true
  mkfifo "$DAEMON_STDERR_FIFO" 2>/dev/null || true
  # Re-apply ownership of the per-spawn FIFO/tail, which root just recreated.
  if [ "$DROP_DAEMON_PRIVILEGES" = "1" ]; then
    for _f in "$DAEMON_STDERR_FIFO" "$DAEMON_STDERR_TAIL"; do
      [ -e "$_f" ] && chown "${CUE_DAEMON_UID}:${CUE_DAEMON_GID}" "$_f" 2>/dev/null || true
    done
  fi
  if [ -p "$DAEMON_STDERR_FIFO" ]; then
    tee -a "$DAEMON_STDERR_TAIL" < "$DAEMON_STDERR_FIFO" >&2 &
    DAEMON_TEE_PID=$!
    (
      cd /app/assistant &&
        DEBUG_STDOUT_LOGS="${DEBUG_STDOUT_LOGS:-1}" \
          exec $DAEMON_PRIVILEGE_PREFIX /app/assistant/docker-entrypoint.sh 2> "$DAEMON_STDERR_FIFO"
    ) &
    DAEMON_PID=$!
  else
    # FIFO unavailable (e.g. read-only workspace) — fall back to inheriting
    # stderr directly. We lose contention detection but never lose the daemon.
    DAEMON_TEE_PID=""
    (
      cd /app/assistant &&
        DEBUG_STDOUT_LOGS="${DEBUG_STDOUT_LOGS:-1}" \
          exec $DAEMON_PRIVILEGE_PREFIX /app/assistant/docker-entrypoint.sh
    ) &
    DAEMON_PID=$!
  fi
}

# daemon_exit_is_contention: true when the daemon's last stderr shows it aborted
# because another instance already holds the transport/DB (PORT_IN_USE /
# DB_LOCKED). Those are the categories emitted by the duplicate-daemon abort in
# src/daemon/server.ts → startup-error.ts. In that case we must exit, not
# respawn.
daemon_exit_is_contention() {
  [ -f "$DAEMON_STDERR_TAIL" ] || return 1
  # Match the last DAEMON_ERROR: line's category. grep for the structured
  # marker so ordinary log noise mentioning "port" can't trip this.
  grep -a 'DAEMON_ERROR:' "$DAEMON_STDERR_TAIL" 2>/dev/null |
    grep -Eq '"error":"(PORT_IN_USE|DB_LOCKED)"'
}

# ── Restart budget + backoff bookkeeping ────────────────────────────────
# Restart timestamps recorded in a rolling window; RESTART_COUNT is the number
# still inside CUE_DAEMON_RESTART_WINDOW_S. Reap the daemon (and its tee) and
# decide: contention → exit non-zero (recycle container, don't duplicate);
# budget exhausted → exit non-zero (crash-loop, let orchestrator recycle);
# otherwise → back off (exponential, capped) and respawn.
RESTART_COUNT=0
# Newline-separated epoch seconds of restarts still within the window.
RESTART_TIMES=""

# now_s: current epoch seconds (date +%s is POSIX-portable).
now_s() { date +%s; }

# reap_daemon: block until the dead daemon (and its tee reader) are fully
# collected so no zombies linger and DAEMON_STDERR_TAIL is flushed.
reap_daemon() {
  wait "$DAEMON_PID" 2>/dev/null || true
  if [ -n "$DAEMON_TEE_PID" ]; then
    # The tee exits on its own once the daemon closes the FIFO write end; give
    # it a moment, then make sure it's gone so its buffer is flushed to the tail.
    wait "$DAEMON_TEE_PID" 2>/dev/null || true
    DAEMON_TEE_PID=""
  fi
}

# supervise_daemon_death: called whenever the daemon process is found dead.
# Returns 0 after a successful respawn (caller resumes monitoring); exits the
# whole script non-zero when the death must recycle the container.
supervise_daemon_death() {
  _where="${1:-supervisor}"
  reap_daemon

  # Contention (another daemon holds the transport/DB): the daemon exited on
  # purpose. Respawning would create a doomed duplicate — hand off to the
  # orchestrator to recycle the whole machine instead.
  if daemon_exit_is_contention; then
    echo "[cue-app] daemon aborted: another instance holds the IPC socket/DB (duplicate-daemon guard) — NOT respawning, recycling container" >&2
    kill "$GATEWAY_PID" 2>/dev/null || true
    exit 1
  fi

  # Prune restart timestamps outside the rolling window, recompute the count.
  _now="$(now_s)"
  _cutoff=$((_now - CUE_DAEMON_RESTART_WINDOW_S))
  _kept=""
  RESTART_COUNT=0
  # shellcheck disable=SC2086
  for _t in $RESTART_TIMES; do
    if [ "$_t" -ge "$_cutoff" ]; then
      _kept="$_kept $_t"
      RESTART_COUNT=$((RESTART_COUNT + 1))
    fi
  done
  RESTART_TIMES="$_kept"

  if [ "$RESTART_COUNT" -ge "$CUE_DAEMON_MAX_RESTARTS" ]; then
    echo "[cue-app] daemon crash-looped: ${RESTART_COUNT} restarts within ${CUE_DAEMON_RESTART_WINDOW_S}s (budget=${CUE_DAEMON_MAX_RESTARTS}) — giving up, recycling container" >&2
    kill "$GATEWAY_PID" 2>/dev/null || true
    exit 1
  fi

  # Exponential backoff: base * 2^count, capped. Uses the pre-increment count
  # so the first restart waits base seconds.
  _backoff="$CUE_DAEMON_BACKOFF_BASE_S"
  _n=0
  while [ "$_n" -lt "$RESTART_COUNT" ]; do
    _backoff=$((_backoff * 2))
    if [ "$_backoff" -ge "$CUE_DAEMON_BACKOFF_MAX_S" ]; then
      _backoff="$CUE_DAEMON_BACKOFF_MAX_S"
      break
    fi
    _n=$((_n + 1))
  done

  _attempt=$((RESTART_COUNT + 1))
  echo "[cue-app] daemon died (${_where}) — RESPAWN attempt ${_attempt}/${CUE_DAEMON_MAX_RESTARTS} in ${_backoff}s (window=${CUE_DAEMON_RESTART_WINDOW_S}s)" >&2
  # Backoff via a backgrounded sleep + wait so the TERM/INT trap can still fire
  # promptly during the pause.
  sleep "$_backoff" &
  wait $! 2>/dev/null || true

  RESTART_TIMES="$RESTART_TIMES $(now_s)"
  RESTART_COUNT=$((RESTART_COUNT + 1))
  start_daemon
  echo "[cue-app] daemon respawned (pid ${DAEMON_PID}); waiting for socket" >&2
  return 0
}

echo "[cue-app] starting daemon (workspace=${VELLUM_WORKSPACE_DIR})" >&2
start_daemon

# GATEWAY_PID is referenced by supervise_daemon_death (to tear the gateway down
# when a death recycles the container). It only exists after the gateway starts
# below; predeclare it empty so the socket-wait phase can share the supervisor.
GATEWAY_PID=""

# Wait for the daemon's IPC socket — the gateway connects to it on boot.
# Large workspaces boot slowly (bun cold start + SQLite WAL replay + schema
# migrations can exceed 3 minutes on a multi-hundred-MB DB), so the budget
# must be generous; a too-short wait turns a healthy slow boot into a crash
# loop. Override per-deploy with CUE_DAEMON_SOCKET_WAIT_S.
#
# If the daemon dies before the socket appears (e.g. OOM mid-boot), route the
# death through the supervisor: a contention/duplicate exit or an exhausted
# budget recycles the container, otherwise it respawns and we restart the wait.
# The wait budget resets per daemon instance — each fresh boot gets its full
# SOCK_WAIT to replay WAL + migrate.
SOCK_WAIT="${CUE_DAEMON_SOCKET_WAIT_S:-900}"
i=0
while [ ! -S "$SOCK" ]; do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[cue-app] daemon exited before creating $SOCK" >&2
    supervise_daemon_death "socket-wait"
    # Respawned: reset the per-instance wait budget and keep polling.
    i=0
    continue
  fi
  i=$((i + 1))
  if [ "$i" -ge "$SOCK_WAIT" ]; then
    echo "[cue-app] timed out after ${i}s waiting for $SOCK — recycling container" >&2
    kill "$DAEMON_PID" 2>/dev/null || true
    exit 1
  fi
  [ $((i % 30)) -eq 0 ] && echo "[cue-app] still waiting for daemon socket (${i}s/${SOCK_WAIT}s — large DBs replay WAL + migrate on first boot)" >&2
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
# every chat/mission. The supervisor below RESPAWNS a crashed/OOM-killed daemon
# in place (bounded budget + backoff) so a transient OOM self-heals without a
# full machine reschedule; only an unrecoverable fault (duplicate-daemon abort,
# crash-loop past budget, or a gateway death) exits non-zero to let the platform
# restart policy (Fly "always" / Render) reboot the whole machine cleanly.
cd /app/gateway
bun --smol run src/index.ts &
GATEWAY_PID=$!

# Clean shutdown: forward SIGTERM/SIGINT (docker stop / platform stop) to the
# gateway, daemon, and the daemon's stderr tee, then wait, so a container stop
# is never treated as a crash (and never triggers a respawn).
_shutdown() {
  trap '' TERM INT
  echo "[cue-app] stop signal — shutting down gateway and daemon" >&2
  kill "$GATEWAY_PID" "$DAEMON_PID" 2>/dev/null || true
  [ -n "$DAEMON_TEE_PID" ] && kill "$DAEMON_TEE_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  exit 0
}
trap _shutdown TERM INT

# Supervise: debian-slim /bin/sh is dash, which lacks bash's `wait -n`, so
# poll both PIDs. `sleep` runs backgrounded + `wait`ed so the TERM/INT trap
# fires immediately instead of after the current sleep completes.
#
# Daemon death → supervise_daemon_death: respawn on OOM/crash within budget, or
# exit non-zero on contention / crash-loop. Gateway death → exit non-zero: the
# gateway is cheap and stateless to recycle and depends on the daemon socket, so
# a fresh container is the right recovery (no in-place gateway respawn).
while :; do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[cue-app] daemon exited unexpectedly" >&2
    supervise_daemon_death "supervisor"
    # Respawned within budget — resume monitoring. The gateway reconnects to
    # the new daemon over the same socket path once it rebinds.
    continue
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "[cue-app] gateway exited — restarting container" >&2
    kill "$DAEMON_PID" 2>/dev/null || true
    [ -n "$DAEMON_TEE_PID" ] && kill "$DAEMON_TEE_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 5 &
  wait $! || true
done
