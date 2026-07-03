/**
 * Dark dossier hero for a contact — design-matched to surfaces/Contacts.dc.html
 * (ink panel, radial-blue glow, avatar, name + role line, a role chip, and a
 * row of real stat tiles).
 *
 * Only real data is surfaced: the mock's "meetings / open commitments / since
 * last touch" tiles are demo content; the gateway exposes interaction count and
 * last-interaction time, so we show those plus the verified-channel count. No
 * fabricated stats.
 */

import { formatRelativeDate } from "@/utils/format-date";
import type { ContactPayload } from "@/domains/contacts/types";

const MONO = "'DM Mono', ui-monospace, monospace";

function describeRole(
  role: string | null | undefined,
  contactType: string | null | undefined,
): {
  label: string;
  chipBg: string;
  chipColor: string;
  avatarBg: string;
  avatarColor: string;
} {
  if (role === "guardian") {
    return {
      label: "GUARDIAN",
      chipBg: "rgba(39,126,65,.22)",
      chipColor: "#7FD39A",
      avatarBg: "#1A2230",
      avatarColor: "#fff",
    };
  }
  if (role === "assistant" || contactType === "assistant") {
    return {
      label: "ASSISTANT",
      chipBg: "rgba(127,119,221,.22)",
      chipColor: "#B6AFF0",
      avatarBg: "#FBE7DD",
      avatarColor: "#B5572B",
    };
  }
  return {
    label: "CONTACT",
    chipBg: "rgba(61,110,232,.22)",
    chipColor: "#9DB4E6",
    avatarBg: "#DBE4FB",
    avatarColor: "#2B53C4",
  };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

interface StatTileProps {
  value: string;
  label: string;
}

function StatTile({ value, label }: StatTileProps) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
      <div style={{ fontFamily: MONO, fontSize: 10, color: "#7E8BA3" }}>
        {label}
      </div>
    </div>
  );
}

interface ContactDossierHeaderProps {
  contact: ContactPayload;
  /** Display name (may be edited/optimistic) — falls back to the payload. */
  displayName: string;
  /** Subtitle under the name (e.g. notes excerpt or role). */
  subtitle?: string;
  /** Optional primary CTA shown at the right of the stat row. */
  action?: React.ReactNode;
}

export function ContactDossierHeader({
  contact,
  displayName,
  subtitle,
  action,
}: ContactDossierHeaderProps) {
  const role = describeRole(contact.role, contact.contactType);
  const name = displayName.trim() || "Unnamed contact";

  const activeChannels = contact.channels.filter(
    (c) => c.status !== "revoked",
  ).length;
  const lastTouch =
    contact.lastInteraction != null
      ? formatRelativeDate(new Date(contact.lastInteraction).toISOString())
      : "—";

  return (
    <div
      style={{
        position: "relative",
        background: "#1A2230",
        borderRadius: 16,
        overflow: "hidden",
        padding: "24px 26px",
        color: "#fff",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(360px 180px at 88% 20%,rgba(61,110,232,.25),transparent 70%)",
        }}
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 18,
        }}
      >
        <span
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: role.avatarBg,
            color: role.avatarColor,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {initials(name)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "-.5px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </div>
          {subtitle ? (
            <div
              style={{
                fontSize: 13,
                color: "#AEB7C7",
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            background: role.chipBg,
            color: role.chipColor,
            padding: "5px 11px",
            borderRadius: 7,
            flexShrink: 0,
          }}
        >
          {role.label}
        </span>
      </div>

      <div
        style={{
          position: "relative",
          display: "flex",
          gap: 26,
          marginTop: 20,
          alignItems: "center",
        }}
      >
        <StatTile
          value={String(contact.interactionCount)}
          label={
            contact.interactionCount === 1 ? "interaction" : "interactions"
          }
        />
        <StatTile value={lastTouch} label="last touch" />
        <StatTile
          value={String(activeChannels)}
          label={activeChannels === 1 ? "channel" : "channels"}
        />
        {action ? <div style={{ marginLeft: "auto" }}>{action}</div> : null}
      </div>
    </div>
  );
}
