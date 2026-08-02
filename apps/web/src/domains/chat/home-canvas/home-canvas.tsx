/**
 * The home canvas, below the composer — positions 3 and 4, and nothing else.
 *
 * This component has **no hand-written children**. It maps
 * {@link REGION_ELEMENTS} and looks each id up in {@link RENDERERS}, an
 * exhaustive `Record<RegionElementId, …>`. Adding a fifth thing here is not a
 * matter of typing more JSX: there is no JSX to type into. You would have to
 * add a manifest entry (a compile error — the manifest is a six-tuple), give
 * it a `RegionElementId` (a compile error — the record would be missing a key
 * until you add it, and the id has to come from the tuple), and answer
 * `alreadyVisibleOnThisScreen` with a value its type does not admit.
 *
 * And if you route around all three by dropping an element in as a sibling,
 * {@link auditHomeCanvas} counts it — in the test, and in the browser console
 * during development.
 *
 * See `home-canvas-model.ts` for the ruling this implements.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { ConversationStarterChip } from "@/domains/chat/components/conversation-starter-chip";
import {
  auditHomeCanvas,
  canvasElement,
  canvasRegion,
  PROMPT_CHIP_CAP,
  REGION_ELEMENTS,
  type RegionElementId,
} from "@/domains/chat/home-canvas/home-canvas-model";
import {
  PROMPT_SOURCE_GLYPH,
  useCanvasPrompts,
  type CanvasPrompt,
} from "@/domains/chat/home-canvas/use-canvas-prompts";
import { useCanvasDoor } from "@/domains/chat/home-canvas/use-canvas-door";
import { routes } from "@/utils/routes";

/**
 * Theme-aware tokens, declared locally like the rest of the chat domain so the
 * canvas does not reach across a domain boundary for a colour.
 *
 * `--mv1-t3` is deliberately absent. It resolves to `--content-tertiary`
 * (`#71808e`), which measures **4.05:1** on white — under the 4.5:1 floor. It
 * is a border/ground token whose name does not say so, which is precisely the
 * naming failure §1 describes. Nothing on this canvas sets text in it.
 */
const C = {
  /** `--content-default` — 12.6:1 light, 15.9:1 dark. */
  ink: "var(--mv1-t1)",
  /** `--content-secondary` — 5.9:1 light, 6.1:1 dark. The floor is 4.5:1. */
  body: "var(--mv1-t2)",
  line: "var(--mv1-line)",
} as const;

// ---------------------------------------------------------------------------
// Position 3 — up to five prompt chips
// ---------------------------------------------------------------------------

function CanvasPrompts({
  prompts,
  onSelect,
}: {
  prompts: readonly CanvasPrompt[];
  onSelect: (prompt: CanvasPrompt) => void;
}) {
  // Sliced against the manifest's own cap, not a local number. §4 says "up to
  // 5" in exactly one place and this reads it.
  const visible = prompts.slice(0, PROMPT_CHIP_CAP);
  if (visible.length === 0) return null;

  return (
    <div
      {...canvasElement("prompts")}
      className="flex flex-wrap items-center justify-center gap-2"
    >
      {visible.map((p) => (
        <ConversationStarterChip
          key={p.id}
          label={`${PROMPT_SOURCE_GLYPH[p.source]} ${p.label}`}
          onSelect={() => onSelect(p)}
          aria-label={`Ask Cue: ${p.label}`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Position 4 — one sentence pill, pointing ↑ at the rail
// ---------------------------------------------------------------------------

/**
 * The pill's state glyph. Every state carries one — §8's no-colour-only rule —
 * and they are HQ's glyphs so the same state wears the same mark on both
 * surfaces. `○` is not "zero": it is "I could not read this", which is a
 * different sentence from "nothing".
 */
function doorGlyph(needsYou: number | null, delivered: number | null): string {
  if (needsYou == null && delivered == null) return "○";
  if (needsYou != null && needsYou > 0) return "‖";
  return "✓";
}

function CanvasDoorPill({
  assistantId,
  nowMs,
}: {
  assistantId: string | null;
  nowMs: number;
}) {
  const door = useCanvasDoor(assistantId, nowMs);

  // Hold rather than assert. "I couldn't read your work just now" is a real
  // claim and it must not be the thing a page-load flashes on the way to the
  // truth.
  if (door.isPending) return null;

  return (
    <div
      {...canvasElement("door")}
      className="flex justify-center"
      style={{ marginTop: 14 }}
    >
      {/* The sentence IS the door — one affordance, not a sentence plus a
          "show me" button. `↑` says where it goes: the rail row above. */}
      <Link
        to={routes.hq}
        className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 no-underline transition-colors"
        style={{ borderColor: C.line, color: C.body, fontSize: 13 }}
      >
        <span aria-hidden style={{ color: C.body }}>
          {doorGlyph(door.needsYou, door.delivered)}
        </span>
        <span>{door.sentence}</span>
        <span aria-hidden style={{ color: C.ink, fontWeight: 600 }}>
          ↑ HQ
        </span>
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The region
// ---------------------------------------------------------------------------

export interface HomeCanvasRegionProps {
  assistantId: string | null;
  /** Fired with the chip's prompt text; the caller seeds and sends. */
  onSelectPrompt: (prompt: CanvasPrompt) => void;
}

/**
 * Positions 3–4.
 *
 * Note the absence of a `children` prop: the region cannot be handed anything
 * to render. Everything it draws comes from the manifest.
 */
export function HomeCanvasRegion({
  assistantId,
  onSelectPrompt,
}: HomeCanvasRegionProps) {
  // Stamped once per mount. The sentence's "While you slept" / "Today so far"
  // must not flip because an unrelated re-render crossed noon.
  const [nowMs] = useState(() => Date.now());
  const { prompts } = useCanvasPrompts(assistantId);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * The dev guard.
   *
   * The type system cannot see JSX someone adds three files away that happens
   * to land inside this container; the DOM can. This runs the same audit the
   * test runs, so a seventh element is loud in the browser the day it is
   * written rather than at review time — or never.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const root = rootRef.current;
    if (!root) return;
    const audit = auditHomeCanvas(root);
    if (!audit.ok) console.error(`[home-canvas] ${audit.verdict}`);
  });

  const RENDERERS: Record<RegionElementId, ReactNode> = {
    prompts: <CanvasPrompts prompts={prompts} onSelect={onSelectPrompt} />,
    door: <CanvasDoorPill assistantId={assistantId} nowMs={nowMs} />,
  };

  return (
    <div ref={rootRef} {...canvasRegion()} className="mt-4">
      {REGION_ELEMENTS.map((el) => (
        <ElementFragment key={el.id}>
          {RENDERERS[el.id as RegionElementId]}
        </ElementFragment>
      ))}
    </div>
  );
}

/**
 * Renders a manifest element's node and nothing around it.
 *
 * A wrapper `<div>` here would put an untagged element between the region and
 * its tagged child, which is the shape {@link auditHomeCanvas} treats as an
 * intruder. Keeping the tagged node as a *direct* child of the region is what
 * makes that check meaningful.
 */
function ElementFragment({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
