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
 * Next-run preview mirrors the DAEMON's cron interpretation (the recurrence
 * engine runs croner with `timezone: schedule.timezone ?? undefined`, i.e. a
 * stored IANA zone, else the daemon host's local zone). The editor shows the
 * server's `nextRunAt` whenever the draft equals the saved expression; for a
 * changed draft, `resolveCronZone` + `nextRunFromChipsInZone` reproduce the
 * daemon's zone so the preview instant is the one that will actually fire
 * (mobile UAT P1-17: cron wall-clock ran in server-UTC while the preview
 * pretended browser-local).
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

// ---------------------------------------------------------------------------
// Daemon-zone-aware next-run computation (mobile UAT P1-17)
// ---------------------------------------------------------------------------

/**
 * The timezone the daemon evaluates a schedule's cron in.
 *  - "browser": same wall clock as this device — the plain `nextRunFromChips`
 *    math is already correct.
 *  - "iana": the schedule stores an explicit IANA zone.
 *  - "offset": no stored zone — the daemon uses ITS host zone, whose effective
 *    UTC offset we infer from data the daemon already sent (saved cron fields
 *    + the `nextRunAt` instant it computed from them).
 */
export type CronZone =
  | { kind: "browser" }
  | { kind: "iana"; timeZone: string }
  | { kind: "offset"; offsetMinutes: number };

/** Minutes east of UTC for `timeZone` at instant `at`; null if the zone id
 *  is unknown to this browser. */
function tzOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const parts: Record<string, number> = {};
    for (const p of new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at)) {
      if (p.type !== "literal") parts[p.type] = Number(p.value);
    }
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour === 24 ? 0 : parts.hour, // hourCycle quirk: midnight as "24"
      parts.minute,
      parts.second,
    );
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return null;
  }
}

/**
 * Resolve the zone the daemon will interpret this schedule's cron in.
 *
 * With a stored IANA zone that this browser also knows, that zone wins (and
 * collapses to "browser" when it IS the browser's zone). Without one, the
 * daemon evaluates the cron in its host zone — recover its effective offset
 * from the saved cron's wall-clock fields vs. the daemon-computed `nextRunAt`
 * instant. Falls back to "browser" when there's nothing to infer from (custom
 * cron shapes / no nextRunAt), keeping the previous behaviour.
 */
export function resolveCronZone(schedule: {
  timezone: string | null;
  savedCron: string | null;
  nextRunAt: number | null;
}): CronZone {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (schedule.timezone) {
    if (schedule.timezone === browserZone) return { kind: "browser" };
    return tzOffsetMinutes(schedule.timezone, new Date()) !== null
      ? { kind: "iana", timeZone: schedule.timezone }
      : { kind: "browser" };
  }

  const saved = parseCronToChips(schedule.savedCron);
  if (saved.chip === "custom" || schedule.nextRunAt == null) {
    return { kind: "browser" };
  }
  const at = new Date(schedule.nextRunAt);
  const cronWall = saved.hour * 60 + saved.minute;
  const utcWall = at.getUTCHours() * 60 + at.getUTCMinutes();
  let offset = cronWall - utcWall; // minutes east of UTC
  // Normalize into the real-world offset band (−12h, +14h].
  while (offset > 840) offset -= 1440;
  while (offset <= -720) offset += 1440;
  return offset === -at.getTimezoneOffset()
    ? { kind: "browser" }
    : { kind: "offset", offsetMinutes: offset };
}

/** Short label for a non-browser zone ("Asia/Hong_Kong", "UTC", "UTC+5:30");
 *  null when the zone matches the browser (no label needed). */
export function cronZoneLabel(zone: CronZone): string | null {
  if (zone.kind === "browser") return null;
  if (zone.kind === "iana") return zone.timeZone;
  const off = zone.offsetMinutes;
  if (off === 0) return "UTC";
  const abs = Math.abs(off);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${off > 0 ? "+" : "-"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/**
 * Next occurrence of a simple chip cadence with the cron's wall clock
 * interpreted in `zone` — the instant the daemon will actually fire. Returns
 * a real instant (render it in local time as usual); null for "custom".
 */
export function nextRunFromChipsInZone(
  cadence: ChipCadence,
  zone: CronZone,
  now: Date = new Date(),
): Date | null {
  if (cadence.chip === "custom") return null;
  if (zone.kind === "browser") return nextRunFromChips(cadence, now);

  const matchesDow = (dow: number): boolean => {
    if (cadence.chip === "daily") return true;
    if (cadence.chip === "weekday") return dow >= 1 && dow <= 5;
    return dow === cadence.weekday;
  };

  if (zone.kind === "offset") {
    // Fixed offset: the zone's wall clock equals the UTC fields of
    // (instant + offset), so run the day-walk in UTC-field space.
    const shift = zone.offsetMinutes * 60_000;
    const wallNow = new Date(now.getTime() + shift);
    const candidate = new Date(wallNow);
    candidate.setUTCHours(cadence.hour, cadence.minute, 0, 0);
    while (
      candidate.getTime() <= wallNow.getTime() ||
      !matchesDow(candidate.getUTCDay())
    ) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(cadence.hour, cadence.minute, 0, 0);
    }
    return new Date(candidate.getTime() - shift);
  }

  // IANA zone: walk the zone's calendar days, resolving each wall time to an
  // instant via a two-pass (DST-safe) offset lookup.
  const nowOffset = tzOffsetMinutes(zone.timeZone, now);
  if (nowOffset === null) return nextRunFromChips(cadence, now);
  const zoneToday = new Date(now.getTime() + nowOffset * 60_000);
  for (let i = 0; i <= 7; i++) {
    const wall = new Date(
      Date.UTC(
        zoneToday.getUTCFullYear(),
        zoneToday.getUTCMonth(),
        zoneToday.getUTCDate() + i,
        cadence.hour,
        cadence.minute,
      ),
    );
    if (!matchesDow(wall.getUTCDay())) continue;
    const first = tzOffsetMinutes(zone.timeZone, wall);
    if (first === null) return null;
    let instant = new Date(wall.getTime() - first * 60_000);
    const second = tzOffsetMinutes(zone.timeZone, instant);
    if (second !== null && second !== first) {
      instant = new Date(wall.getTime() - second * 60_000);
    }
    if (instant.getTime() > now.getTime()) return instant;
  }
  return null;
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
