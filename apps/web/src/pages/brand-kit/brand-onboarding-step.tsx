/**
 * Onboarding step — "Make everything look like you" (mock SET 2 · 2f–g).
 *
 * A skippable step in the connect-your-world (HQ first-run) flow. The intro
 * frame offers the three entry paths (Upload / Website / Guided) with an
 * "I'll do this later" escape and a Continue; picking a path drops into the
 * shared BrandKitStudio so the whole build+review happens inline, then
 * `onDone` advances the flow. Reuses the app's `C`/serif tokens, so it follows
 * the same light/dark + 390px treatment as the rest of setup.
 */

import { useState, type CSSProperties } from "react";
import { FileText, Globe, PencilLine } from "lucide-react";

import { useIsMobile } from "@/hooks/use-is-mobile";

import { C, Display, MicroLabel, PrimaryButton, serif } from "./brand-kit-ui";
import { BrandKitStudio } from "./brand-kit-page";
import type { BrandPath } from "./brand-entry-chooser";

const INTRO_PATHS: Array<{
  path: BrandPath;
  icon: typeof FileText;
  tint: string;
  title: string;
}> = [
  { path: "upload", icon: FileText, tint: C.blue, title: "Upload" },
  { path: "website", icon: Globe, tint: C.green, title: "Website" },
  { path: "guided", icon: PencilLine, tint: C.violet, title: "Guided" },
];

export function BrandOnboardingStep({
  stepLabel = "Connect your world · Step 4 / 5",
  onContinue,
  onSkip,
}: {
  stepLabel?: string;
  /** Advance the flow (after Continue or a successful save). */
  onContinue: () => void;
  /** "I'll do this later" — skip the step entirely. */
  onSkip: () => void;
}) {
  const isMobile = useIsMobile();
  const [started, setStarted] = useState(false);

  if (started) {
    // Inline the full studio; a save advances via onDone.
    return (
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <BrandKitStudio compact onDone={onContinue} onSkip={onSkip} />
      </div>
    );
  }

  return (
    <div style={introShell}>
      <div style={{ marginBottom: 20 }}>
        <MicroLabel color={C.t3}>{stepLabel}</MicroLabel>
      </div>

      <div style={{ textAlign: "center" }}>
        <Display size={isMobile ? 27 : 32} style={{ marginBottom: 12 }}>
          Make everything look like{" "}
          <span style={{ fontStyle: "italic" }}>you</span>
        </Display>
        <p
          style={{
            fontSize: 13.5,
            color: C.t2,
            lineHeight: 1.55,
            maxWidth: 420,
            margin: "0 auto 22px",
          }}
        >
          Add your brand once and every deck, doc and image Cue makes comes out
          in your colors, fonts and voice.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          marginBottom: 22,
        }}
      >
        {INTRO_PATHS.map((p) => {
          const Icon = p.icon;
          return (
            <button
              key={p.path}
              type="button"
              onClick={() => setStarted(true)}
              style={introCard}
            >
              <span
                style={{
                  color: p.tint,
                  display: "inline-flex",
                  marginBottom: 8,
                }}
              >
                <Icon size={18} strokeWidth={1.8} />
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: C.t1 }}>
                {p.title}
              </span>
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
        }}
      >
        <button type="button" onClick={onSkip} style={skipStyle}>
          I'll do this later
        </button>
        <PrimaryButton onClick={() => setStarted(true)}>Continue</PrimaryButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const introShell: CSSProperties = {
  maxWidth: 520,
  margin: "0 auto",
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 22,
  padding: 28,
};

const introCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 2,
  background: C.bg,
  border: `1px solid ${C.line2}`,
  borderRadius: 14,
  padding: "20px 10px",
  cursor: "pointer",
  fontFamily: serif,
};

const skipStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: C.t3,
  fontSize: 13,
  cursor: "pointer",
  padding: "6px 2px",
};
