/**
 * Cue channel presence (design v0.2 / DESIGN-SPEC §2: "channel presence with
 * live dots = one memory").
 *
 * A compact strip in the sidebar showing the channels Cue is reachable on
 * (email, Slack, Telegram, phone, …) with a live readiness dot — green = ready,
 * amber = configured-but-degraded/stale, grey = not ready. Wired to the real
 * `channels/readiness` snapshot. Renders nothing until at least one channel is
 * configured, so it stays out of the way on a fresh assistant.
 */

import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { channelsReadinessGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  slack: "Slack",
  telegram: "Telegram",
  twilio: "Phone",
  phone: "Phone",
  voice: "Voice",
  a2a: "Agents",
  sms: "SMS",
};

function labelFor(channel: string): string {
  return (
    CHANNEL_LABELS[channel.toLowerCase()] ??
    channel.charAt(0).toUpperCase() + channel.slice(1)
  );
}

interface Snapshot {
  channel: string;
  ready: boolean;
  setupStatus?: string | null;
  stale?: boolean;
}

function dotColor(s: Snapshot): string {
  if (s.ready && !s.stale) return "var(--system-positive-strong, #277E41)";
  if (s.stale || s.setupStatus === "pending") return "#F1B21E"; // amber
  return "var(--content-disabled, #8D99A5)";
}

export function CueChannelPresence() {
  const assistantId = useActiveAssistantId();
  const query = useQuery({
    ...channelsReadinessGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.snapshots ?? [],
    // Presence is ambient; refresh on a relaxed cadence.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const snapshots = (query.data ?? []) as Snapshot[];
  // Only surface channels that are actually configured (have a setupStatus or
  // are ready) — a bare "not configured" channel is noise in the rail.
  const configured = snapshots.filter(
    (s) => s.ready || (s.setupStatus != null && s.setupStatus !== "not_configured"),
  );
  if (configured.length === 0) return null;

  return (
    <div style={{ padding: "8px 12px 4px" }}>
      <div
        style={{
          fontFamily: "'DM Mono', ui-monospace, monospace",
          fontSize: 10.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--content-secondary)",
          marginBottom: 6,
          paddingLeft: 4,
        }}
      >
        Channels
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {configured.map((s) => (
          <div
            key={s.channel}
            title={
              s.ready
                ? `${labelFor(s.channel)} · ready`
                : `${labelFor(s.channel)} · ${s.setupStatus ?? "not ready"}`
            }
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 4px",
              fontSize: 13,
              color: "var(--content-default)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                flexShrink: 0,
                background: dotColor(s),
                boxShadow: s.ready && !s.stale
                  ? "0 0 0 3px color-mix(in srgb, var(--system-positive-strong, #277E41) 18%, transparent)"
                  : undefined,
              }}
            />
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {labelFor(s.channel)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
