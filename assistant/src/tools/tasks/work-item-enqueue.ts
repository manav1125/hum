import { createTask, getTask, listTasks } from "../../tasks/task-store.js";
import { sanitizeToolList } from "../../tasks/tool-sanitizer.js";
import { getLogger } from "../../util/logger.js";
import {
  buildWorkItemMismatchError,
  createWorkItemWithPermissions,
  findActiveWorkItemBySource,
  getWorkItem,
  identifyEntityById,
  updateWorkItem,
  type WorkItem,
} from "../../work-items/work-item-store.js";
import {
  triageAndMaybeAutoRunWorkItem,
  type TriageAutoRunOutcome,
} from "../../work-items/work-item-triage.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("task-list-add");

const PRIORITY_LABELS: Record<number, string> = {
  0: "high",
  1: "medium",
  2: "low",
};

/**
 * Safety ceiling on how long the tool result waits for the triage + auto-run
 * decision. The decision itself is bounded (the flash triage sidechain has an
 * 8s timeout, then the policy check is milliseconds), so this only fires if
 * something hangs — in which case the result falls back to an honest hedge.
 */
const AUTO_RUN_DECISION_WAIT_MS = 12_000;

/**
 * Await the triage + auto-run outcome, bounded by
 * {@link AUTO_RUN_DECISION_WAIT_MS}. Returns `null` when the decision didn't
 * land in time (the triage keeps going in the background; only the report is
 * hedged).
 */
