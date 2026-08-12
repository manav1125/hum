---
name: daily-briefing
description: Proactive daily briefing that fires on a recurring schedule, pulls recent memory and workspace context, composes a structured summary (action items, progress, radar, next steps), and delivers it to your channels — as a notification/DM, or posted into a Slack channel as a threaded Block Kit digest. Enable with a time like "set up my daily briefing at 9am". Disable, reschedule, or check status at any time.
compatibility: Designed for Cue personal assistants
metadata:
  emoji: "📋"
  vellum:
    category: productivity
    display-name: "Daily Briefing"
    user-invocable: true
    activation-hints:
      - "User asks to set up, schedule, pause, resume, or re-time a recurring daily briefing or morning digest"
      - "User asks for a daily digest posted into a Slack channel"
      - "User asks when their next briefing is or what time it fires"
    avoid-when:
      - "User wants one briefing right now rather than a recurring schedule — use start-the-day instead"
---

Send yourself a structured morning briefing every day — without asking for it. The briefing pulls your recent memory, decisions, and workspace context, composes a concise summary, and delivers it to your connected channels (Slack, Telegram, macOS, etc.).

## Setup

Enable the briefing by telling your assistant:

> "Set up my daily briefing at 9am"

The assistant will create a recurring schedule. On first run you will receive a briefing in all connected channels.

You can also say:

- "Set my daily briefing to 7:30am"
- "What time is my daily briefing?"
- "Pause my daily briefing"
- "Turn off my morning briefing"

## What the briefing covers

Each briefing is structured into up to four sections, each capped at 3–5 bullets:

**Action Items** — Unresolved tasks, pending decisions, or commitments due today.

**Progress** — Notable completions or milestones from the past 24 hours.

**On Your Radar** — Anything flagged as important, upcoming, or worth watching.

**Suggested Next Steps** — 2–3 concrete actions ranked by impact.

Sections with nothing to report are omitted entirely.

## How to enable

Run this skill and follow the prompts, or tell your assistant directly:

```bash
bun scripts/setup.ts
```

The setup script asks for your preferred delivery time and timezone, then creates the schedule.

## Managing the schedule

Once enabled, all management is conversational — just tell your assistant:

| What you want | Say                            |
| ------------- | ------------------------------ |
| Change time   | "Move my briefing to 8am"      |
| Check status  | "When is my next briefing?"    |
| Pause         | "Pause my daily briefing"      |
| Resume        | "Resume my daily briefing"     |
| Disable       | "Turn off my morning briefing" |

## How it works

Setup runs `scripts/setup.ts` via bash, which calls `assistant schedules create` to register a recurring `execute`-mode schedule. When the schedule fires each day:

1. The scheduler boots a background conversation with the briefing prompt as the initial message.
2. The agent runtime injects your recent memory, decisions, and workspace context automatically.
3. The agent composes the briefing and runs `assistant notifications send` to deliver it.
4. The notification routes to all your connected channels — the same pipeline as any other Cue notification.

The briefing conversation is reused across runs so context accumulates over time (the agent sees prior briefings when composing today's).

## Posting the digest into a Slack channel

`assistant notifications send` delivers through the notification router — DMs and
personal channels. It deliberately does **not** post into shared Slack channels.
When the user wants the digest posted into a channel (e.g. a team's `#daily`
channel), the scheduled run must call the Slack Web API directly with
`chat.postMessage` via the `slack_channel` credential:

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"channel":"C0123456789","text":"Daily Briefing — Monday June 2","blocks":[{"type":"header","text":{"type":"plain_text","text":"Daily Briefing — Monday June 2"}},{"type":"section","text":{"type":"mrkdwn","text":"*Action Items*\n• …\n\n*On Your Radar*\n• …"}}]}' \
  /chat.postMessage --json
```

Guidance for the channel variant:

- **Use Block Kit** (`blocks`) for the digest body — a `header` block for the
  date, `section` blocks per briefing section. Always include a plain `text`
  fallback for notifications.
- **Thread the detail.** Capture `ts` from the `chat.postMessage` response,
  then post one reply per substantial item with `thread_ts` set to that value,
  so the channel gets one compact digest and the detail lives in its thread
  (see the Threading section of the `slack` skill — replies must pass
  `thread_ts` to land in-thread rather than as new top-level posts):

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"channel":"C0123456789","thread_ts":"1716000000.000001","text":"Detail on item 1 …"}' \
  /chat.postMessage --json
```

- **Set it up** by including the target channel ID and these delivery
  instructions in the schedule's message when creating it (pass
  `--slack-channel C0123456789` to `scripts/setup.ts`, or ask the assistant:
  "post my daily briefing into #daily every morning at 9"). The bot must be a
  member of the channel.
- The `slack_channel` credential is the channel bot token (see the `slack`
  skill's Connection section). If it is missing, load the **slack-app-setup**
  skill rather than improvising credential setup.

## Privacy

The briefing only reads context already stored in your memory and workspace. It does not connect to external calendars or task managers unless you have those integrations configured separately.
