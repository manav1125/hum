import { execSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { getRuntimeHttpHost, getRuntimeHttpPort } from "../config/env.js";
import { getIsContainerized } from "../config/env-registry.js";
import { loadOrCreateSigningKey } from "../runtime/auth/token-service.js";
import { ensureBun } from "../util/bun-runtime.js";
import { DaemonError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  ensureDataDir,
  getDaemonStartupLockPath,
  getDaemonStderrLogPath,
  getDataDir,
  getPidPath,
  getWorkspaceConfigPath,
} from "../util/platform.js";

const log = getLogger("lifecycle");

const DAEMON_TIMEOUT_DEFAULTS = {
  startupSocketWaitMs: 5000,
  stopTimeoutMs: 5000,
  sigkillGracePeriodMs: 2000,
};

const HEALTH_CHECK_TIMEOUT_MS = 1500;
const STARTUP_LOCK_STALE_MS = 120_000;

function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Read daemon timeout values directly from the config JSON file, bypassing
 * loadConfig() and its ensureMigratedDataDir()/ensureDataDir() side effects.
 * Falls back to hardcoded defaults on any error (missing file, malformed JSON,
 * unexpected shape) so daemon stop/start never fails due to config issues.
 */
function readDaemonTimeouts(): typeof DAEMON_TIMEOUT_DEFAULTS {
  try {
    const raw = JSON.parse(readFileSync(getWorkspaceConfigPath(), "utf-8"));
    if (raw.daemon && typeof raw.daemon === "object") {
      return {
        startupSocketWaitMs: isPositiveInteger(raw.daemon.startupSocketWaitMs)
          ? raw.daemon.startupSocketWaitMs
          : DAEMON_TIMEOUT_DEFAULTS.startupSocketWaitMs,
        stopTimeoutMs: isPositiveInteger(raw.daemon.stopTimeoutMs)
          ? raw.daemon.stopTimeoutMs
          : DAEMON_TIMEOUT_DEFAULTS.stopTimeoutMs,
        sigkillGracePeriodMs: isPositiveInteger(raw.daemon.sigkillGracePeriodMs)
          ? raw.daemon.sigkillGracePeriodMs
          : DAEMON_TIMEOUT_DEFAULTS.sigkillGracePeriodMs,
      };
    }
  } catch {
    // Missing file, malformed JSON, etc. — use defaults.
  }
  return { ...DAEMON_TIMEOUT_DEFAULTS };
}

/**
 * Kill the stale daemon recorded in this workspace's PID file, if any.
 * Only targets the exact PID from our PID file — never scans globally —
 * so isolated daemons (e.g., dev instances with a different VELLUM_WORKSPACE_DIR)
 * are never affected.
 */
function killStaleDaemon(): void {
  const pid = readPid();
  if (pid == null) return;
  if (!isProcessRunning(pid)) {
    cleanupPidFile();
    return;
  }

  // Guard against stale PID reuse: if the PID has been recycled by the OS
  // and now belongs to an unrelated process, we must not signal it.
  if (!isVellumDaemonProcess(pid)) {
    log.info(
      { pid },
      "PID file references a non-vellum process (stale PID reuse) — cleaning up PID file only",
    );
    cleanupPidFile();
    return;
  }

  // The PID file references a live vellum daemon process, but getDaemonStatus()
  // (called earlier in startDaemon) already returns early when the daemon is
  // healthy. If we reach here, the recorded process is alive but non-responsive.
  try {
    log.info({ pid }, "Killing stale daemon process from PID file");
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may have exited between the check and the kill.
  }
  cleanupPidFile();
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a PID belongs to a vellum daemon process (a bun process
 * running the daemon's main.ts). Prevents signaling an unrelated process
 * that reused a stale PID.
 */
function isVellumDaemonProcess(pid: number): boolean {
  try {
    const cmd = execSync(`ps -ww -p ${pid} -o command=`, {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // The daemon is spawned as `bun run <path>/main.ts` — look for bun
    // running our daemon entry point.
    return cmd.includes("bun") && cmd.includes("daemon/main.ts");
  } catch {
    // Process exited or ps failed — treat as not ours.
    return false;
  }
}

/** Normalize a bind address to a connectable host for health checks.
 *  Wildcard addresses (0.0.0.0, ::) bind all interfaces but aren't
 *  connectable on all platforms — substitute loopback. IPv6 literals
 *  need brackets in URLs. */
function healthCheckHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  if (host.includes(":")) return `[${host}]`;
  return host;
}

/** Hit the daemon's HTTP /healthz endpoint. Returns true if it responds
 *  with HTTP 200 within the timeout — false on connection refused, timeout,
 *  or any other error. */
async function isHttpHealthy(): Promise<boolean> {
  const host = healthCheckHost(getRuntimeHttpHost());
  const port = getRuntimeHttpPort();
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (getIsContainerized()) return null; // Docker manages process lifecycle
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function writePid(pid: number): void {
  if (getIsContainerized()) return; // Docker manages process lifecycle
  writeFileSync(getPidPath(), String(pid));
}

export function cleanupPidFile(): void {
  if (getIsContainerized()) return; // Docker manages process lifecycle
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
}

/** Only remove the PID file if it belongs to the given process. Prevents a
 *  failing second startup from deleting the PID of an already-running daemon. */
export function cleanupPidFileIfOwner(ownerPid: number): void {
  if (getIsContainerized()) return; // Docker manages process lifecycle
  const currentPid = readPid();
  if (currentPid === ownerPid) {
    cleanupPidFile();
  }
}

export function isDaemonRunning(): boolean {
  if (getIsContainerized()) return true; // Container orchestrator manages lifecycle
  const pid = readPid();
  if (pid == null) return false;
  if (!isProcessRunning(pid)) {
    cleanupPidFile();
    return false;
  }
  return true;
}

async function getDaemonStatus(): Promise<{
  running: boolean;
  pid?: number;
}> {
  if (getIsContainerized()) return { running: true, pid: process.pid }; // Container orchestrator manages lifecycle
  const pid = readPid();
  if (pid == null) return { running: false };
  if (!isProcessRunning(pid)) {
    cleanupPidFile();
    return { running: false };
  }
  // Guard against stale PID reuse: if the OS recycled the PID and it now
  // belongs to an unrelated process, discard the stale PID file.
  if (!isVellumDaemonProcess(pid)) {
    log.info(
      { pid },
      "PID file references a non-vellum process (stale PID reuse) — cleaning up",
    );
    cleanupPidFile();
    return { running: false };
  }
  // Process is alive and is ours — verify HTTP /healthz is responsive. A
  // deadlocked or wedged daemon will pass the PID liveness check but fail
  // to accept connections, and should be treated as not running so
  // killStaleDaemon() can clean it up.
  const responsive = await isHttpHealthy();
  if (!responsive) {
    log.warn(
      { pid },
      "Daemon process alive but HTTP health check unresponsive",
    );
    return { running: false, pid };
  }
  return { running: true, pid };
}

function getStartupLockPath(): string {
  return getDaemonStartupLockPath();
}

/**
 * Contents of the startup lock: who holds it, and since when.
 *
 * The PID is the part that matters. Age alone cannot distinguish a crashed
 * holder from a slow one, and those two need opposite handling — see
 * {@link acquireStartupLock}. Written as JSON; a bare-number body from an
 * older build parses as a timestamp with no owner, which is treated as
 * unverifiable and falls back to the age rule.
 */
interface StartupLockRecord {
  pid?: number;
  ts: number;
}

function readStartupLock(lockPath: string): StartupLockRecord | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8").trim();
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; ts?: unknown };
    if (typeof parsed.ts === "number") {
      return {
        ts: parsed.ts,
        ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
      };
    }
  } catch {
    // Fall through to the legacy bare-timestamp format.
  }
  const ts = parseInt(raw, 10);
  return isNaN(ts) ? null : { ts };
}

/**
 * Attempt to acquire the daemon startup lock. Returns true on success.
 *
 * Breaking a held lock is decided by OWNERSHIP first and age only second.
 * The lock used to be broken on age alone, which gets the dangerous case
 * backwards: a daemon that legitimately takes longer than the timeout to
 * start is not a crashed one, and stealing its lock starts a SECOND daemon
 * against the same workspace. Two daemons is the one failure this codebase
 * refuses to degrade into — invisible to health checks, unreachable by stop
 * commands, and still running the scheduler, memory worker and background
 * wake against a shared database, so every side effect happens twice.
 *
 * So: a lock whose owner is provably gone is broken immediately, however
 * fresh it is — a crashed starter should not block the next one for two
 * minutes. A lock whose owner is alive is respected for the stale window.
 *
 * The age rule is kept as the escape hatch rather than replaced by ownership,
 * because a PID can be reused: an unrelated process that inherits the number
 * would otherwise hold the lock forever. Age also remains the only rule
 * available for a lock that names no owner, which now means a file written by
 * an older build.
 *
 * Exported only so its tests exercise this function rather than a re-declared
 * copy of the rule, which would drift toward permissive without failing.
 */
export function acquireStartupLock(): boolean {
  const lockPath = getStartupLockPath();
  try {
    // Ensure the root directory exists before attempting the lock file write.
    // On a first-time run, getRootDir() may not exist yet, and writeFileSync
    // with 'wx' would throw ENOENT — which the catch block misinterprets as
    // "lock already held."
    ensureDataDir();
    // O_CREAT | O_EXCL — fails atomically if the file already exists.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
      { flag: "wx" },
    );
    return true;
  } catch {
    // Lock file exists — decide whether its holder is still there.
    const record = readStartupLock(lockPath);
    if (record === null) {
      // Unreadable: another process may be mid-write. Do not break it.
      return false;
    }

    if (record.pid !== undefined && isProcessRunning(record.pid)) {
      // Owner is alive. Respect the lock unless it has also outlived the
      // stale window, which is the escape hatch for PID reuse: an unrelated
      // process that inherited the number would otherwise hold the lock
      // forever.
      //
      // Liveness is `kill(pid, 0)` — a syscall, deliberately not a `ps`
      // probe of the command line. Identifying a process by forking `ps` is
      // a known scar here: forking is what fails first under memory
      // pressure, so the check returns "not ours" exactly when the machine
      // is struggling, and a live holder's lock gets broken at the worst
      // possible moment. The starter is also not necessarily the daemon
      // entry point, so a command-line match would not identify it anyway.
      if (Date.now() - record.ts <= STARTUP_LOCK_STALE_MS) return false;
    } else if (record.pid !== undefined) {
      // Owner is provably gone: break immediately however fresh the lock is.
      // A crashed starter should not block the next one for two minutes.
      try {
        unlinkSync(lockPath);
      } catch {
        // Someone else removed it first; retrying is still correct.
      }
      return acquireStartupLock();
    }

    if (Date.now() - record.ts > STARTUP_LOCK_STALE_MS) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* raced with another breaker */
      }
      return acquireStartupLock();
    }
    return false;
  }
}

