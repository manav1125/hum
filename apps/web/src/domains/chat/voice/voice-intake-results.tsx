/**
 * VoiceIntakeResults — the live-transcription card + captured action-item chips
 * for the Voice surface (DESIGN-SPEC "/Users/manavgupta/Downloads/Cue-Surfaces.html"
 * §S2 "Voice").
 *
 * The S2 mock draws, under the aperture orb, a translucent card with a mono
 * "HEARING YOU…" eyebrow, the transcript, and — on a hairline-divided row — the
 * action-item chips Cue extracted: "✉ Reply drafted → ⟡ <tag>", "◷ Task queued →
 * ⟡ <tag>". This component renders that card from the **real**
 * {@link import("./voice-intake-api").VoiceIntakeResponse} the daemon returns
 * (summary + action items + the executable work items it minted), so the chips
 * reflect work that actually landed — not decoration.
 *
 * Each chip's primary action is wired to the existing execution path:
 *  - The card is anchored on the freshly-created voice thread; tapping it (or the
 *    "Open thread" affordance) navigates into that conversation — where Cue has
 *    already written the read-back + numbered action items and is offering to
 *    start.
 *  - The "Task queued" chips open Activity (the queued work items live there,
 *    tagged `voice`), the same surface the assistant message points at.
 *
 * ⟡ tag: the daemon tags every minted work item `voice` but does not yet file
 * them onto a specific mission/project, so there is no per-item mission id to
 * show. We use the derived thread title as the ⟡ tag (the closest real handle
 * the response carries). When action-item → mission linkage lands server-side,
 * swap `tag` for the returned mission/project name with no layout churn.
 *
 * Presentational only — it owns no session state and issues no network calls;
 * navigation is delegated to the caller so the surface keeps the single
 * navigation owner.
 */

import { CalendarClock, Mail } from "lucide-react";

import type { VoiceIntakeResponse } from "@/domains/chat/voice/voice-intake-api";

const mono = "'DM Mono', ui-monospace, monospace";

// S2 ink-panel palette (spec literals). The Voice surface is intentionally a
// dark surface, so these are fixed rather than themed — matching the sibling
// {@link import("./voice-mode-surface").VoiceModeSurface} constants.
const CARD_BG = "rgba(255,255,255,.06)";
const CARD_LINE = "rgba(255,255,255,.1)";
const DIVIDER = "rgba(255,255,255,.08)";
const EYEBROW = "rgba(255,255,255,.4)";
const TRANSCRIPT = "#DCE4F2";
const BLUE_CHIP_FG = "#9DB8F4";
const BLUE_CHIP_BG = "rgba(91,134,240,.14)";
const TEAL_CHIP_FG = "#8FD0C8";
const TEAL_CHIP_BG = "rgba(14,140,140,.16)";
const TEAL_BADGE = "#0E8C8C";

/** A single captured-action chip: icon · label · "→ ⟡ tag". */
function ActionChip({
  icon,
  label,
  tag,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tag: string;
  tone: "blue" | "teal";
  onClick: () => void;
}) {
  const fg = tone === "blue" ? BLUE_CHIP_FG : TEAL_CHIP_FG;
  const bg = tone === "blue" ? BLUE_CHIP_BG : TEAL_CHIP_BG;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        color: fg,
        background: bg,
        border: "none",
        borderRadius: 7,
        padding: "5px 10px",
        cursor: "pointer",
        fontFamily: "'DM Sans', sans-serif",
        lineHeight: 1.3,
        textAlign: "left",
      }}
    >
      <span aria-hidden style={{ display: "inline-flex", flexShrink: 0 }}>
        {icon}
      </span>
      {label}
      {" → "}
      <b style={{ fontWeight: 600 }}>⟡ {tag}</b>
    </button>
  );
}

/** The teal square badge that leads the "Task queued" chip in the mock. */
function QueuedBadge() {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        width: 14,
        height: 14,
        borderRadius: 4,
        background: TEAL_BADGE,
        color: "#fff",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <CalendarClock size={9} />
    </span>
  );
}

export interface VoiceIntakeResultsProps {
  /** The structured intake the daemon returned for the just-spoken transcript. */
  result: VoiceIntakeResponse;
  /** What the user actually said (the local transcript we captured). */
  transcript: string;
  /** A short ⟡ tag for the chips (the derived thread title). */
  tag: string;
  /** Open the created voice thread (Cue's read-back + queued action items). */
  onOpenThread: () => void;
  /** Open Activity, where the queued work items live (tagged `voice`). */
  onOpenActivity: () => void;
}

export function VoiceIntakeResults({
  result,
  transcript,
  tag,
  onOpenThread,
  onOpenActivity,
}: VoiceIntakeResultsProps) {
  const items = result.actionItems ?? [];
  // Work items the daemon actually minted (Activity → Cued). The first item is
  // typically the reply/first-move; the rest are queued tasks. We render one
  // "Reply drafted" chip for the lead action and "Task queued" chips for the
  // remainder — the shape the S2 mock shows. When nothing was extracted we still
  // show the card with the transcript so the surface never reads as empty.
  const [lead, ...rest] = items;

  return (
    <div
      style={{
        background: CARD_BG,
        border: `1px solid ${CARD_LINE}`,
        borderRadius: 14,
        padding: "14px 18px",
        maxWidth: 560,
        width: "100%",
        textAlign: "left",
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 9,
          letterSpacing: "0.14em",
          color: EYEBROW,
        }}
      >
        HEARD YOU
      </div>
      <div
        style={{
          fontSize: 14.5,
          color: TRANSCRIPT,
          marginTop: 8,
          lineHeight: 1.5,
        }}
      >
        “{transcript}”
      </div>

      {lead || rest.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 7,
            marginTop: 12,
            paddingTop: 12,
            borderTop: `1px solid ${DIVIDER}`,
          }}
        >
          {lead ? (
            <ActionChip
              tone="blue"
              icon={<Mail size={12} />}
              label="Reply drafted"
              tag={tag}
              onClick={onOpenThread}
            />
          ) : null}
          {rest.map((item, i) => (
            <ActionChip
              key={`${item.text}-${i}`}
              tone="teal"
              icon={<QueuedBadge />}
              label="Task queued"
              tag={tag}
              onClick={onOpenActivity}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
