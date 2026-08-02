/**
 * Coach-mark tour registry — the single source of truth for every guided
 * first-step tip in the app.
 *
 * Each {@link CoachStep} names a target by its `data-coach` attribute, carries
 * its own copy, and belongs to a surface. The {@link FeatureTour} host reads
 * this list, matches the current route to a surface, and shows the surface's
 * unseen tips one at a time (see `use-feature-tour.ts`).
 *
 * Adding a tip is a data-only change: add the step here and put a matching
 * `data-coach="<anchor>"` on the target element. A step whose target isn't
 * mounted simply no-ops, so entries can be wired ahead of (or behind) the UI.
 *
 * Copy voice: say what the feature does *for the user* in one calm sentence —
 * never how it's built, never an imperative nag.
 */

import type { CoachmarkAlign, CoachmarkSide } from "@vellumai/design-library";

import { routes } from "@/utils/routes";

export type CoachSurface =
  | "chat"
  | "create"
  | "channels"
  | "agents"
  | "memory"
  | "voice"
  | "cue-live"
  | "projects"
  | "guardrails"
  | "connectors"
  | "hq";

export interface CoachStep {
  /** Unique id. Backs the `cue:coach:<id>` localStorage seen-flag. */
  id: string;
  /** Surface this step belongs to (groups a surface's mini-tour). */
  surface: CoachSurface;
  /** Value of the `data-coach` attribute on the target element. */
  anchor: string;
  /** One line — the feature name / what it is. */
  title: string;
  /** One calm sentence — what it does for the user. */
  body: string;
  /** Preferred placement of the tip relative to the target. */
  side?: CoachmarkSide;
  align?: CoachmarkAlign;
  /** Order within the surface tour (ascending). */
  order: number;
}

export interface CoachSurfaceDef {
  id: CoachSurface;
  /** Route prefixes this surface's tour is eligible on. */
  routes: string[];
  /**
   * Optional extra gate evaluated at runtime — return false to hold the tour
   * (e.g. don't collide with a one-time orientation panel).
   */
  gate?: () => boolean;
}

/** localStorage key for the HQ "what changed" orientation (see hq-native-marker). */
const HQ_ORIENTATION_SEEN_KEY = "cue:hq-orientation-seen";
/** localStorage key for the HQ first-run explainer (see hq-firstrun). */
const HQ_FIRSTRUN_SEEN_KEY = "cue:hq:firstrun:v1";

/**
 * HQ hosts two other one-time welcomes — the switch-over orientation panel and
 * the first-run "here's how Cue works" explainer. Hold the tour until BOTH are
 * settled; stacking coach marks on top of an explainer is noise, not guidance.
 */
function hqOrientationSettled(): boolean {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return true;
    return (
      ls.getItem(HQ_ORIENTATION_SEEN_KEY) != null &&
      ls.getItem(HQ_FIRSTRUN_SEEN_KEY) != null
    );
  } catch {
    return true;
  }
}

/**
 * Surface definitions — route matching + per-surface gating. Order matters
 * only for route resolution: more specific prefixes are listed first so
 * `/assistant/hq/agents` resolves to `agents`, not `hq`.
 */
export const COACH_SURFACES: CoachSurfaceDef[] = [
  { id: "agents", routes: [routes.hqAgents, routes.agentsAtWork] },
  // HQ shares the one-time orientation panel — hold its tour until that's done.
  { id: "hq", routes: [routes.hq], gate: hqOrientationSettled },
  { id: "chat", routes: [routes.conversations] },
  { id: "create", routes: [routes.create] },
  { id: "channels", routes: [routes.channels] },
  { id: "memory", routes: [routes.memory] },
  { id: "cue-live", routes: [routes.cueLive] },
  { id: "voice", routes: [routes.voice] },
  // Work is ONE surface with two views (`?view=things|everything`), so it is
  // one coach surface too. `surfaceForPath` matches on pathname alone, and a
  // second entry for the same path would make "first match wins" decide which
  // tips you get. The ledger's tip lives here and simply waits for its anchor
  // to exist — which happens on the Everything view.
  { id: "projects", routes: [routes.projects, routes.allWork] },
  { id: "guardrails", routes: [routes.guardrails, routes.trust] },
  { id: "connectors", routes: [routes.connectors] },
];

/**
 * Every coach step. The HQ steps are included as data so the surface tour
 * lights up automatically once `data-coach` anchors are added to the HQ
 * board/hero (those files are owned by another change).
 */
