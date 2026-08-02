/**
 * First-run explainer — ONE line that names the work loop, on the first HQ a
 * genuinely new account ever sees, and then never again.
 *
 * ## What was wrong with the three-card version
 *
 * 1. **It was three cards of onboarding above the work.** The tier system
 *    governs LANES; a first-run block is not a lane, so it sailed through the
 *    whole density pass untouched and kept ~230px between the composer and
 *    "NEEDS YOU". Each card's body explained something the surface states for
 *    itself one screen down — arrivals, the pause-for-your-OK rule, and the
 *    Review queue are all lanes on this same page — so the bodies were the
 *    screen describing itself. What survives is the three *titles*, which are
 *    the only part the deck does not already say.
 *
 * 2. **`SHOWN ONCE` was a promise the code had not made.** The seen-flag was
 *    written by the dismiss button and by nothing else, so anyone who scrolled
 *    past the block — the natural thing to do when it sits between you and your
 *    work — got it back on every single visit, forever. The label was true only
 *    for the users who clicked. It is now recorded when the block is *shown*,
 *    which is what "once" means; the button stays as the explicit way out.
 *
 * 3. **Nothing gated it on the account actually being new.** `show` was true
 *    for every browser profile regardless of state, so an account with missions,
 *    projects and ninety-odd tracked items was still told what Cue is. The
 *    sibling first-run meter on this page already solved exactly this
 *    (`shouldShowSetupMeter` / `hasRealUsage`, added because localStorage-only
 *    progress reads pristine on a second browser or the desktop shell's own
 *    origin). This now takes the same gate.
 *
 * Design: autonomy-states v2 (first-run); FINAL-NAV-BRIEF §4 ("is this already
 * visible somewhere else on this screen?") and §8 (every state carries a glyph).
 */
import { StateBadge } from "@vellumai/design-library";
import { useEffect, useState } from "react";

import { C, mono } from "./hq-kit";

const STORAGE_KEY = "cue:hq:firstrun:v1";

/** localStorage, or null when this profile has none we can rely on. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether this profile has already been shown the explainer.
 *
 * No storage counts as "already shown": without somewhere to record it we
 * cannot keep the promise the block makes, and a block that reappears every
 * visit is worse than one that never appears.
 */
function alreadyShown(): boolean {
  const ls = storage();
  if (!ls) return true;
  try {
    return ls.getItem(STORAGE_KEY) != null;
  } catch {
    return true;
  }
}

function markShown(): void {
  try {
    storage()?.setItem(STORAGE_KEY, "1");
  } catch {
    // Private-mode storage failures just mean it may show again.
  }
}

/**
 * Show the explainer once, to an account that is actually new.
 *
 * `established` is live evidence from the deck that this account already has
 * work in it — see `hasRealUsage`. It is the honesty gate: teaching the loop to
 * someone who has been running it for weeks is the product not knowing who it
 * is talking to.
 */
export function useHqFirstRun({ established }: { established: boolean }): {
  show: boolean;
  dismiss: () => void;
} {
  const [show, setShow] = useState(() => !established && !alreadyShown());
  // Recorded on DISPLAY, not on click — see the module header. Idempotent, so
  // StrictMode's double-invoke costs one extra write and nothing else.
  useEffect(() => {
    if (show) markShown();
  }, [show]);
  const dismiss = () => {
    setShow(false);
    markShown();
  };
  return { show, dismiss };
}

/**
 * The loop, in three verbs. Each carries its state glyph (§8: no colour-only
 * state) and the badges are the same ones the lanes below use, so the line is
 * also a legend for the rest of the screen.
 */
const STEPS: Array<{ state: "capture" | "running" | "review"; text: string }> =
  [
    { state: "capture", text: "It picks things up" },
    { state: "running", text: "It does the work" },
    { state: "review", text: "You sign off" },
  ];

export function HqFirstRun({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section
      aria-label="How the work loop works"
      data-slot="hq-firstrun"
      style={{
        marginTop: 14,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        background: C.surface,
        padding: "9px 13px",
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: C.t3,
          whiteSpace: "nowrap",
        }}
      >
        How Cue works
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          flex: 1,
          minWidth: 0,
        }}
      >
        {STEPS.map((s) => (
          <span
            key={s.state}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12.5,
              color: C.t2,
              whiteSpace: "nowrap",
            }}
          >
            <StateBadge state={s.state} size="sm" showLabel={false} />
            {s.text}
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: C.t3,
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Got it
      </button>
    </section>
  );
}
