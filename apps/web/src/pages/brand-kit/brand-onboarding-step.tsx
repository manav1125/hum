/**
 * Onboarding step — "Everything Cue makes, in your brand" (design SET 8 · BrandSetup).
 *
 * A skippable step in the connect-your-world (HQ first-run) flow. When the
 * active assistant already has an extracted/saved brand profile we drop straight
 * into the high-fidelity brand board: a before→after "live preview" hero
 * (generic deck vs. the same deck in the user's brand), then palette / type /
 * logos / voice cards, all bound to the REAL extracted brand data. Save & apply
 * persists + activates the kit (POST/PATCH + activate), "Add another brand"
 * re-opens the entry chooser, and Skip advances the flow.
 *
 * With no brand yet we fall back to the existing BrandKitStudio (chooser → path
 * → extract) so a first-time user can still build one; a successful save lands
 * back on this board.
 *
 * Everything visual reuses the app's `C` / serif / mono tokens so the step rides
 * the same light/dark theming as the rest of setup.
 */

import { useEffect, useState, type CSSProperties } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useIsMobile } from "@/hooks/use-is-mobile";

import { C, mono, serif } from "./brand-kit-ui";
import { BrandKitStudio } from "./brand-kit-page";
import {
  toBrandInput,
  useActivateBrandProfile,
  useBrandProfiles,
  useCreateBrandProfile,
  useUpdateBrandProfile,
  brandKitPath,
  type BrandProfile,
  type BrandProfileInput,
} from "./use-brand-kit";

export function BrandOnboardingStep({
  stepLabel = "Brand profile",
  onContinue,
  onSkip,
}: {
  stepLabel?: string;
  /** Advance the flow (after Continue or a successful save). */
  onContinue: () => void;
  /** "I'll do this later" — skip the step entirely. */
  onSkip: () => void;
}) {
  const assistantId = useActiveAssistantId();
  const { active, isLoading } = useBrandProfiles(assistantId);

  // "Add another" / no-kit users route through the studio (chooser → extract);
  // a save there advances the flow just like the board's own Save.
  const [studio, setStudio] = useState(false);

  if (isLoading && !studio) {
    return (
      <div style={{ maxWidth: 920, margin: "0 auto", padding: 40, textAlign: "center" }}>
        <span style={microLabel}>Loading your brand…</span>
      </div>
    );
  }

  if (studio || !active) {
    return (
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <BrandKitStudio compact onDone={onContinue} onSkip={onSkip} />
      </div>
    );
  }

  return (
    <BrandBoard
      key={active.id}
      assistantId={assistantId}
      profile={active}
      stepLabel={stepLabel}
      onSaved={onContinue}
      onSkip={onSkip}
      onAddAnother={() => setStudio(true)}
    />
  );
}

// ---------------------------------------------------------------------------
// The brand board — the SET 8 mock, bound to the real active profile.
// ---------------------------------------------------------------------------

