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
        overflow: "hidden",
      }}
    >
      <AuroraBackdrop />
      <div
        style={{
          position: "relative",
          padding:
            "calc(env(safe-area-inset-top, 0px) + 64px) 20px 40px",
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
