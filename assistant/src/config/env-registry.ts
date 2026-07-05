/**
 * Centralized environment variable registry.
 *
 * This module documents every VELLUM_* and related env var with its type,
 * default, and description, and exports typed accessor functions for each.
 *
 * IMPORTANT: This module has NO internal imports (no logger, no platform
 * utilities) so it can be safely imported from bootstrap-level code like
 * util/platform.ts and util/logger.ts without circular dependencies.
 *
 * Higher-level env vars that depend on the logger or config system live in
 * config/env.ts, which re-exports selected accessors from this module.
 */

// ── Helpers (dependency-free) ────────────────────────────────────────────────

function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

function flag(name: string): boolean {
  const raw = str(name);
  return raw === "true" || raw === "1";
}

function int(name: string): number | undefined {
  const raw = str(name);
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ── Registry ─────────────────────────────────────────────────────────────────
// Each entry documents the env var name, type, default, and purpose.

/**
 * DEBUG_STDOUT_LOGS — boolean, default: false
 * Enables additional log output to stdout (alongside file logging).
 */
export function getDebugStdoutLogs(): boolean {
  return flag("DEBUG_STDOUT_LOGS");
}

/**
 * IS_CONTAINERIZED — boolean, default: false
 * When true, indicates the assistant is running inside a container (e.g. Docker).
 * Persistent data is stored in VELLUM_WORKSPACE_DIR (mapped to a dedicated volume).
 */
export function getIsContainerized(): boolean {
  return flag("IS_CONTAINERIZED");
}

/**
 * IS_PLATFORM — boolean, default: false
 * When true, indicates the assistant is running as a platform-managed
 * remote instance. Controls platform-specific behaviors like webhook
 * callback registration and blocking `platform disconnect`.
 *
 * Separate from IS_CONTAINERIZED because local Docker assistants are
 * containerized (need CES sidecar, gateway trust store, etc.) but are
 * not platform-managed.
 */
export function getIsPlatform(): boolean {
  return flag("IS_PLATFORM");
}

/**
 * Whether this assistant is running as a platform-managed remote instance.
 */
export function isPlatformRemote(): boolean {
  return getIsPlatform();
}

/**
 * VELLUM_DISABLE_PLATFORM — boolean, default: false
 * When true, all outbound platform API calls in local mode are suppressed.
 * The daemon, gateway, and web UI each no-op platform requests with a
 * debug log. Has no effect when IS_PLATFORM is true (platform-managed
 * instances always connect to the platform).
 */
export function getDisablePlatform(): boolean {
  return flag("VELLUM_DISABLE_PLATFORM");
}

/**
 * VELLUM_DEVICE_ID — string, default: undefined
 * Host-stable device id injected by the CLI into containerized deployments,
 * where the container fs cannot persist device.json across recreation.
 * Takes precedence over device.json resolution in util/device-id.ts.
 */
export function getDeviceIdOverride(): string | undefined {
  return str("VELLUM_DEVICE_ID");
}

/**
 * VELLUM_WORKSPACE_DIR — string, default: undefined
 * Overrides the default workspace directory.
 * Used in containerized deployments where the workspace is a separate volume.
 */
export function getWorkspaceDirOverride(): string | undefined {
  return str("VELLUM_WORKSPACE_DIR");
}

/**
 * VELLUM_BACKUP_DIR — string, default: undefined
 * Overrides the default backup root directory (~/.vellum/backups/).
 * Used in containerized deployments where the backup directory must be
 * on a persistent volume.
 */
export function getBackupDirOverride(): string | undefined {
  return str("VELLUM_BACKUP_DIR");
}

/**
 * VELLUM_BACKUP_KEY_PATH — string, default: undefined
 * Overrides the default backup encryption key path (~/.vellum/protected/backup.key).
 * Used in containerized deployments where the key must be on a persistent volume.
 */
export function getBackupKeyPathOverride(): string | undefined {
  return str("VELLUM_BACKUP_KEY_PATH");
}

// ── Profiler env vars ───────────────────────────────────────────────────
// These are injected by the platform when running a managed assistant in
// profiler mode. The runtime uses them to locate, scope, and budget-limit
// profiler output on the workspace volume.

/**
 * VELLUM_CPU_LIMIT — string (K8s resource format), default: undefined
 * The CPU resource limit for the container (e.g. "2000m", "2").
 * Set by the platform StatefulSet template to the exact K8s CPU limit.
 * Used by the health endpoint to report accurate CPU core count inside
 * gVisor sandboxes where cgroup files may expose the host node's CPUs.
 */
export function getCpuLimit(): string | undefined {
  return str("VELLUM_CPU_LIMIT");
}

/**
 * VELLUM_MINIKUBE_STORAGE_SIZE — string (K8s resource format), default: undefined
 * The PVC storage request size for the assistant volume (e.g. "10Gi").
 * Only set in minikube (local dev) mode. Used by the health endpoint to
 * report accurate disk capacity on hostPath-backed PVCs where statfsSync
 * reports the host's entire filesystem instead of the PVC.
 */
export function getMinikubeStorageSize(): string | undefined {
  return str("VELLUM_MINIKUBE_STORAGE_SIZE");
}

/**
 * VELLUM_DISABLE_DISK_PRESSURE — boolean, default: false
 * When set, the disk-pressure guard stays disabled and never locks. Intended
 * for deployments where the workspace lives on a large shared host filesystem
 * (e.g. a Render overlay) rather than a dedicated volume, so `statfs` of the
 * workspace reflects other tenants' usage and false-locks the assistant into
 * storage-cleanup mode. A pure flag check, so it can never silently fail the
 * way the `du`-vs-`statfs` measurement heuristic can.
 */
export function getDiskPressureDisabled(): boolean {
  return flag("VELLUM_DISABLE_DISK_PRESSURE");
}

/**
 * VELLUM_DISABLE_CES — boolean, default: false
 * When set, the daemon does not start, discover, or reconnect to the CES
 * (Credential Execution Service) sidecar at all — credentials come from the
 * encrypted file store with env-var fallback. Intended for containerized
 * deployments that ship no CES sidecar (e.g. the single-container Render
 * cue-app): without the flag, startup discovery fails and the credential
 * layer keeps attempting a CES "upgrade" reconnection every cooldown window
 * forever. Do NOT set this on platform-managed pods, where the CES sidecar
 * is the primary credential source and reconnection is how the daemon
 * recovers from sidecar restarts.
 */
export function getCesDisabled(): boolean {
  return flag("VELLUM_DISABLE_CES");
}

/**
 * CUE_DISABLE_MEMORY_ROUTER — boolean, default: false
 * When set, the memory-v2 "Sonnet router" (a blocking per-turn LLM call that
 * selects concept pages to inject) is suppressed even when
 * `config.memory.v2.router.enabled` is true, falling through to the fast
 * activation pipeline (ANN + BM25, no extra LLM call). The router roughly
 * doubles per-turn latency — it runs a full model call before the main agent
 * call — and is unreliable through OpenRouter (its forced tool call frequently
 * fails schema validation, so it pays the latency and injects nothing). A pure
 * env flag so the latency-critical path can be cut without a per-workspace
 * config migration.
 *
 * Note: `memory.v2.router.enabled` now defaults to FALSE in the config schema
 * for exactly the reasons above, so this flag only matters for workspaces
 * that explicitly opted the router back on in config.json — it remains as
 * the emergency off switch for those.
 */
export function getMemoryV2RouterDisabled(): boolean {
  return flag("CUE_DISABLE_MEMORY_ROUTER");
}

/**
 * CUE_DISABLE_LOOP_LAG_MONITOR — boolean, default: false
 * Kill switch for the event-loop lag monitor (`util/event-loop-lag.ts`),
 * which logs `event_loop_blocked` warnings whenever synchronous work stalls
 * the daemon's single event loop. The monitor costs one timer tick per 250ms;
 * disable only if the probe itself is suspected of noise in a benchmark.
 */
export function getLoopLagMonitorDisabled(): boolean {
  return flag("CUE_DISABLE_LOOP_LAG_MONITOR");
}

/**
 * CUE_LOOP_LAG_WARN_MS — integer (ms), default: 500
 * Warn threshold for the event-loop lag monitor. Blocks shorter than this
 * are not logged.
 */
export function getLoopLagWarnMs(): number | undefined {
  return int("CUE_LOOP_LAG_WARN_MS");
}

/**
 * CUE_LOG_FULL_LLM_PAYLOADS — boolean, default: false
 * When set, `llm_request_logs` rows store raw LLM request/response payloads
 * verbatim instead of truncating individual strings over 64KB (in practice:
 * inline base64 media). Full payloads restore pre-truncation inspector
 * fidelity at the cost of multi-MB synchronous serialization + sqlite writes
 * on the turn path and unbounded assistant.db growth on image-heavy
 * conversations. Debugging aid only.
 */
export function getLogFullLlmPayloads(): boolean {
  return flag("CUE_LOG_FULL_LLM_PAYLOADS");
}

/**
 * CUE_DISABLE_BACKGROUND_MEMORY — boolean, default: false
 * EMERGENCY BRAKE: when set, the background memory re-processing jobs (v2
 * consolidation and the memory retrospective) bail immediately.
 *
 * The default (unset) is safe: both jobs run on EPHEMERAL conversations —
 * the conversation row is deleted when the run settles (see
 * `runBackgroundJob`'s `ephemeralConversation` option and the retrospective
 * handler's delete-on-success) — and terminal `memory_jobs` rows are reaped
 * on a 7-day retention, so recurring runs no longer accumulate DB rows. Both
 * jobs execute only via the memory jobs worker's background queue, never in
 * a user turn's path.
 *
 * Setting the flag also disables memory EXTRACTION downstream: `remember`
 * writes land in `memory/buffer.md` but consolidation never routes them into
 * searchable concept pages, so "Remember X" is acknowledged and then never
 * recalled. Leave it unset except while diagnosing a live incident. Memory
 * RECALL/INJECTION of the already-built graph is unaffected either way. A
 * pure env flag so it can be cut without a per-workspace config migration,
 * matching {@link getMemoryV2RouterDisabled}.
 */
export function getDisableBackgroundMemory(): boolean {
  return flag("CUE_DISABLE_BACKGROUND_MEMORY");
}

/**
 * CUE_DISABLE_WORKITEM_AUTORUN — boolean, default: false
 * Kill-switch for autonomy-policy-gated auto-execution of freshly captured
 * work items (work-items/work-item-triage.ts). When set, captured items stay
 * queued until the user runs them manually — triage scoring still applies.
 * A pure env flag so it can be cut without a per-workspace config migration,
 * matching {@link getDisableBackgroundMemory}.
 */
export function getDisableWorkItemAutoRun(): boolean {
  return flag("CUE_DISABLE_WORKITEM_AUTORUN");
}

/**
 * CUE_DISABLE_MISSION_ORCHESTRATOR — boolean, default: false
 * Kill-switch for scheduled per-mission orchestrator cycles
 * (missions/mission-orchestrator.ts). When set, cadenced cycles are skipped
 * entirely; an explicit manual trigger (POST missions/:id/run-cycle) still
 * runs, mirroring the heartbeat's force semantics. A pure env flag so it can
 * be cut without a per-workspace config migration, matching
 * {@link getDisableWorkItemAutoRun}.
 */
export function getDisableMissionOrchestrator(): boolean {
  return flag("CUE_DISABLE_MISSION_ORCHESTRATOR");
}

/**
 * CUE_DISABLE_CONTACT_MEMORY — boolean, default: false
 * Kill-switch for from-conversation contact-memory auto-extraction
 * (contacts/contact-memory-extract-job.ts). When set, the post-conversation
 * `contact_memory_extract` background job short-circuits without running the
 * flash-LLM pass, so the People dossier's "WHAT CUE REMEMBERS" section only
 * shows manual/told facts — never auto-extracted ones. The manual "remember
 * about X" path is unaffected. Read at job time so the switch takes effect
 * without a daemon restart. A pure env flag so it can be cut without a
 * per-workspace config migration, matching {@link getDisableWorkItemAutoRun}.
 */
export function getDisableContactMemory(): boolean {
  return flag("CUE_DISABLE_CONTACT_MEMORY");
}

/**
 * VELLUM_PROFILER_RUN_ID — string, default: undefined
 * Unique identifier for the current profiler run. When set, the profiler
 * run store treats this run as "active" and will never prune its directory.
 */
export function getProfilerRunId(): string | undefined {
  return str("VELLUM_PROFILER_RUN_ID");
}

/**
 * VELLUM_PROFILER_MODE — string, default: undefined
 * The profiling mode to activate (e.g. "cpu", "heap", "cpu+heap").
 * When unset, profiling is disabled.
 */
export function getProfilerMode(): string | undefined {
  return str("VELLUM_PROFILER_MODE");
}

/**
 * VELLUM_PROFILER_MAX_BYTES — integer, default: undefined
 * Maximum total bytes retained across all profiler runs (including active).
 * The startup sweep prunes oldest completed runs to stay within budget.
 */
export function getProfilerMaxBytes(): number | undefined {
  return int("VELLUM_PROFILER_MAX_BYTES");
}

/**
 * VELLUM_PROFILER_MAX_RUNS — integer, default: undefined
 * Maximum number of completed profiler runs retained on disk.
 * The startup sweep prunes oldest completed runs to stay within budget.
 */
export function getProfilerMaxRuns(): number | undefined {
  return int("VELLUM_PROFILER_MAX_RUNS");
}

/**
 * VELLUM_PROFILER_MIN_FREE_MB — integer, default: undefined
 * Minimum free disk space (in megabytes) that must remain after profiler
 * runs are accounted for. The startup sweep prunes oldest completed runs
 * until at least this much free space is available.
 */
export function getProfilerMinFreeMb(): number | undefined {
  return int("VELLUM_PROFILER_MIN_FREE_MB");
}

// ── APNs (direct Apple Push Notification service) ────────────────────────────
// Credentials for token-based APNs auth (.p8 signing key). These carry
// credential material, so they are intentionally NOT added to
// tools/terminal/safe-env.ts — agent-spawned child processes never need them.

/**
 * CUE_APNS_KEY_P8 — string, default: undefined
 * Contents of the APNs .p8 signing key (PEM). Literal "\n" sequences are
 * normalized to real newlines so the key can be pasted into single-line
 * env configuration UIs (e.g. the Render dashboard). Takes precedence over
 * CUE_APNS_KEY_PATH.
 */
export function getApnsKeyP8(): string | undefined {
  const raw = str("CUE_APNS_KEY_P8");
  return raw ? raw.replace(/\\n/g, "\n") : undefined;
}

/**
 * CUE_APNS_KEY_PATH — string, default: undefined
 * Filesystem path to the APNs .p8 signing key. Used when CUE_APNS_KEY_P8
 * is not set.
 */
export function getApnsKeyPath(): string | undefined {
  return str("CUE_APNS_KEY_PATH");
}

/**
 * CUE_APNS_KEY_ID — string, default: undefined
 * The 10-character Key ID of the APNs signing key (Apple Developer portal,
 * Certificates, Identifiers & Profiles → Keys). JWT `kid` header.
 */
export function getApnsKeyId(): string | undefined {
  return str("CUE_APNS_KEY_ID");
}

/**
 * CUE_APNS_TEAM_ID — string, default: undefined
 * The Apple Developer Team ID that owns the signing key. JWT `iss` claim.
 */
export function getApnsTeamId(): string | undefined {
  return str("CUE_APNS_TEAM_ID");
}

/**
 * CUE_APNS_BUNDLE_ID — string, default: "com.ventureverse.cue"
 * The iOS app bundle identifier, sent as the `apns-topic` header.
 */
export function getApnsBundleId(): string {
  return str("CUE_APNS_BUNDLE_ID") ?? "com.ventureverse.cue";
}

/**
 * CUE_APNS_ENV — "sandbox" | "production", default: "production"
 * Which APNs environment to send to. Development builds (run from Xcode)
 * register sandbox tokens; TestFlight and App Store builds register
 * production tokens.
 */
export function getApnsEnv(): "sandbox" | "production" {
  return str("CUE_APNS_ENV") === "sandbox" ? "sandbox" : "production";
}

// ── Known env var names ──────────────────────────────────────────────────────

/**
 * Complete set of recognized VELLUM_* env var names. Used by validateEnvVars()
 * to warn about typos or unrecognized variables.
 */
const KNOWN_VELLUM_VARS = new Set([
  "VELLUM_ASSISTANT_NAME",
  "VELLUM_ASSISTANT_PLATFORM_URL",
  "VELLUM_AWS_ROLE_ARN",
  "VELLUM_BACKUP_DIR",
  "VELLUM_BACKUP_KEY_PATH",
  "VELLUM_CLOUD",
  "VELLUM_DAEMON_AUTOSTART",
  "VELLUM_DATA_DIR",
  "VELLUM_DEBUG",
  "VELLUM_DESKTOP_APP",
  "VELLUM_DEV",
  "VELLUM_DEVICE_ID",
  "VELLUM_DISABLE_PLATFORM",
  "VELLUM_DOCS_BASE_URL",
  "VELLUM_ENVIRONMENT",
  "VELLUM_HATCHED_BY",
  "VELLUM_HOOK_EVENT",
  "VELLUM_HOOK_NAME",
  "VELLUM_HOOK_SETTINGS",
  "VELLUM_LOCKFILE_DIR",
  "VELLUM_PLATFORM_URL",
  "VELLUM_PROFILER_MAX_BYTES",
  "VELLUM_PROFILER_MAX_RUNS",
  "VELLUM_PROFILER_MIN_FREE_MB",
  "VELLUM_PROFILER_MODE",
  "VELLUM_PROFILER_RUN_ID",
  "VELLUM_ROOT_DIR",
  "VELLUM_SSH_USER",
  "VELLUM_WORKSPACE_DIR",
  "VELLUM_CPU_LIMIT",
  "VELLUM_MEMORY_LIMIT",
  "VELLUM_MINIKUBE_STORAGE_SIZE",
  "VELLUM_DISABLE_DISK_PRESSURE",
  "VELLUM_DISABLE_CES",
]);

/**
 * Check all VELLUM_* env vars and return warnings for any unrecognized ones.
 * Returns an array of warning messages (empty if all vars are recognized).
 *
 * This is intentionally a pure function that returns strings rather than
 * logging directly, so it can be called from bootstrap code before the
 * logger is initialized.
 */
export function checkUnrecognizedEnvVars(): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VELLUM_") && !KNOWN_VELLUM_VARS.has(key)) {
      warnings.push(`Unrecognized environment variable: ${key}`);
    }
  }
  return warnings;
}
