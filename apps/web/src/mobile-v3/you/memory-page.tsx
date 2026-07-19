/**
 * Mv3MemoryPage — the mobile Memory screen (spec frame 10: what Cue knows —
 * inspectable, editable).
 *
 * Layout (frame-verbatim): `‹ You` → "Memory" large title → search field →
 * People / Preferences / Work / Life segment → the card stack → the green
 * "Stored on your instance only" trust line.
 *
 * DATA (all real):
 *  · People      — real contacts (`contactsGet`): avatar letter, name, role,
 *                  "N moments" = interactionCount, notes as the summary line.
 *                  Tapping opens the relationship dossier (People surface).
 *  · other segs  — real memory items (`useMemoryItemsQuery`), grouped by the
 *                  8-kind model: Preferences = behavioral/emotional · Work =
 *                  procedural/semantic/prospective · Life = episodic/
 *                  narrative/shared. Items told directly render as quoted
 *                  rules with "You told me · date" provenance.
 *  · edit/forget — the SAME mutations the desktop Memory page uses
 *                  (`memoryitemsByIdPatch` / `memoryitemsByIdDelete`).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { contactsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  memoryitemsByIdDelete,
  memoryitemsByIdPatch,
} from "@/generated/daemon/sdk.gen";
import { memoryitemsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useMemoryItemsQuery } from "@/domains/intelligence/memories/hooks/use-memory-items-query";
import type { MemoryItem } from "@/domains/intelligence/memories/types";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { microLabel, rise } from "../mv3-kit";
import { SheetShell } from "../sheet-shell";
import { SegRail, TrustFootnote, YouScreen, shortDate } from "./you-kit";

type MemorySegment = "people" | "preferences" | "work" | "life";

/** Kind → segment map over the 8-kind memory model. */
const SEGMENT_KINDS: Record<Exclude<MemorySegment, "people">, string[]> = {
  preferences: ["behavioral", "emotional"],
  work: ["procedural", "semantic", "prospective"],
  life: ["episodic", "narrative", "shared"],
};

/** Deterministic avatar hue per name (frame 10 uses solid brand-ish fills). */
const AVATAR_HUES = ["#611F69", "#2B53C4", "#0E8C8C", "#7F77DD", "#3560CC"];
function avatarHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}

interface ContactRow {
  id: string;
  displayName: string;
  role: string;
  notes?: string | null;
  interactionCount: number;
}

