/**
 * MobileDocumentOverlay — the mobile v3 doc-from-chat screen (spec frame 38).
 *
 * Full-screen overlay hosting a document referenced from chat. The design
 * decision on frame 38: mobile edits are CONVERSATIONAL — the doc renders as
 * a read-only paper preview; the user selects a region and tells Cue the
 * change (typed instruction or quick chips), and the edit submits as a normal
 * chat turn in the document's conversation (the `?prompt=` auto-send path the
 * comment-feedback flow already uses). No cursor-level editor on the phone;
 * an always-present "Continue on desktop" handoff row covers deep work.
 *
 * Frame-38 chrome (inline styles are the spec): dark header (‹ · title ·
 * Share), light paper canvas (#E9EBF0 with a white card), and a dark glass
 * edit panel: focused instruction field, quick chips, the desktop-handoff
 * row. Share is real — it drives the existing `documentsByIdPdfGet` export.
 * The handoff is a share/copy of the doc's own URL (`routes.document`) — no
 * presence claim (the frame's "already open there" is softened to what's
 * true: the same doc at the same link).
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */

import { lazy, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { ArrowUp, ChevronLeft, Loader2 } from "lucide-react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { documentsByIdPdfGet } from "@/generated/daemon/sdk.gen";
import type { OpenedDocumentState } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

// Same lazy split the desktop viewer uses — Tiptap is ~600 kB.
const TiptapDocumentEditor = lazy(() =>
  import("./tiptap-document-editor").then((m) => ({
    default: m.TiptapDocumentEditor,
  })),
);

/** Quick edit chips (frame 38 — content-specific middle chip generalized). */
const EDIT_CHIPS = ["Shorter", "Add detail", "Fix numbers"] as const;

/** Cap the quoted selection so the prompt stays readable. */
const MAX_QUOTE_CHARS = 400;

/**
 * Light paper variables for the preview card: the Tiptap styles read the
 * design-library semantic tokens, so rebinding them locally renders the doc
 * as frame 38's white paper regardless of the app theme.
 */
const PAPER_VARS: React.CSSProperties = {
  ["--content-default" as string]: "#1A2230",
  ["--content-secondary" as string]: "#4A5568",
  ["--content-tertiary" as string]: "#5A6672",
  ["--border-base" as string]: "#D7DDE7",
  ["--surface-base" as string]: "#F2F3F7",
};

interface MobileDocumentOverlayProps {
  /** When `null`, the overlay renders nothing. */
  openedDocumentState: OpenedDocumentState | null;
  /** Resolved assistant id used for the PDF export. */
  assistantId: string | null;
  /** Closes the overlay (resets `openedDocumentState` upstream). */
  onClose: () => void;
}

export function MobileDocumentOverlay({
  openedDocumentState,
  assistantId,
  onClose,
}: MobileDocumentOverlayProps) {
  if (!openedDocumentState || !assistantId) return null;
  return (
    <MobileDocumentV3
      // Remount per document so selection/draft state can't leak across docs.
      key={openedDocumentState.surfaceId}
      doc={openedDocumentState}
      assistantId={assistantId}
      onClose={onClose}
    />
  );
}

function MobileDocumentV3({
  doc,
  assistantId,
  onClose,
}: {
  doc: OpenedDocumentState;
  assistantId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  const [editText, setEditText] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const desktopUrl = useMemo(
    () => `${window.location.origin}${routes.document(doc.surfaceId)}`,
    [doc.surfaceId],
  );

  // ── Selection → quoted context. Tiptap fires onTextSelect on any DOM
  // selection inside the (read-only) editor; we keep only the text.
  const handleTextSelect = useCallback(
    (sel: { text: string } | null) => {
      if (sel === null) {
        // Collapsing the selection keeps the last quote (tapping the input
        // collapses it); the chip's ✕ is the explicit clear.
        return;
      }
      const text = sel.text.trim();
      if (text) {
        haptic.light();
        setSelection(text);
      }
    },
    [],
  );

  // ── Submit — a normal chat turn in the doc's conversation, prefixed with
  // the doc + quoted-selection context. `?prompt=` auto-sends on arrival
  // (use-auto-send-effects), so this closes the overlay and lands the user
  // in the thread watching the edit run.
  const handleSubmit = useCallback(() => {
    const instruction = editText.trim();
    if (!instruction) return;
    haptic.medium();
    const quote = selection
      ? selection.length > MAX_QUOTE_CHARS
        ? `${selection.slice(0, MAX_QUOTE_CHARS)}…`
        : selection
      : null;
    const prompt = quote
      ? `Edit the document "${doc.documentName}". About this passage:\n> ${quote.replace(/\n/g, "\n> ")}\n\n${instruction}`
      : `Edit the document "${doc.documentName}": ${instruction}`;
    navigate(
      `${routes.conversation(doc.conversationId)}?prompt=${encodeURIComponent(prompt)}`,
    );
    onClose();
  }, [editText, selection, doc.documentName, doc.conversationId, navigate, onClose]);

  const handleChip = useCallback((label: string) => {
    haptic.light();
    setEditText((prev) => (prev.trim().length > 0 ? prev : label));
  }, []);

  // ── Share — the real PDF export path (documentsByIdPdfGet), offered via
  // the native share sheet when the platform supports sharing files,
  // otherwise a plain download.
  const handleShare = useCallback(async () => {
    if (exporting) return;
    haptic.light();
    setExporting(true);
    try {
      const { data: blob, response } = await documentsByIdPdfGet({
        path: { assistant_id: assistantId, id: doc.surfaceId },
        throwOnError: false,
        parseAs: "blob",
      });
      if (!response?.ok || !blob) return;
      const filename = `${doc.documentName || "document"}.pdf`;
      const file = new File([blob], filename, { type: "application/pdf" });
      if (
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({ files: [file], title: doc.documentName });
      } else {
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), {
          href: url,
          download: filename,
        });
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      // Share sheet dismissed or export unavailable — quiet no-op.
    } finally {
      setExporting(false);
    }
  }, [exporting, assistantId, doc.surfaceId, doc.documentName]);

  // ── Desktop handoff — share/copy the doc's own URL. No presence claims.
  const handleHandoff = useCallback(async () => {
    haptic.light();
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: doc.documentName, url: desktopUrl });
        return;
      }
    } catch {
      // Share dismissed — fall through to copy.
    }
    try {
      await navigator.clipboard.writeText(desktopUrl);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Clipboard unavailable — nothing further to offer.
    }
  }, [doc.documentName, desktopUrl]);

  const canSend = editText.trim().length > 0;

  return (
    <div
      data-mv3
      className="fixed inset-x-0 bottom-0 z-30 h-[100dvh]"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
      }}
    >
      {/* HEADER — ‹ · title/meta · Share (frame 38). */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 20px 8px",
        }}
      >
        <button
          type="button"
          onClick={() => {
            haptic.light();
            onClose();
          }}
          aria-label="Close document"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 44,
            height: 44,
            border: "none",
            background: "transparent",
            color: "var(--mv3-micro)",
            cursor: "pointer",
            padding: 0,
            marginLeft: -14,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <ChevronLeft size={22} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {doc.documentName}
          </div>
          <div style={{ fontSize: 11, color: "var(--mv3-muted)" }}>
            doc · select text to quote it
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleShare()}
          disabled={exporting}
          aria-label="Share document as PDF"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minHeight: 44,
            padding: "0 4px",
            border: "none",
            background: "transparent",
            color: "var(--mv3-micro)",
            fontSize: 13,
            fontFamily: "inherit",
            cursor: exporting ? "default" : "pointer",
            flexShrink: 0,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          {exporting ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : null}
          Share
        </button>
      </div>

      {/* PAPER PREVIEW — light canvas + white card (frame 38), read-only
          Tiptap render of the real content; selection feeds the quote chip. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: "#E9EBF0",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: "14px 18px",
            background: "#FFFFFF",
            borderRadius: 10,
            boxShadow: "0 20px 50px -20px rgba(23,23,28,.4)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            ...PAPER_VARS,
          }}
        >
          <LazyBoundary
            fallback={
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Loader2
                  size={20}
                  className="animate-spin"
                  style={{ color: "#5A6672" }}
                />
              </div>
            }
          >
            <TiptapDocumentEditor
              content={doc.content}
              editable={false}
              onTextSelect={handleTextSelect}
              className="h-full min-h-0 flex-1"
            />
          </LazyBoundary>
        </div>
      </div>

      {/* EDIT PANEL — instruction field · chips · desktop handoff (frame 38). */}
      <div
        style={{
          flexShrink: 0,
          background: "rgba(22,26,36,.96)",
          borderTop: "1px solid rgba(255,255,255,.1)",
          backdropFilter: "blur(28px)",
          WebkitBackdropFilter: "blur(28px)",
          padding: "12px 18px 0",
          paddingBottom:
            "calc(10px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
        }}
      >
        {/* Quoted selection → sent with the edit. */}
        {selection ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              marginBottom: 9,
              padding: "8px 12px",
              background: "rgba(61,110,232,.1)",
              border: "1px solid rgba(61,110,232,.3)",
              borderRadius: 12,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                fontStyle: "italic",
                color: "#C7D6F5",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              &ldquo;{selection}&rdquo;
            </span>
            <button
              type="button"
              onClick={() => {
                haptic.light();
                setSelection(null);
              }}
              aria-label="Clear quoted selection"
              style={{
                flexShrink: 0,
                minWidth: 32,
                minHeight: 32,
                border: "none",
                background: "transparent",
                color: "var(--mv3-muted)",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              ✕
            </button>
          </div>
        ) : null}

        {/* Instruction field (frame 38's focused input). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "rgba(255,255,255,.06)",
            border: "1.5px solid #3D6EE8",
            borderRadius: 16,
            padding: "4px 6px 4px 15px",
            boxShadow: "0 0 0 3px rgba(61,110,232,.12)",
          }}
        >
          <input
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Make this paragraph two sentences"
            aria-label="Describe the edit"
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--mv3-text)",
              // ≥16px (build rules): prevents iOS focus-zoom.
              fontSize: 16,
              fontFamily: "inherit",
              padding: "10px 0",
            }}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSend}
            aria-label="Send edit to Cue"
            style={{
              width: 44,
              height: 44,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: canSend ? "pointer" : "default",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: canSend
                  ? "var(--mv3-accent-fill-gradient)"
                  : "var(--mv3-btn2-bg)",
                color: canSend ? "#fff" : "var(--mv3-muted)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: canSend
                  ? "0 8px 18px -6px rgba(61,110,232,.6)"
                  : "none",
                opacity: canSend ? 1 : 0.55,
              }}
            >
              <ArrowUp size={16} aria-hidden />
            </span>
          </button>
        </div>

        {/* Quick chips (frame 38). */}
        <div style={{ display: "flex", gap: 7, marginTop: 9, overflow: "hidden" }}>
          {EDIT_CHIPS.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => handleChip(label)}
              style={{
                fontSize: 11.5,
                color: "var(--mv3-muted)",
                background: "rgba(255,255,255,.06)",
                border: "1px solid rgba(255,255,255,.09)",
                borderRadius: 99,
                padding: "0 12px",
                minHeight: 44,
                whiteSpace: "nowrap",
                fontFamily: "inherit",
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Desktop handoff — ALWAYS present (frame 38); copy softened to the
            truth: same doc, same link, no presence claim. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            margin: "11px 0 2px",
            padding: "10px 13px",
            background: "rgba(61,110,232,.1)",
            border: "1px solid rgba(61,110,232,.3)",
            borderRadius: 13,
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#7FA3F2"
            strokeWidth="1.8"
            aria-hidden
          >
            <rect x="2" y="5" width="20" height="13" rx="2" />
            <path d="M8 21h8" />
          </svg>
          <span style={{ fontSize: 12, color: "#C7D6F5", flex: 1, minWidth: 0 }}>
            Deep editing? <b>Continue on desktop</b> — same doc at this link
          </span>
          <button
            type="button"
            onClick={() => void handleHandoff()}
            style={{
              flexShrink: 0,
              minHeight: 44,
              padding: "0 4px",
              border: "none",
              background: "transparent",
              color: "var(--mv3-micro)",
              fontSize: 12,
              fontFamily: "inherit",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {linkCopied ? "Link copied ✓" : "Send link ›"}
          </button>
        </div>
      </div>
    </div>
  );
}
