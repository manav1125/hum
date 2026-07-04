/**
 * People — relationship memory (design v0.3 §04).
 *
 * Wired to your real contacts: a master list (`contactsGet`) + a per-person
 * dossier that loads the FULL contact record on selection
 * (`contactsByIdGet`) — richer than the list row, with per-channel
 * verification, last-seen, policy, and per-channel interaction counts, plus
 * any assistant-side metadata. The dossier is actionable: a "Message" action
 * mints a conversation about the person (`postChatMessage`) and navigates to
 * it. We render only what the API actually returns — when nothing has been
 * recorded yet, an honest empty state, not a promise. v0.3 dossier styling.
 */

import {
  CircleDot,
  Hash,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  Send,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";

import type { ContactPayload } from "@/domains/contacts/types";
import {
  contactsByIdGetOptions,
  contactsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ContactsByIdGetResponse } from "@/generated/daemon/types.gen";
import { postChatMessage } from "@/domains/chat/api/messages";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

const C = {
  ink: "var(--mv1-t1)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  blueW: "var(--mv1-blue-wash)",
  violet: "var(--mv1-violet)",
  violetS: "var(--mv1-violet-strong)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  amber: "var(--mv1-amber)",
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

  const isMobile = useIsMobile();
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
              background: "var(--mv1-card)",
              border: `1px solid ${C.line2}`,
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
              gridTemplateColumns: isMobile
                ? "1fr"
                : "minmax(0,260px) minmax(0,1fr)",
              gap: isMobile ? 16 : 22,
              alignItems: "start",
            }}
          >
            <PeopleList
              contacts={contacts}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
            {selected ? (
              <Dossier
                key={selected.id}
                contact={selected}
                assistantId={assistantId}
              />
            ) : null}
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

/** The full per-contact record returned by `contactsByIdGet`. */
type FullContact = NonNullable<
  Extract<ContactsByIdGetResponse, { contact: unknown }>["contact"]
>;
type FullContactChannel = FullContact["channels"][number];
type ContactAssistantMetadata = NonNullable<
  Extract<
    ContactsByIdGetResponse,
    { assistantMetadata?: unknown }
  >["assistantMetadata"]
>;

