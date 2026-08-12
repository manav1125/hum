/**
 * daily-briefing setup script
 *
 * Creates or updates the daily briefing schedule using the
 * `assistant schedules` CLI. Run this once to configure your briefing time
 * and timezone. After setup, manage it conversationally.
 *
 * Usage (the assistant calls this via bash):
 *   bun scripts/setup.ts
 *   bun scripts/setup.ts --time 08:00 --timezone America/New_York
 *   bun scripts/setup.ts --time 09:00 --slack-channel C0123456789
 *   bun scripts/setup.ts --disable
 *   bun scripts/setup.ts --status
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const BRIEFING_NAME = "Daily Briefing";
const BRIEFING_DESCRIPTION =
  "Composes and delivers the proactive daily briefing (daily-briefing skill).";

const BRIEFING_PROMPT = `You are composing the user's proactive daily briefing. Use the memory context injected above to surface what matters today.

Structure the briefing:

**Daily Briefing — [today's date, e.g. Monday June 2]**

**Action Items** — Unresolved tasks, pending decisions, or commitments due today. Skip if none.
**Progress** — Notable completions or milestones from the past 24 hours. Skip if none.
**On Your Radar** — Anything flagged as important, upcoming, or worth watching. Skip if none.
**Suggested Next Steps** — 2-3 concrete actions for today, ranked by impact.

Rules: max 3-5 bullets per section; omit empty sections; end with one encouraging sentence.

After composing, deliver via bash:
  assistant notifications send --title "Daily Briefing -- [date]" --message "[briefing text]" --source-event-name "briefing.daily"`;

/**
 * Extra delivery step appended when the digest should also be POSTED into a
 * Slack channel. `assistant notifications send` routes to DMs/personal
 * channels only, so channel posting goes straight at chat.postMessage with
 * the slack_channel bot token — Block Kit body, per-item thread replies.
 */
function slackChannelPromptSection(channelId: string): string {
  return `

Additionally, post the same briefing INTO the Slack channel ${channelId} (the bot must be a member):
1. Post the digest with Block Kit via bash:
   assistant oauth request --provider slack_channel -X POST -H "Content-Type: application/json" -d '{"channel":"${channelId}","text":"[fallback text]","blocks":[...header + one section block per briefing section...]}' /chat.postMessage --json
2. Capture "ts" from the response, then post one threaded reply per substantial item with "thread_ts" set to that value, so detail lives in the thread rather than flooding the channel.`;
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    time: { type: "string", default: "09:00" },
    timezone: { type: "string" },
    "slack-channel": { type: "string" },
    disable: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
daily-briefing setup

Usage:
  bun scripts/setup.ts [options]

Options:
  --time <HH:MM>          Delivery time in 24-hour format (default: 09:00)
  --timezone <tz>         IANA timezone (default: auto-detected from workspace)
  --slack-channel <id>    Also post the digest into this Slack channel
                          (channel ID, e.g. C0123456789; bot must be a member)
  --disable               Pause the briefing without deleting it
  --status                Show current briefing configuration
  -h, --help              Show this help

Examples:
  bun scripts/setup.ts --time 08:00 --timezone America/New_York
  bun scripts/setup.ts --time 09:00 --slack-channel C0123456789
  bun scripts/setup.ts --disable
  bun scripts/setup.ts --status
`);
  process.exit(0);
}

function validateTime(time: string): boolean {
  if (!/^\d{1,2}:\d{2}$/.test(time)) return false;
  const [h, m] = time.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function validateTimezone(tz: string): boolean {
  // Defense-in-depth: only accept real IANA timezone names. The exec layer
  // below already prevents shell injection, but rejecting bogus input early
  // gives a clear error instead of a confusing CLI failure.
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    if (supported && supported.length > 0) {
      return supported.includes(tz);
    }
    // Fallback for runtimes without supportedValuesOf: let the Intl
    // constructor validate. It throws RangeError on unknown zones.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Slack channel IDs are C/G-prefixed uppercase alphanumerics. Same
 * defense-in-depth stance as the timezone check: the value is embedded in the
 * schedule prompt, so nothing that is not plainly a channel ID gets in.
 */
function validateSlackChannel(id: string): boolean {
  return /^[CG][A-Z0-9]{6,}$/.test(id);
}

function parseCron(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${m} ${h} * * *`;
}

