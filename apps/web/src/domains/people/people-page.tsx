/**
 * People — relationship memory (Cue-Surfaces.html §S4).
 *
 * Master–detail dossier built to the shipped HQ design language: an
 * editorial serif hero, DM-Mono microlabels, and the theme-aware `--mv1-*`
 * tokens (defined locally here — `people` is a domain and can't cross-import
 * `domains/activity`). The list stays wired to real contacts (`contactsGet`);
 * selecting one loads the FULL relationship dossier
 * (`contactsByIdDossierGet`) — a blended relationship score/tier badge
 * ("HUMAN · STRONG · 70%"), "WHAT CUE REMEMBERS" (durable facts, with an
 * add-a-fact affordance + per-fact forget), "REACHABLE ON" channels, and a
 * newest-first interactions timeline that links to the underlying thread.
 *
 * Honest states throughout: a score-0 contact reads as "new", not "strong";
 * an empty memory list invites you to teach Cue rather than promising recall
 * that hasn't happened. On mobile the two panes stack — list first, tap to
 * push a full-screen detail with a back affordance (the Projects pattern).
 */

import {
  ArrowLeft,
  CircleDot,
  Hash,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  Send,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ContactPayload } from "@/domains/contacts/types";
import {
  contactsByIdDossierGetOptions,
  contactsByIdDossierGetQueryKey,
  contactsByIdMemoryByMidDeleteMutation,
  contactsByIdMemoryPostMutation,
  contactsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ContactsByIdDossierGetResponse } from "@/generated/daemon/types.gen";
import { postChatMessage } from "@/domains/chat/api/messages";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

/**
 * Theme-aware inline palette. Points at the `--mv1-*` CSS vars (src/index.css)
 * so these surfaces follow the active light/dark theme instead of pasting a
 * light canvas onto dark chrome. Defined locally — `people` can't import
 * `domains/activity/theme`.
 */