/** Render a flat, human-readable line for one assistant-metadata value. */
function metadataValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function Dossier({
  contact,
  assistantId,
}: {
  contact: ContactPayload;
  assistantId: string;
}) {
  const navigate = useNavigate();

  // Load the FULL contact record on selection. This is richer than the list
  // row `contact` (per-channel verification/last-seen/policy/interaction
  // counts + assistant-side metadata), so we render real detail rather than
  // re-displaying the list item. Falls back to the list row while loading or
  // if the detail fetch fails.
  const detailQuery = useQuery({
    ...contactsByIdGetOptions({
      path: { assistant_id: assistantId, id: contact.id },
    }),
    select: (data): { full: FullContact; meta?: ContactAssistantMetadata } => ({
      full: data.contact,
      meta: data.assistantMetadata,
    }),
  });

  const full = detailQuery.data?.full ?? null;
  const meta = detailQuery.data?.meta ?? null;

  // Prefer full-record fields, fall back to the list row.
  const notes = full?.notes ?? contact.notes;
  const interactionCount = full?.interactionCount ?? contact.interactionCount;
  const lastInteraction = full?.lastInteraction ?? contact.lastInteraction;
  const channels: Array<
    FullContactChannel | ContactPayload["channels"][number]
  > = full?.channels ?? contact.channels;

  const roleLabel = [
    full?.role ?? contact.role,
    full?.contactType ?? contact.contactType,
  ]
    .filter((v): v is string => Boolean(v) && v !== "contact")
    .join(" · ");

  const hasInteractions = interactionCount > 0 || Boolean(lastInteraction);

  const [messaging, setMessaging] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);

  async function startConversation() {
    if (messaging) return;
    setMessaging(true);
    setMessageError(null);
    // Mint a fresh conversation seeded with an intent about this person, then
    // navigate to it. `null` conversationId asks the assistant to mint one.
    const intent = hasInteractions
      ? `What's the latest with ${contact.displayName}?`
      : `Draft a message to ${contact.displayName}.`;
    const result = await postChatMessage(assistantId, null, intent);
    if (result.ok) {
      void navigate(routes.conversation(result.conversationId));
      return;
    }
    setMessaging(false);
    setMessageError(
      result.error.detail ?? "Couldn’t start a conversation — try again.",
    );
  }

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
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 500, color: C.t1 }}>
            {contact.displayName}
          </div>
          {roleLabel ? (
            <div style={{ fontSize: 12.5, color: C.t2 }}>{roleLabel}</div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void startConversation()}
          disabled={messaging}
          title={`Start a conversation about ${contact.displayName}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: C.blue,
            border: "none",
            borderRadius: 9,
            padding: "8px 13px",
            fontSize: 12.5,
            fontWeight: 500,
            color: "#FFFFFF",
            cursor: messaging ? "default" : "pointer",
            opacity: messaging ? 0.7 : 1,
            flexShrink: 0,
          }}
        >
          {messaging ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <MessageSquare size={14} />
          )}
          Message
        </button>
      </div>

      {messageError ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--mv1-danger)",
            marginBottom: 10,
          }}
        >
          {messageError}
        </div>
      ) : null}

      <Card title="How you know them">
        {notes ? `${notes} · ` : ""}
        {interactionCount}{" "}
        {interactionCount === 1 ? "interaction" : "interactions"} · last seen{" "}
        {fmtWhen(lastInteraction)}
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13.5,
            fontWeight: 500,
            color: C.t1,
          }}
        >
          Reachable on
          {detailQuery.isLoading ? (
            <Loader2 size={12} className="animate-spin" color={C.t3} />
          ) : null}
        </div>
        {channels.length === 0 ? (
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
            {channels.map((ch) => {
              // `contactsByIdGet` channels carry richer per-channel detail
              // (verification + last-seen) than the list row; render it when
              // present.
              const verifiedAt = "verifiedAt" in ch ? ch.verifiedAt : undefined;
              const lastSeenAt = "lastSeenAt" in ch ? ch.lastSeenAt : undefined;
              const sub: string[] = [
                `${ch.type}${ch.isPrimary ? " · primary" : ""}`,
              ];
              if (verifiedAt) sub.push(`verified ${fmtWhen(verifiedAt)}`);
              else if (lastSeenAt) sub.push(`seen ${fmtWhen(lastSeenAt)}`);
              return (
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
                      {sub.join(" · ")}
                    </span>
                  </span>
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: 10.5,
                      padding: "1px 6px",
                      borderRadius: 5,
                      background:
                        ch.status === "active"
                          ? "var(--mv1-green-wash)"
                          : C.sunken,
                      color: ch.status === "active" ? C.green : C.t3,
                    }}
                  >
                    {ch.status}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ height: 10 }} />

      {/* Interaction detail — only what the record actually carries. No
          fabricated commitments/timeline; an honest empty state otherwise. */}
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          padding: "13px 15px",
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 500, color: C.t1 }}>
          Interactions
        </div>
        {detailQuery.isLoading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 12,
              color: C.t2,
              marginTop: 6,
            }}
          >
            <Loader2 size={13} className="animate-spin" /> Loading detail…
          </div>
        ) : hasInteractions ? (
          <div
            style={{
              marginTop: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <DetailRow
              label="Recorded"
              value={`${interactionCount} ${
                interactionCount === 1 ? "interaction" : "interactions"
              }`}
            />
            <DetailRow label="Last seen" value={fmtWhen(lastInteraction)} />
            {(full?.channels ?? [])
              .filter((ch) => ch.interactionCount > 0)
              .map((ch) => (
                <DetailRow
                  key={ch.id}
                  label={ch.type}
                  value={`${ch.interactionCount} · last ${fmtWhen(
                    ch.lastInteraction,
                  )}`}
                />
              ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.t2, marginTop: 5 }}>
            No interactions recorded yet. As Cue talks with{" "}
            {contact.displayName} across your channels, the history fills in
            here.
          </div>
        )}
      </div>

      {meta ? <MetadataCard meta={meta} /> : null}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 10,
        fontSize: 12.5,
      }}
    >
      <span style={{ color: C.t3, textTransform: "capitalize" }}>{label}</span>
      <span style={{ color: C.t1, textAlign: "right" }}>{value}</span>
    </div>
  );
}

/** Assistant-side metadata (`contactsByIdGet.assistantMetadata`), flattened. */
function MetadataCard({ meta }: { meta: ContactAssistantMetadata }) {
  const rows = Object.entries(meta.metadata ?? {})
    .map(([key, value]) => [key, metadataValue(value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);

  if (rows.length === 0) return null;

  return (
    <>
      <div style={{ height: 10 }} />
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderLeft: `3px solid ${C.violet}`,
          borderRadius: "0 12px 12px 0",
          padding: "13px 15px",
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 500, color: C.t1 }}>
          What Cue remembers
        </div>
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {rows.map(([key, value]) => (
            <DetailRow key={key} label={key} value={value} />
          ))}
        </div>
      </div>
    </>
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
      <div style={{ fontSize: 13.5, fontWeight: 500, color: C.t1 }}>
        {title}
      </div>
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
