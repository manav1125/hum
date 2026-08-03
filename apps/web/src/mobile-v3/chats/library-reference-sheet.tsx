/**
 * ▦ Library — the composer's fourth mode (v25 · G6).
 *
 *   "▦ Library → a reference. Sheet. Pick a file to attach it to what you're
 *    saying."
 *
 * A sheet over the composer rather than a destination, because you are not
 * going anywhere: you are naming a file inside a sentence you are already
 * writing. It leads with what this conversation's own thing has made, since
 * that is what "the Library from here" means (§3 of the brief: "Library from a
 * thing leads with that thing's files").
 *
 * WHAT "ATTACH" HONESTLY MEANS HERE, because the word could imply more than
 * happens. There is no endpoint that binds an existing server-side document to
 * an outgoing message — the composer's attachment path is file UPLOAD only. So
 * picking an item writes a plain, explicit reference into the message you are
 * composing:
 *
 *     Using "Acme pricing model" from my library: |
 *
 * That is a real instruction the assistant acts on, and you can see and edit it
 * before it sends. What it is NOT is a chip that claims a binding the wire does
 * not have. If the document-attachment endpoint lands later, this is the one
 * place to change.
 *
 * Failure is an error state, not an empty one: a library that could not be
 * fetched says so and offers a retry. An empty library says why it is empty.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, LayoutGrid, Search } from "lucide-react";

import {
  appsGetOptions,
  documentsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { haptic } from "@/utils/haptics";

import { GlassCard } from "../glass-card";
import { SheetShell } from "../sheet-shell";

export interface LibraryReference {
  kind: "document" | "app";
  id: string;
  title: string;
  /** Epoch ms of last change, for ordering and the "made here" line. */
  updatedAt: number;
  /** The conversation it was made in, when the daemon knows. */
  conversationId?: string | null;
}

/**
 * The sentence a picked reference writes into the composer.
 *
 * Exported and pure so the wording is testable, and so it is obvious that this
 * is TEXT — the whole of what picking a file does.
 */
export function referenceText(reference: LibraryReference): string {
  return `Using "${reference.title}" from my library: `;
}

/** Insert the reference at the end of whatever is already typed. */
export function withReference(input: string, reference: LibraryReference): string {
  const existing = input.trimEnd();
  const line = referenceText(reference);
  return existing.length === 0 ? line : `${existing}\n${line}`;
}

/**
 * Ordering: files this conversation made first (that is what "the Library from
 * here" means), then everything else by recency.
 */
