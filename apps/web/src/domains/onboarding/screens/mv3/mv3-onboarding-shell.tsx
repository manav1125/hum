/**
 * Mv3OnboardingShell — the shared mobile-v3 onboarding canvas (spec frames
 * 14/26/27/28): aurora over the mv3 background, a mono "STEP N OF 4" eyebrow
 * with optional Skip, the step's content, and one full-width CTA pinned above
 * the home indicator. Mobile-only call sites (pre-chat-flow gates on
 * `useMobileLayout`); desktop onboarding keeps its existing screens untouched.
 */
import { haptic } from "@/utils/haptics";

const SAFE_TOP = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";
const SAFE_BOTTOM =
  "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))";

export function Mv3OnboardingShell({
  step,
  onBack,
  onSkip,
  cta,
  ctaDisabled,
  ctaVariant = "accent",
  onCta,
  children,
  centered = false,
}: {
  /** "STEP 1 OF 4" eyebrow text. Omit to hide the row (frame 28). */
  step?: string;
  /** Optional ‹ back affordance ahead of the eyebrow. */
  onBack?: () => void;
  onSkip?: () => void;
  cta: string;
  ctaDisabled?: boolean;
  /** accent = blue gradient (frames 14/26/27); ink = white/ink (frame 28). */
  ctaVariant?: "accent" | "ink";
  onCta: () => void;
  children: React.ReactNode;
  /** Center the content column vertically (frames 26/28). */
  centered?: boolean;
}) {
  return (
    <div
      data-mv3
      data-slot="mv3-onboarding"
      style={{
        position: "relative",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: "-20%",
          background:
            "radial-gradient(46% 36% at 50% 28%, var(--mv3-aurora), transparent 68%)",
          filter: "blur(32px)",
          animation: "mv3Aur 11s ease-in-out infinite",
          pointerEvents: "none",
          willChange: "transform",
        }}
      />

      {step || onSkip ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: `calc(${SAFE_TOP} + 14px) 26px 0`,
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            {onBack ? (
              <button
                type="button"
                aria-label="Back"
                className="cue-pressable"
                onClick={() => {
                  haptic.light();
                  onBack();
                }}
                style={{
                  fontSize: 17,
                  color: "var(--mv3-micro)",
                  background: "none",
                  border: "none",
                  padding: "8px 10px 8px 0",
                  minHeight: 44,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  lineHeight: 1,
                }}
              >
                ‹
              </button>
            ) : null}
            <span
              style={{
                fontFamily: "var(--mv3-mono)",
                fontSize: 10.5,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--mv3-micro)",
              }}
            >
              {step ?? ""}
            </span>
          </span>
          {onSkip ? (
            <button
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                onSkip();
              }}
              style={{
                fontSize: 13,
                color: "var(--mv3-faint)",
                background: "none",
                border: "none",
                padding: "10px 0 10px 16px",
                minHeight: 44,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Skip
            </button>
          ) : null}
        </div>
      ) : (
        <div style={{ height: `calc(${SAFE_TOP} + 14px)`, flexShrink: 0 }} />
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          justifyContent: centered ? "center" : "flex-start",
          padding: centered ? "0 28px" : "12px 26px 0",
          position: "relative",
          zIndex: 2,
        }}
      >
        {children}
      </div>

      <div
        style={{
          flexShrink: 0,
          padding: `12px 20px calc(10px + ${SAFE_BOTTOM})`,
          position: "relative",
          zIndex: 5,
        }}
      >
        <button
          type="button"
          className="cue-pressable"
          disabled={ctaDisabled}
          onClick={() => {
            haptic.medium();
            onCta();
          }}
          style={{
            width: "100%",
            border: "none",
            borderRadius: 16,
            padding: 16,
            minHeight: 52,
            fontSize: 16,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
            opacity: ctaDisabled ? 0.55 : 1,
            ...(ctaVariant === "ink"
              ? {
                  background: "var(--mv3-text)",
                  color: "var(--mv3-bg)",
                  boxShadow:
                    "0 12px 40px -8px color-mix(in srgb, var(--mv3-text) 30%, transparent)",
                }
              : {
                  background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
                  color: "#ffffff",
                  boxShadow: "0 16px 36px -12px rgba(61,110,232,.6)",
                }),
          }}
        >
          {cta}
        </button>
      </div>
    </div>
  );
}
