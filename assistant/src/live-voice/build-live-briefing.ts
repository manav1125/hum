/**
 * `buildLiveBriefing` — a compact, spoken-conversation context pre-seed for a
 * live voice session: who the user is (durable PKB/memory), the missions and
 * projects they're driving, what's on their plate right now (open tasks), and
 * what's coming up (enabled schedules). It is injected once into the session's
 * system instruction at start so the assistant opens the conversation already
 * knowing the user's world — the differentiator over a generic voice assistant.
 *
 * Why this matters most for the Gemini (speech-native) engine: the cascade runs
 * Cue's full agent loop and already assembles context per turn, but Gemini Live
 * reasons entirely from its one setup-time system instruction — without this it
 * knows nothing about the user's actual work. The briefing is engine-agnostic;
 * both engines inject it, so behaviour stays consistent.
 *
 * Contract: never throws. Every source is wrapped independently, so a single
 * store hiccup degrades that section to nothing rather than failing the session
 * start. Returns "" when there is nothing worth saying (fresh workspace), which
 * callers treat as "append nothing".
 */

import { readPkbContext } from "../memory/pkb/context.js";
import { listMissions } from "../missions/mission-store.js";
import { listSchedules } from "../schedule/schedule-store.js";
import { getLogger } from "../util/logger.js";
import { listProjects } from "../work-items/project-store.js";
import { listWorkItems } from "../work-items/work-item-store.js";

const log = getLogger("live-briefing");

/** Statuses that mean "on the user's plate right now". Mirrors get_open_tasks. */
const OPEN_STATUSES = new Set(["queued", "running", "awaiting_review"]);

/** Bounds so a large workspace can't blow the session-start prompt or latency. */
const DEFAULT_MAX_CHARS = 2500;
const MAX_PKB_CHARS = 1200;
const MAX_MISSIONS = 4;
const MAX_PROJECTS = 6;
const MAX_TASKS = 8;
const MAX_SCHEDULES = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

function safe<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    log.warn({ err, section: label }, "live briefing section failed");
    return fallback;
  }
}

/** Coarse, timezone-free "when" for an upcoming run — enough for a spoken cue. */
function relativeWhen(nextRunAt: number, now: number): string {
  const deltaDays = Math.floor((nextRunAt - now) / DAY_MS);
  if (nextRunAt <= now) return "now";
  if (deltaDays <= 0) return "later today";
  if (deltaDays === 1) return "tomorrow";
  if (deltaDays < 7) return `in ${deltaDays} days`;
  return "later";
}

export interface BuildLiveBriefingOptions {
  /** Epoch ms; injectable for tests. Defaults to Date.now(). */
  now?: number;
  /** Hard cap on the returned string. Defaults to ~2500 chars. */
  maxChars?: number;
}

/**
 * Assemble the briefing. Synchronous — all reads are local SQLite/file reads
 * the daemon already serves (the Gemini tool `get_open_tasks` reads the same
 * stores), so this adds no network hop to session start.
 */
export function buildLiveBriefing(opts?: BuildLiveBriefingOptions): string {
  const now = opts?.now ?? Date.now();
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const sections: string[] = [];

  // 1. Who the user is + durable memory (the always-loaded PKB context).
  const pkb = safe("pkb", () => readPkbContext(), null);
  if (pkb && pkb.trim()) {
    const trimmed =
      pkb.length > MAX_PKB_CHARS ? `${pkb.slice(0, MAX_PKB_CHARS)}…` : pkb;
    sections.push(`About your user:\n${trimmed.trim()}`);
  }

  // 2. Active missions — the big goals, with the outcome each drives toward.
  const missions = safe(
    "missions",
    () => listMissions({ status: "active" }).slice(0, MAX_MISSIONS),
    [],
  );
  if (missions.length > 0) {
    const lines = missions.map((m) =>
      m.outcome?.trim() ? `- ${m.title} → ${m.outcome.trim()}` : `- ${m.title}`,
    );
    sections.push(`Active missions:\n${lines.join("\n")}`);
  }

  // 3. Active projects — the initiatives currently in motion.
  const projects = safe(
    "projects",
    () => listProjects({ status: "active" }).slice(0, MAX_PROJECTS),
    [],
  );
  if (projects.length > 0) {
    sections.push(
      `Active projects: ${projects.map((p) => p.title).join(", ")}`,
    );
  }

  // 4. What's on their plate right now — open work items (title + status).
  const openTasks = safe(
    "tasks",
    () =>
      listWorkItems()
        .filter((w) => OPEN_STATUSES.has(w.status))
        .slice(0, MAX_TASKS)
        .map((w) => ({ title: w.title, status: w.status })),
    [] as Array<{ title: string; status: string }>,
  );
  if (openTasks.length > 0) {
    const lines = openTasks.map((t) => `- ${t.title} (${t.status})`);
    sections.push(`On their plate right now:\n${lines.join("\n")}`);
  }

  // 5. Coming up — enabled schedules, soonest first.
  const upcoming = safe(
    "schedules",
    () =>
      listSchedules({ enabledOnly: true })
        .filter((s) => typeof s.nextRunAt === "number")
        .sort((a, b) => a.nextRunAt - b.nextRunAt)
        .slice(0, MAX_SCHEDULES)
        .map((s) => ({ name: s.name, when: relativeWhen(s.nextRunAt, now) })),
    [] as Array<{ name: string; when: string }>,
  );
  if (upcoming.length > 0) {
    const lines = upcoming.map((s) => `- ${s.name} (${s.when})`);
    sections.push(`Coming up:\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "";

  const body = sections.join("\n\n");
  const capped = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;

  return [
    "CONTEXT — this is live background about the person you're talking to and what they're working on right now. Use it to be specific and personal (reference their real work, missions, and tasks when relevant). Do NOT read it aloud verbatim or announce that you have a briefing; just talk like someone who already knows them.",
    "",
    capped,
  ].join("\n");
}
