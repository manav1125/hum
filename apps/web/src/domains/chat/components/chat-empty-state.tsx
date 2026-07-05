import { type ReactNode } from "react";

import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

// Theme-aware tokens pointing at the shipped `--mv1-*` CSS-variable system so
// light + dark both resolve. Defined locally to respect the cross-domain
// import boundary (chat must not import from domains/activity).
const C = {
  ink: "var(--mv1-t1)",
  blueS: "var(--mv1-blue-strong)",
} as const;
const serif = "'Instrument Serif', Georgia, serif";

/**
 * Empty-state hero for a fresh chat: optional avatar and greeting headline.
 * Presentational only — the composer and conversation-starter chips are
 * rendered by the parent `ChatBody` in the same flex column so that
 * greeting → composer → starters appear as one vertically-centered group.
 *
 * Restyled to the shipped HQ design language (Cue-Surfaces S6): an editorial
 * Instrument Serif greeting whose closing question is set in an accent italic,
 * over the theme-aware `C.*` tokens so light + dark both read correctly.
 *
 * Centering and overflow handling live on `ChatBody`'s outer container
 * (`justify-content: safe center` + `overflow-y-auto`), not here. This
 * component just renders its content at natural height.
 *
 * See [React — Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state)
 * for why the composer must stay at a fixed tree position rather than
 * being passed as a slot into this component.
 */
export interface ChatEmptyStateProps {
  /** Greeting headline. Defaults to {@link DEFAULT_EMPTY_STATE_GREETING}. */
  greeting?: string;
  /**
   * Optional avatar rendered above the greeting on mobile, or to its left on
   * desktop. Caller passes a
   * `<ChatAvatar … size={40} interactive />` when avatar data is available;
   * omit the slot to render greeting-only.
   */
  avatarSlot?: ReactNode;
}

/**
 * Splits a greeting into a lead-in and a closing clause so the closing clause
 * (usually the question) can render in the accent serif italic — the S6
 * "Been looking forward to this. *What should we get moving?*" treatment.
 * Falls back to the whole string as the lead-in when no split point is found.
 */
function splitGreeting(greeting: string): { lead: string; tail: string } {
  const trimmed = greeting.trim();
  // Prefer splitting after the first sentence terminator that has more text
  // following it (so a single trailing "?" doesn't strand an empty tail).
  const match = trimmed.match(/^(.*?[.!?])\s+(\S.*)$/);
  if (match && match[2]) return { lead: match[1], tail: match[2] };
  return { lead: trimmed, tail: "" };
}

export function ChatEmptyState({
  greeting = DEFAULT_EMPTY_STATE_GREETING,
  avatarSlot,
}: ChatEmptyStateProps) {
  const { lead, tail } = splitGreeting(greeting);
  const headline = (
    <span style={{ fontFamily: serif, letterSpacing: "-0.2px", color: C.ink }}>
      {lead}
      {tail ? (
        <>
          {" "}
          <span style={{ fontStyle: "italic", color: C.blueS }}>{tail}</span>
        </>
      ) : null}
    </span>
  );

  return (
    <div className="py-8">
      <div className="mx-auto w-full max-w-[var(--chat-max-width)] px-3 sm:px-6">
        <div className="flex flex-col items-center justify-center gap-3 md:flex-row md:items-center">
          {avatarSlot}
          <span
            className="text-center leading-tight md:hidden"
            style={{ fontSize: 25 }}
          >
            {headline}
          </span>
          <span
            className="hidden leading-tight md:inline"
            style={{ fontSize: 30 }}
          >
            {headline}
          </span>
        </div>
      </div>
    </div>
  );
}