/**
 * Release the startup lock, but only if this process still owns it.
 *
 * An unconditional unlink can delete a lock another process legitimately
 * acquired after ours was broken, which would let a third start proceed
 * concurrently — reintroducing the two-daemon case from the other side.
 */
export function releaseStartupLock(): void {
  const lockPath = getStartupLockPath();
  const record = readStartupLock(lockPath);
  // A legacy lock names no owner; it can only have been ours to release.
  if (
    record !== null &&
    record.pid !== undefined &&
    record.pid !== process.pid
  ) {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* already removed */
  }
}

// NOTE: startDaemon() is the assistant-side daemon lifecycle manager.
// It should eventually converge with cli/src/lib/local.ts::startLocalDaemon
// which is the CLI-side equivalent.
async function startDaemon(): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  const status = await getDaemonStatus();
  if (status.running && status.pid) {
    return { pid: status.pid, alreadyRunning: true };
  }

  // Serialize concurrent startup attempts. If another caller already holds
  // the lock, wait for it to finish and then re-check daemon status.
  if (!acquireStartupLock()) {
    log.info("Another startup in progress, waiting for lock");
    const lockWaitMs = 10_000;
    const lockInterval = 200;
    let lockWaited = 0;
    let lockAcquired = false;
    while (lockWaited < lockWaitMs) {
      await new Promise((r) => setTimeout(r, lockInterval));
      lockWaited += lockInterval;
      if (acquireStartupLock()) {
        lockAcquired = true;
        break;
      }
    }
    if (!lockAcquired) {
      // Timed out waiting for the lock — re-check status in case the
      // other caller succeeded.
      const recheck = await getDaemonStatus();
      if (recheck.running && recheck.pid) {
        return { pid: recheck.pid, alreadyRunning: true };
      }
      throw new DaemonError(
        "Timed out waiting for concurrent daemon startup to finish",
      );
    }
    // Acquired the lock after waiting — re-check in case the other caller
    // already started the daemon successfully.
    const recheck = await getDaemonStatus();
    if (recheck.running && recheck.pid) {
      releaseStartupLock();
      return { pid: recheck.pid, alreadyRunning: true };
    }
  }

  try {
    return await startDaemonLocked();
  } finally {
    releaseStartupLock();
  }
}

