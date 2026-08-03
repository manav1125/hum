/**
 * K4 · Search — pull down from any screen.
 *
 * "Desktop's ⌘K, phone-shaped: pull down from any screen." The gesture is the
 * spec, not the field: search that lives behind a magnifier in a corner is
 * search you have to go to, and the reach audit says the top corners are where
 * escapes live, not primaries.
 *
 * TWO PLACES THIS DELIBERATELY DIVERGES FROM THE DRAWN FRAME, BOTH BECAUSE THE
 * FRAME ASSUMES DATA THE PLATFORM DOES NOT HAVE:
 *
 * 1. **The answer card.** The frame shows "CUE'S ANSWER — 24 months at $47/seat
 *    … 3 sources · 1 decision". There is no answer endpoint; producing that
 *    text means running a model turn, which is a real spend, started by typing
 *    rather than by asking. So a question gets an ANSWER-FIRST AFFORDANCE — the
 *    top row, one tap, seeds a thread with the question — and the typed list
 *    below it. What is never rendered is an answer-shaped card with nothing
 *    behind it.
 *
 * 2. **Decision records.** Not in the index (see `search-source.ts`). The
 *    surface says so in one line instead of dressing a memory up as one.
 *
 * Everything else is the frame: the field at the top, the typed list, the
 * category counts, provenance on every row.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";

import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import {
  DECISIONS_NOT_INDEXED,
  looksLikeQuestion,
  searchFromPhone,
  type SearchOutcome,
  type SearchResult,
  type SearchResultKind,
} from "./search-source";

/** How far a downward drag from the top must travel to open search. */
export const PULL_SEARCH_THRESHOLD_PX = 88;

/**
 * A fresh draft conversation id — a plain UUID, mirroring
 * `domains/chat/utils/conversation-selection.createDraftConversationId` and
 * inlined for the same reason the Intelligence and Library surfaces inline it:
 * mobile-v3 stays free of a cross-domain import into chat (CONVENTIONS.md).
 */
function newDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const KIND_GLYPH: Record<SearchResultKind, string> = {
  conversation: "◍",
  memory: "✦",
  schedule: "◷",
  contact: "◉",
  decision: "◈",
};

/**
 * Does this drag mean "open search"? Pure so the discrimination is testable.
 * Only a drag that starts at the very top of an unscrolled surface counts —
 * otherwise every pull-to-refresh and every scroll-up would open it.
 */
export function isPullDownForSearch(input: {
  startY: number;
  endY: number;
  deltaX: number;
  scrollTop: number;
}): boolean {
  if (input.scrollTop > 0) return false;
  const dy = input.endY - input.startY;
  if (dy < PULL_SEARCH_THRESHOLD_PX) return false;
  return dy > Math.abs(input.deltaX) * 1.6;
}

/* ------------------------------ the gesture ------------------------------ */

function usePullDownToOpen(onOpen: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number; scrollTop: number } | null = null;

    const scrollTopOf = (target: EventTarget | null): number => {
      let node = target instanceof HTMLElement ? target : null;
      while (node) {
        if (node.scrollTop > 0) return node.scrollTop;
        node = node.parentElement;
      }
      return 0;
    };

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      start = {
        x: touch.clientX,
        y: touch.clientY,
        scrollTop: scrollTopOf(e.target),
      };
    };
    const onEnd = (e: TouchEvent) => {
      const from = start;
      start = null;
      const touch = e.changedTouches[0];
      if (!from || !touch) return;
      if (
        !isPullDownForSearch({
          startY: from.y,
          endY: touch.clientY,
          deltaX: touch.clientX - from.x,
          scrollTop: from.scrollTop,
        })
      )
        return;
      void haptic.light();
      onOpen();
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, [onOpen, enabled]);
}

/* ------------------------------ the overlay ------------------------------ */