export const COACH_STEPS: CoachStep[] = [
  // ── Chat · compose ──────────────────────────────────────────────────────
  {
    id: "chat-composer",
    surface: "chat",
    anchor: "chat-composer",
    title: "Ask Cue to do things",
    body: "Type what you want done in plain words — Cue takes it from here.",
    side: "top",
    order: 1,
  },
  {
    id: "chat-voice",
    surface: "chat",
    anchor: "chat-voice",
    title: "Or just say it",
    body: "Tap the mic to talk instead of type — handy when your hands are busy.",
    side: "top",
    align: "end",
    order: 2,
  },

  // ── Create · studio ─────────────────────────────────────────────────────
  {
    id: "create-prompt",
    surface: "create",
    anchor: "create-prompt",
    title: "Make something",
    body: "Describe an image, doc, or app and Cue drafts a first version for you.",
    side: "top",
    order: 1,
  },

  // ── Channels ────────────────────────────────────────────────────────────
  {
    id: "channels-connect",
    surface: "channels",
    anchor: "channels-connect",
    title: "Reach Cue where you already are",
    body: "Connect a channel so you can hand off work from email, Slack, or SMS.",
    side: "bottom",
    order: 1,
  },

  // ── Agents · the roster ─────────────────────────────────────────────────
  {
    id: "agents-hire",
    surface: "agents",
    anchor: "agents-hire",
    title: "Build your team",
    body: "Hire an agent to own a recurring job so it runs without you asking.",
    side: "bottom",
    order: 1,
  },

  // ── Memory ──────────────────────────────────────────────────────────────
  {
    id: "memory-teach",
    surface: "memory",
    anchor: "memory-teach",
    title: "What Cue remembers",
    body: "Teach Cue a fact or preference once and it carries across every chat.",
    side: "bottom",
    order: 1,
  },

  // ── Voice mode ──────────────────────────────────────────────────────────
  {
    id: "voice-start",
    surface: "voice",
    anchor: "voice-start",
    title: "Talk it through",
    body: "Start a voice session to think out loud — Cue listens and acts as you speak.",
    side: "top",
    order: 1,
  },

  // ── Cue Live ────────────────────────────────────────────────────────────
  {
    id: "cuelive-enable",
    surface: "cue-live",
    anchor: "cuelive-enable",
    title: "Cue, always on",
    body: "Turn Cue Live on and you can summon it hands-free whenever you need it.",
    side: "bottom",
    align: "start",
    order: 1,
  },

  // ── Projects ────────────────────────────────────────────────────────────
  {
    id: "projects-new",
    surface: "projects",
    anchor: "projects-new",
    title: "Group work into things",
    body: "A thing is whatever you're trying to get done. Start one to keep its tasks, files and agents in one place.",
    side: "bottom",
    align: "end",
    order: 1,
  },

  // ── All work · the queue ────────────────────────────────────────────────
  {
    id: "work-view",
    surface: "projects",
    anchor: "work-view",
    title: "Everything in flight",
    body: "Everything shows every live task, whichever thing it belongs to — regroup it to suit how you scan.",
    side: "bottom",
    align: "start",
    order: 1,
  },

  // ── Guardrails ──────────────────────────────────────────────────────────
  {
    id: "guardrails-checkpoint",
    surface: "guardrails",
    anchor: "guardrails-checkpoint",
    title: "You stay in control",
    body: "Add a checkpoint to decide which actions Cue must ask you about first.",
    side: "bottom",
    order: 1,
  },

  // ── Connectors · MCP ────────────────────────────────────────────────────
  {
    id: "connectors-add",
    surface: "connectors",
    anchor: "connectors-add",
    title: "Give Cue more reach",
    body: "Connect a tool so Cue can act in the apps your work already lives in.",
    side: "left",
    align: "start",
    order: 1,
  },

  // ── HQ · the command deck (anchors wired in hq-page/hq-board) ────────────
  {
    id: "hq-capture",
    surface: "hq",
    anchor: "hq-capture",
    title: "Drop anything here",
    body: "Capture a thought, task, or link and Cue sorts it into the right lane.",
    side: "bottom",
    order: 1,
  },
  {
    id: "hq-lanes",
    surface: "hq",
    anchor: "hq-lanes",
    title: "Your work, in motion",
    body: "Watch work move from needs-you to in-progress to done as Cue runs it.",
    side: "top",
    order: 2,
  },
  {
    id: "hq-rings",
    surface: "hq",
    anchor: "hq-rings",
    title: "The day at a glance",
    body: "The rings show what's live, what's waiting on you, and what's scheduled.",
    side: "bottom",
    order: 3,
  },
  {
    id: "hq-agents",
    surface: "hq",
    anchor: "hq-agents",
    title: "Who's on the clock",
    body: "These are the agents running your company — tap one to see what it owns.",
    side: "top",
    order: 4,
  },
];

/** Steps for a surface, in tour order. */
export function stepsForSurface(surface: CoachSurface): CoachStep[] {
  return COACH_STEPS.filter((s) => s.surface === surface).sort(
    (a, b) => a.order - b.order,
  );
}

/**
 * Resolve which surface (if any) a pathname belongs to. First match wins, so
 * `COACH_SURFACES` lists more-specific routes ahead of their prefixes.
 */
export function surfaceForPath(pathname: string): CoachSurfaceDef | null {
  return (
    COACH_SURFACES.find((surface) =>
      surface.routes.some(
        (route) => pathname === route || pathname.startsWith(`${route}/`),
      ),
    ) ?? null
  );
}
