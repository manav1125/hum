/**
 * Function-calling bridge: the curated set of Cue actions exposed to the Gemini
 * Live model, and the executor that runs them against Cue's real stores when the
 * model calls one. This is what makes "Tier 1" voice able to actually DO things
 * (not just chat) — and `run_deep_task` is the escalation hatch to the full
 * agent loop for anything substantive.
 *
 * v1 keeps the surface small and backed entirely by existing, tested work-item
 * functions. New declarations should map to real executors the same way — never
 * a stub that reports false success (the cardinal voice sin).
 */

import { createTask } from "../tasks/task-store.js";
import { getLogger } from "../util/logger.js";
import {
  createWorkItemWithPermissions,
  listWorkItems,
} from "../work-items/work-item-store.js";
import { triageAndMaybeAutoRunWorkItem } from "../work-items/work-item-triage.js";
import type {
  GeminiFunctionDeclaration,
  GeminiLiveToolCall,
} from "./gemini-live-client.js";

const log = getLogger("gemini-live-tools");

export const GEMINI_LIVE_FUNCTION_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: "add_task",
    description:
      "Capture a quick task or to-do on the user's list. Use for simple reminders the user asks you to note down.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title of the task, e.g. 'Call the dentist'.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "run_deep_task",
    description:
      "Hand a substantive request to Cue's full assistant to work on in the background (research, drafting, multi-step work). The user will get the result in their Review lane. Use this when a request needs real work rather than a one-line answer.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "A clear, self-contained description of what to do, in the user's intent.",
        },
      },
      required: ["request"],
    },
  },
  {
    name: "get_open_tasks",
    description:
      "Look up the user's current open tasks (queued, running, or awaiting their review) so you can tell them what's on their plate.",
    parameters: { type: "object", properties: {} },
  },
];

const OPEN_STATUSES = new Set(["queued", "running", "awaiting_review"]);

/**
 * Create a work item and return IMMEDIATELY, running triage + any auto-run in
 * the background. The shared `executeTaskListAdd` path blocks up to 12s waiting
 * for the triage/auto-run decision — fine for typed chat, but in a live voice
 * turn that stall makes the model go silent and the realtime session time the
 * turn out ("add a task stopped working"). Voice tool calls must be instant.
 */
function createWorkItemFast(opts: {
  title: string;
  executionPrompt?: string;
  conversationId: string;
  /**
   * When true, triage may auto-run the item in the background (for `run_deep_task`
   * — real work whose result lands in Review). When false (a plain `add_task`
   * to-do like "go to the gym"), the item just sits in the queue as a reminder;
   * auto-running a to-do produces nonsense output and hides it in Review.
   */
  autoRun: boolean;
}): string {
  const template = opts.executionPrompt ?? opts.title;
  const task = createTask({
    title: opts.title,
    template,
    createdFromConversationId: opts.conversationId,
  });
  const workItem = createWorkItemWithPermissions({
    taskId: task.id,
    title: opts.title,
    priorityTier: 1,
  });
  if (opts.autoRun) {
    // Fire-and-forget: triage + policy-gated auto-run in the background.
    void triageAndMaybeAutoRunWorkItem(workItem.id, {
      callerSetPriority: false,
    }).catch((err) =>
      log.warn({ err, id: workItem.id }, "background triage failed"),
    );
  }
  return workItem.id;
}

/**
 * Execute a function the Gemini Live model called. Returns the plain object that
 * goes back as the `functionResponse`. Never throws — a failure is reported to
 * the model as `{ ok: false, error }` so it can tell the user honestly.
 */
export async function executeGeminiLiveFunctionCall(
  call: GeminiLiveToolCall,
  ctx: { conversationId: string },
): Promise<{ id?: string; name: string; response: unknown }> {
  const wrap = (response: unknown) => ({
    id: call.id,
    name: call.name,
    response,
  });

  try {
    switch (call.name) {
      case "add_task": {
        const title = String(call.args.title ?? "").trim();
        if (!title) return wrap({ ok: false, error: "empty title" });
        const id = createWorkItemFast({
          title,
          conversationId: ctx.conversationId,
          autoRun: false,
        });
        log.info({ title, id }, "gemini-live add_task");
        return wrap({
          ok: true,
          message: `Added "${title}" to your task list.`,
        });
      }

      case "run_deep_task": {
        const request = String(call.args.request ?? "").trim();
        if (!request) return wrap({ ok: false, error: "empty request" });
        const id = createWorkItemFast({
          title: request.length > 80 ? `${request.slice(0, 77)}…` : request,
          executionPrompt: request,
          conversationId: ctx.conversationId,
          autoRun: true,
        });
        log.info({ id }, "gemini-live run_deep_task");
        return wrap({
          ok: true,
          message:
            "Started working on that in the background; it'll be in the Review lane.",
        });
      }

      case "get_open_tasks": {
        const open = listWorkItems()
          .filter((w) => OPEN_STATUSES.has(w.status))
          .slice(0, 10)
          .map((w) => ({ title: w.title, status: w.status }));
        return wrap({ ok: true, count: open.length, tasks: open });
      }

      default:
        return wrap({ ok: false, error: `unknown function ${call.name}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, name: call.name }, "gemini-live function call failed");
    return wrap({ ok: false, error: message });
  }
}
