/**
 * Level-based reconciler converging plugin `schedules/` declarations into
 * ordinary schedule rows.
 *
 * Ported from upstream ede433188c, re-based onto Cue's schedule store.
 * Upstream identifies declared rows with `source_key` / `definition_hash` /
 * `user_enabled` columns added by their persistence migration 364. Our
 * schedule rows live in the memory DB (`schedule_jobs`), whose schema is
 * owned outside this module's territory, so the reconciler keeps its
 * bookkeeping in a JSON sidecar instead:
 * `<workspace>/plugins-data/plugin-schedules-state.json`, mapping each
 * declaration's `sourceKey` (`plugin:<pluginName>/<scheduleName>`) to the
 * schedule row it manages, the definition hash last applied, and the enabled
 * state last written — enough to detect user overrides without schema
 * changes. Declared rows are additionally attributed via
 * `createdBy: "plugin:<pluginName>"`.
 *
 * Each pass enumerates the installed, enabled plugins, parses their
 * declarations (see `./plugin-schedule-declarations.ts`), and diffs the
 * desired set against the sidecar-tracked rows: new declarations are
 * inserted, changed ones (by `definitionHash`) updated in place, and rows
 * whose declaration is gone (plugin uninstalled/disabled, schedules dir
 * removed, or the feature flag turned off) are disarmed in place. Rows the
 * sidecar does not track are imperative schedules and are never touched.
 *
 * User overrides: a user may enable/disable a declared row through the
 * ordinary schedules UI. The sidecar records the enabled value the
 * reconciler last wrote; a row whose live value differs was toggled by the
 * user, and that choice survives reconciles and definition updates unless
 * the declaration's own `enabled` field changes (a new declared value wins
 * once, then the user can override again). A user who deletes a declared
 * row keeps it deleted until the declaration's definition changes, which
 * recreates the row as a new consent baseline.
 *
 * Fail-closed rules follow upstream: an invalid declaration keeps its
 * last-good `execute` row untouched (the row fires the message that last
 * validated) but disarms a `script` row (the row fires `index.sh` by path,
 * which is exactly the content that failed to validate). An `ended`
 * recurrence keeps last-good handling in both modes.
 *
 * Triggers: daemon startup (`../plugins/user-loader.ts` after the plugin
 * load loop), the plugin auto-update sweep after an unattended upgrade
 * (`../plugins/auto-update.ts`), and a periodic backstop sweep started
 * alongside boot that covers CLI installs/enables that happen while the
 * daemon runs.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { emitNotificationSignal } from "../notifications/emit-signal.js";
import type { AttentionHints } from "../notifications/signal.js";
import { isPluginDisabled } from "../plugins/disabled-state.js";
import { parsePluginManifest } from "../plugins/external-plugin-loader.js";
import { listInstalledPluginDirs } from "../plugins/installed-plugin-dirs.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import {
  type DeclarationError,
  parsePluginScheduleDeclarations,
  type ScheduleDeclaration,
} from "./plugin-schedule-declarations.js";
import { isPluginSchedulesEnabled } from "./plugin-schedules-gate.js";
import {
  createSchedule,
  deleteSchedule,
  DuplicateScheduleError,
  getSchedule,
  type ScheduleJob,
  updateSchedule,
} from "./schedule-store.js";

const log = getLogger("plugin-schedule-reconciler");

// ── Sidecar state ───────────────────────────────────────────────────────

export const PLUGIN_SCHEDULES_STATE_FILENAME = "plugin-schedules-state.json";

/** One tracked declaration → schedule-row link. */
export interface DeclaredScheduleStateEntry {
  /** Row id in the schedule store. */
  scheduleId: string;
  /** Definition hash last applied to the row. */
  definitionHash: string;
  /** The declaration's `enabled` field as of the last apply. */
  declaredEnabled: boolean;
  /**
   * The row `enabled` value the reconciler last wrote. A live row whose
   * value differs was toggled by the user; that override is preserved.
   */
  appliedEnabled: boolean;
  /** True when the reconciler disarmed the row (plugin/flag off). */
  disarmed: boolean;
  /**
   * True when the user deleted the row; respected until the definition
   * hash changes, which recreates the row as a new consent baseline.
   */
  userDeleted: boolean;
  pluginName: string;
  scheduleName: string;
}

