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

import { executeTaskListAdd } from "../tools/tasks/work-item-enqueue.js";
import type { ToolContext } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { listWorkItems } from "../work-items/work-item-store.js";
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

/** Build a minimal guardian ToolContext for a live-voice-originated action. */
function buildToolContext(conversationId: string): ToolContext {
  return {
    conversationId,
    workingDir: process.cwd(),
  } as ToolContext;
}

const OPEN_STATUSES = new Set(["queued", "running", "awaiting_review"]);

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
        const result = await executeTaskListAdd(
          { title, if_exists: "reuse_existing" },
          buildToolContext(ctx.conversationId),
        );
        log.info({ title, isError: result.isError }, "gemini-live add_task");
        return wrap(
          result.isError
            ? { ok: false, error: result.content }
            : { ok: true, message: `Added "${title}".` },
        );
      }

      case "run_deep_task": {
        const request = String(call.args.request ?? "").trim();
        if (!request) return wrap({ ok: false, error: "empty request" });
        // Enqueue as a work item with the full request as the execution prompt;
        // triage auto-runs it in the background per the user's autonomy policy —
        // exactly the same path a typed request takes.
        const result = await executeTaskListAdd(
          {
            title: request.length > 80 ? `${request.slice(0, 77)}…` : request,
            execution_prompt: request,
            if_exists: "create_duplicate",
          },
          buildToolContext(ctx.conversationId),
        );
        log.info({ isError: result.isError }, "gemini-live run_deep_task");
        return wrap(
          result.isError
            ? { ok: false, error: result.content }
            : {
                ok: true,
                message:
                  "Started working on that in the background; it'll be in the Review lane.",
              },
        );
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
