/**
 * `teach_skill`: the owner demonstrates a task, Cue writes it up as a skill.
 *
 * Three actions on one explicit session — start, status, stop — because the
 * whole product is that the owner controls the boundaries. `stop` returns the
 * transcript and the authoring guidance in its result, so the same turn that
 * ends the demonstration can go on to call `scaffold_managed_skill`. That is
 * deliberate: the alternative was a background job that woke later and wrote a
 * skill on its own, which puts the draft somewhere the owner is not, at a
 * moment they are not thinking about it. Here the draft arrives in the
 * conversation they just had, where "no, that step is only for overdue
 * invoices" is a reply.
 *
 * This tool never writes a skill itself. Writing goes through
 * `scaffold_managed_skill`, which already carries the permission check and the
 * approval card. A second write path would be a second set of rules.
 */

import { HostObserveProxy } from "../../daemon/host-observe-proxy.js";
import {
  ensureTeachDriverStarted,
  stopTeachDriver,
} from "../../teach/teach-driver-lifecycle.js";
import {
  getTeachSessionView,
  getTeachTimeline,
  startTeachSession,
  stopTeachSession,
  TEACH_SESSION_MAX_MINUTES,
} from "../../teach/teach-session.js";
import {
  buildTeachPrompt,
  logTeachSynthesisStart,
} from "../../teach/teach-synthesis.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

function describeView(label: string): string {
  const v = getTeachSessionView();
  if (!v.sessionId) return `${label}: no demonstration has been recorded.`;
  return [
    `${label}:`,
    `- status: ${v.armed ? "watching" : "finished"}`,
    `- learning: ${v.goal || "(not stated)"}`,
    `- steps seen: ${v.stepCount}`,
    ...(v.armed ? [`- stops on its own in: ${v.secondsRemaining}s`] : []),
    ...(v.droppedSteps > 0
      ? [`- steps beyond the retention cap: ${v.droppedSteps}`]
      : []),
  ].join("\n");
}

export async function executeTeachSkill(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action;
  if (action !== "start" && action !== "stop" && action !== "status") {
    return {
      content: 'Error: action must be one of "start", "stop", "status"',
      isError: true,
    };
  }

  if (action === "status") {
    return { content: describeView("Demonstration"), isError: false };
  }

  if (action === "start") {
    const goal = input.goal;
    if (typeof goal !== "string" || !goal.trim()) {
      return {
        content:
          'Error: goal is required — say what you are about to be shown, e.g. "how I file a client invoice". It is what tells the skill apart from the next one.',
        isError: true,
      };
    }

    // Refuse rather than arm a session nothing can look through. Arming here
    // would show the owner a "watching your screen" state over a loop that
    // captures nothing, and they would demonstrate a whole task for no result.
    if (!HostObserveProxy.instance.isAvailable()) {
      return {
        content:
          "I can't watch the screen right now — no desktop client is connected that can share it. Open the Cue desktop app on the machine you want to demonstrate on, then try again.",
        isError: true,
      };
    }

    const requested = input.duration_minutes;
    const view = startTeachSession({
      goal,
      ...(typeof requested === "number" ? { durationMinutes: requested } : {}),
    });
    ensureTeachDriverStarted();

    return {
      content: [
        `Watching your screen to learn: ${view.goal}`,
        ``,
        `Go ahead and do the task as you normally would. I'll stop on my own`,
        `in ${Math.round(view.secondsRemaining / 60)} minute(s) (the cap is`,
        `${TEACH_SESSION_MAX_MINUTES}), or tell me when you're done and I'll`,
        `stop and write it up.`,
      ].join("\n"),
      isError: false,
    };
  }

  // stop
  await stopTeachDriver();
  stopTeachSession();
  const timeline = getTeachTimeline();

  if (!timeline) {
    return {
      content:
        'There\'s no demonstration to write up — nothing was started. Use action "start" first, then do the task.',
      isError: false,
    };
  }

  if (timeline.steps.length === 0) {
    // Not an error: the watching worked, it just saw nothing legible. Saying
    // so plainly beats writing a skill out of an empty transcript.
    return {
      content: [
        `Stopped watching, but I didn't read anything usable off the screen`,
        `for "${timeline.goal}".`,
        ``,
        `That usually means the screen was locked, the desktop client lost its`,
        `connection, or the task happened somewhere I can't see. Nothing was`,
        `recorded, so there's nothing to write up.`,
      ].join("\n"),
      isError: false,
    };
  }

  logTeachSynthesisStart(timeline);
  return { content: buildTeachPrompt(timeline), isError: false };
}
