/**
 * Shared placeholder for mobile v3 surfaces whose full build is in flight.
 * Each cluster replaces its page module wholesale; this scaffold just keeps
 * the route navigable (aurora + large title + a quiet line) until then.
 */
import { AuroraBackdrop } from "@/mobile-v3/aurora-backdrop";

export function Mv3StubPage({ title }: { title: string }) {
  return (
    <div
      data-mv3
      style={{
        minHeight: "100dvh",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        position: "relative",
        // `clip` (both axes — a lone overflow-x:clip computes back to hidden
        // next to overflow-y:hidden) forbids programmatic scrollLeft drift;
        // `hidden` still allowed focus/autoscroll to wedge the shell
        // sideways (P1 546px-orb fix). The aurora is paint-contained, so
        // engines without `clip` support degrade safely.
        overflow: "clip",
      }}
    >
      <AuroraBackdrop />
      <div
        style={{
          position: "relative",
          padding:
            "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 64px) 20px 40px",
        }}
      >
        <h1
          style={{
            fontSize: 29,
            fontWeight: 700,
            letterSpacing: "-0.8px",
            margin: 0,
          }}
        >
          {title}
        </h1>
        <p style={{ color: "var(--mv3-muted)", marginTop: 10, fontSize: 15 }}>
          Coming online…
        </p>
      </div>
    </div>
  );
}