const C = {
  ink: "var(--mv1-t1)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  blueW: "var(--mv1-blue-wash)",
  violet: "var(--mv1-violet)",
  violetS: "var(--mv1-violet-strong)",
  bg: "var(--mv1-canvas)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  greenW: "var(--mv1-green-wash)",
  amber: "var(--mv1-amber)",
  danger: "var(--mv1-danger)",
  /** Text leg for small copy where colour is the only carrier (A1). */
  dangerText: "var(--mv1-danger-text)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

/** The dossier payload the detail pane renders. */
type Dossier = Extract<
  ContactsByIdDossierGetResponse,
  { dossier: unknown }
>["dossier"];
type DossierMemory = Dossier["memory"][number];
type DossierChannel = Dossier["reachability"][number];
type DossierInteraction = Dossier["interactions"][number];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Normalise a daemon epoch (seconds or ms) to ms. */
function toMs(value: number | null | undefined): number | null {
  if (!value) return null;
  return value > 1e12 ? value : value * 1000;
}

/** Epoch → short "Sep 14" style date. Null/0 → "—". */
function fmtDate(value: number | null | undefined): string {
  const ms = toMs(value);
  if (ms == null) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Relative "2d ago" label, computed against a `now` captured once at mount so
 * render stays pure (no `Date.now()` in render).
 */
function fmtAgo(value: number | null | undefined, now: number): string | null {
  const ms = toMs(value);
  if (ms == null) return null;
  const diff = now - ms;
  if (diff < 0) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * Map a relationship score/tier to an honest badge. Score 0 (or no
 * interactions) reads as "NEW", not a fabricated strength.
 */
function relationshipBadge(
  score: number,
  tier: string,
  interactionCount: number,
): { label: string; color: string; wash: string } | null {
  if (interactionCount <= 0 && score <= 0) {
    return { label: "NEW", color: C.t3, wash: C.sunken };
  }
  const pct = Math.round(Math.max(0, Math.min(100, score)));
  const t = tier.toLowerCase();
  if (t === "strong") {
    return { label: `STRONG · ${pct}%`, color: C.green, wash: C.greenW };
  }
  if (t === "building") {
    return { label: `BUILDING · ${pct}%`, color: C.blueS, wash: C.blueW };
  }
  // "weak" / anything else — still show the honest percentage.
  return { label: `EARLY · ${pct}%`, color: C.t3, wash: C.sunken };
}

const CHANNEL_ICON: Record<string, LucideIcon> = {
  email: Mail,
  gmail: Mail,
  slack: Hash,
  sms: Phone,
  phone: Phone,
  twilio: Phone,
  whatsapp: Phone,
  telegram: Send,
};

function channelIcon(type: string, color: string): ReactNode {
  const Icon = CHANNEL_ICON[type.toLowerCase()] ?? CircleDot;
  return <Icon size={13} color={color} />;
}

const KIND_TINT: Record<string, string> = {
  fact: C.blueS,
  preference: C.violet,
  relationship: C.green,
  context: C.amber,
};

export function PeoplePage() {
  const assistantId = useActiveAssistantId();
  const isMobile = useIsMobile();

  const contactsQuery = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.contacts,
  });

  // Capture "now" once at mount so relative-time rendering stays pure.
  const [now] = useState(() => Date.now());
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const contacts = useMemo(() => {
    // Relationship memory is about other people — exclude the assistant's own
    // identity and the guardian (you).
    const list = (contactsQuery.data ?? []).filter(
      (c) => c.role !== "assistant" && c.role !== "guardian",
    );
    return [...list].sort(
      (a, b) =>
        (b.lastInteraction ?? 0) - (a.lastInteraction ?? 0) ||
        b.interactionCount - a.interactionCount,
    );
  }, [contactsQuery.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => c.displayName.toLowerCase().includes(q));
  }, [contacts, search]);

  const selected =
    contacts.find((c) => c.id === selectedId) ??
    (isMobile ? null : (filtered[0] ?? contacts[0] ?? null));

  // Mobile: once a contact is selected, push a full-screen detail view.
  if (isMobile && selected) {
    return (
      <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
        <div
          style={{ maxWidth: 640, margin: "0 auto", padding: "16px 16px 40px" }}
        >
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: "none",
              padding: "6px 2px",
              marginBottom: 8,
              fontSize: 13,
              color: C.t2,
              cursor: "pointer",
            }}
          >
            <ArrowLeft size={16} /> People
          </button>
          <DossierPane
            key={selected.id}
            contact={selected}
            assistantId={assistantId}
            now={now}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: 24 }}>
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
                fontSize: 10.5,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: C.t3,
              }}
            >
              People · relationship memory
            </div>
            <h1
              style={{
                fontFamily: serif,
                fontSize: 31,
                lineHeight: 1.05,
                margin: "5px 0 0",
                fontWeight: 400,
                color: C.t1,
              }}
            >
              The people Cue knows.
            </h1>
          </div>
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
            <Loader2 size={16} className="animate-spin" /> Loading your people…
          </div>
        ) : contacts.length === 0 ? (
          <div style={{ marginTop: 22 }}>
            <ListEmptyState error={contactsQuery.isError} />
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile
                ? "1fr"
                : "minmax(0,300px) minmax(0,1fr)",
              gap: isMobile ? 16 : 22,
              alignItems: "start",
              marginTop: 22,
            }}
          >
            <ContactList
              contacts={filtered}
              search={search}
              onSearch={setSearch}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
              now={now}
            />
            {selected ? (
              <DossierPane
                key={selected.id}
                contact={selected}
                assistantId={assistantId}
                now={now}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Contact list ────────────────────────────────────────────────────────────

function ContactList({
  contacts,
  search,
  onSearch,
  selectedId,
  onSelect,
  now,
}: {
  contacts: ContactPayload[];
  search: string;
  onSearch: (v: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search people"
        style={{
          width: "100%",
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderRadius: 10,
          padding: "9px 12px",
          fontSize: 13,
          color: C.t1,
          outline: "none",
        }}
      />
      {contacts.length === 0 ? (
        <div
          style={{
            fontSize: 12.5,
            color: C.t2,
            padding: "14px 4px",
            textAlign: "center",
          }}
        >
          No one matches “{search}”.
        </div>
      ) : (
        contacts.map((c) => {
          const active = c.id === selectedId;
          const ago = fmtAgo(c.lastInteraction, now);
          const sub =
            c.interactionCount > 0
              ? `${c.interactionCount} ${
                  c.interactionCount === 1 ? "interaction" : "interactions"
                }${ago ? ` · ${ago}` : ""}`
              : "No interactions yet";
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                background: C.surface,
                border: active
                  ? `1.5px solid ${C.blue}`
                  : `1px solid ${C.line}`,
                borderRadius: 12,
                padding: "11px 13px",
                boxShadow: active
                  ? "0 14px 30px -20px rgba(61,110,232,.5)"
                  : "none",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <Avatar name={c.displayName} size={36} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: C.t1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.displayName}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 11.5,
                    color: C.t2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {sub}
                </span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

function Avatar({ name, size }: { name: string; size: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: C.blueW,
        color: C.blueS,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: size * 0.36,
        flexShrink: 0,
      }}
    >
      {initials(name)}
    </span>
  );
}

// ── Dossier ─────────────────────────────────────────────────────────────────

function DossierPane({
  contact,
  assistantId,
  now,
}: {
  contact: ContactPayload;
  assistantId: string;
  now: number;
}) {
  const navigate = useNavigate();

  const dossierQuery = useQuery({
    ...contactsByIdDossierGetOptions({
      path: { assistant_id: assistantId, id: contact.id },
    }),
    select: (data): Dossier => data.dossier,
  });

  const dossier = dossierQuery.data ?? null;
  const displayName = dossier?.displayName ?? contact.displayName;

  const roleLabel = useMemo(() => {
    const parts = [
      dossier?.role ?? contact.role,
      dossier?.contactType ?? contact.contactType,
    ].filter((v): v is string => Boolean(v) && v !== "contact");
    return parts.join(" · ");
  }, [dossier, contact]);

  const rel = dossier?.relationship ?? null;
  const badge = rel
    ? relationshipBadge(rel.score, rel.tier, rel.interactionCount)
    : null;

  const [messaging, setMessaging] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);

  async function startConversation() {
    if (messaging) return;
    setMessaging(true);
    setMessageError(null);
    const hasHistory = (rel?.interactionCount ?? contact.interactionCount) > 0;
    const intent = hasHistory
      ? `What's the latest with ${displayName}?`
      : `Draft a message to ${displayName}.`;
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
      {/* Header — score ring, serif name, trust/relationship badges */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <ScoreRing name={displayName} score={rel?.score ?? 0} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontFamily: serif, fontSize: 24, color: C.t1 }}>
              {displayName}
            </span>
            <Chip
              label={(
                dossier?.contactType ??
                contact.contactType ??
                "human"
              ).toUpperCase()}
              color={C.t3}
              wash={C.sunken}
            />
            {badge ? (
              <Chip label={badge.label} color={badge.color} wash={badge.wash} />
            ) : dossierQuery.isLoading ? (
              <Loader2 size={12} className="animate-spin" color={C.t3} />
            ) : null}
          </div>
          {roleLabel ? (
            <div style={{ fontSize: 12.5, color: C.t2, marginTop: 3 }}>
              {roleLabel}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void startConversation()}
          disabled={messaging}
          title={`Start a conversation about ${displayName}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            background: C.blue,
            border: "none",
            borderRadius: 9,
            padding: "9px 15px",
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
        <div style={{ fontSize: 12, color: C.dangerText, marginTop: 10 }}>
          {messageError}
        </div>
      ) : null}

      {/* Panels */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 12,
          marginTop: 18,
        }}
      >
        <MemorySection
          assistantId={assistantId}
          contactId={contact.id}
          displayName={displayName}
          memory={dossier?.memory ?? []}
          loading={dossierQuery.isLoading}
          now={now}
        />
        <ReachableSection
          channels={dossier?.reachability ?? []}
          loading={dossierQuery.isLoading}
        />
        <InteractionsSection
          interactions={dossier?.interactions ?? []}
          count={rel?.interactionCount ?? contact.interactionCount}
          loading={dossierQuery.isLoading}
          displayName={displayName}
          now={now}
          onOpen={(id) => navigate(routes.conversation(id))}
        />
      </div>
    </div>
  );
}

/** Circular relationship-strength ring wrapping an avatar. */
function ScoreRing({ name, score }: { name: string; score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const R = 52;
  const circ = 2 * Math.PI * R;
  const offset = circ * (1 - clamped / 100);
  return (
    <div
      style={{
        position: "relative",
        width: 56,
        height: 56,
        flexShrink: 0,
      }}
    >
      <svg
        viewBox="0 0 120 120"
        width={56}
        height={56}
        style={{ transform: "rotate(-90deg)" }}
      >
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke={C.sunken}
          strokeWidth={6}
        />
        {clamped > 0 ? (
          <circle
            cx="60"
            cy="60"
            r={R}
            fill="none"
            stroke={C.blue}
            strokeWidth={6}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
          />
        ) : null}
      </svg>
      <span
        style={{
          position: "absolute",
          inset: 0,
          margin: "auto",
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: C.blueW,
          color: C.blueS,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 15,
          fontWeight: 600,
        }}
      >
        {initials(name)}
      </span>
    </div>
  );
}

function Chip({
  label,
  color,
  wash,
}: {
  label: string;
  color: string;
  wash: string;
}) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 9,
        letterSpacing: "0.1em",
        color,
        background: wash,
        borderRadius: 6,
        padding: "3px 8px",
      }}
    >
      {label}
    </span>
  );
}

function Microlabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 9.5,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: C.t3,
      }}
    >
      {children}
    </div>
  );
}

const PANEL: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 12,
  padding: "14px 16px",
};

// ── WHAT CUE REMEMBERS ──────────────────────────────────────────────────────

function MemorySection({
  assistantId,
  contactId,
  displayName,
  memory,
  loading,
  now,
}: {
  assistantId: string;
  contactId: string;
  displayName: string;
  memory: DossierMemory[];
  loading: boolean;
  now: number;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: contactsByIdDossierGetQueryKey({
        path: { assistant_id: assistantId, id: contactId },
      }),
    });
  }

  const addMutation = useMutation({
    ...contactsByIdMemoryPostMutation(),
    onSuccess: () => {
      setDraft("");
      setAdding(false);
      setError(null);
      invalidate();
    },
    onError: () => setError("Couldn’t save that — try again."),
  });

  const forgetMutation = useMutation({
    ...contactsByIdMemoryByMidDeleteMutation(),
    onSuccess: invalidate,
  });

  function submit() {
    const statement = draft.trim();
    if (!statement || addMutation.isPending) return;
    addMutation.mutate({
      path: { assistant_id: assistantId, id: contactId },
      body: { statement },
    });
  }

  const pendingForgetId =
    forgetMutation.isPending && forgetMutation.variables
      ? forgetMutation.variables.path.mid
      : null;

  return (
    <div style={{ ...PANEL, borderLeft: `3px solid ${C.violet}` }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Microlabel>What Cue remembers</Microlabel>
        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            setError(null);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            background: "transparent",
            border: "none",
            fontSize: 11,
            color: C.blueS,
            cursor: "pointer",
            padding: 0,
          }}
        >
          {adding ? <X size={13} /> : <Plus size={13} />}
          {adding ? "Cancel" : "Add a fact"}
        </button>
      </div>

      {adding ? (
        <div style={{ marginTop: 11 }}>
          <textarea
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={`Tell Cue something about ${displayName}…`}
            rows={2}
            style={{
              width: "100%",
              background: C.bg,
              border: `1px solid ${C.line}`,
              borderRadius: 9,
              padding: "9px 11px",
              fontSize: 12.5,
              color: C.t1,
              resize: "vertical",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 8,
            }}
          >
            <span style={{ fontSize: 10.5, color: C.t3 }}>⌘↵ to save</span>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || addMutation.isPending}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: C.blue,
                border: "none",
                borderRadius: 8,
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 500,
                color: "#FFFFFF",
                cursor:
                  !draft.trim() || addMutation.isPending
                    ? "default"
                    : "pointer",
                opacity: !draft.trim() || addMutation.isPending ? 0.6 : 1,
              }}
            >
              {addMutation.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : null}
              Remember this
            </button>
          </div>
          {error ? (
            <div style={{ fontSize: 11, color: C.dangerText, marginTop: 6 }}>
              {error}
            </div>
          ) : null}
        </div>
      ) : null}

      {loading && memory.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 12,
            color: C.t2,
            marginTop: 10,
          }}
        >
          <Loader2 size={13} className="animate-spin" /> Loading…
        </div>
      ) : memory.length === 0 ? (
        !adding ? (
          <div
            style={{
              fontSize: 12.5,
              color: C.t2,
              lineHeight: 1.55,
              marginTop: 10,
            }}
          >
            Cue hasn’t learned anything about {displayName} yet — tell it
            something, or it’ll pick things up as you interact.
          </div>
        ) : null
      ) : (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {memory.map((m) => (
            <MemoryRow
              key={m.id}
              item={m}
              now={now}
              forgetting={pendingForgetId === m.id}
              onForget={() =>
                forgetMutation.mutate({
                  path: { assistant_id: assistantId, id: contactId, mid: m.id },
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryRow({
  item,
  now,
  forgetting,
  onForget,
}: {
  item: DossierMemory;
  now: number;
  forgetting: boolean;
  onForget: () => void;
}) {
  const tint = KIND_TINT[item.kind.toLowerCase()] ?? C.t3;
  const ago = fmtAgo(item.createdAt, now);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        opacity: forgetting ? 0.5 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: tint,
          marginTop: 6,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: C.t1, lineHeight: 1.5 }}>
          {item.statement}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: mono,
              fontSize: 9,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: tint,
              background: C.sunken,
              borderRadius: 5,
              padding: "2px 6px",
            }}
          >
            {item.kind}
          </span>
          <span style={{ fontSize: 10.5, color: C.t3 }}>
            {item.source}
            {ago ? ` · ${ago}` : ""}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onForget}
        disabled={forgetting}
        title="Forget this"
        style={{
          background: "transparent",
          border: "none",
          padding: 3,
          color: C.t3,
          cursor: forgetting ? "default" : "pointer",
          flexShrink: 0,
        }}
      >
        {forgetting ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <X size={13} />
        )}
      </button>
    </div>
  );
}

// ── REACHABLE ON ────────────────────────────────────────────────────────────

function ReachableSection({
  channels,
  loading,
}: {
  channels: DossierChannel[];
  loading: boolean;
}) {
  return (
    <div style={PANEL}>
      <Microlabel>Reachable on</Microlabel>
      {loading && channels.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 12,
            color: C.t2,
            marginTop: 10,
          }}
        >
          <Loader2 size={13} className="animate-spin" /> Loading…
        </div>
      ) : channels.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.t2, marginTop: 8 }}>
          No channels connected yet.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 10,
          }}
        >
          {channels.map((ch) => (
            <ChannelChip key={ch.channelId} channel={ch} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelChip({ channel }: { channel: DossierChannel }) {
  const reachable = channel.reachable && channel.status === "active";
  const tint = reachable ? C.green : C.t3;
  return (
    <span
      title={`${channel.address} · ${channel.status}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontSize: 11.5,
        color: C.t1,
        background: C.sunken,
        borderRadius: 8,
        padding: "6px 11px",
        maxWidth: "100%",
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          background: C.surface,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {channelIcon(channel.type, tint)}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 180,
        }}
      >
        {channel.address}
      </span>
      {channel.isPrimary ? (
        <span style={{ fontSize: 9.5, color: C.t3, flexShrink: 0 }}>
          primary
        </span>
      ) : null}
      <span
        aria-hidden
        title={channel.status}
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: tint,
          flexShrink: 0,
        }}
      />
    </span>
  );
}

// ── INTERACTIONS ────────────────────────────────────────────────────────────

function InteractionsSection({
  interactions,
  count,
  loading,
  displayName,
  now,
  onOpen,
}: {
  interactions: DossierInteraction[];
  count: number;
  loading: boolean;
  displayName: string;
  now: number;
  onOpen: (conversationId: string) => void;
}) {
  // Newest-first.
  const rows = useMemo(
    () => [...interactions].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
    [interactions],
  );

  return (
    <div style={PANEL}>
      <Microlabel>Interactions{count > 0 ? ` · ${count}` : ""}</Microlabel>
      {loading && rows.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 12,
            color: C.t2,
            marginTop: 10,
          }}
        >
          <Loader2 size={13} className="animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            fontSize: 12.5,
            color: C.t2,
            lineHeight: 1.55,
            marginTop: 10,
          }}
        >
          No interactions recorded yet. As Cue talks with {displayName} across
          your channels, the history fills in here.
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {rows.map((it, idx) => (
            <InteractionRow
              key={`${it.conversationId}-${it.at}-${idx}`}
              item={it}
              now={now}
              first={idx === 0}
              onOpen={() => onOpen(it.conversationId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InteractionRow({
  item,
  now,
  first,
  onOpen,
}: {
  item: DossierInteraction;
  now: number;
  first: boolean;
  onOpen: () => void;
}) {
  const isCall = item.kind.toLowerCase() === "call";
  const Icon = isCall ? Phone : MessageSquare;
  const ago = fmtAgo(item.at, now);
  const when = ago ?? fmtDate(item.at);
  const title = item.title?.trim() || (isCall ? "Call" : "Conversation");
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderTop: first ? "none" : `1px solid ${C.line}`,
        padding: first ? "0 0 13px" : "13px 0",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: isCall ? C.greenW : C.blueW,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon size={13} color={isCall ? C.green : C.blueS} />
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
          {title}
        </span>
        <span style={{ fontSize: 11, color: C.t3 }}>
          {when}
          {item.channel ? ` · ${item.channel}` : ""}
        </span>
      </span>
    </button>
  );
}

// ── Empty / error ───────────────────────────────────────────────────────────

function ListEmptyState({ error }: { error: boolean }) {
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
      <div style={{ fontFamily: serif, fontSize: 21, color: C.t1 }}>
        {error ? "Couldn’t load your people" : "No people yet"}
      </div>
      <div
        style={{
          fontSize: 13,
          color: C.t2,
          marginTop: 6,
          maxWidth: 380,
          margin: "6px auto 0",
          lineHeight: 1.5,
        }}
      >
        {error
          ? "Cue couldn’t reach contacts just now — try again in a moment."
          : "As Cue meets people across your channels, they’ll show up here with the context it’s gathered."}
      </div>
    </div>
  );
}
