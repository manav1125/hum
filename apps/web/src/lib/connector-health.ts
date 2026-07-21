/**
 * Connector health presentation — pure helpers shared by the mobile
 * Connections screen, the You-root row meta, and the desktop Tools & Apps
 * page. The daemon's `/v1/connector-apps` now attaches a per-connected-app
 * `health` object built from REAL call evidence (passive proxy outcomes +
 * a cached liveness probe):
 *
 *  · "attention" — the provider rejected the connection (or it's disabled):
 *    amber treatment, Reconnect as the primary action;
 *  · "ok"        — a real authenticated call succeeded recently: the row may
 *    say "working ✓ Nh ago" (never without a genuine success timestamp);
 *  · "unknown"   — linked but no recent evidence either way: keep the honest
 *    "Linked" + footnote (exactly the pre-probe behavior).
 *
 * Older daemons omit `health` entirely — every helper here treats a missing
 * object as "unknown" so the UI degrades to the honest fallback.
 */

export type ConnectorHealthStatus = "ok" | "attention" | "unknown";

export interface ConnectorHealthLike {
  status: ConnectorHealthStatus;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  checkedAt?: string;
}

/** Status with the missing-health (old daemon) fallback. */
export function healthStatus(
  health: ConnectorHealthLike | undefined,
): ConnectorHealthStatus {
  return health?.status ?? "unknown";
}

/** "just now" / "12m ago" / "3h ago" / "5d ago" — null if unparsable. */
export function relativeAge(
  iso: string | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.max(0, Math.floor((now - t) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * The one-line status for a connected row/tile. "working ✓" only ever
 * renders alongside a real success timestamp.
 */
export function connectionStatusLine(
  health: ConnectorHealthLike | undefined,
  now: number = Date.now(),
): string {
  const status = healthStatus(health);
  if (status === "attention") return "Needs attention";
  if (status === "ok" && health?.lastSuccessAt) {
    const age = relativeAge(health.lastSuccessAt, now);
    return age ? `Linked · working ✓ ${age}` : "Linked · working ✓";
  }
  return "Linked";
}

/** Count of connected apps whose health says attention. */
export function attentionCount(
  apps: ReadonlyArray<{ connected: boolean; health?: ConnectorHealthLike }>,
): number {
  return apps.filter(
    (a) => a.connected && healthStatus(a.health) === "attention",
  ).length;
}

/** True when some connected app is still evidence-less (honest-footnote case). */
export function hasUnknownConnections(
  apps: ReadonlyArray<{ connected: boolean; health?: ConnectorHealthLike }>,
): boolean {
  return apps.some(
    (a) => a.connected && healthStatus(a.health) === "unknown",
  );
}

/** The You-root / Connections-header meta: "8 linked · 2 need attention". */
export function connectionsMeta(linked: number, attention: number): string {
  if (attention > 0) {
    return `${linked} linked · ${attention} need${attention === 1 ? "s" : ""} attention`;
  }
  return `${linked} linked`;
}
