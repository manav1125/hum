/**
 * People — relationship memory (design v0.3 §04).
 *
 * Wired to your real contacts (`contactsGet`): a master list + per-person
 * dossier. The dossier surfaces real fields — role/type, notes, interaction
 * count + last-seen, and reachable channels with status. The richer rollup
 * (open commitments, a full interaction timeline) comes from the memory +
 * meeting-capture pipeline (Phase 3) and is noted as such. v0.3 dossier styling.
 */

import {
  CircleDot,
  Hash,
  Loader2,
  Mail,
  Phone,
  Send,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";

import type { ContactPayload } from "@/domains/contacts/types";
import { contactsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
  violetS: "#534AB7",
  surface: "#FFFFFF",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
  amber: "#F1B21E",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Epoch (s or ms) → short relative-ish date. Null/0 → "—". */
function fmtWhen(value: number | null | undefined): string {
  if (!value) return "—";
  const ms = value > 1e12 ? value : value * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const CHANNEL_ICON: Record<string, LucideIcon> = {
  email: Mail,
  gmail: Mail,
  slack: Hash,
  sms: Phone,
  phone: Phone,
  twilio: Phone,
  telegram: Send,
};

function channelIcon(type: string): ReactNode {
  const Icon = CHANNEL_ICON[type.toLowerCase()] ?? CircleDot;
  return <Icon size={14} color={C.blueS} />;
}

export function PeoplePage() {
  const assistantId = useActiveAssistantId();
  const contactsQuery = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.contacts,
  });

  const contacts = useMemo(() => {
    // Relationship memory is about other people — exclude the assistant's own
    // identity and the guardian (you).
    const list = (contactsQuery.data ?? []).filter(
      (c) => c.role !== "assistant" && c.role !== "guardian",
    );
    // Most-recently/most-active first.
    return [...list].sort(
      (a, b) =>
        (b.lastInteraction ?? 0) - (a.lastInteraction ?? 0) ||
        b.interactionCount - a.interactionCount,
    );
  }, [contactsQuery.data]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    contacts.find((c) => c.id === selectedId) ?? contacts[0] ?? null;

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: mono,
                fontSize: 11.5,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: C.blueS,
                marginBottom: 10,
              }}
            >
              Contacts
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: C.t1,
                marginBottom: 16,
              }}
            >
              The people Cue knows — relationship memory
            </div>
          </div>
          <Link
            to="/assistant/trust"
            title="Trust & consent — who can reach Cue, and what it may do"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "#FFFFFF",
              border: "1px solid #D7DDE7",
              borderRadius: 9,
              padding: "7px 13px",
              fontSize: 12.5,
              fontWeight: 500,
              color: C.t1,
              textDecoration: "none",
              flexShrink: 0,
            }}
          >
            Trust
          </Link>
        </div>

        {contactsQuery.isLoading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "24px 0",
              fontSize: 13,
              color: C.t2,
            }}
          >
            <Loader2 className="size-4 animate-spin" /> Loading your people…
          </div>
        ) : contacts.length === 0 ? (
          <EmptyState error={contactsQuery.isError} />
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,260px) minmax(0,1fr)",
              gap: 22,
              alignItems: "start",
            }}
          >
            <PeopleList
              contacts={contacts}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
            {selected ? <Dossier contact={selected} /> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function PeopleList({
  contacts,
  selectedId,
  onSelect,
}: {
  contacts: ContactPayload[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        overflow: "hidden",
        background: C.surface,
      }}
    >
      {contacts.map((c, idx) => {
        const active = c.id === selectedId;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 11,
              padding: "11px 13px",
              border: "none",
              borderBottom:
                idx === contacts.length - 1 ? "none" : `1px solid ${C.line}`,
              background: active ? C.sunken : "transparent",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: C.blueW,
                color: C.blueS,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 500,
                fontSize: 12.5,
                flexShrink: 0,
              }}
            >
              {initials(c.displayName)}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: C.t1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.displayName}
              </span>
              <span style={{ fontSize: 12, color: C.t2 }}>
                {c.interactionCount}{" "}
                {c.interactionCount === 1 ? "interaction" : "interactions"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Dossier({ contact }: { contact: ContactPayload }) {
  const roleLabel = [contact.role, contact.contactType]
    .filter((v): v is string => Boolean(v) && v !== "contact")
    .join(" · ");

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            background: C.blueW,
            color: C.blueS,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 500,
            fontSize: 15,
            flexShrink: 0,
          }}
        >
          {initials(contact.displayName)}
        </span>
        <div>
          <div style={{ fontSize: 17, fontWeight: 500, color: C.t1 }}>
            {contact.displayName}
          </div>
          {roleLabel ? (
            <div style={{ fontSize: 12.5, color: C.t2 }}>{roleLabel}</div>
          ) : null}
        </div>
      </div>

      <Card title="How you know them">
        {contact.notes ? `${contact.notes} · ` : ""}
        {contact.interactionCount}{" "}
        {contact.interactionCount === 1 ? "interaction" : "interactions"} · last
        seen {fmtWhen(contact.lastInteraction)}
      </Card>

      <div style={{ height: 10 }} />

      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          padding: "13px 15px",
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 500, color: C.t1 }}>
          Reachable on
        </div>
        {contact.channels.length === 0 ? (
          <div style={{ fontSize: 12, color: C.t2, marginTop: 5 }}>
            No channels connected yet.
          </div>
        ) : (
          <div
            style={{
              marginTop: 8,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {contact.channels.map((ch) => (
              <div
                key={ch.id}
                style={{ display: "flex", alignItems: "center", gap: 9 }}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    background: C.blueW,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {channelIcon(ch.type)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: 12.5,
                      color: C.t1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ch.address}
                  </span>
                  <span style={{ fontSize: 11, color: C.t3 }}>
                    {ch.type}
                    {ch.isPrimary ? " · primary" : ""}
                  </span>
                </span>
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 10.5,
                    padding: "1px 6px",
                    borderRadius: 5,
                    background: ch.status === "active" ? "#E2F0E7" : C.sunken,
                    color: ch.status === "active" ? C.green : C.t3,
                  }}
                >
                  {ch.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderLeft: `3px solid ${C.violet}`,
          borderRadius: "0 12px 12px 0",
          padding: "11px 14px",
          fontSize: 13,
          color: C.t2,
          marginTop: 14,
        }}
      >
        Open commitments and a full interaction timeline assemble from memory +
        meeting capture — so before any touchpoint, Cue surfaces this
        automatically and you walk in already caught up.
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        padding: "13px 15px",
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 500, color: C.t1 }}>{title}</div>
      <div style={{ fontSize: 12, color: C.t2, marginTop: 3 }}>{children}</div>
    </div>
  );
}

function EmptyState({ error }: { error: boolean }) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.surface,
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 500, color: C.t1 }}>
        {error ? "Couldn’t load your people" : "No people yet"}
      </div>
      <div style={{ fontSize: 13, color: C.t2, marginTop: 6 }}>
        {error
          ? "Cue couldn’t reach contacts just now — try again in a moment."
          : "As Cue meets people across your channels, they’ll show up here with context."}
      </div>
    </div>
  );
}
