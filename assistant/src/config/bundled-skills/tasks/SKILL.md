---
name: tasks
description: The user's task queue — capture to-dos and commitments as work items, triage them by priority, run them in the background, and review the results. Use for ANY "add to my tasks/list", "what's on my plate", "run that task", "mark it done" request. For recurring/scheduled automations use the schedule skill instead.
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "✅"
  vellum:
    display-name: "Tasks"
    category: "productivity"
    activation-hints:
      - "User wants to add, check, update, run, or complete items on their to-do list or task queue"
      - "User states a commitment or action item they want tracked (\"I need to…\", \"remind me to…\" without a specific time)"
      - "For one-off action items, not recurring automations (use schedule for those)"
    avoid-when:
      - "User wants recurring/scheduled automation — use the schedule skill instead"
      - "User wants the work done right now in this thread — just do it, no queueing needed"
---

Manage the user's task queue with first-class tools. Every captured task is a **work item** with a priority tier and a status that flows `queued → running → awaiting_review → done`.

## Tools

- **task_list_add** — capture a task. Give it a short `title` and, when the task will need real instructions to execute later, an `execution_prompt` carrying the full detail (paths, links, names — everything needed to do the work cold). Cue then auto-triages the item (scores urgency, sets priority) and, when the user's autonomy policy allows, runs it in the background and brings the result back for review.
- **task_list_show** — view the queue, optionally by status (`queued`, `running`, `awaiting_review`, `done`, …).
- **task_list_update** — change priority/notes/status. Approving finished work = set an `awaiting_review` item to `done`.
- **task_list_remove** — drop a task that's no longer needed.
- **task_queue_run** — start a queued task in the background immediately ("run it now"). Returns right away; the result lands in the Review lane. This is the ONLY way to execute a queued task in the background — it goes through Cue's work-item runner, which stamps the run history, captures the output for review, and gates completion behind the user's sign-off.

## How to behave

1. **Capture fast.** When the user states a task, call `task_list_add` immediately — one tool call, no preamble. Do NOT do the work in the thread unless they asked for it now.
2. **"Run it in the background" = enqueue + run.** When the user asks for a task to run in the background, call `task_list_add` (if not already queued) then `task_queue_run`. That's the whole job — the runner executes it, streams status, and delivers the result to the Review lane. NEVER spawn your own subagent (`subagent_spawn` or similar) for queued work, and NEVER set the item's status to `running`/`awaiting_review`/`done` yourself to simulate a run: a hand-rolled run records no output, no run history, and skips the user's review gate.
3. **Don't set priority unless the user did.** Omit `priority_tier` so auto-triage can score urgency from content. Pass it only when the user says "high priority", "whenever", etc.
4. **Rich execution prompts.** The title is for humans; the `execution_prompt` is for the executor. "Email the deck to Sarah" as a title needs an execution_prompt with which deck, which Sarah, and what to say.
5. **Status discipline.** `done` is only reachable from `awaiting_review` — completed runs land there for the user's sign-off. If the user says "mark X done" and it's still `queued`, confirm whether they did it themselves, then set `awaiting_review` → `done`.
6. **Never** manage the queue via shell/CLI commands — always use these tools.

## Anti-patterns

- Don't run `assistant task …` CLI commands via bash — the tools above are the interface.
- Don't spawn a subagent to execute a queued task — `task_queue_run` is the execution path. A subagent run is invisible to the queue: no run record, no output for the Review lane, no cycle-time, and the user never gets to review the result.
- Don't flip work-item statuses to mirror work you did elsewhere — statuses are owned by the runner and the user's review actions.
- Don't create a schedule for a one-off task (schedule is for recurring/timed automations).
- Don't duplicate: `task_list_add` reuses an existing active item with the same title by default — trust it.