function BrandBoard({
  assistantId,
  profile,
  stepLabel,
  onSaved,
  onSkip,
  onAddAnother,
}: {
  assistantId: string;
  profile: BrandProfile;
  stepLabel: string;
  onSaved: () => void;
  onSkip: () => void;
  onAddAnother: () => void;
}) {
  const isMobile = useIsMobile();

  // The board edits a working copy; every field is bound to the real profile.
  const [draft, setDraft] = useState<BrandProfileInput>(() => toBrandInput(profile));
  useEffect(() => setDraft(toBrandInput(profile)), [profile]);

  // Save & apply — PATCH the existing kit and make sure it's the active one.
  // (Identical wiring to brand-review's save path; the board only restyles it.)
  const update = useUpdateBrandProfile(assistantId);
  const activate = useActivateBrandProfile(assistantId);
  const create = useCreateBrandProfile(assistantId);
  const [saved, setSaved] = useState(false);
  const saving = update.isPending || activate.isPending || create.isPending;
  const errored = (update.isError || create.isError) && !saving;

  const save = () => {
    if (saving) return;
    setSaved(false);
    const body = {
      name: draft.name,
      palette: draft.palette,
      fonts: draft.fonts,
      logo: draft.logo,
      voice: draft.voice,
      assets: draft.assets,
      source: draft.source,
    };
    update.mutate(
      { path: { ...brandKitPath(assistantId), bid: profile.id }, body },
      {
        onSuccess: () => {
          if (profile.isActive !== 1) {
            activate.mutate({
              path: { ...brandKitPath(assistantId), bid: profile.id },
            });
          }
          setSaved(true);
          onSaved();
        },
      },
    );
  };

  // Derived, data-driven brand tokens for the preview + swatches.
  const primary = draft.palette.primary || C.blue;
  const accent = draft.palette.accent || primary;
  const brandBg = draft.palette.bg || "#FBF9F4";
  const brandSurface = draft.palette.surface || "#ffffff";
  const brandText = draft.palette.text || "#1A2230";
  const brandName = draft.name || "Your brand";
  const initial = (brandName.trim()[0] ?? "B").toUpperCase();
  const headingFont = draft.fonts.heading || serif;
  const bodyFont = draft.fonts.body || "'DM Sans', system-ui, sans-serif";

  return (
    <div style={{ width: "100%", maxWidth: 920, margin: "0 auto" }}>
      <div style={shell}>
        {/* ── header: step microlabel + progress ── */}
        <div style={{ padding: isMobile ? "22px 20px 0" : "26px 34px 0" }}>
          <div style={headerRow}>
            <span style={microLabel}>{stepLabel}</span>
            <ProgressDots />
          </div>
          <h1
            style={{
              fontFamily: serif,
              fontSize: isMobile ? 28 : 34,
              fontWeight: 400,
              letterSpacing: "-0.4px",
              margin: "16px 0 0",
              lineHeight: 1.1,
              color: C.t1,
            }}
          >
            Everything Cue makes,{" "}
            <span style={{ fontStyle: "italic", color: C.blue }}>in your brand</span>
          </h1>
          <p
            style={{
              fontSize: 14,
              color: C.t2,
              margin: "9px 0 0",
              maxWidth: 560,
              lineHeight: 1.5,
            }}
          >
            Decks, docs, emails, posts — all styled the way your company already
            looks. We pulled this from your brand; tune anything below.
          </p>
        </div>

        {/* ── HERO: before → after live preview ── */}
        <div style={{ padding: isMobile ? "18px 20px 0" : "22px 34px 0" }}>
          <PreviewHero
            isMobile={isMobile}
            brandName={brandName}
            initial={initial}
            headingFont={headingFont}
            primary={primary}
            accent={accent}
            brandBg={brandSurface /* the deck's surface = the "paper" it sits on */}
            brandText={brandText}
          />
        </div>

        {/* ── brand board: palette · type · logos · voice ── */}
        <div style={{ padding: isMobile ? "16px 20px 0" : "20px 34px 0" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
              gap: 12,
            }}
          >
            <PaletteCard
              primary={primary}
              accent={accent}
              bg={brandBg}
              surface={brandSurface}
              text={brandText}
            />
            <TypeCard
              headingFont={headingFont}
              bodyFont={bodyFont}
              headingName={draft.fonts.heading || "Instrument Serif"}
              bodyName={draft.fonts.body || "DM Sans"}
            />
            <LogosCard
              brandName={brandName}
              initial={initial}
              headingFont={headingFont}
              primary={primary}
              brandText={brandText}
              logo={draft.logo}
              onReplace={onAddAnother}
            />
            <VoiceCard voice={draft.voice} />
          </div>
        </div>

        {errored ? (
          <div style={{ padding: isMobile ? "14px 20px 0" : "14px 34px 0" }}>
            <div style={errorBanner}>Couldn't save — please try again.</div>
          </div>
        ) : null}

        {/* ── footer actions ── */}
        <div
          style={{
            padding: isMobile ? "18px 20px 22px" : "20px 34px 26px",
            marginTop: 6,
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <button type="button" onClick={onAddAnother} style={addBrandBtn}>
            + Add another brand
          </button>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onSkip} style={skipBtn}>
            Skip
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            style={{ ...saveBtn, opacity: saving ? 0.6 : 1 }}
          >
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save & apply everywhere"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero — the emotional centerpiece: generic deck vs. the same deck rebranded.
// ---------------------------------------------------------------------------

function PreviewHero({
  isMobile,
  brandName,
  initial,
  headingFont,
  primary,
  accent,
  brandBg,
  brandText,
}: {
  isMobile: boolean;
  brandName: string;
  initial: string;
  headingFont: string;
  primary: string;
  accent: string;
  brandBg: string;
  brandText: string;
}) {
  // On desktop both decks sit side-by-side; on mobile a Before/After toggle
  // swaps between them so the reveal still lands in a single column.
  const [side, setSide] = useState<"before" | "after">("after");

  const before = (
    <div style={{ ...heroCell, borderRight: isMobile ? "none" : `1px solid ${C.line}` }}>
      <span style={{ ...heroTag, color: C.t3 }}>GENERIC</span>
      <div style={genericDeck}>
        <div style={genericMark}>◇</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: "#333", letterSpacing: "-0.3px" }}>
            Q3 Growth Review
          </div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 5 }}>
            Prepared for the leadership team
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <span style={{ width: 40, height: 5, borderRadius: 3, background: "#DADFE6" }} />
          <span style={{ width: 24, height: 5, borderRadius: 3, background: "#E7ECF3" }} />
        </div>
      </div>
    </div>
  );

  const after = (
    <div
      style={{
        ...heroCell,
        background: `linear-gradient(180deg, ${C.surface}, color-mix(in srgb, ${primary} 8%, ${C.surface}))`,
      }}
    >
      <span style={{ ...heroTag, color: C.blueText, display: "flex", alignItems: "center", gap: 5 }}>
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: C.blue,
            boxShadow: `0 0 0 3px color-mix(in srgb, ${C.blue} 18%, transparent)`,
          }}
        />
        {brandName}
      </span>
      <div
        style={{
          ...deckBase,
          background: brandBg,
          border: "1px solid rgba(0,0,0,.06)",
          boxShadow: `0 14px 34px -16px color-mix(in srgb, ${primary} 40%, transparent)`,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: primary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontFamily: headingFont,
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          {initial}
        </div>
        <div>
          <div
            style={{
              fontFamily: headingFont,
              fontSize: 20,
              fontWeight: 600,
              color: brandText,
              letterSpacing: "-0.2px",
            }}
          >
            Q3 Growth Review
          </div>
          <div style={{ fontSize: 11, color: brandText, opacity: 0.6, marginTop: 5 }}>
            Prepared for the leadership team
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ width: 40, height: 5, borderRadius: 3, background: primary }} />
          <span style={{ width: 24, height: 5, borderRadius: 3, background: accent }} />
        </div>
      </div>
    </div>
  );

  return (
    <div style={heroFrame}>
      <div style={heroBar}>
        <span style={{ ...microLabel, fontSize: 10 }}>LIVE PREVIEW · SAME DECK, YOUR BRAND</span>
        <div style={toggleWrap}>
          <button
            type="button"
            onClick={() => setSide("before")}
            style={toggleBtn(side === "before")}
          >
            Before
          </button>
          <button
            type="button"
            onClick={() => setSide("after")}
            style={toggleBtn(side === "after")}
          >
            In your brand
          </button>
        </div>
      </div>
      {isMobile ? (
        side === "before" ? before : after
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
          {before}
          {after}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function PaletteCard({
  primary,
  accent,
  bg,
  surface,
  text,
}: {
  primary: string;
  accent: string;
  bg: string;
  surface: string;
  text: string;
}) {
  const slots: Array<{ label: string; color: string; bordered?: boolean }> = [
    { label: "Primary", color: primary },
    { label: "Accent", color: accent },
    { label: "Bg", color: bg, bordered: true },
    { label: "Surface", color: surface, bordered: true },
    { label: "Text", color: text },
  ];
  return (
    <div style={card}>
      <div style={{ ...microLabel, marginBottom: 12 }}>PALETTE</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {slots.map((s) => (
          <div key={s.label} style={{ textAlign: "center" }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 11,
                background: s.color,
                border: s.bordered ? `1px solid ${C.line}` : "none",
                boxShadow: s.bordered
                  ? "none"
                  : `0 6px 14px -8px color-mix(in srgb, ${s.color} 70%, transparent)`,
              }}
            />
            <div style={{ ...swatchLabel }}>{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

function TypeCard({
  headingFont,
  bodyFont,
  headingName,
  bodyName,
}: {
  headingFont: string;
  bodyFont: string;
  headingName: string;
  bodyName: string;
}) {
  return (
    <div style={card}>
      <div style={{ ...microLabel, marginBottom: 12 }}>TYPE</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={typeRow}>
          <span style={{ fontFamily: headingFont, fontSize: 22, fontWeight: 600, color: C.t1 }}>
            Heading
          </span>
          <span style={fontName}>{headingName}</span>
        </div>
        <div style={{ height: 1, background: C.line }} />
        <div style={typeRow}>
          <span style={{ fontFamily: bodyFont, fontSize: 15, color: C.t1 }}>
            Body copy sets the tone.
          </span>
          <span style={fontName}>{bodyName}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logos — on light / on dark / mark. Names are contained + ellipsis-truncated
// (fixes the old cramped-logo overflow).
// ---------------------------------------------------------------------------

function LogosCard({
  brandName,
  initial,
  headingFont,
  primary,
  brandText,
  logo,
  onReplace,
}: {
  brandName: string;
  initial: string;
  headingFont: string;
  primary: string;
  brandText: string;
  logo: BrandProfileInput["logo"];
  onReplace: () => void;
}) {
  return (
    <div style={{ ...card, gridColumn: "1 / -1" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={microLabel}>LOGOS</div>
        <button type="button" onClick={onReplace} style={replaceBtn}>
          Replace
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <LogoTile caption="ON LIGHT" panelBg="#ffffff">
          <LogoLockup
            src={logo.light}
            initial={initial}
            markBg={primary}
            markFg="#fff"
            headingFont={headingFont}
            name={brandName}
            nameColor={brandText}
          />
        </LogoTile>
        <LogoTile caption="ON DARK" panelBg={brandText}>
          <LogoLockup
            src={logo.dark}
            initial={initial}
            markBg="#fff"
            markFg={primary}
            headingFont={headingFont}
            name={brandName}
            nameColor="#fff"
          />
        </LogoTile>
        <LogoTile caption="MARK" panelBg={C.bg}>
          {logo.mark ? (
            <img
              src={logo.mark}
              alt=""
              style={{ maxHeight: 38, maxWidth: "100%", objectFit: "contain" }}
            />
          ) : (
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: primary,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontFamily: headingFont,
                fontSize: 20,
                fontWeight: 600,
              }}
            >
              {initial}
            </span>
          )}
        </LogoTile>
      </div>
    </div>
  );
}

function LogoTile({
  caption,
  panelBg,
  children,
}: {
  caption: string;
  panelBg: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
      <div
        style={{
          height: 74,
          background: panelBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 12,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
      <div
        style={{
          ...microLabel,
          fontSize: 9,
          padding: "6px 10px",
          borderTop: `1px solid ${C.line}`,
          background: C.surface,
        }}
      >
        {caption}
      </div>
    </div>
  );
}

function LogoLockup({
  src,
  initial,
  markBg,
  markFg,
  headingFont,
  name,
  nameColor,
}: {
  src?: string;
  initial: string;
  markBg: string;
  markFg: string;
  headingFont: string;
  name: string;
  nameColor: string;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={{ maxHeight: 30, maxWidth: "100%", objectFit: "contain" }}
      />
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: "100%" }}>
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: markBg,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: markFg,
          fontFamily: headingFont,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {initial}
      </span>
      <span
        style={{
          fontFamily: headingFont,
          fontSize: 15,
          fontWeight: 600,
          color: nameColor,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {name}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice — tone chips + do/don't, bound to the extracted voice (skipped if empty).
// ---------------------------------------------------------------------------

function VoiceCard({ voice }: { voice: BrandProfileInput["voice"] }) {
  const toneChips = (voice.tone ?? "")
    .split(/[,·]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const doList = voice.doList ?? [];
  const dontList = voice.dontList ?? [];
  const hasVoice = toneChips.length > 0 || doList.length > 0 || dontList.length > 0;
  if (!hasVoice) return null;
  return (
    <div style={{ ...card, gridColumn: "1 / -1" }}>
      <div style={{ ...microLabel, marginBottom: 12 }}>VOICE</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        {toneChips.length ? (
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontSize: 12.5, color: C.t2, marginBottom: 7 }}>Tone</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {toneChips.map((t) => (
                <span key={t} style={toneChip}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {doList.length || dontList.length ? (
          <div style={{ flex: 1, minWidth: 180, display: "flex", gap: 12 }}>
            {doList.length ? (
              <div style={{ flex: 1 }}>
                <div style={{ ...doDontLabel, color: C.green }}>DO</div>
                <div style={doDontText}>{doList.join(". ")}.</div>
              </div>
            ) : null}
            {dontList.length ? (
              <div style={{ flex: 1 }}>
                <div style={{ ...doDontLabel, color: C.danger }}>DON'T</div>
                <div style={doDontText}>{dontList.join(", ")}.</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress — 5 of 6 filled (STEP 5 OF 6 in the mock).
// ---------------------------------------------------------------------------

function ProgressDots() {
  const total = 6;
  const filled = 5;
  return (
    <div style={{ display: "flex", gap: 5 }}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          style={{
            width: 22,
            height: 4,
            borderRadius: 2,
            background: i < filled ? C.blue : C.line2,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const shell: CSSProperties = {
  width: "100%",
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 26,
  boxShadow: "0 40px 90px -50px rgba(26,34,48,.5)",
  overflow: "hidden",
};

const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const microLabel: CSSProperties = {
  fontFamily: mono,
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: C.t3,
};

const heroFrame: CSSProperties = {
  border: `1px solid ${C.line}`,
  borderRadius: 18,
  overflow: "hidden",
  background: C.bg,
};

const heroBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "12px 16px",
  borderBottom: `1px solid ${C.line}`,
  flexWrap: "wrap",
};

const toggleWrap: CSSProperties = {
  display: "inline-flex",
  background: C.sunken,
  borderRadius: 8,
  padding: 2,
  gap: 2,
};

function toggleBtn(active: boolean): CSSProperties {
  return {
    border: "none",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 11.5,
    fontWeight: 500,
    borderRadius: 6,
    padding: "5px 12px",
    whiteSpace: "nowrap",
    background: active ? C.surface : "transparent",
    color: active ? C.t1 : C.t3,
  };
}

const heroCell: CSSProperties = {
  padding: 22,
  position: "relative",
};

const heroTag: CSSProperties = {
  position: "absolute",
  top: 14,
  left: 14,
  fontFamily: mono,
  fontSize: 9,
  letterSpacing: "0.1em",
};

const deckBase: CSSProperties = {
  aspectRatio: "16 / 10",
  borderRadius: 10,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  marginTop: 8,
};

const genericDeck: CSSProperties = {
  ...deckBase,
  background: "#fff",
  border: "1px solid #E5E9F0",
  boxShadow: "0 8px 24px -16px rgba(0,0,0,.3)",
};

const genericMark: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 7,
  background: "#E7ECF3",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#98A2AF",
  fontSize: 13,
  fontWeight: 700,
};

const card: CSSProperties = {
  border: `1px solid ${C.line}`,
  borderRadius: 16,
  padding: "16px 18px",
  background: C.surface,
};

const swatchLabel: CSSProperties = {
  fontFamily: mono,
  fontSize: 9,
  color: C.t3,
  marginTop: 6,
};

const typeRow: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 10,
};

const fontName: CSSProperties = {
  fontFamily: mono,
  fontSize: 10,
  color: C.t3,
  whiteSpace: "nowrap",
};

const toneChip: CSSProperties = {
  fontSize: 12,
  background: C.blueW,
  color: C.blueS,
  border: `1px solid color-mix(in srgb, ${C.blue} 30%, transparent)`,
  borderRadius: 999,
  padding: "5px 12px",
};

const doDontLabel: CSSProperties = {
  fontSize: 11,
  fontFamily: mono,
  marginBottom: 6,
};

const doDontText: CSSProperties = {
  fontSize: 12.5,
  color: C.t2,
  lineHeight: 1.5,
};

const addBrandBtn: CSSProperties = {
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 500,
  color: C.blueS,
  background: C.surface,
  border: `1px solid color-mix(in srgb, ${C.blue} 30%, transparent)`,
  borderRadius: 11,
  padding: "12px 18px",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
};

const replaceBtn: CSSProperties = {
  fontFamily: "inherit",
  fontSize: 11.5,
  color: C.blueS,
  background: C.blueW,
  border: `1px solid color-mix(in srgb, ${C.blue} 25%, transparent)`,
  borderRadius: 8,
  padding: "5px 11px",
  cursor: "pointer",
};

const skipBtn: CSSProperties = {
  fontFamily: "inherit",
  fontSize: 14,
  fontWeight: 500,
  color: C.t2,
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: "12px 8px",
};

const saveBtn: CSSProperties = {
  fontFamily: "inherit",
  fontSize: 14,
  fontWeight: 500,
  color: "#fff",
  background: C.ink,
  border: "none",
  borderRadius: 11,
  padding: "12px 24px",
  cursor: "pointer",
};

const errorBanner: CSSProperties = {
  fontFamily: mono,
  fontSize: 12,
  color: C.danger,
  background: `color-mix(in srgb, ${C.danger} 10%, transparent)`,
  border: `1px solid color-mix(in srgb, ${C.danger} 35%, transparent)`,
  borderRadius: 10,
  padding: "10px 12px",
};