async function awaitAutoRunOutcome(
  outcomePromise: Promise<TriageAutoRunOutcome>,
): Promise<TriageAutoRunOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), AUTO_RUN_DECISION_WAIT_MS);
  });
  try {
    return await Promise.race([outcomePromise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Status + guidance lines for the enqueue result, reflecting what actually
 * happened after triage: if the auto-runner STARTED the item, the tool result
 * must say so (so the model tells the user it's running, not "waiting for you
 * to say run") — the historical bug was composing the reply from the
 * pre-triage snapshot.
 */
function buildStatusLines(
  workItem: WorkItem,
  outcome: TriageAutoRunOutcome | null,
): { statusLine: string; note: string } {
  // Re-read so the reported status reflects post-triage reality.
  const fresh = getWorkItem(workItem.id) ?? workItem;

  if (outcome?.autoRunStarted || fresh.status === "running") {
    return {
      statusLine: `  Status: running (auto-started)`,
      note: "Cue auto-started this task in the background per the user's autonomy settings. Tell the user it is ALREADY RUNNING and the result will land in the Review lane — do NOT say it is queued or waiting for approval.",
    };
  }

  if (outcome === null) {
    // Decision didn't land in time — hedge rather than promise it will wait.
    return {
      statusLine: `  Status: ${fresh.status}`,
      note: "Cue may still start this task automatically in the background, depending on the user's autonomy settings. Don't promise it will wait for an explicit go-ahead.",
    };
  }

  return {
    statusLine: `  Status: ${fresh.status}`,
    note: "The task is queued and will wait for the user (or an explicit task_queue_run) to start it.",
  };
}

/**
 * Execution channels that are NOT external messaging channels and therefore
 * carry no meaningful channel provenance for a work item: the local desktop
 * app ("vellum") and internal transports ("platform", "a2a"). A commitment
 * enqueued from one of these is a genuine local task — it must stay
 * source-less so {@link sourceTypeToCategory} renders it as "task" rather than
 * fabricating a channel.
 */
const NON_CHANNEL_EXECUTION_CHANNELS: ReadonlySet<string> = new Set([
  "vellum",
  "platform",
  "a2a",
]);

/**
 * Resolve the real `(sourceType, sourceId)` provenance for a work item being
 * enqueued from a channel commitment. Explicit `source_type` / `source_id`
 * inputs (e.g. supplied by the action-board synth or a caller that already
 * knows the canonical channel ids) win; otherwise we fall back to the
 * invocation's own channel context — `executionChannel` is the channel kind
 * (slack/telegram/whatsapp/phone/email) and the requester chat id (or the
 * conversation id) is the stable conversation/source id.
 *
 * Returns `{}` for genuine local tasks (desktop / internal transports), so the
 * generic task path is preserved and dedup keys stay channel-distinct.
 */
function deriveWorkItemSource(
  input: Record<string, unknown>,
  context: ToolContext,
): { sourceType?: string; sourceId?: string } {
  const explicitType =
    typeof input.source_type === "string" && input.source_type.trim()
      ? input.source_type.trim()
      : undefined;
  const explicitId =
    typeof input.source_id === "string" && input.source_id.trim()
      ? input.source_id.trim()
      : undefined;
  if (explicitType || explicitId) {
    return {
      ...(explicitType ? { sourceType: explicitType } : {}),
      ...(explicitId ? { sourceId: explicitId } : {}),
    };
  }

  const channel = context.executionChannel?.trim();
  if (!channel || NON_CHANNEL_EXECUTION_CHANNELS.has(channel)) {
    return {};
  }

  // The conversation/source id within that channel: prefer the external chat
  // id (the channel-native thread id), then the Slack channel binding, then
  // the internal conversation id as a last resort.
  const sourceId =
    context.requesterChatId?.trim() ||
    context.channelPermissionChannelId?.trim() ||
    context.conversationId?.trim() ||
    undefined;

  return {
    sourceType: channel,
    ...(sourceId ? { sourceId } : {}),
  };
}

function handleDuplicate(
  title: string,
  ifExists: string,
  input: Record<string, unknown>,
  source: { sourceType?: string; sourceId?: string },
): ToolExecutionResult | null {
  // Source-aware dedup: key on (sourceType, sourceId, title) when a channel
  // source is known so two channel commitments only collapse when they share
  // the same channel/conversation AND title. Falls back to title-only for
  // source-less local tasks (handled inside findActiveWorkItemBySource).
  const match = findActiveWorkItemBySource({
    title,
    sourceType: source.sourceType ?? null,
    sourceId: source.sourceId ?? null,
  });
  if (!match) return null;
  log.info(
    { title, existingId: match.id, ifExists },
    "task_list_add: duplicate detected",
  );

  if (ifExists === "reuse_existing") {
    log.info(
      { title, existingId: match.id },
      "task_list_add: reused existing item",
    );
    return {
      content: `Task "${match.title}" already exists in the queue (ID: ${match.id}, status: ${match.status}). Use task_list_update to modify it.`,
      isError: false,
    };
  }

  if (ifExists === "update_existing") {
    const updates: Partial<{
      title: string;
      notes: string;
      priorityTier: number;
      sortIndex: number;
    }> = {};
    if (input.priority_tier !== undefined)
      updates.priorityTier = input.priority_tier as number;
    if (input.notes !== undefined) updates.notes = input.notes as string;
    if (input.sort_index !== undefined)
      updates.sortIndex = input.sort_index as number;
    if (Object.keys(updates).length > 0) {
      updateWorkItem(match.id, updates);
    }
    log.info(
      { title, existingId: match.id, updates },
      "task_list_add: updated existing item",
    );
    return {
      content: `Reused existing task "${match.title}" (ID: ${
        match.id
      }) instead of creating a duplicate.${
        Object.keys(updates).length > 0
          ? ` Updated: ${Object.keys(updates).join(", ")}.`
          : ""
      }`,
      isError: false,
    };
  }

  return null;
}

export async function executeTaskListAdd(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const taskId = input.task_id as string | undefined;
    const taskName = input.task_name as string | undefined;
    const titleOverride = input.title as string | undefined;
    const executionPrompt = input.execution_prompt as string | undefined;
    const notes = input.notes as string | undefined;
    const priorityTier = input.priority_tier as number | undefined;
    const sortIndex = input.sort_index as number | undefined;
    const rawRequiredTools = input.required_tools as string[] | undefined;

    const ifExists = (input.if_exists as string) || "reuse_existing";

    // Real channel provenance for this commitment (slack/telegram/…+ conv id),
    // or `{}` for a genuine local task. Stamped onto the work item so the feed
    // can group/dedup per channel instead of seeing a generic "task".
    const source = deriveWorkItemSource(input, context);

    // Sanitize explicit required_tools if provided (including empty array)
    const hasExplicitTools = rawRequiredTools !== undefined;
    const sanitizedTools = hasExplicitTools
      ? sanitizeToolList(rawRequiredTools)
      : undefined;

    // Ad-hoc mode: title provided without task_id or task_name
    if (!taskId && !taskName) {
      if (!titleOverride) {
        return {
          content:
            "Error: You must provide either task_id, task_name, or title to create a work item.",
          isError: true,
        };
      }

      // Duplicate-prevention guard
      if (ifExists !== "create_duplicate") {
        const duplicateResult = handleDuplicate(
          titleOverride,
          ifExists,
          input,
          source,
        );
        if (duplicateResult) return duplicateResult;
      } else {
        log.info(
          { title: titleOverride },
          "task_list_add: creating duplicate (if_exists=create_duplicate)",
        );
      }

      log.debug({ title: titleOverride }, "task_list_add: creating new item");

      // Auto-create a lightweight task template for the ad-hoc item.
      // Use execution_prompt as the template (the actual instruction sent to the
      // model at run time), falling back to notes then title. This preserves
      // detailed instructions (e.g. full file paths) that may be shortened in
      // the display title.
      const adHocTemplate = executionPrompt ?? notes ?? titleOverride;
      const adHocTask = createTask({
        title: titleOverride,
        template: adHocTemplate,
      });

      // For ad-hoc items: explicit tools → persist; omitted → null
      const adHocRequiredTools = hasExplicitTools
        ? JSON.stringify(sanitizedTools)
        : undefined;

      const workItem = createWorkItemWithPermissions({
        taskId: adHocTask.id,
        title: titleOverride,
        notes,
        priorityTier: priorityTier ?? 1,
        sortIndex,
        requiredTools: adHocRequiredTools,
        ...source,
      });
      // Await the triage + auto-run DECISION (bounded; not the run itself) so
      // the tool result reports what actually happened to the item.
      const outcome = await awaitAutoRunOutcome(
        triageAndMaybeAutoRunWorkItem(workItem.id, {
          callerSetPriority: priorityTier != null,
        }),
      );

      log.info(
        {
          selectorType: "title",
          workItemId: workItem.id,
          title: workItem.title,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          autoRunStarted: outcome?.autoRunStarted ?? "unknown",
        },
        "ad-hoc work item created",
      );

      const priority =
        PRIORITY_LABELS[workItem.priorityTier] ??
        `tier ${workItem.priorityTier}`;
      const { statusLine, note } = buildStatusLines(workItem, outcome);
      const lines = [
        `Enqueued work item:`,
        `  Title: ${workItem.title}`,
        `  ID: ${workItem.id}`,
        `  Priority: ${priority}`,
        statusLine,
      ];
      if (workItem.notes) {
        lines.push(`  Notes: ${workItem.notes}`);
      }
      if (workItem.sortIndex !== undefined) {
        lines.push(`  Sort index: ${workItem.sortIndex}`);
      }
      lines.push("", note);

      return { content: lines.join("\n"), isError: false };
    }

    let resolvedTask;

    if (taskId) {
      resolvedTask = getTask(taskId);
      if (!resolvedTask) {
        const entity = identifyEntityById(taskId);
        if (entity.type === "work_item") {
          return {
            content: `Error: ${buildWorkItemMismatchError(
              taskId,
              entity.title!,
              "task_list_update to modify the existing work item, or task_list_add with just a title for a new ad-hoc item",
            )}`,
            isError: true,
          };
        }
        return {
          content: `Error: No task definition found with ID "${taskId}". Use task_list to see available task templates, or provide just a title to create an ad-hoc work item.`,
          isError: true,
        };
      }
    } else {
      // Search by name (case-insensitive substring match)
      const needle = taskName!.toLowerCase();
      const allTasks = listTasks();
      const matches = allTasks.filter((t) =>
        t.title.toLowerCase().includes(needle),
      );

      if (matches.length === 0) {
        return {
          content: `Error: No task definition found matching "${taskName}". Use task_list to see available tasks.`,
          isError: true,
        };
      }

      if (matches.length > 1) {
        const lines = [
          `Multiple task definitions match "${taskName}". Please specify by ID:`,
          "",
        ];
        for (const m of matches) {
          lines.push(`- ${m.title}  (ID: ${m.id})`);
        }
        return { content: lines.join("\n"), isError: true };
      }

      resolvedTask = matches[0];
    }

    const finalTitle = titleOverride ?? resolvedTask.title;

    // Duplicate-prevention guard
    if (ifExists !== "create_duplicate") {
      const duplicateResult = handleDuplicate(
        finalTitle,
        ifExists,
        input,
        source,
      );
      if (duplicateResult) return duplicateResult;
    } else {
      log.info(
        { title: finalTitle },
        "task_list_add: creating duplicate (if_exists=create_duplicate)",
      );
    }

    log.debug({ title: finalTitle }, "task_list_add: creating new item");

    const selectorType = taskId ? "task_id" : "task_name";

    // Snapshot precedence: explicit required_tools > template tools > null
    let resolvedRequiredTools: string | undefined;
    if (hasExplicitTools) {
      resolvedRequiredTools = JSON.stringify(sanitizedTools);
    } else if (resolvedTask.requiredTools) {
      // Snapshot template tools at add time
      const templateTools = sanitizeToolList(
        JSON.parse(resolvedTask.requiredTools),
      );
      resolvedRequiredTools = JSON.stringify(templateTools);
    }

    const workItem = createWorkItemWithPermissions({
      taskId: resolvedTask.id,
      title: finalTitle,
      notes,
      priorityTier: priorityTier ?? 1,
      sortIndex,
      requiredTools: resolvedRequiredTools,
      ...source,
    });
    // Await the triage + auto-run DECISION (bounded; not the run itself) so
    // the tool result reports what actually happened to the item.
    const outcome = await awaitAutoRunOutcome(
      triageAndMaybeAutoRunWorkItem(workItem.id, {
        callerSetPriority: priorityTier != null,
      }),
    );

    log.info(
      {
        selectorType,
        taskId: resolvedTask.id,
        workItemId: workItem.id,
        title: workItem.title,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        autoRunStarted: outcome?.autoRunStarted ?? "unknown",
      },
      "work item created from task definition",
    );

    const priority =
      PRIORITY_LABELS[workItem.priorityTier] ?? `tier ${workItem.priorityTier}`;
    const { statusLine, note } = buildStatusLines(workItem, outcome);
    const lines = [
      `Enqueued work item:`,
      `  Title: ${workItem.title}`,
      `  ID: ${workItem.id}`,
      `  Task definition: ${resolvedTask.title} (${resolvedTask.id})`,
      `  Priority: ${priority}`,
      statusLine,
    ];
    if (workItem.notes) {
      lines.push(`  Notes: ${workItem.notes}`);
    }
    if (workItem.sortIndex !== undefined) {
      lines.push(`  Sort index: ${workItem.sortIndex}`);
    }
    lines.push("", note);

    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "enqueue failed");
    return { content: `Error: ${msg}`, isError: true };
  }
}