async function startDaemonLocked(): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  // Kill a stale daemon recorded in this workspace's PID file (e.g., after
  // a crash where the process is alive but non-responsive).
  killStaleDaemon();

  // Ensure root + workspace dirs exist before spawning. The daemon itself
  // handles full ensureDataDir() during runDaemon(), but we need at least
  // the root dir for the PID file and stderr log.
  ensureDataDir();

  // Spawn the daemon as a detached child process
  const mainPath = resolve(import.meta.dirname ?? __dirname, "main.ts");

  // Pre-load the signing key so the daemon receives it via env var and
  // never needs to access the protected directory for key material.
  // Done before opening stderrFd to avoid leaking the file descriptor if
  // loadOrCreateSigningKey throws.
  const spawnEnv = { ...process.env };
  if (!spawnEnv.ACTOR_TOKEN_SIGNING_KEY) {
    try {
      const key = loadOrCreateSigningKey();
      spawnEnv.ACTOR_TOKEN_SIGNING_KEY = key.toString("hex");
    } catch (err) {
      throw new DaemonError(
        `Failed to pre-load signing key for daemon: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Resolve bun before opening stderrFd to avoid leaking the file
  // descriptor if ensureBun() throws (same pattern as loadOrCreateSigningKey).
  const bunPath = await ensureBun();

  // Redirect the child's stderr to a file instead of piping it back to the
  // parent. A pipe's read end is destroyed when the parent exits, leaving
  // fd 2 broken in the child. Bun (unlike Node.js) does not ignore SIGPIPE,
  // so any later stderr write would silently kill the daemon.
  const stderrPath = getDaemonStderrLogPath();
  const stderrFd = openSync(stderrPath, "w");

  const child = spawn(bunPath, ["run", mainPath], {
    detached: true,
    stdio: ["ignore", "ignore", stderrFd],
    env: spawnEnv,
  });

  // The child inherited the fd; close the parent's copy.
  closeSync(stderrFd);

  let childExited = false;
  let childExitCode: number | null = null;
  child.on("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });

  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new DaemonError("Failed to start daemon: no PID returned");
  }

  // Wait for HTTP /healthz to respond before writing the PID file. Writing
  // it earlier would leave an orphaned PID file if the daemon crashes during
  // initialization — callers would think the daemon is still running.
  const timeouts = readDaemonTimeouts();
  const maxWait = timeouts.startupSocketWaitMs;
  const interval = 200;
  let waited = 0;
  while (waited < maxWait) {
    if (childExited) {
      const stderr = readFileSync(stderrPath, "utf-8").trim();
      const detail = stderr
        ? `\n${stderr}`
        : `\nCheck logs at ${getDataDir()}/logs/ for details.`;
      throw new DaemonError(
        `Daemon exited immediately (code ${
          childExitCode ?? "unknown"
        }).${detail}`,
      );
    }
    if (await isHttpHealthy()) {
      writePid(pid);
      return { pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  // The child process is still running but the HTTP health check hasn't
  // passed yet. Write the PID file so isDaemonRunning()/stopDaemon() can
  // still track and manage the orphaned process.
  writePid(pid);
  throw new DaemonError(
    `Daemon started but health check not responding after ${maxWait}ms`,
  );
}

export type StopResult =
  | { stopped: true }
  | { stopped: false; reason: "not_running" | "stop_failed" };

export async function ensureDaemonRunning(): Promise<void> {
  const status = await getDaemonStatus();
  if (status.running) return;
  await startDaemon();
}