export function Mv3PullSearch({ enabled = true }: { enabled?: boolean }) {
  const [open, setOpen] = useState(false);
  usePullDownToOpen(
    useCallback(() => setOpen(true), []),
    enabled && !open,
  );

  if (!open) return null;
  const host = document.getElementById("viewport-overlays") ?? document.body;
  return createPortal(<SearchOverlay onClose={() => setOpen(false)} />, host);
}

export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [searching, setSearching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setOutcome(null);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setSearching(true);
    const timer = setTimeout(() => {
      void searchFromPhone(assistantId, trimmed, {
        signal: controller.signal,
      }).then((next) => {
        if (controller.signal.aborted) return;
        // A superseded keystroke never searched. Painting it would either blank
        // the list or claim nothing matched — both are lies about a request
        // that never asked. Leave the last real outcome where it is.
        if (next.status === "cancelled") return;
        setOutcome(next);
        setSearching(false);
      });
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, assistantId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const question = looksLikeQuestion(query);

  const askCue = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    void haptic.medium();
    // The same seam "Teach Cue something" uses: park the text on the pending
    // deep-link store, mint a fresh draft thread, navigate. A PREFILL, not an
    // auto-send — the user presses send, so nothing spends on a keystroke.
    usePendingDeepLinkStore.getState().setPendingComposerMessage(trimmed);
    const draftId = newDraftConversationId();
    useConversationStore.getState().setActiveConversationId(draftId);
    onClose();
    void navigate(routes.conversation(draftId));
  };

  return (
    <div
      data-mv3
      data-mv3-state="search"
      role="dialog"
      aria-label="Search"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
      }}
    >
      <div style={{ padding: "10px 16px", flexShrink: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            background: "var(--mv3-card)",
            border: "1.5px solid var(--mv3-teal)",
            borderRadius: 17,
            padding: "4px 6px 4px 13px",
          }}
        >
          <span aria-hidden style={{ color: "var(--mv3-teal-text)", fontSize: 13 }}>
            ⌕
          </span>
          <input
            autoFocus
            aria-label="Search your Cue"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your Cue"
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 40,
              border: "none",
              background: "transparent",
              color: "var(--mv3-text)",
              fontSize: 16,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            style={{
              minWidth: 40,
              minHeight: 40,
              border: "none",
              background: "none",
              color: "var(--mv3-muted)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "2px 16px 24px" }}>
        {/* Answer-first: for a question, the top row is the ask. */}
        {question ? (
          <button
            type="button"
            onClick={askCue}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: "var(--mv3-card)",
              border: "1px solid var(--mv3-card-border)",
              borderRadius: 16,
              padding: "14px 15px",
              fontFamily: "inherit",
              color: "var(--mv3-text)",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                fontFamily: "var(--mv3-mono)",
                fontSize: 8.5,
                letterSpacing: ".1em",
                color: "var(--mv3-accent-text)",
              }}
            >
              ASK CUE
            </span>
            <span
              style={{
                display: "block",
                fontSize: 13,
                lineHeight: 1.5,
                marginTop: 8,
              }}
            >
              “{query.trim()}” — I&apos;ll answer from what I know and show my
              sources.
            </span>
          </button>
        ) : null}

        <Body
          query={query}
          searching={searching}
          outcome={outcome}
          onOpenResult={() => onClose()}
        />
      </div>

      <p
        style={{
          flexShrink: 0,
          margin: 0,
          padding: "0 16px 12px",
          fontSize: 10.5,
          textAlign: "center",
          color: "var(--mv3-muted)",
        }}
      >
        Pull down from any screen to search
      </p>
    </div>
  );
}

