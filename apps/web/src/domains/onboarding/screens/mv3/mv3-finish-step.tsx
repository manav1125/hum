/**
 * Mv3FinishStep — onboarding Step 4, mobile v3 (spec frame 28): "Your orbit
 * is forming." over the mark inside a live orbit, with REAL receipts only —
 * what's connected (from the funnel's own Google-connect state), the mode
 * chosen (if Step 3 was completed), and the standing promise that the first
 * brief lands at 7:30 tomorrow. Nothing is fabricated: no connection → no
 * "connected" line, no mode pick → no mode line, and no found-counts because
 * the web funnel's connect step surfaces none.
 *
 * "See today →" hands off to Today (/assistant/hq).
 */
import { CueRing } from "@/mobile-v3/cue-ring";

import type { PendingWorkspaceMode } from "../../mv3-onboarding-prefs";
import { Mv3OnboardingShell } from "./mv3-onboarding-shell";

const MODE_LABEL: Record<PendingWorkspaceMode, string> = {
  observe: "Observe mode",
  assist: "Assist mode",
  autonomous: "Autonomous mode",
};

export function Mv3FinishStep({
  googleConnected,
  mode,
  onFinish,
}: {
  googleConnected: boolean;
  mode: PendingWorkspaceMode | null;
  onFinish: () => void;
}) {
  const receipts: string[] = [];
  if (googleConnected) receipts.push("Google connected");
  if (mode) receipts.push(MODE_LABEL[mode]);

  return (
    <Mv3OnboardingShell cta="See today →" ctaVariant="ink" onCta={onFinish} centered>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        {/* The forming orbit — one satellite dot riding a slow spin; the
            connected-app chip joins the orbit only when a connection is real. */}
        <div style={{ position: "relative", width: 190, height: 190 }}>
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: "1px solid var(--mv3-guide-ring)",
            }}
          />
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              animation: "mv3Spin 16s linear infinite",
            }}
          >
            {googleConnected ? (
              <span
                style={{
                  position: "absolute",
                  transform: "rotate(30deg) translateX(95px)",
                  width: 24,
                  height: 24,
                  borderRadius: 8,
                  background: "var(--mv3-chip-bg)",
                  border:
                    "1px solid color-mix(in srgb, var(--mv3-ring-active) 50%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow:
                    "0 0 14px color-mix(in srgb, var(--mv3-accent) 40%, transparent)",
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--mv3-ring-active)"
                  strokeWidth="2"
                >
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M3.5 6.5L12 13l8.5-6.5" />
                </svg>
              </span>
            ) : null}
            <span
              style={{
                position: "absolute",
                transform: "rotate(200deg) translateX(95px)",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--mv3-ring-active)",
                boxShadow:
                  "0 0 12px color-mix(in srgb, var(--mv3-ring-active) 90%, transparent)",
              }}
            />
          </div>
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: 44,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, var(--mv3-ring-glow), transparent 62%)",
              filter: "blur(18px)",
              animation: "mv3Glow 3.4s ease-in-out infinite",
            }}
          />
          <span
            style={{
              position: "absolute",
              inset: 50,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CueRing size={90} stroke="var(--mv3-text)" />
          </span>
        </div>

        <div
          style={{
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: "-0.8px",
            textAlign: "center",
            marginTop: 30,
            lineHeight: 1.15,
            animation: "mv3Rise .8s ease .2s both",
          }}
        >
          Your orbit
          <br />
          is forming.
        </div>
        <div
          style={{
            fontSize: 14.5,
            color: "var(--mv3-muted)",
            textAlign: "center",
            marginTop: 12,
            lineHeight: 1.6,
            animation: "mv3Rise .8s ease .35s both",
          }}
        >
          {receipts.length > 0 ? (
            <>
              {receipts.join(" · ")}
              <br />
            </>
          ) : null}
          Your first brief lands at 7:30 tomorrow.
        </div>
      </div>
    </Mv3OnboardingShell>
  );
}
