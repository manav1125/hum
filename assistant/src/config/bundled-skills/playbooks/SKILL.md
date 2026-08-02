---
name: playbooks
description: Trigger-action rules that claim an arrival from a watcher before the relevance gate judges it
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "📖"
  vellum:
    display-name: "Playbooks"
    category: "productivity"
---

A playbook is a trigger→action rule over things that **arrive**. When a watcher
(Gmail, Calendar, GitHub, …) picks up a new item, playbooks get first refusal: if
one matches, it claims the item, mints a work item with the action attached, and
the relevance gate never judges it.

Playbooks are the same list the owner sees under **You → Automations**. What is
created here shows up there, and vice versa.

Playbooks are **not** schedules. A schedule fires on a clock and the owner
authors the cadence (`schedule` skill). A playbook fires only when something
arrives and never on its own. If the owner wants "every morning at 8", that is a
schedule.

## Structure

Each playbook has:

- **Trigger**: a case-insensitive substring matched against the arrival's title
  and summary (e.g. "invoice", "review requested"). `*` claims everything on the
  channel.
- **Action**: what to do when triggered (natural language description)
- **Name**: short display name shown on the Automations surface (defaults to the
  trigger)
- **Channel**: which watcher source it applies to — `gmail`, `outlook`,
  `google-calendar`, `outlook-calendar`, `github`, `linear` — or `*` for all
- **Autonomy level**: how much the assistant does on its own
  - `auto` -- execute automatically
  - `draft` -- prepare a response for review (default)
  - `notify` -- surface it only
- **Priority**: higher wins. Exactly one playbook fires per arrival.

## Autonomy is capped

The requested autonomy is stored as asked, then clamped at fire time by the
workspace's global trust dial (observe → notify, assist → draft, autonomous →
auto). `playbook_create` and `playbook_update` report the **effective** level and
say so explicitly when the dial held it below what was asked.

## Lifecycle

1. Create a playbook with `playbook_create` specifying trigger and action.
2. List existing playbooks with `playbook_list`, optionally filtering by channel.
3. Update rules with `playbook_update` (including `enabled` to pause one) or
   remove them with `playbook_delete`.

## What happens without a playbook

Nothing is lost. Every watcher hit still reaches the owner: it goes through the
relevance gate, which files the noise and surfaces the rest into Came In. A
playbook is an override for the cases where the owner has already decided a kind
of thing matters — it skips the judging call and attaches an action.