// Run a command WITHOUT a shell. Arguments are passed as an array to
// execFileSync, so untrusted values (e.g. --timezone) can never be
// interpreted as shell syntax. Never reintroduce a string/shell form here.
function run(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: "utf-8" }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const display = [file, ...args].join(" ");
    throw new Error(`Command failed: ${display}\n${msg}`);
  }
}

interface ScheduleRow {
  id: string;
  name: string;
  enabled: boolean;
  [key: string]: unknown;
}

/** `assistant schedules list --json` returns `{ schedules: [...] }`. */
function listSchedules(): ScheduleRow[] {
  const raw = run("assistant", ["schedules", "list", "--json"]);
  const parsed = JSON.parse(raw) as { schedules?: ScheduleRow[] };
  return parsed.schedules ?? [];
}

function findExistingSchedule(): { id: string; enabled: boolean } | null {
  try {
    const match = listSchedules().find((s) => s.name === BRIEFING_NAME);
    return match ? { id: match.id, enabled: match.enabled } : null;
  } catch {
    return null;
  }
}

// -- status -----------------------------------------------------------
if (values.status) {
  const existing = findExistingSchedule();
  if (!existing) {
    console.log(
      "No daily briefing is configured. Run without --status to create one.",
    );
  } else {
    const job = listSchedules().find((s) => s.name === BRIEFING_NAME);
    console.log(JSON.stringify(job, null, 2));
  }
  process.exit(0);
}

// -- disable ----------------------------------------------------------
if (values.disable) {
  const existing = findExistingSchedule();
  if (!existing) {
    console.log("No daily briefing found -- nothing to disable.");
    process.exit(0);
  }
  if (!existing.enabled) {
    console.log("Daily briefing is already disabled.");
    process.exit(0);
  }
  run("assistant", ["schedules", "disable", existing.id]);
  console.log("Daily briefing disabled. Run without --disable to re-enable.");
  process.exit(0);
}

// -- enable / create --------------------------------------------------
if (!validateTime(values.time!)) {
  console.error(
    `Error: invalid time "${values.time}". Use HH:MM 24-hour format, e.g. "09:00".`,
  );
  process.exit(1);
}

if (values.timezone && !validateTimezone(values.timezone)) {
  console.error(
    `Error: invalid timezone "${values.timezone}". Use an IANA timezone name, e.g. "America/New_York".`,
  );
  process.exit(1);
}

const slackChannel = values["slack-channel"];
if (slackChannel && !validateSlackChannel(slackChannel)) {
  console.error(
    `Error: invalid Slack channel id "${slackChannel}". Use the channel ID (e.g. "C0123456789"), not the #name.`,
  );
  process.exit(1);
}

const cron = parseCron(values.time!);
const tzArgs = values.timezone ? ["--timezone", values.timezone] : [];
const prompt = slackChannel
  ? BRIEFING_PROMPT + slackChannelPromptSection(slackChannel)
  : BRIEFING_PROMPT;
const existing = findExistingSchedule();

if (existing) {
  run("assistant", [
    "schedules",
    "update",
    existing.id,
    "--expression",
    cron,
    "--message",
    prompt,
    "--reuse-conversation",
    ...tzArgs,
  ]);
  if (!existing.enabled) {
    run("assistant", ["schedules", "enable", existing.id]);
  }
  console.log(
    `Daily briefing updated and enabled. Delivery: ${values.time}${values.timezone ? ` (${values.timezone})` : ""}${slackChannel ? `, also posted to Slack channel ${slackChannel}` : ""}.`,
  );
} else {
  run("assistant", [
    "schedules",
    "create",
    BRIEFING_NAME,
    "--expression",
    cron,
    "--description",
    BRIEFING_DESCRIPTION,
    ...tzArgs,
    "--message",
    prompt,
  ]);
  // `schedules create` cannot set conversation reuse; flip it on afterwards
  // so context accumulates across runs (the agent sees prior briefings).
  const created = findExistingSchedule();
  if (created) {
    run("assistant", [
      "schedules",
      "update",
      created.id,
      "--reuse-conversation",
    ]);
  }
  console.log(
    `Daily briefing created. Delivery: ${values.time}${values.timezone ? ` (${values.timezone})` : ""}${slackChannel ? `, also posted to Slack channel ${slackChannel}` : ""}. You will receive your first briefing at the next scheduled time.`,
  );
}