interface PluginSchedulesState {
  version: 1;
  entries: Record<string, DeclaredScheduleStateEntry>;
}

function statePath(): string {
  return join(
    getWorkspaceDir(),
    "plugins-data",
    PLUGIN_SCHEDULES_STATE_FILENAME,
  );
}

function loadState(): PluginSchedulesState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as unknown;
    if (
      raw !== null &&
      typeof raw === "object" &&
      (raw as PluginSchedulesState).version === 1 &&
      typeof (raw as PluginSchedulesState).entries === "object" &&
      (raw as PluginSchedulesState).entries !== null
    ) {
      return raw as PluginSchedulesState;
    }
  } catch {
    // Missing or unreadable: start fresh. A corrupt sidecar loses the
    // user-override bookkeeping but never orphans rows silently — the
    // re-link pass below re-adopts rows by their `createdBy` attribution.
  }
  return { version: 1, entries: {} };
}

function saveState(state: PluginSchedulesState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a crash mid-write never leaves a truncated sidecar.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

// ── Reconcile pass ──────────────────────────────────────────────────────

/** In-flight pass; concurrent triggers await it rather than racing. */
let reconcileInFlight: Promise<void> | null = null;

/**
 * Converge plugin-declared schedules against the current on-disk plugin set.
 *
 * Single-flight: concurrent triggers serialize through the in-flight latch,
 * so two passes never interleave their list/diff/write sequences. Never
 * throws: a failed pass is logged and the next trigger retries from disk.
 */
export async function reconcilePluginSchedules(): Promise<void> {
  while (reconcileInFlight !== null) {
    await reconcileInFlight;
  }
  reconcileInFlight = (async () => {
    try {
      await runReconcilePass();
    } catch (err) {
      log.error({ err }, "Plugin schedule reconcile failed");
    }
  })().finally(() => {
    reconcileInFlight = null;
  });
  await reconcileInFlight;
}

interface DesiredEntry {
  pluginName: string;
  declaration: ScheduleDeclaration;
}

interface CollectedDeclarations {
  desired: Map<string, DesiredEntry>;
  errors: DeclarationError[];
  /** Keys whose plugin manifest failed to parse; their rows must disarm. */
  manifestFailedKeys: Set<string>;
}

async function runReconcilePass(): Promise<void> {
  // The feature flag is a kill switch, not just a launch gate. While it is
  // off nothing is parsed, and the desired set is empty, so the disarm
  // branch below turns every declared row off on the next pass. Turning the
  // flag back on re-arms them from their declarations.
  const { desired, errors, manifestFailedKeys }: CollectedDeclarations =
    isPluginSchedulesEnabled()
      ? await collectDesiredDeclarations()
      : { desired: new Map(), errors: [], manifestFailedKeys: new Set() };

  const state = loadState();

  for (const [sourceKey, { pluginName, declaration }] of desired) {
    try {
      applyDeclaration(state, sourceKey, pluginName, declaration);
    } catch (err) {
      log.error(
        { err, sourceKey },
        "Failed to apply declared schedule, skipping",
      );
    }
  }

  // A key with a declaration error keeps its last-good row untouched: fail
  // closed means the broken declaration does not load, not that a previously
  // healthy schedule is torn down by its own typo. An execute row can be
  // held that way because it fires the message stored on the row, which is
  // the one that last validated.
  //
  // A script row cannot: it fires its entrypoint by absolute path, so
  // holding it armed through an invalid declaration runs whatever `index.sh`
  // now holds, which is exactly the content that failed to validate. Those
  // rows disarm through the same path as an absent declaration and re-arm on
  // the pass after the declaration parses again. An `ended` recurrence is
  // not a rewrite, so it keeps the last-good handling in both modes.
  const heldKeys = new Set<string>();
  for (const error of errors) {
    const entry = state.entries[error.sourceKey];
    const row = entry ? getSchedule(entry.scheduleId) : null;
    const disarmsScriptRow =
      error.kind === "invalid" && row !== null && row.mode === "script";
    if (!disarmsScriptRow && !manifestFailedKeys.has(error.sourceKey)) {
      heldKeys.add(error.sourceKey);
    }
  }

  // Disarm rows whose declaration is absent from the desired set (plugin
  // uninstalled or disabled, flag off, or the schedule directory removed),
  // plus the script rows an invalid declaration left out of `heldKeys`
  // above. The row, its runs, and the sidecar entry are kept so a reinstall
  // or re-enable re-links by `sourceKey`.
  for (const [sourceKey, entry] of Object.entries(state.entries)) {
    if (desired.has(sourceKey) || heldKeys.has(sourceKey)) {
      continue;
    }
    if (entry.userDeleted || entry.disarmed) {
      continue;
    }
    try {
      const row = getSchedule(entry.scheduleId);
      if (row === null) {
        entry.userDeleted = true;
        continue;
      }
      if (row.enabled) {
        updateSchedule(entry.scheduleId, { enabled: false });
        log.info(
          { sourceKey, scheduleId: entry.scheduleId },
          "Disarmed plugin-declared schedule (declaration absent)",
        );
      }
      entry.disarmed = true;
      entry.appliedEnabled = false;
    } catch (err) {
      log.error(
        { err, sourceKey, scheduleId: entry.scheduleId },
        "Failed to disarm declared schedule, skipping",
      );
    }
  }

  for (const error of errors) {
    emitDefinitionError(error, !heldKeys.has(error.sourceKey));
  }

  // A pass that tracks nothing and has nothing to track leaves no sidecar
  // behind — a workspace with no plugin schedules should not grow one.
  if (Object.keys(state.entries).length > 0 || existsSync(statePath())) {
    saveState(state);
  }
}

/**
 * Converge one declaration onto its schedule row, creating, updating, or
 * re-arming as needed, and record the outcome in the sidecar entry.
 */
function applyDeclaration(
  state: PluginSchedulesState,
  sourceKey: string,
  pluginName: string,
  declaration: ScheduleDeclaration,
): void {
  const entry = state.entries[sourceKey];
  const config = declaration.config;

  const definitionUpdates = {
    description: config.description ?? `Declared by the ${pluginName} plugin`,
    syntax: config.syntax,
    expression: config.expression,
    // Script-mode runs ignore the message column (the engine executes
    // `script`); it is non-null in the schema, so store an empty string.
    message: declaration.message ?? "",
    script: declaration.scriptInvocation,
    mode: declaration.mode,
    quiet: config.quiet ?? false,
    inferenceProfile: config.inferenceProfile,
    timeoutMs: config.timeoutMs,
  };

  const existingRow = entry ? getSchedule(entry.scheduleId) : null;

  if (entry && existingRow === null) {
    // The user deleted the row. Respect that until the definition changes:
    // a new definition is a new consent baseline and recreates the row.
    if (entry.definitionHash === declaration.definitionHash) {
      if (!entry.userDeleted) {
        entry.userDeleted = true;
      }
      return;
    }
  }

  if (!entry || existingRow === null) {
    let created: ScheduleJob;
    try {
      created = createSchedule({
        name: `${pluginName}/${declaration.name}`,
        ...definitionUpdates,
        timezone: config.timezone,
        enabled: config.enabled,
        maxRetries: config.maxRetries ?? undefined,
        retryBackoffMs: config.retryBackoffMs ?? undefined,
        createdBy: `plugin:${pluginName}`,
      });
    } catch (err) {
      if (err instanceof DuplicateScheduleError) {
        log.warn(
          { sourceKey, existingId: err.existingId },
          "Declared schedule collides with an existing schedule of the same name and cadence — skipping",
        );
        return;
      }
      throw err;
    }
    state.entries[sourceKey] = {
      scheduleId: created.id,
      definitionHash: declaration.definitionHash,
      declaredEnabled: config.enabled,
      appliedEnabled: created.enabled,
      disarmed: false,
      userDeleted: false,
      pluginName,
      scheduleName: declaration.name,
    };
    // A row arming without consent must never be silent: an unattended
    // install/upgrade has no interactive consent prompt, so the arrival
    // notification is the consent surface for those paths. Deduped by
    // definition hash so concurrent triggers emit once.
    if (created.enabled) {
      emitScheduleDeclared(pluginName, declaration);
    }
    return;
  }

  // Row exists. Work out the enabled value this pass should apply:
  // - the user's live toggle wins over a re-apply of the same declared value;
  // - a *changed* declared value wins once (an upgrade flipping `enabled`);
  // - a disarmed row re-arms to the resolved value.
  const userOverrode = existingRow.enabled !== entry.appliedEnabled;
  const declaredChanged = config.enabled !== entry.declaredEnabled;
  const targetEnabled = declaredChanged
    ? config.enabled
    : userOverrode
      ? existingRow.enabled
      : entry.disarmed
        ? config.enabled
        : existingRow.enabled;

  const definitionChanged = entry.definitionHash !== declaration.definitionHash;
  const rearming = entry.disarmed && targetEnabled && !existingRow.enabled;

  if (
    definitionChanged ||
    entry.disarmed ||
    existingRow.enabled !== targetEnabled
  ) {
    updateSchedule(entry.scheduleId, {
      name: `${pluginName}/${declaration.name}`,
      ...definitionUpdates,
      timezone: config.timezone,
      enabled: targetEnabled,
      maxRetries: config.maxRetries ?? 3,
      retryBackoffMs: config.retryBackoffMs ?? 60000,
    });
    if (definitionChanged && existingRow.enabled && targetEnabled) {
      // Surface a plugin upgrade rewriting an armed schedule's definition,
      // so the user learns the thing firing on their behalf changed.
      emitDefinitionChanged(pluginName, declaration);
    }
    if (definitionChanged && !existingRow.enabled && targetEnabled) {
      // A definition change arming a disarmed row gets the arrival
      // notification: it is new behavior the user has not consented to.
      emitScheduleDeclared(pluginName, declaration);
    } else if (rearming) {
      log.info(
        { sourceKey, scheduleId: entry.scheduleId },
        "Re-armed plugin-declared schedule",
      );
    }
  }

  entry.definitionHash = declaration.definitionHash;
  entry.declaredEnabled = config.enabled;
  entry.appliedEnabled = targetEnabled;
  entry.disarmed = false;
  entry.userDeleted = false;
  entry.pluginName = pluginName;
  entry.scheduleName = declaration.name;
}

/**
 * Enumerate installed plugins and gather their schedule declarations.
 * Identity = the directory basename, mirroring the plugin loader.
 *
 * Disabled plugins and plugins without a `schedules/` directory are skipped
 * entirely; only schedule-declaring plugins pay the manifest parse each
 * pass. A schedule-declaring plugin whose manifest fails
 * {@link parsePluginManifest} (unreadable or schema-invalid `package.json`)
 * also contributes nothing to the desired set: the runtime loader refuses
 * to bring such a plugin up, so its schedules must not stay armed either.
 */
async function collectDesiredDeclarations(): Promise<CollectedDeclarations> {
  const desired = new Map<string, DesiredEntry>();
  const errors: DeclarationError[] = [];
  const manifestFailedKeys = new Set<string>();

  for (const { name, dir } of listInstalledPluginDirs()) {
    if (isPluginDisabled(name)) {
      continue;
    }
    if (!existsSync(join(dir, "schedules"))) {
      continue;
    }
    const parsed = parsePluginScheduleDeclarations(dir, name);
    if ((await parsePluginManifest(dir, { quiet: true })) === undefined) {
      const reason = "the plugin's package.json could not be read or validated";
      for (const declared of [
        ...parsed.declarations.map((d) => ({
          scheduleName: d.name,
          sourceKey: d.sourceKey,
        })),
        ...parsed.errors,
      ]) {
        manifestFailedKeys.add(declared.sourceKey);
        errors.push({
          pluginName: name,
          scheduleName: declared.scheduleName,
          sourceKey: declared.sourceKey,
          reason,
          kind: "invalid",
        });
      }
      continue;
    }
    for (const declaration of parsed.declarations) {
      desired.set(declaration.sourceKey, { pluginName: name, declaration });
    }
    errors.push(...parsed.errors);
  }

  return { desired, errors, manifestFailedKeys };
}

// ── Definition-lifecycle notifications ──────────────────────────────────

// Same shape as the background-job failure notification: passive home-feed
// surfacing, no action required.
const DEFINITION_NOTIFICATION_HINTS: AttentionHints = {
  requiresAction: false,
  urgency: "medium",
  isAsyncBackground: true,
  visibleInSourceNow: false,
};

/**
 * Fire-and-forget definition-lifecycle signal. Simplified from upstream's
 * tracked-emit machinery: dedupe rides the pipeline's `dedupeKey` alone, so
 * a transient pipeline failure drops the notification instead of retrying.
 */
function emitDefinitionSignal(
  sourceEventName: string,
  sourceKey: string,
  dedupeKey: string,
  contextPayload: Record<string, unknown>,
): void {
  void emitNotificationSignal({
    sourceChannel: "scheduler",
    sourceContextId: sourceKey,
    sourceEventName,
    dedupeKey,
    contextPayload,
    attentionHints: DEFINITION_NOTIFICATION_HINTS,
  }).catch((err) => {
    log.warn(
      { err, sourceKey, sourceEventName },
      "Failed to emit schedule definition notification",
    );
  });
}

/**
 * UTC day of the last definition-error emit per `sourceKey`. A persistently
 * broken declaration re-surfaces on every backstop pass; this guard skips
 * the emit call entirely so steady-state passes do no notification work.
 */
const definitionErrorEmittedDay = new Map<string, string>();

/** Test-only: forget the definition-error day latch. */
export function resetDefinitionErrorEmitGuardForTests(): void {
  definitionErrorEmittedDay.clear();
}

function emitDefinitionError(error: DeclarationError, paused: boolean): void {
  if (error.kind === "ended") {
    // A bounded recurrence that ran its course is not an authoring error.
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  if (definitionErrorEmittedDay.get(error.sourceKey) === day) {
    return;
  }
  definitionErrorEmittedDay.set(error.sourceKey, day);
  emitDefinitionSignal(
    "schedule.definition_error",
    error.sourceKey,
    `schedule-definition-error:${error.sourceKey}:${day}`,
    {
      pluginName: error.pluginName,
      scheduleName: error.scheduleName,
      sourceKey: error.sourceKey,
      reason: error.reason,
      paused,
    },
  );
}

function emitDefinitionChanged(
  pluginName: string,
  declaration: ScheduleDeclaration,
): void {
  emitDefinitionSignal(
    "schedule.definition_changed",
    declaration.sourceKey,
    `schedule-definition-changed:${declaration.sourceKey}:${declaration.definitionHash}`,
    {
      pluginName,
      scheduleName: declaration.name,
      sourceKey: declaration.sourceKey,
    },
  );
}

function emitScheduleDeclared(
  pluginName: string,
  declaration: ScheduleDeclaration,
): void {
  emitDefinitionSignal(
    "schedule.declared",
    declaration.sourceKey,
    `schedule-declared:${declaration.sourceKey}:${declaration.definitionHash}`,
    {
      pluginName,
      scheduleName: declaration.name,
      sourceKey: declaration.sourceKey,
      cadence: declaration.config.expression,
    },
  );
}

// ── Periodic backstop sweep ─────────────────────────────────────────────

/**
 * Backstop interval. CLI installs / enable-disable toggles write to disk
 * without poking the daemon, so this bounds how long a change can go
 * unreflected in the rows.
 */
const SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Guard against a slow pass stacking further passes behind the latch. */
let sweepInProgress = false;

/**
 * Start the periodic reconcile sweep. Idempotent: repeat calls reuse the
 * timer. The timer is unref'd so it never keeps the process alive.
 */
export function startPluginScheduleReconcileSweep(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    void reconcilePluginSchedules().finally(() => {
      sweepInProgress = false;
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** Stop the periodic reconcile sweep. Used in tests and shutdown. */
export function stopPluginScheduleReconcileSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}

/**
 * Test-only: delete every sidecar-tracked schedule row and reset the
 * sidecar. Production code never deletes declared rows (they disarm and
 * keep their history); tests need a clean slate between cases.
 */
export function resetPluginSchedulesStateForTests(): void {
  const state = loadState();
  for (const entry of Object.values(state.entries)) {
    try {
      deleteSchedule(entry.scheduleId);
    } catch {
      // best-effort cleanup
    }
  }
  saveState({ version: 1, entries: {} });
}
