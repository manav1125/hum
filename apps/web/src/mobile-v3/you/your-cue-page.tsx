/**
 * **Your Cue** at phone width — v22 frame M5.
 *
 * One name on both platforms. The screen was called "You", which design's R2
 * ruling calls wrong twice: *"it predates the door existing, and it's wrong
 * twice: it's about Cue's setup, and the phone's leaf set had drifted."* This
 * is the same eighteen leaves, the same groups and the same order as the
 * desktop shell — the only difference is a pushed list instead of a leaf
 * column, because a phone has no column to put beside anything.
 *
 * The set is NOT redeclared here. It is read from
 * `components/nav/your-cue-model.ts`, which is what stops the drift from
 * happening a second time; this file owns rendering and nothing else.
 *
 * ## Every row either navigates or says why it cannot
 *
 * Nine surfaces are genuinely better with a keyboard, and design's ruling is
 * that the phone **names** them rather than hiding them. `your-cue-mobile.ts`
 * holds that judgement per leaf, checked against what actually renders at
 * 390px; a closed row here draws at full strength with a `⊘` glyph, its short
 * badge and its reason — never an `opacity` wrapper, which is receding by
 * contrast through the back door.
 *
 * ## Reach
 *
 * The back chevron sits top-left, which the brief allows *provided every
 * screen has swipe-back*. It does: this is a router push, and the shell's
 * swipe-back gesture covers it. Nothing on this screen is a primary action —
 * it is a list of doors — so the 60% rule has nothing to place.
 */
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  YOUR_CUE_GROUPS,
  type YourCueLeaf,
} from "@/components/nav/your-cue-model";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { microLabel } from "../mv3-kit";
import { YouScreen } from "./you-kit";
import { useCueCounts } from "./use-cue-counts";
import { LEAF_GLYPH, phoneLeafState } from "./your-cue-mobile";

/** The count that belongs beside a leaf, or null when there isn't one. */
function leafMeta(
  key: string,
  counts: ReturnType<typeof useCueCounts>,
): string | null {
  switch (key) {
    case "agents":
      return counts.agents == null ? null : String(counts.agents);
    case "skills":
      return counts.skills == null ? null : String(counts.skills);
    case "connectors":
      return counts.connectorsLive == null
        ? null
        : `${counts.connectorsLive} live`;
    default:
      return null;
  }
}

/** One row of the pushed list. Frame values: 11/13px, 18px glyph gutter. */
function LeafRow({
  leaf,
  meta,
  isLast,
}: {
  leaf: YourCueLeaf;
  meta: string | null;
  isLast: boolean;
}) {
  const navigate = useNavigate();
  const state = phoneLeafState(leaf);
  const glyph = LEAF_GLYPH[leaf.key] ?? "·";
  const rowStyle: React.CSSProperties = {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 11,
    textAlign: "left",
    padding: "12px 13px",
    // The frames draw 41px; 44 is the floor a thumb needs and the only value
    // that differs from the spec here.
    minHeight: 44,
    background: "transparent",
    border: "none",
    borderBottom: isLast ? "none" : "1px solid var(--mv3-line)",
    fontFamily: "inherit",
    color: "var(--mv3-text)",
  };

  if (state.state === "closed") {
    return (
      <div
        // A closed row is two or three lines tall, so its glyph and badge
        // align to the label rather than floating in the middle of the reason.
        style={{ ...rowStyle, alignItems: "flex-start" }}
        data-slot="your-cue-leaf-closed"
        data-leaf={leaf.key}
      >
        <span
          aria-hidden
          style={{ fontSize: 13, width: 18, flexShrink: 0, lineHeight: "19px" }}
        >
          {glyph}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, display: "block" }}>{leaf.label}</span>
          {/* Full strength, deliberately: the explanation is the row's whole
              value, and dimming it would make the honest label the quietest
              thing on the screen. */}
          <span
            style={{
              fontSize: 11,
              color: "var(--mv3-muted)",
              display: "block",
              marginTop: 2,
              lineHeight: 1.45,
            }}
          >
            {state.reason}
          </span>
        </span>
        <span
          style={{
            fontSize: 9.5,
            color: "var(--mv3-muted)",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 4,
            lineHeight: "19px",
          }}
        >
          {/* The state carries a glyph, never colour alone. */}
          <span aria-hidden>⊘</span>
          {state.badge}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="cue-pressable"
      data-slot="your-cue-leaf"
      data-leaf={leaf.key}
      aria-label={meta ? `${leaf.label} — ${meta}` : leaf.label}
      onClick={() => {
        haptic.light();
        navigate(state.to);
      }}
      style={{ ...rowStyle, cursor: "pointer" }}
    >
      <span aria-hidden style={{ fontSize: 13, width: 18, flexShrink: 0 }}>
        {glyph}
      </span>
      <span style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{leaf.label}</span>
      {meta ? (
        <span
          style={{ fontSize: 10.5, color: "var(--mv3-muted)", flexShrink: 0 }}
        >
          {meta}
        </span>
      ) : null}
      <span
        aria-hidden
        style={{ color: "var(--mv3-muted)", marginLeft: 6, flexShrink: 0 }}
      >
        ›
      </span>
    </button>
  );
}

export function Mv3YourCuePage() {
  const assistantId = useActiveAssistantId();
  const counts = useCueCounts(assistantId);

  // Two leaves are flag-gated and their pages self-redirect when the flag is
  // off. Waiting for hydration keeps them from flickering in for flag-off
  // users; `hasHydrated` is false only for the first frame.
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const externalPlugins = useAssistantFeatureFlagStore.use.externalPlugins();
  const marketplace = useAssistantFeatureFlagStore.use.marketplace();

  const groups = YOUR_CUE_GROUPS.map((group) => ({
    ...group,
    leaves: group.leaves.filter((leaf) => {
      if (!leaf.flag) return true;
      if (!flagsHydrated) return false;
      return leaf.flag === "externalPlugins" ? externalPlugins : marketplace;
    }),
  })).filter((group) => group.leaves.length > 0);

  const leafCount = groups.reduce((n, g) => n + g.leaves.length, 0);

  return (
    <YouScreen
      tint="lavender"
      testId="mv3-your-cue-all"
      back={routes.yourCue}
      backLabel="Your Cue"
      title="Everything"
      sub={`${leafCount} places you can change how Cue works`}
    >
      {groups.map((group) => (
        <div key={group.key}>
          <div
            style={{
              ...microLabel,
              color: "var(--mv3-muted)",
              padding: "4px 6px 6px",
            }}
          >
            {group.title}
          </div>
          <div
            style={{
              background: "var(--mv3-card)",
              border: "1px solid var(--mv3-card-border)",
              borderRadius: 14,
              overflow: "hidden",
            }}
          >
            {group.leaves.map((leaf, i) => (
              <LeafRow
                key={leaf.key}
                leaf={leaf}
                meta={leafMeta(leaf.key, counts)}
                isLast={i === group.leaves.length - 1}
              />
            ))}
          </div>
        </div>
      ))}
    </YouScreen>
  );
}
