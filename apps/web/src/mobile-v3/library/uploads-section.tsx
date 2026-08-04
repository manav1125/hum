/**
 * "Things you sent · in their chats" — the Library's search-only section.
 *
 * Rendered BELOW the made-with-Cue results and visually separated from them,
 * so the header's claim ("115 things made with Cue") keeps covering only what
 * is above the rule. Every row is a door back to the thread the file lives in;
 * there is deliberately no preview and no share affordance here, because the
 * promise of the section is "it's still in your chat", not "here it is again".
 *
 * See `library-search.ts` for why a count appears only when the answer is
 * provably whole, and why a failed search renders a sentence rather than
 * nothing.
 */
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

import { mv3Mono } from "@/mobile-v3/mv3-kit";
import {
  hasUploadSection,
  UPLOADS_SECTION_LABEL,
  uploadsScopeNote,
  type UploadHit,
  type UploadSearchState,
} from "./library-search";

function sentWhen(createdAt: number, now: number): string {
  const days = Math.floor((now - createdAt) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`;
}

function UploadRow({
  hit,
  now,
  onOpen,
}: {
  hit: UploadHit;
  now: number;
  onOpen: (hit: UploadHit) => void;
}) {
  // No thread means no door. A row that cannot honour "in their chats" is
  // still shown — the file is real and the owner asked for it — but it does
  // not offer a link it cannot follow.
  const thread = hit.sourceConversation;
  const label = thread
    ? `${hit.original_filename}, in ${thread.title}`
    : hit.original_filename;

  return (
    <button
      type="button"
      aria-label={label}
      disabled={!thread}
      onClick={thread ? () => onOpen(hit) : undefined}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        width: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        padding: "7px 2px",
        cursor: thread ? "pointer" : "default",
        borderBottom: "1px solid var(--mv3-hairline)",
      }}
    >
      <span
        style={{
          fontSize: 12.5,
          color: "var(--mv3-text)",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {hit.original_filename}
      </span>
      <span
        style={{
          fontFamily: mv3Mono,
          fontSize: 9,
          color: "var(--mv3-faint)",
          flexShrink: 0,
        }}
      >
        {sentWhen(hit.created_at, now)}
      </span>
      <span
        style={{
          fontSize: 11,
          color: thread ? "var(--mv3-muted)" : "var(--mv3-faint)",
          maxWidth: 130,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {thread ? `${thread.title} ›` : "chat no longer exists"}
      </span>
    </button>
  );
}

export function UploadsSection({
  state,
  now,
  onNavigate,
}: {
  state: UploadSearchState;
  now: number;
  /** Called before navigating, so a sheet can close itself first. */
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  if (!hasUploadSection(state)) return null;

  const note = uploadsScopeNote(state);
  const rows = state.status === "whole" ? state.rows : [];

  const open = (hit: UploadHit) => {
    const id = hit.sourceConversation?.id;
    if (!id) return;
    onNavigate?.();
    void navigate(routes.conversation(id));
  };

  return (
    <div
      style={{
        marginTop: 18,
        paddingTop: 14,
        // The rule IS the separation design asked for: everything above it is
        // "made with Cue", everything below it is not.
        borderTop: "1px solid var(--mv3-hairline)",
      }}
    >
      <div
        style={{
          fontFamily: mv3Mono,
          fontSize: 8.5,
          letterSpacing: "0.11em",
          textTransform: "uppercase",
          color: "var(--mv3-faint)",
          padding: "0 2px 7px",
        }}
      >
        {UPLOADS_SECTION_LABEL}
      </div>

      {state.status === "failed" ? (
        /* An outage says so. It must never read as "you sent nothing". */
        <div
          style={{
            fontSize: 12,
            color: "var(--mv3-fail-text)",
            lineHeight: 1.5,
            padding: "0 2px",
          }}
        >
          {note}
        </div>
      ) : (
        <>
          {rows.map((hit) => (
            <UploadRow key={hit.id} hit={hit} now={now} onOpen={open} />
          ))}
          {note ? (
            <div
              style={{
                fontSize: 11,
                color: "var(--mv3-faint)",
                lineHeight: 1.5,
                padding: "8px 2px 0",
              }}
            >
              {note}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
