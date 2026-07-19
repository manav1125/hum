/**
 * Chips ↔ cron mapping for the mobile-v3 schedule editor (spec frame 40:
 * plain-language chips + a time input, raw cron demoted to a mono footnote).
 *
 * The simple shapes the chips can express are exactly:
 *   Every weekday →  "m h * * 1-5"
 *   Daily         →  "m h * * *"
 *   Weekly        →  "m h * * d"        (one weekday)
 * Anything else (step values, day-of-month, multi-day lists, 6-field crons…)
 * classifies as "custom" and is edited as raw cron. Mapping is round-trip
 * safe for the simple shapes: build(parse(expr)) === expr for chip-built
 * expressions, and parse(build(chip, t)) returns the same chip + time.
 *
 * Next-run preview is computed in the BROWSER timezone for the simple shapes
 * (the daemon's recurrence engine stays authoritative — the editor shows the
 * server's `nextRunAt` whenever the draft equals the saved expression).
 */
import { formatTimeOfDay } from "@/domains/settings/utils/cron-builder";

export type CadenceChipId = "weekday" | "daily" | "weekly" | "custom";

export interface ChipCadence {
  chip: CadenceChipId;
  /** Minute within the hour (0–59). Meaningless when chip === "custom". */
  minute: number;
  /** Hour of day (0–23). Meaningless when chip === "custom". */
  hour: number;
  /** Weekday 0=Sun…6=Sat — used when chip === "weekly". */
  weekday: number;
}

const WEEKDAY_SET = "1,2,3,4,5";

function parseIntField(field: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n <= max ? n : null;
}

/** Normalize a day-of-week token: cron allows 7 for Sunday. */
function normalizeDow(n: number): number {
  return n === 7 ? 0 : n;
}

/**
 * Classify a cron expression into a chip cadence. Returns chip "custom" (with
 * minute/hour zeroed) for anything the chips can't express.
 */
export function parseCronToChips(expression: string | null): ChipCadence {
  const custom: ChipCadence = { chip: "custom", minute: 0, hour: 0, weekday: 1 };
  if (!expression) return custom;

  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return custom;
  const [minuteField, hourField, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minute = parseIntField(minuteField, 59);
  const hour = parseIntField(hourField, 23);
  if (minute === null || hour === null) return custom;
  if (dom !== "*" || month !== "*") return custom;

  if (dow === "*") return { chip: "daily", minute, hour, weekday: 1 };
  if (dow === "1-5") return { chip: "weekday", minute, hour, weekday: 1 };

  // A comma list that covers exactly Mon–Fri is still "every weekday".
  if (dow.includes(",")) {
    const parts = dow.split(",").map((p) => parseIntField(p, 7));
    if (parts.some((p) => p === null)) return custom;
    const days = Array.from(
      new Set((parts as number[]).map(normalizeDow)),
    ).sort((a, b) => a - b);
    if (days.join(",") === WEEKDAY_SET) {
      return { chip: "weekday", minute, hour, weekday: 1 };
    }
    return custom;
  }

  const single = parseIntField(dow, 7);
  if (single !== null) {
    return { chip: "weekly", minute, hour, weekday: normalizeDow(single) };
  }
  return custom;
}

/** Build the 5-field cron for a (non-custom) chip cadence. */
export function buildCronFromChips(cadence: ChipCadence): string {
  const { minute, hour } = cadence;
  switch (cadence.chip) {
    case "weekday":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${cadence.weekday}`;
    case "daily":
    case "custom":
      return `${minute} ${hour} * * *`;
  }
}

/**
 * Next occurrence of a simple chip cadence, in the browser timezone.
 * Returns null for "custom" (the daemon owns arbitrary-cron recurrence).
 */
export function nextRunFromChips(
  cadence: ChipCadence,
  now: Date = new Date(),
): Date | null {
  if (cadence.chip === "custom") return null;
  const matchesDay = (d: Date): boolean => {
    const day = d.getDay();
    if (cadence.chip === "daily") return true;
    if (cadence.chip === "weekday") return day >= 1 && day <= 5;
    return day === cadence.weekday;
  };

  const candidate = new Date(now);
  candidate.setHours(cadence.hour, cadence.minute, 0, 0);
  if (candidate.getTime() <= now.getTime() || !matchesDay(candidate)) {
    // Walk forward day by day (at most 7 iterations).
    do {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(cadence.hour, cadence.minute, 0, 0);
    } while (!matchesDay(candidate));
  }
  return candidate;
}

/**
 * Compact next-run wording for the mono footnote:
 * "today 7:30 AM" / "tomorrow 7:30 AM" / "Mon 7:30 AM" / "Jul 30, 7:30 AM".
 */
export function formatNextRun(ts: number | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  const time = formatTimeOfDay(date.getHours(), date.getMinutes());

  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(date) - startOfDay(new Date())) / 86_400_000,
  );

  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  if (dayDiff > 1 && dayDiff < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** Loose shape check for a raw custom cron (5 space-separated fields). */
export function looksLikeCron(expression: string): boolean {
  return expression.trim().split(/\s+/).length === 5;
}
