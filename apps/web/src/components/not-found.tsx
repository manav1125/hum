/**
 * NotFound — branded dead-route page (mobile UAT missing-screen #10).
 * Rendered by BOTH catch-alls in routes.tsx: the `/assistant/*` one (inside
 * RootLayout's chrome) and the top-level one (standalone, no layout), so it
 * sizes itself and assumes nothing about its parent.
 *
 * Mobile speaks the v3 grammar (aurora canvas + SF stack + "Back to Today"
 * primary); desktop gets the quiet serif card the HQ deck uses.
 */
import { Link } from "react-router";

import { useMobileLayout } from "@/hooks/use-is-mobile";
import { AuroraBackdrop } from "@/mobile-v3/aurora-backdrop";
import { primaryBtn } from "@/mobile-v3/mv3-kit";
import { routes } from "@/utils/routes";

export function NotFound() {
  const isMobile = useMobileLayout();

  if (isMobile) {
    return (
      <main
        data-mv3
        data-slot="not-found"
        aria-labelledby="not-found-title"
        style={{
          position: "relative",
          flex: 1,
          minHeight: "100svh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 32px",
          background: "var(--mv3-bg)",
          color: "var(--mv3-text)",
          fontFamily: "var(--mv3-font)",
          textAlign: "center",
        }}
      >
        <AuroraBackdrop />
        <div style={{ position: "relative", zIndex: 2 }}>
          <div
            aria-hidden
            style={{
              fontFamily: "var(--mv3-mono)",
              fontSize: 11,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--mv3-muted)",
              marginBottom: 10,
            }}
          >
            404
          </div>
          <h1
            id="not-found-title"
            style={{
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: "-0.5px",
              margin: 0,
            }}
          >
            This screen doesn&rsquo;t exist
          </h1>
          <p
            style={{
              fontSize: 13.5,
              lineHeight: 1.5,
              color: "var(--mv3-muted)",
              margin: "10px 0 22px",
            }}
          >
            The link may be old, or the page moved. Everything that matters is
            back on Today.
          </p>
          <Link
            to={routes.hq}
            style={{
              ...primaryBtn,
              flex: "none",
              display: "inline-block",
              textDecoration: "none",
              padding: "12px 26px",
              minHeight: 44,
            }}
          >
            Back to Today
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main
      data-slot="not-found"
      aria-labelledby="not-found-title"
      style={{
        flex: 1,
        minHeight: "60svh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
    >
      <section
        style={{
          maxWidth: 420,
          width: "100%",
          border: "1px solid var(--border-base)",
          borderRadius: 14,
          background: "var(--surface-lift)",
          padding: "34px 36px",
          textAlign: "center",
          fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
          color: "var(--content-default)",
        }}
      >
        <div
          aria-hidden
          style={{
            fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
            fontSize: 11,
            letterSpacing: "0.14em",
            color: "var(--content-tertiary)",
            marginBottom: 10,
          }}
        >
          404
        </div>
        <h1
          id="not-found-title"
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.3px",
            margin: 0,
          }}
        >
          This page doesn&rsquo;t exist
        </h1>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--content-secondary)",
            margin: "10px 0 20px",
          }}
        >
          The link may be old, or the page moved.
        </p>
        <Link
          to={routes.hq}
          style={{
            display: "inline-block",
            fontSize: 14,
            textDecoration: "underline",
            textUnderlineOffset: 3,
            color: "var(--content-default)",
          }}
        >
          Back to Today
        </Link>
      </section>
    </main>
  );
}