function Body({
  query,
  searching,
  outcome,
  onOpenResult,
}: {
  query: string;
  searching: boolean;
  outcome: SearchOutcome | null;
  onOpenResult: () => void;
}) {
  if (query.trim().length < 2) {
    return (
      <Note>
        Type at least two characters. I search your conversations, memories,
        schedules and people. {DECISIONS_NOT_INDEXED}
      </Note>
    );
  }

  // Online, and something IS in flight — so a progress line is honest here.
  // (The offline state is the one where it never is.)
  if (searching && !outcome) return <Note>Searching…</Note>;
  if (!outcome) return null;

  if (outcome.status === "error") {
    // Cue reports its own errors first, verbatim, first person. Red is for this.
    return (
      <div
        role="alert"
        style={{
          background: "var(--mv3-fail-card-bg)",
          border: "1px solid var(--mv3-fail-card-border)",
          borderRadius: 15,
          padding: "13px 14px",
          marginTop: 10,
          display: "flex",
          gap: 9,
        }}
      >
        <span aria-hidden style={{ color: "var(--mv3-fail)", fontSize: 12 }}>
          !
        </span>
        <span
          style={{
            fontSize: 12.5,
            lineHeight: 1.55,
            color: "var(--mv3-fail-text)",
          }}
        >
          {outcome.message}
        </span>
      </div>
    );
  }

  if (outcome.status === "unavailable") return <Note>{outcome.message}</Note>;

  // Never stored (see the `.then` guard) — narrowed here so the union stays
  // exhaustive and a future status can't slip through as "no results".
  if (outcome.status === "cancelled") return <Note>Searching…</Note>;

  if (outcome.results.length === 0) {
    return (
      <Note>
        Nothing matched “{outcome.query}”. I searched conversations, memories,
        schedules and people — {DECISIONS_NOT_INDEXED}
      </Note>
    );
  }

  const counts = countByKind(outcome.results);

  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 5,
          marginTop: 12,
          flexWrap: "wrap",
        }}
      >
        <Count label={`All · ${outcome.results.length}`} active />
        {counts.map(([kind, n]) => (
          <Count key={kind} label={`${KIND_LABEL[kind]} · ${n}`} />
        ))}
      </div>

      <div
        style={{
          background: "var(--mv3-card)",
          border: "1px solid var(--mv3-card-border)",
          borderRadius: 15,
          marginTop: 10,
          overflow: "hidden",
        }}
      >
        {outcome.results.map((result, i) => (
          <Row
            key={result.id}
            result={result}
            last={i === outcome.results.length - 1}
            onOpen={onOpenResult}
          />
        ))}
      </div>

      <Note>{DECISIONS_NOT_INDEXED}</Note>
    </>
  );
}

const KIND_LABEL: Record<SearchResultKind, string> = {
  conversation: "Messages",
  memory: "Memory",
  schedule: "Schedules",
  contact: "People",
  decision: "Decisions",
};

function countByKind(results: SearchResult[]): Array<[SearchResultKind, number]> {
  const counts = new Map<SearchResultKind, number>();
  for (const r of results) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return [...counts.entries()];
}

function Count({ label, active }: { label: string; active?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: active ? 600 : 400,
        color: active ? "var(--mv3-bg)" : "var(--mv3-muted)",
        background: active ? "var(--mv3-text)" : "var(--mv3-card)",
        border: active ? "none" : "1px solid var(--mv3-card-border)",
        borderRadius: 99,
        padding: "5px 11px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function Row({
  result,
  last,
  onOpen,
}: {
  result: SearchResult;
  last: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        void haptic.light();
        onOpen();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        minHeight: 48,
        textAlign: "left",
        background: "none",
        border: "none",
        borderBottom: last ? undefined : "1px solid var(--mv3-line)",
        padding: "11px 13px",
        fontFamily: "inherit",
        color: "var(--mv3-text)",
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          borderRadius: 6,
          background: "var(--mv3-btn2-bg)",
          color: "var(--mv3-muted)",
          fontSize: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {KIND_GLYPH[result.kind]}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12, fontWeight: 600 }}>
          {result.title}
        </span>
        {/* Provenance on every row: where it came from, always. */}
        <span
          style={{
            display: "block",
            fontSize: 9.5,
            color: "var(--mv3-muted)",
            marginTop: 1,
          }}
        >
          {result.meta}
        </span>
      </span>
    </button>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: "14px 0 0",
        fontSize: 11.5,
        lineHeight: 1.6,
        color: "var(--mv3-muted)",
        textAlign: "center",
      }}
    >
      {children}
    </p>
  );
}
