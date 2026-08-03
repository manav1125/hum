/**
 * What each Your Cue leaf does **on a phone**.
 *
 * The leaf SET, the groups and the order are not decided here — they come from
 * `components/nav/your-cue-model.ts`, which both platforms read, and which is
 * the whole reason the two stopped describing different products. This module
 * answers one narrower question per leaf:
 *
 *   **does this surface exist on a phone, and if not, why not?**
 *
 * ## The rule it enforces
 *
 * A row that renders is not a row that navigates. Design's ruling (v24, §8 of
 * the brief) is that nine surfaces are *named rather than hidden* — the phone
 * links out and says why — and `your-cue-model.ts` already ships the pattern:
 * a `null` destination plus a reason string, rendered as a disabled row with a
 * `⊘` glyph. **A dead link is worse than an honest "Mac only".**
 *
 * The inverse is equally true, and it is why this list is shorter than
 * design's nine. Marking a surface "desktop only" when the phone has a real,
 * touch-native screen for it would be its own lie, and would delete working
 * function from the product to satisfy a list. Every leaf below was checked
 * against what actually renders at 390px:
 *
 *   Schedules      → `Mv3SchedulesLeaf`      phone-native, navigates
 *   Models         → `Mv3AiLeaf`             phone-native, navigates
 *   Usage & spend  → `Mv3UsagePage`          phone-native, navigates
 *   Preferences    → `Mv3AppearanceLeaf`     phone-native, navigates
 *   Brand          → `Mv3BrandLeaf`          phone-native, navigates
 *   System access  → `Mv3PrivacyLeaf`        phone-native, navigates
 *   Plugins        → `Mv3PluginsPage`        phone-native, navigates
 *   Marketplace    → desktop page only       NAMED, does not navigate
 *   Agent network  → desktop page only       NAMED, does not navigate
 *
 * Six of design's nine already have the screen design assumed they lacked.
 * That delta is reported rather than silently absorbed.
 *
 * ## Two leaves whose phone destination is not their desktop one
 *
 *   · **Channels** — `/assistant/channels` is where the phone's hub used to
 *     live, and it now redirects to the hub's real URL. The per-channel SETUP
 *     the leaf is *for* has always been the Connections workbench, which is
 *     where the shipped phone footer already pointed.
 *   · **Cue Live** — Look / Point / Take control are desktop-app capabilities.
 *     Design's own label for this row is the honest one: "Mac only".
 */

import {
  YOUR_CUE_GROUPS,
  type YourCueLeaf,
} from "@/components/nav/your-cue-model";
import { routes } from "@/utils/routes";

/** A leaf that goes somewhere on a phone. */
export interface PhoneLeafOpen {
  state: "open";
  /** Where it lands on a phone — usually, but not always, `leaf.to`. */
  to: string;
}

/** A leaf that renders and says why it cannot go anywhere. */
export interface PhoneLeafClosed {
  state: "closed";
  /** Second person, naming the actual cause. Read aloud to screen readers. */
  reason: string;
  /** The short right-hand label on the row: "Mac only", "Desktop". */
  badge: string;
}

export type PhoneLeafState = PhoneLeafOpen | PhoneLeafClosed;

/**
 * Leaves with no phone surface, and the sentence each one says instead.
 *
 * Keyed by leaf key so a leaf renamed in the shared model fails loudly here
 * (`your-cue-mobile.test.ts` asserts every key still resolves) rather than
 * quietly reverting to "navigates".
 */
const NO_PHONE_SURFACE: Record<string, PhoneLeafClosed> = {
  marketplace: {
    state: "closed",
    badge: "Desktop",
    reason:
      "Browsing 1,288 skills across seven sources is a keyboard job — it opens on the Mac app or a desktop browser.",
  },
  "agent-network": {
    state: "closed",
    badge: "Desktop",
    reason:
      "Pairing with another agent means reading and approving a peer's scopes. That review needs a desktop screen.",
  },
  "cue-live": {
    state: "closed",
    badge: "Mac only",
    reason:
      "Look, Point and Take control drive your Mac's screen, so they only run in the desktop app.",
  },
};

/**
 * Leaves whose phone destination differs from `leaf.to`. See the module note —
 * both are corrections of a URL that means something else on a phone, not
 * lookalike substitutions.
 */
const PHONE_DESTINATION: Record<string, string> = {
  channels: routes.contacts.root,
};

/**
 * Where a leaf goes on a phone, or why it cannot go anywhere.
 *
 * Order of decision, and it matters: the shared model's own `to: null` wins
 * first, because a surface that does not exist on EITHER platform is not a
 * phone limitation and must not be described as one.
 */
export function phoneLeafState(leaf: YourCueLeaf): PhoneLeafState {
  if (leaf.to === null) {
    return {
      state: "closed",
      badge: "Not built",
      reason:
        leaf.unavailableReason ??
        "This surface doesn't exist yet on any platform.",
    };
  }
  const closed = NO_PHONE_SURFACE[leaf.key];
  if (closed) return closed;
  return { state: "open", to: PHONE_DESTINATION[leaf.key] ?? leaf.to };
}

/**
 * The row glyph per leaf.
 *
 * Verbatim from v22 M5 and v24 F2 for the thirteen leaves design drew; the
 * remaining seven follow the same mixed grammar (a geometric mark where one
 * reads, an emoji where the frames already use one). Two constraints the
 * frames do not state but the rows need: no two leaves share a glyph, and
 * nothing here is the only carrier of a state — the `⊘` on a closed row is
 * separate, so a glyph that fails to render costs recognition, never meaning.
 */
export const LEAF_GLYPH: Record<string, string> = {
  identity: "◉",
  brand: "🎨",
  agents: "◆",
  skills: "✦",
  plugins: "🧩",
  marketplace: "◱",
  // Design draws 🔌. It renders as a near-black plug on the dark ground and
  // measured as the least legible mark on the screen — the same contrast class
  // this pack has logged eight times, arriving through a glyph instead of a
  // hex. `⧉` is from design's own invariant glyph set and reads in both themes.
  connectors: "⧉",
  // Design draws 📡, which renders near-black on the dark ground — the same
  // legibility problem as the plug above, arriving through a glyph.
  channels: "☏",
  "agent-network": "🔗",
  "cue-live": "👁",
  memory: "🧠",
  watching: "✧",
  schedules: "⟳",
  automations: "○",
  guardrails: "🛡",
  "system-access": "⌘",
  models: "◑",
  usage: "◔",
  workspace: "▩",
  preferences: "⚙",
};

/**
 * The two config groups the ⓶ screen shows in full (v24 F2), by group key.
 *
 * F2 is a summary, not the whole shell: it answers "what is my Cue doing, and
 * how is it set up" in ONE scroll, so it carries the groups you actually reach
 * for from a phone and links to {@link routes.yourCueAll} for the rest. The
 * full eighteen live one tap away, never hidden.
 */
export const CUE_SCREEN_GROUPS: readonly string[] = [
  "who-works-for-you",
  "what-cue-knows",
] as const;

/** Every leaf, flattened, that a given feature-flag state lets the phone show. */
export function visibleLeaves(flags: {
  externalPlugins: boolean;
  marketplace: boolean;
}): YourCueLeaf[] {
  return YOUR_CUE_GROUPS.flatMap((group) => group.leaves).filter((leaf) => {
    if (leaf.flag === "externalPlugins") return flags.externalPlugins;
    if (leaf.flag === "marketplace") return flags.marketplace;
    return true;
  });
}