function PersonCard({
  contact,
  delay,
  onPress,
}: {
  contact: ContactRow;
  delay: number;
  onPress: () => void;
}) {
  return (
    <GlassCard
      padding="14px 16px"
      radius={20}
      blur={delay < 0.4}
      style={{ cursor: "pointer", ...rise(delay) }}
      onClick={() => {
        haptic.light();
        onPress();
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          aria-hidden
          style={{
            width: 34,
            height: 34,
            borderRadius: "50%",
            background: avatarHue(contact.displayName),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 600,
            color: "#fff",
            flexShrink: 0,
          }}
        >
          {contact.displayName.charAt(0).toUpperCase() || "?"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>
            {contact.displayName}
          </div>
          {contact.role ? (
            <div style={{ fontSize: 11.5, color: "var(--mv3-muted)" }}>
              {contact.role}
            </div>
          ) : null}
        </div>
        {contact.interactionCount > 0 ? (
          <span style={{ fontSize: 11, color: "var(--mv3-faint)" }}>
            {contact.interactionCount}{" "}
            {contact.interactionCount === 1 ? "moment" : "moments"}
          </span>
        ) : null}
      </div>
      {contact.notes ? (
        <div
          style={{
            fontSize: 12.5,
            color: "var(--mv3-muted)",
            lineHeight: 1.55,
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--mv3-line)",
          }}
        >
          {contact.notes}
        </div>
      ) : null}
    </GlassCard>
  );
}

/**
 * PersonSheet — the v3 person detail (QA night P1-13). The old tap jumped
 * into the legacy serif People page, crossing two design systems mid-flow;
 * this keeps the dossier in the v3 sheet grammar. Honest interim: shows the
 * contact's real fields (role, notes, moments) plus the memory items whose
 * subject/statement name them — read-only until a full v3 person view lands.
 */
function PersonSheet({
  contact,
  items,
  onClose,
}: {
  contact: ContactRow | null;
  items: MemoryItem[];
  onClose: () => void;
}) {
  const related = useMemo(() => {
    if (!contact) return [];
    const name = contact.displayName.trim().toLowerCase();
    if (!name) return [];
    return items
      .filter((i) =>
        `${i.subject} ${i.statement}`.toLowerCase().includes(name),
      )
      .slice(0, 8);
  }, [contact, items]);

  if (!contact) return null;

  return (
    <SheetShell open onClose={onClose} label={`Person: ${contact.displayName}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: avatarHue(contact.displayName),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 17,
            fontWeight: 600,
            color: "#fff",
            flexShrink: 0,
          }}
        >
          {contact.displayName.charAt(0).toUpperCase() || "?"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.3px" }}>
            {contact.displayName}
          </div>
          <div style={{ fontSize: 12, color: "var(--mv3-muted)", marginTop: 2 }}>
            {[
              contact.role || null,
              contact.interactionCount > 0
                ? `${contact.interactionCount} ${
                    contact.interactionCount === 1 ? "moment" : "moments"
                  }`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Cue is still getting to know them."}
          </div>
        </div>
      </div>

      {contact.notes ? (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              ...microLabel,
              fontSize: 9.5,
              color: "var(--mv3-faint)",
              marginBottom: 7,
            }}
          >
            What Cue knows
          </div>
          <div
            style={{
              fontSize: 13.5,
              color: "var(--mv3-text)",
              lineHeight: 1.55,
            }}
          >
            {contact.notes}
          </div>
        </div>
      ) : null}

      {related.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div
            style={{
              ...microLabel,
              fontSize: 9.5,
              color: "var(--mv3-faint)",
              marginBottom: 7,
            }}
          >
            Filed memories · {related.length}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {related.map((i) => (
              <div
                key={i.id}
                style={{
                  background: "var(--mv3-btn2-bg)",
                  border: "1px solid var(--mv3-btn2-border)",
                  borderRadius: 12,
                  padding: "10px 13px",
                }}
              >
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                  {i.statement}
                </div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: "var(--mv3-faint)",
                    marginTop: 3,
                  }}
                >
                  {i.kind} · {shortDate(i.firstSeenAt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!contact.notes && related.length === 0 ? (
        <div
          style={{
            fontSize: 13,
            color: "var(--mv3-muted)",
            lineHeight: 1.55,
            marginTop: 16,
          }}
        >
          Nothing filed yet — Cue builds this dossier as you work together.
        </div>
      ) : null}

      <div
        style={{
          fontSize: 10.5,
          color: "var(--mv3-faint)",
          marginTop: 16,
          textAlign: "center",
        }}
      >
        Edit or forget individual memories from the list behind this sheet.
      </div>
    </SheetShell>
  );
}

function MemoryCard({
  item,
  expanded,
  delay,
  onToggle,
  onEdit,
  onForget,
  editing,
  draft,
  onDraftChange,
  onSaveEdit,
  onCancelEdit,
  saving,
}: {
  item: MemoryItem;
  expanded: boolean;
  delay: number;
  onToggle: () => void;
  onEdit: () => void;
  onForget: () => void;
  editing: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  saving: boolean;
}) {
  const direct = item.sourceType === "direct";
  const meta = direct
    ? `You told me · ${shortDate(item.firstSeenAt)}`
    : `${item.kind} · ${shortDate(item.firstSeenAt)}`;

  return (
    <GlassCard
      padding="13px 16px"
      radius={20}
      blur={false}
      style={{ ...rise(Math.min(delay, 0.55)) }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!editing) {
            haptic.light();
            onToggle();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !editing) onToggle();
        }}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 11,
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            background: "rgba(61,110,232,.16)",
            color: "var(--mv3-micro)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          ✎
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              rows={3}
              autoFocus
              style={{
                width: "100%",
                fontSize: 16,
                fontFamily: "inherit",
                color: "var(--mv3-text)",
                background: "var(--mv3-track)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 10,
                padding: "9px 11px",
                resize: "vertical",
                outline: "none",
              }}
            />
          ) : (
            <div style={{ fontSize: 13.5, lineHeight: 1.45 }}>
              {direct ? `“${item.statement}”` : item.statement}
            </div>
          )}
          <div
            style={{ fontSize: 11, color: "var(--mv3-faint)", marginTop: 3 }}
          >
            {meta}
          </div>
        </div>
        {!editing && !expanded ? (
          <span style={{ fontSize: 12, color: "var(--mv3-faint)" }}>Edit</span>
        ) : null}
      </div>

      {editing ? (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button
            type="button"
            disabled={saving || draft.trim().length === 0}
            onClick={onSaveEdit}
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--mv3-bg)",
              background: "var(--mv3-text)",
              border: "none",
              borderRadius: 9,
              padding: "9px 16px",
              minHeight: 36,
              cursor: "pointer",
              fontFamily: "inherit",
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={onCancelEdit}
            style={{
              fontSize: 12.5,
              color: "var(--mv3-muted)",
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 9,
              padding: "9px 16px",
              minHeight: 36,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
        </div>
      ) : expanded ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--mv3-line)",
          }}
        >
          <button
            type="button"
            onClick={() => {
              haptic.light();
              onEdit();
            }}
            style={{
              fontSize: 12.5,
              color: "var(--mv3-text)",
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 9,
              padding: "9px 18px",
              minHeight: 36,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              haptic.medium();
              onForget();
            }}
            style={{
              fontSize: 12.5,
              color: "#E5675B",
              background: "rgba(229,103,91,.12)",
              border: "1px solid rgba(229,103,91,.3)",
              borderRadius: 9,
              padding: "9px 18px",
              minHeight: 36,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Forget
          </button>
        </div>
      ) : null}
    </GlassCard>
  );
}

export function Mv3MemoryPage() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const [segment, setSegment] = useState<MemorySegment>("people");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingForget, setPendingForget] = useState<MemoryItem | null>(null);
  // Person detail stays IN the v3 surface (QA night P1-13): a sheet over this
  // page instead of a jump into the legacy serif People page. Interim until a
  // full v3 person view exists.
  const [personId, setPersonId] = useState<string | null>(null);

  const contactsQuery = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 60_000,
  });
  const contacts = useMemo<ContactRow[]>(
    () =>
      ((contactsQuery.data?.contacts ?? []) as ContactRow[])
        .slice()
        .sort((a, b) => b.interactionCount - a.interactionCount),
    [contactsQuery.data],
  );

  const memoryQuery = useMemoryItemsQuery(assistantId, null);
  const items = useMemo<MemoryItem[]>(
    () => memoryQuery.data?.items ?? [],
    [memoryQuery.data],
  );
  const total = memoryQuery.data?.total ?? items.length;

  const q = query.trim().toLowerCase();

  const visiblePeople = useMemo(
    () =>
      contacts.filter(
        (c) =>
          q === "" ||
          `${c.displayName} ${c.role} ${c.notes ?? ""}`
            .toLowerCase()
            .includes(q),
      ),
    [contacts, q],
  );

  const visibleItems = useMemo(() => {
    if (segment === "people") return [];
    const kinds = new Set(SEGMENT_KINDS[segment]);
    return items.filter(
      (i) =>
        kinds.has(i.kind) &&
        (q === "" ||
          `${i.statement} ${i.subject}`.toLowerCase().includes(q)),
    );
  }, [items, segment, q]);

  async function invalidate() {
    await queryClient.invalidateQueries({
      queryKey: memoryitemsGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
  }

  const editMutation = useMutation({
    mutationFn: async (vars: { id: string; statement: string }) => {
      const { error } = await memoryitemsByIdPatch({
        path: { assistant_id: assistantId, id: vars.id },
        body: { statement: vars.statement },
        throwOnError: false,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      haptic.success();
      setEditingId(null);
      await invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (item: MemoryItem) => {
      const { error } = await memoryitemsByIdDelete({
        path: { assistant_id: assistantId, id: item.id },
        throwOnError: false,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      haptic.success();
      setPendingForget(null);
      setExpandedId(null);
      await invalidate();
    },
  });

  const loading =
    segment === "people" ? contactsQuery.isLoading : memoryQuery.isLoading;
  const failed =
    segment === "people" ? contactsQuery.isError : memoryQuery.isError;

  return (
    <YouScreen
      tint="blue"
      testId="mv3-memory"
      back={routes.channels}
      header={
        <div
          style={{
            padding: "6px 22px 12px",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <div
            style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.8px" }}
          >
            Memory
          </div>
          {/* Search field (≥16px input so iOS never zooms). */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 14,
              padding: "0 14px",
              marginTop: 12,
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--mv3-faint)"
              strokeWidth="2"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.5-4.5" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                total > 0
                  ? `Search what Cue knows… (${total.toLocaleString()})`
                  : "Search what Cue knows…"
              }
              aria-label="Search memories"
              style={{
                flex: 1,
                fontSize: 16,
                fontFamily: "inherit",
                color: "var(--mv3-text)",
                background: "transparent",
                border: "none",
                outline: "none",
                padding: "11px 0",
                minHeight: 44,
              }}
            />
          </div>
          <div style={{ marginTop: 11 }}>
            <SegRail<MemorySegment>
              ariaLabel="Memory sections"
              value={segment}
              onChange={(v) => {
                setSegment(v);
                setExpandedId(null);
                setEditingId(null);
              }}
              items={[
                { value: "people", label: "People" },
                { value: "preferences", label: "Preferences" },
                { value: "work", label: "Work" },
                { value: "life", label: "Life" },
              ]}
            />
          </div>
        </div>
      }
    >
      {loading ? (
        <div
          style={{
            fontSize: 13,
            color: "var(--mv3-muted)",
            padding: "16px 4px",
          }}
        >
          Loading what Cue knows…
        </div>
      ) : failed ? (
        <GlassCard padding="16px">
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>
            Couldn't load memory
          </div>
          <div
            style={{ fontSize: 12.5, color: "var(--mv3-muted)", marginTop: 4 }}
          >
            The memory store didn't respond — try again in a moment.
          </div>
        </GlassCard>
      ) : segment === "people" ? (
        visiblePeople.length === 0 ? (
          <GlassCard padding="18px 16px">
            <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
              {q
                ? "No people match that search."
                : "No people yet — Cue builds dossiers as you work together."}
            </div>
          </GlassCard>
        ) : (
          visiblePeople
            .slice(0, 30)
            .map((c, i) => (
              <PersonCard
                key={c.id}
                contact={c}
                delay={0.1 + Math.min(i, 3) * 0.15}
                onPress={() => setPersonId(c.id)}
              />
            ))
        )
      ) : visibleItems.length === 0 ? (
        <GlassCard padding="18px 16px">
          <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
            {q
              ? "No memories match that search."
              : "Nothing filed here yet — Cue learns as you go."}
          </div>
        </GlassCard>
      ) : (
        visibleItems.slice(0, 60).map((item, i) => (
          <MemoryCard
            key={item.id}
            item={item}
            delay={0.1 + Math.min(i, 3) * 0.15}
            expanded={expandedId === item.id}
            editing={editingId === item.id}
            draft={draft}
            onDraftChange={setDraft}
            onToggle={() =>
              setExpandedId((cur) => (cur === item.id ? null : item.id))
            }
            onEdit={() => {
              setEditingId(item.id);
              setDraft(item.statement);
            }}
            onForget={() => setPendingForget(item)}
            onSaveEdit={() => {
              if (draft.trim().length > 0) {
                editMutation.mutate({ id: item.id, statement: draft.trim() });
              }
            }}
            onCancelEdit={() => setEditingId(null)}
            saving={
              editMutation.isPending && editMutation.variables?.id === item.id
            }
          />
        ))
      )}

      <TrustFootnote>
        Stored on your instance only · tap any memory to edit or forget
      </TrustFootnote>

      <PersonSheet
        contact={contacts.find((c) => c.id === personId) ?? null}
        items={items}
        onClose={() => setPersonId(null)}
      />

      <ConfirmDialog
        open={pendingForget !== null}
        title="Forget this memory?"
        message={
          pendingForget
            ? `Cue will permanently forget “${pendingForget.statement}”. This can't be undone.`
            : ""
        }
        confirmLabel={deleteMutation.isPending ? "Forgetting…" : "Forget"}
        cancelLabel="Keep"
        destructive
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (pendingForget) deleteMutation.mutate(pendingForget);
        }}
        onCancel={() => {
          if (!deleteMutation.isPending) setPendingForget(null);
        }}
      />
    </YouScreen>
  );
}
