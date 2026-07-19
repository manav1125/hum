/**
 * GlassCard — the mv3 material: rgba glass over the aurora, hairline border,
 * 20–28px radii, backdrop blur.
 *
 * Spec values (frame 1 dark / frame 12 light):
 *   default: bg rgba(28,32,44,.72)/rgba(255,255,255,.85), border
 *            rgba(255,255,255,.1)/rgba(0,0,0,.06), radius 22, blur(20px),
 *            shadow 0 20px 44px -22px rgba(0,0,0,.7) / 0 16px 36px -22px
 *            rgba(23,23,28,.25)
 *   amber:   bg rgba(52,42,22,.75)/#FBF4E4, border rgba(224,166,75,.4)/
 *            rgba(180,119,15,.35)  (the ‖ needs-you treatment)
 *   violet:  bg rgba(38,34,58,.6)/rgba(255,255,255,.85), border
 *            rgba(167,159,240,.35)/rgba(127,119,221,.35)  (◱ review)
 *
 * PERF: backdrop-filter layers are capped — pass `blur={false}` on cards that
 * sit in a long scroll list so only the visually load-bearing few keep a live
 * backdrop-filter (the rgba fill alone still reads as glass over the aurora).
 */
import type React from "react";

export type GlassTint = "default" | "amber" | "violet";

const TINTS: Record<
  GlassTint,
  { bg: string; border: string; shadow: string }
> = {
  default: {
    bg: "var(--mv3-card)",
    border: "var(--mv3-card-border)",
    shadow: "var(--mv3-card-shadow)",
  },
  amber: {
    bg: "var(--mv3-amber-card-bg)",
    border: "var(--mv3-amber-card-border)",
    shadow: "var(--mv3-amber-card-shadow)",
  },
  violet: {
    bg: "var(--mv3-violet-card-bg)",
    border: "var(--mv3-violet-card-border)",
    shadow: "var(--mv3-violet-card-shadow)",
  },
};

export function GlassCard({
  tint = "default",
  radius = 22,
  padding = "16px 17px",
  blur = true,
  style,
  children,
  ...rest
}: {
  tint?: GlassTint;
  /** Spec radii run 20–28px; cards are 22. */
  radius?: number;
  padding?: React.CSSProperties["padding"];
  /** Set false to skip backdrop-filter (cap simultaneous blur layers). */
  blur?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "style" | "children">) {
  const t = TINTS[tint];
  return (
    <div
      data-mv3
      {...rest}
      style={{
        background: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: radius,
        padding,
        boxShadow: t.shadow,
        ...(blur
          ? {
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
            }
          : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
