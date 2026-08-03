/**
 * K3 · Day one — the first screen an alpha user meets.
 *
 * Design: "No tour, no empty deck. ONE QUESTION THAT PRODUCES YOUR FIRST THING
 * without using the word — four chips or your own words. The footer is honest
 * that connectors haven't happened, and sequences them AFTER the first real
 * answer rather than before it."
 *
 * Three things that look like decoration and are not:
 *
 * 1. **No empty deck.** A zero-state list with "no items yet" teaches a new
 *    user that Cue is a container they have to fill. The question teaches that
 *    Cue is something you ask. There is no list on this screen at all.
 *
 * 2. **The chips never say "work item", "task" or "project".** Design's phrase
 *    is "without using the word". A first-run user has no model of Cue's nouns
 *    yet, and borrowing one is how a product feels like admin.
 *
 * 3. **Connectors come after.** The footer states the current truth — nothing
 *    is connected — and points forward. Asking for inbox access before Cue has
 *    done a single useful thing is the ask most alpha users decline.
 *
 * The answer is handed to `onAnswer` verbatim. It is NEVER auto-sent from
 * inside this component: the caller seeds a fresh thread with it, the user
 * presses send. A first screen that fires a model turn off a chip tap is a
 * screen that can spend money before anyone has agreed to anything.
 */
import { useRef, useState } from "react";

import { CueRing } from "@/mobile-v3/cue-ring";
import { haptic } from "@/utils/haptics";

export interface DayOneChip {
  glyph: string;
  label: string;
}

export const DAY_ONE_CHIPS: readonly DayOneChip[] = [
  { glyph: "💼", label: "Close a deal I'm working on" },
  { glyph: "💰", label: "Raise money" },
  { glyph: "🚀", label: "Ship something" },
  { glyph: "📥", label: "Get on top of my inbox" },
] as const;

export function DayOneState({
  name,
  onAnswer,
  chips = DAY_ONE_CHIPS,
}: {
  /** Only a real given name. `null` greets without one rather than inventing. */
  name?: string | null;
  onAnswer: (answer: string) => void;
  chips?: readonly DayOneChip[];
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const answer = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // `.medium` — this hands work off. The haptic map reserves `.light` for
    // selection, and choosing what Cue does first is not a selection.
    void haptic.medium();
    onAnswer(trimmed);
  };

  return (
    <div
      data-mv3
      data-mv3-state="day-one"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 20px",
          overflowY: "auto",
        }}
      >
        {/* The mark, once. Decoration — the greeting below carries the meaning
            — but it is the only thing on this screen that says whose app this
            is, and day one is the one moment that matters. */}
        <div
          aria-hidden
          style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}
        >
          <CueRing size={36} stroke="var(--mv3-text)" />
        </div>

        <h1
          style={{
            margin: 0,
            fontSize: 27,
            lineHeight: 1.18,
            fontWeight: 600,
            letterSpacing: "-.02em",
            textAlign: "center",
          }}
        >
          {name ? `Hello ${name}.` : "Hello."}
          <br />
          Let&apos;s start with one thing.
        </h1>
        <p
          style={{
            margin: "12px 0 0",
            fontSize: 12.5,
            lineHeight: 1.55,
            color: "var(--mv3-muted)",
            textAlign: "center",
          }}
        >
          Tell me something you&apos;re trying to get done — I&apos;ll take it
          from there.
        </p>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 7,
            marginTop: 22,
          }}
        >
          {chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={() => answer(chip.label)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                minHeight: 46,
                fontSize: 12.5,
                fontFamily: "inherit",
                textAlign: "left",
                color: "var(--mv3-text)",
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 14,
                padding: "12px 14px",
                cursor: "pointer",
              }}
            >
              <span aria-hidden style={{ fontSize: 13, flexShrink: 0 }}>
                {chip.glyph}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{chip.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* The composer sits bottom-anchored — the primary is inside the bottom
          third, per the reach rule, and it is the same shape the rest of the
          app's composer is so this screen teaches the real gesture. */}
      <form
        style={{ flexShrink: 0, padding: "10px 18px 9px" }}
        onSubmit={(e) => {
          e.preventDefault();
          answer(typed);
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--mv3-card)",
            border: "1.5px solid var(--mv3-accent)",
            borderRadius: 19,
            padding: "4px 6px 4px 15px",
          }}
        >
          <input
            ref={inputRef}
            aria-label="Tell Cue what you're trying to get done"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="…or say it in your own words"
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              border: "none",
              background: "transparent",
              color: "var(--mv3-text)",
              // 16px minimum or iOS Safari zooms the whole screen on focus.
              fontSize: 16,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
          <button
            type="submit"
            aria-label="Start"
            disabled={!typed.trim()}
            style={{
              width: 38,
              height: 38,
              flexShrink: 0,
              borderRadius: "50%",
              border: "none",
              background: typed.trim()
                ? "var(--mv3-accent)"
                : "var(--mv3-track)",
              color: typed.trim() ? "#FFFFFF" : "var(--mv3-muted)",
              fontSize: 15,
              cursor: typed.trim() ? "pointer" : "default",
            }}
          >
            ↑
          </button>
        </div>
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 10.5,
            textAlign: "center",
            color: "var(--mv3-muted)",
          }}
        >
          Nothing&apos;s connected yet —{" "}
          <span style={{ color: "var(--mv3-accent-text)" }}>that comes next</span>
        </p>
      </form>
    </div>
  );
}