export function orderForConversation(
  items: readonly LibraryReference[],
  conversationId: string | null | undefined,
): LibraryReference[] {
  return [...items].sort((a, b) => {
    const aHere = conversationId != null && a.conversationId === conversationId;
    const bHere = conversationId != null && b.conversationId === conversationId;
    if (aHere !== bHere) return aHere ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

export interface LibraryReferenceSheetProps {
  open: boolean;
  onClose: () => void;
  assistantId: string;
  /** The conversation the sheet was opened from — leads with its files. */
  conversationId?: string | null;
  /** Receives the picked reference. The caller writes it into the composer. */
  onPick: (reference: LibraryReference) => void;
}

export function LibraryReferenceSheet({
  open,
  onClose,
  assistantId,
  conversationId,
  onPick,
}: LibraryReferenceSheetProps) {
  const [query, setQuery] = useState("");

  const documents = useQuery({
    ...documentsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: open && Boolean(assistantId),
    staleTime: 30_000,
  });
  const apps = useQuery({
    ...appsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: open && Boolean(assistantId),
    staleTime: 30_000,
  });

  const items = useMemo<LibraryReference[]>(() => {
    const docs: LibraryReference[] = (documents.data?.documents ?? []).map(
      (d) => ({
        kind: "document",
        id: d.surfaceId,
        title: d.title,
        updatedAt: d.updatedAt,
        conversationId: d.conversationId,
      }),
    );
    const built: LibraryReference[] = (apps.data?.apps ?? []).map((a) => ({
      kind: "app",
      id: a.id,
      title: a.name,
      updatedAt: a.updatedAt,
    }));
    return orderForConversation([...docs, ...built], conversationId);
  }, [documents.data, apps.data, conversationId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.title.toLowerCase().includes(q));
  }, [items, query]);

  // A failed fetch is an ERROR state, never an empty one. Both queries failing
  // means we know nothing; one failing still shows the half we have, so the
  // sheet is not blanked by a partial outage.
  const bothFailed = documents.isError && apps.isError;
  const loading = documents.isLoading || apps.isLoading;

  return (
    <SheetShell open={open} onClose={onClose} label="Reference a file">
      <div style={{ padding: "4px 18px 20px" }}>
        <div
          style={{
            fontSize: 19,
            fontWeight: 700,
            letterSpacing: "-0.4px",
            color: "var(--mv3-text)",
          }}
        >
          Reference a file
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--mv3-muted)",
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          Cue names it in your message and reads it before answering.
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--mv3-card)",
            border: "1px solid var(--mv3-card-border)",
            borderRadius: 14,
            padding: "10px 14px",
            marginTop: 14,
          }}
        >
          <Search
            size={14}
            aria-hidden
            style={{ color: "var(--mv3-faint)", flexShrink: 0 }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your library…"
            aria-label="Search your library"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              // ≥16px — anything smaller focus-zooms iOS, which moves the
              // window under the sheet.
              fontSize: 16,
              color: "var(--mv3-text)",
              fontFamily: "inherit",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 14,
            maxHeight: "46vh",
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {bothFailed ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--mv3-text)",
                lineHeight: 1.55,
                padding: "18px 2px",
              }}
            >
              <span aria-hidden style={{ color: "var(--mv3-fail)" }}>
                ✕
              </span>{" "}
              I couldn&rsquo;t read your library just now.
              <button
                type="button"
                onClick={() => {
                  haptic.light();
                  void documents.refetch();
                  void apps.refetch();
                }}
                style={{
                  display: "block",
                  minHeight: 44,
                  marginTop: 4,
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--mv3-micro)",
                  fontFamily: "inherit",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
            </div>
          ) : loading ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--mv3-muted)",
                padding: "18px 2px",
              }}
            >
              Reading your library…
            </div>
          ) : visible.length === 0 ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--mv3-muted)",
                lineHeight: 1.55,
                padding: "18px 2px",
              }}
            >
              {query.trim()
                ? `Nothing in your library matches “${query.trim()}”.`
                : "Your library is empty — it fills up with the documents and apps Cue makes for you."}
            </div>
          ) : (
            visible.map((item, i) => (
              <GlassCard
                key={`${item.kind}:${item.id}`}
                radius={16}
                padding={0}
                blur={i < 6}
              >
                <button
                  type="button"
                  className="cue-pressable"
                  onClick={() => {
                    haptic.light();
                    onPick(item);
                    onClose();
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    width: "100%",
                    minHeight: 44,
                    padding: "12px 14px",
                    border: "none",
                    background: "transparent",
                    textAlign: "left",
                    fontFamily: "inherit",
                    cursor: "pointer",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 9,
                      background: "var(--mv3-btn2-bg)",
                      border: "1px solid var(--mv3-btn2-border)",
                      color: "var(--mv3-micro)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {item.kind === "document" ? (
                      <FileText size={14} aria-hidden />
                    ) : (
                      <LayoutGrid size={14} aria-hidden />
                    )}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--mv3-text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.title}
                    </span>
                    {conversationId != null &&
                    item.conversationId === conversationId ? (
                      <span
                        style={{
                          display: "block",
                          fontSize: 11,
                          color: "var(--mv3-teal-text)",
                          marginTop: 2,
                        }}
                      >
                        made in this conversation
                      </span>
                    ) : null}
                  </span>
                </button>
              </GlassCard>
            ))
          )}
        </div>
      </div>
    </SheetShell>
  );
}
