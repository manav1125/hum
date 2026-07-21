/**
 * Wall-clock resolution in a configured IANA timezone — shared by the
 * Morning Brief scheduler (fire-window checks) and the push quiet-hours
 * gate (`push-prefs.ts`). Pure and dependency-free so either consumer can
 * import it without coupling to the other.
 */

export interface LocalClock {
  /** Calendar date key, e.g. "2026-07-18", in the effective timezone. */
  dateKey: string;
  minutesOfDay: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Resolve the wall clock in the given IANA timezone (null/invalid = the
 * daemon's local timezone — cloud daemons typically run UTC, so configs
 * should set an explicit timezone for user-local behavior).
 */
export function localClock(now: Date, timezone: string | null): LocalClock {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(now);
      const get = (type: string): string =>
        parts.find((p) => p.type === type)?.value ?? "";
      const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
      const minutesOfDay = Number(get("hour")) * 60 + Number(get("minute"));
      if (
        /^\d{4}-\d{2}-\d{2}$/.test(dateKey) &&
        Number.isFinite(minutesOfDay)
      ) {
        return { dateKey, minutesOfDay };
      }
    } catch {
      // Invalid timezone string — fall through to daemon-local.
    }
  }
  return {
    dateKey: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    minutesOfDay: now.getHours() * 60 + now.getMinutes(),
  };
}
