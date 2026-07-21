/**
 * Playbook runtime — evaluate playbooks against an incoming event and, for the
 * highest-priority match, produce a work item whose autonomy is CAPPED by the
 * global trust dial.
 *
 * This composes the three existing systems rather than duplicating them:
 *  · filing — outputs are ordinary work items (createTask → createWorkItem →
 *    triageAndMaybeAutoRunWorkItem), so they flow through auto-file, the
 *    Review lane, dedupe, and everything else for free.
 *  · guardrails — effective autonomy = requested clamped by the global dial
 *    (autonomy-cap.ts); 'auto' outputs still pass the per-category autonomy
 *    policy + hard-deny guard inside triage before anything actually runs.
 *  · missions — playbooks are event-driven (fired by an inbound item); the
 *    mission orchestrator stays clock-driven. No cadence logic here.
 */

import { createTask } from "../tasks/task-store.js";
import { getLogger } from "../util/logger.js";
import { createWorkItem } from "../work-items/work-item-store.js";
import { triageAndMaybeAutoRunWorkItem } from "../work-items/work-item-triage.js";
import { type CappedAutonomy, effectiveAutonomy } from "./autonomy-cap.js";
import {
  listMatchablePlaybooks,
  markPlaybookFired,
  type PlaybookRecord,
} from "./playbook-store.js";

const log = getLogger("playbook-runtime");

export interface PlaybookEvent {
  /** Channel/source key the event arrived on (e.g. 'gmail', 'slack'). */
  channel: string;
  /** The watcher that surfaced it, if any. */
  watcherId?: string | null;
  /** One-line title for the work item + trigger matching. */
  title: string;
  /** Longer body used for trigger matching (payload summary). */
  summary?: string;
  /** Provenance for the created work item. */
  sourceType?: string;
  sourceId?: string;
  /** Pre-built JSON provenance snapshot; a default is synthesized if absent. */
  sourceContext?: string;
  scopeId?: string;
}

export interface PlaybookFireResult {
  playbookId: string;
  playbookName: string;
  workItemId: string;
  autonomy: CappedAutonomy;
}

function triggerMatches(
  playbook: PlaybookRecord,
  event: PlaybookEvent,
): boolean {
  const needle = playbook.triggerText.trim().toLowerCase();
  // An empty/'*' trigger matches everything on the playbook's channel/watcher.
  if (needle === "" || needle === "*") return true;
  const haystack = `${event.title}\n${event.summary ?? ""}`.toLowerCase();
  return haystack.includes(needle);
}

/**
 * The single highest-priority playbook whose channel/watcher scope AND trigger
 * text match the event, or null. "Priority takes precedence when multiple
 * playbooks match" (SKILL.md) — so exactly one fires.
 */
export function selectPlaybookForEvent(
  event: PlaybookEvent,
): PlaybookRecord | null {
  const candidates = listMatchablePlaybooks({
    channel: event.channel,
    watcherId: event.watcherId ?? null,
    scopeId: event.scopeId,
  });
  for (const p of candidates) {
    if (triggerMatches(p, event)) return p;
  }
  return null;
}

/**
 * Evaluate playbooks for one event and fire the winning rule, if any. Returns
 * null when nothing matched. Best-effort: never throws (a failure here must not
 * take down the watcher tick / channel ingress that called it).
 */
export async function evaluatePlaybooksForEvent(
  event: PlaybookEvent,
): Promise<PlaybookFireResult | null> {
  try {
    const playbook = selectPlaybookForEvent(event);
    if (!playbook) return null;

    const autonomy = effectiveAutonomy(playbook.autonomyLevel);

    // Map effective autonomy → work-item disposition:
    //   notify → parked (never auto-runs; surfaces as a needs-you item)
    //   draft  → queued, drafted for review (skipAutoRun)
    //   auto   → queued, auto-run eligible (still gated by triage policy)
    const parked = autonomy.effective === "notify";
    const skipAutoRun = autonomy.effective !== "auto";

    const task = createTask({
      title: event.title,
      template: event.title,
    });

    const provenance =
      event.sourceContext ??
      JSON.stringify({
        origin: event.channel,
        sourceId: event.sourceId ?? null,
        playbookId: playbook.id,
        playbookName: playbook.name,
        capturedAt: Date.now(),
      });

    const workItem = createWorkItem({
      taskId: task.id,
      title: event.title,
      notes: `Playbook "${playbook.name}": ${playbook.action}`,
      priorityTier: 1,
      sourceType: event.sourceType ?? event.channel,
      sourceId: event.sourceId,
      sourceContext: provenance,
      context: `Triggered by playbook "${playbook.name}" (${autonomy.effective}${
        autonomy.capped ? `, capped from ${autonomy.requested}` : ""
      }). Action: ${playbook.action}`,
      ...(parked ? { autoRunEligibility: "parked" as const } : {}),
      actor: "playbook",
    });

    await triageAndMaybeAutoRunWorkItem(workItem.id, { skipAutoRun });
    markPlaybookFired(playbook.id);

    log.info(
      {
        playbookId: playbook.id,
        workItemId: workItem.id,
        requested: autonomy.requested,
        effective: autonomy.effective,
        capped: autonomy.capped,
        dial: autonomy.dial,
      },
      "playbook fired",
    );

    return {
      playbookId: playbook.id,
      playbookName: playbook.name,
      workItemId: workItem.id,
      autonomy,
    };
  } catch (err) {
    log.warn(
      { err: String(err), channel: event.channel },
      "playbook evaluation failed (event unaffected)",
    );
    return null;
  }
}
