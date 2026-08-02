/**
 * The three Brand Kit entry-path flows (mock SET 2 · 2b–d):
 *
 *   · UploadFlow  — file drop → "extracting palette/fonts/logo/voice…" progress
 *                   → POST /brand-profiles/extract (via attachment) → draft.
 *   · WebsiteFlow — URL field → "scanning" → extract(source:website) → draft.
 *   · GuidedFlow  — 4 steps: colors → logo → fonts → voice → hand-built draft.
 *
 * Each flow resolves to a `BrandProfileInput` handed to the shared review
 * screen via `onDraft`.
 *
 * A FAILED extraction never resolves on its own. The extract endpoint does not
 * throw — an unreachable site, a blocked host, or a source with no brand signal
 * all come back HTTP 200 with an empty draft — so these flows branch on
 * `extraction.status` and stop on anything but `extracted`, showing what went
 * wrong. Continuing to the review screen is then a deliberate click, not a
 * silent hand-off that would look exactly like a successful scan.
 */

import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Upload as UploadIcon,
} from "lucide-react";

import {
  C,
  Display,
  GhostButton,
  MicroLabel,
  PALETTE_SLOTS,
  Panel,
  PrimaryButton,
  Swatch,
} from "./brand-kit-ui";
import {
  extractionSucceeded,
  readExtraction,
  toBrandInput,
  useExtractBrandProfile,
  useExtractFromUpload,
  type BrandExtraction,
  type BrandProfileInput,
} from "./use-brand-kit";
import type { BrandPath } from "./brand-entry-chooser";

// ---------------------------------------------------------------------------
// Path router — picks the flow for the chosen entry path.
// ---------------------------------------------------------------------------

export function BrandPathFlow({
  path,
  assistantId,
  onDraft,
  onBack,
}: {
  path: BrandPath;
  assistantId: string;
  onDraft: (draft: BrandProfileInput) => void;
  onBack: () => void;
}) {
  if (path === "upload") {
    return (
      <UploadFlow assistantId={assistantId} onDraft={onDraft} onBack={onBack} />
    );
  }
  if (path === "website") {
    return (
      <WebsiteFlow
        assistantId={assistantId}
        onDraft={onDraft}
        onBack={onBack}
      />
    );
  }
  return <GuidedFlow onDraft={onDraft} onBack={onBack} />;
}

// ---------------------------------------------------------------------------
// Shared: an extraction checklist row.
// ---------------------------------------------------------------------------

type CheckState = "pending" | "active" | "done";

function CheckRow({ state, label }: { state: CheckState; label: string }) {
  const color = state === "done" ? C.green : state === "active" ? C.t2 : C.t3;
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
    >
      <span
        style={{
          width: 15,
          display: "inline-flex",
          justifyContent: "center",
          color,
        }}
      >
        {state === "done" ? (
          <Check size={13} strokeWidth={2.4} />
        ) : state === "active" ? (
          <Loader2 size={12} className="bk-spin" />
        ) : (
          "○"
        )}
      </span>
      <span style={{ color }}>{label}</span>
    </div>
  );
}

/** Deterministic checklist derived from a single "loading" flag. */
function extractChecklist(loading: boolean, done: boolean): CheckState[] {
  if (done) return ["done", "done", "done", "done"];
  if (loading) return ["done", "done", "active", "pending"];
  return ["pending", "pending", "pending", "pending"];
}

// ---------------------------------------------------------------------------
// Shared: the "we got nothing" outcome.
// ---------------------------------------------------------------------------

const FAILURE_HEADLINE: Record<BrandExtraction["status"], string> = {
  // `extracted` never reaches this panel; present so the map is total.
  extracted: "Extracted",
  empty: "Nothing to extract",
  unreachable: "Couldn't reach it",
  blocked: "Couldn't reach it",
  unreadable: "Couldn't read it",
  disabled: "Extraction is off",
};

/**
 * The honest dead-end. Renders the reason, and makes continuing an explicit
 * choice — the draft behind "Build it by hand" is EMPTY, and the copy says so,
 * because a blank kit the user knowingly fills in is worth more than an
 * invented one they trust.
 *
 * State is carried by the glyph + headline text, never by colour alone.
 */
function ExtractionFailure({
  outcome,
  onRetry,
  onBuildByHand,
}: {
  outcome: BrandExtraction;
  onRetry?: () => void;
  onBuildByHand: () => void;
}) {
  return (
    <div style={failurePanel} role="status">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <AlertTriangle size={15} strokeWidth={2.2} aria-hidden />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: C.t1 }}>
          {FAILURE_HEADLINE[outcome.status]}
        </span>
      </div>
      <p
        style={{
          fontSize: 12.5,
          color: C.t1,
          margin: "8px 0 0",
          lineHeight: 1.5,
        }}
      >
        {outcome.detail}
      </p>
      <p
        style={{
          fontSize: 12.5,
          color: C.t2,
          margin: "8px 0 0",
          lineHeight: 1.5,
        }}
      >
        Nothing was pulled in, so there's no brand kit to review yet.
      </p>
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        {onRetry ? (
          <GhostButton onClick={onRetry}>Try again</GhostButton>
        ) : null}
        <GhostButton onClick={onBuildByHand}>
          Build it by hand instead
        </GhostButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function UploadFlow({
  assistantId,
  onDraft,
  onBack,
}: {
  assistantId: string;
  onDraft: (draft: BrandProfileInput) => void;
  onBack: () => void;
}) {
  const extract = useExtractFromUpload(assistantId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<BrandExtraction | null>(null);

  const run = (f: File) => {
    setFile(f);
    setFailure(null);
    extract.mutate(f, {
      onSuccess: ({ draft, extraction }) => {
        // A 200 is not a success: the endpoint returns an empty draft for
        // every failure mode. Only `extracted` carries observed values.
        if (!extractionSucceeded(extraction)) {
          setFailure(extraction);
          return;
        }
        onDraft(toBrandInput(draft, stripExt(f.name)));
      },
      onError: () => {
        setFailure({
          status: "unreadable",
          detail:
            "The upload didn't complete. Check the file and your connection, then try again.",
        });
      },
    });
  };

  const checks = extractChecklist(extract.isPending, false);

  return (
    <FlowShell label="Upload" onBack={onBack}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) run(f);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        style={{
          ...dropZone,
          borderColor: dragging ? C.blue : C.line2,
          background: dragging ? C.blueW : C.bg,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.pptx,.key,.fig,application/pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) run(f);
          }}
        />
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            background: C.sunken,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: C.t2,
          }}
        >
          <UploadIcon size={20} strokeWidth={1.8} />
        </span>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
          {file ? file.name : "Drop a deck, PDF or guidelines file"}
        </div>
        <MicroLabel>
          {extract.isPending
            ? "Extracting palette, fonts, logo, voice…"
            : "PDF · PPTX · Figma"}
        </MicroLabel>
      </div>

      {(extract.isPending || file) && !failure ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 16,
          }}
        >
          <CheckRow
            state={checks[0]}
            label="Palette — reading dominant colors"
          />
          <CheckRow state={checks[1]} label="Fonts — heading & body" />
          <CheckRow state={checks[2]} label="Logo — locating mark" />
          <CheckRow state={checks[3]} label="Voice — tone & boilerplate" />
        </div>
      ) : null}

      {failure ? (
        <ExtractionFailure
          outcome={failure}
          onRetry={file ? () => run(file) : undefined}
          onBuildByHand={() =>
            onDraft(
              toBrandInput(null, file ? stripExt(file.name) : "Untitled brand"),
            )
          }
        />
      ) : null}
    </FlowShell>
  );
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

// ---------------------------------------------------------------------------
// Website
// ---------------------------------------------------------------------------

function WebsiteFlow({
  assistantId,
  onDraft,
  onBack,
}: {
  assistantId: string;
  onDraft: (draft: BrandProfileInput) => void;
  onBack: () => void;
}) {
  const extract = useExtractBrandProfile();
  const [url, setUrl] = useState("");
  const [failure, setFailure] = useState<BrandExtraction | null>(null);

  const scan = () => {
    const trimmed = url.trim();
    if (!trimmed || extract.isPending) return;
    setFailure(null);
    extract.mutate(
      {
        path: { assistant_id: assistantId },
        body: { source: "website", ref: normalizeUrl(trimmed) },
      },
      {
        onSuccess: (res) => {
          // The scan endpoint never throws: a blocked host, a dead page, and a
          // page with no brand signal all arrive here as 200 + empty draft.
          // Handing that to the review screen is what made every domain
          // produce the same kit — so stop, and say what happened.
          const extraction = readExtraction(res);
          if (!extractionSucceeded(extraction)) {
            setFailure(extraction);
            return;
          }
          onDraft(toBrandInput(res.draft, hostLabel(trimmed)));
        },
        onError: () => {
          setFailure({
            status: "unreachable",
            detail:
              "The scan request didn't complete. Check the address and your connection, then try again.",
          });
        },
      },
    );
  };

  return (
    <FlowShell label="From your website" onBack={onBack}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: `1px solid ${C.line2}`,
          borderRadius: 12,
          padding: "4px 6px 4px 14px",
          background: C.bg,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: extract.isPending ? C.green : C.t3,
            flexShrink: 0,
          }}
        />
        <input
          value={url}
          autoFocus
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") scan();
          }}
          placeholder="northwind.co"
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            color: C.t1,
            fontSize: 15,
          }}
        />
        {extract.isPending ? (
          <MicroLabel color={C.green} style={{ paddingRight: 8 }}>
            Scanning
          </MicroLabel>
        ) : (
          <PrimaryButton onClick={scan} disabled={url.trim().length === 0}>
            Scan
          </PrimaryButton>
        )}
      </div>

      {extract.isPending ? (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              height: 110,
              borderRadius: 12,
              border: `1px solid ${C.line}`,
              background: `linear-gradient(120deg, ${C.sunken}, ${C.surface})`,
              overflow: "hidden",
              position: "relative",
            }}
          >
            <div className="bk-shimmer" style={shimmerStyle} />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
            }}
          >
            <MicroLabel>Pulling colors, fonts, logo & meta copy…</MicroLabel>
          </div>
        </div>
      ) : null}

      {failure ? (
        <ExtractionFailure
          outcome={failure}
          onRetry={scan}
          onBuildByHand={() =>
            onDraft(toBrandInput(null, hostLabel(url.trim())))
          }
        />
      ) : null}
    </FlowShell>
  );
}

function normalizeUrl(v: string): string {
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function hostLabel(v: string): string {
  const host = v.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const core = host.replace(/^www\./, "").split(".")[0] ?? host;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

// ---------------------------------------------------------------------------
// Guided — 4 steps: colors → logo → fonts → voice.
// ---------------------------------------------------------------------------

const GUIDED_STEPS = ["colors", "logo", "fonts", "voice"] as const;
type GuidedStep = (typeof GUIDED_STEPS)[number];

function GuidedFlow({
  onDraft,
  onBack,
}: {
  onDraft: (draft: BrandProfileInput) => void;
  onBack: () => void;
}) {
  const [stepIdx, setStepIdx] = useState(0);
  const [draft, setDraft] = useState<BrandProfileInput>(() =>
    toBrandInput({ source: "guided", name: "My brand" }),
  );
  const step: GuidedStep = GUIDED_STEPS[stepIdx];

  const next = () => {
    if (stepIdx < GUIDED_STEPS.length - 1) setStepIdx((i) => i + 1);
    else onDraft({ ...draft, source: "guided" });
  };
  const back = () => {
    if (stepIdx === 0) onBack();
    else setStepIdx((i) => i - 1);
  };

  return (
    <FlowShell
      label={`Guided · Step ${stepIdx + 1} / 4`}
      onBack={onBack}
      hideBackLink
    >
      {step === "colors" ? (
        <GuidedColors draft={draft} setDraft={setDraft} />
      ) : step === "logo" ? (
        <GuidedLogo draft={draft} setDraft={setDraft} />
      ) : step === "fonts" ? (
        <GuidedFonts draft={draft} setDraft={setDraft} />
      ) : (
        <GuidedVoice draft={draft} setDraft={setDraft} />
      )}

      <div style={{ height: 1, background: C.line, margin: "20px 0 16px" }} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <GhostButton onClick={back}>Back</GhostButton>
        <PrimaryButton onClick={next} full style={{ flex: 1 }}>
          {stepIdx < GUIDED_STEPS.length - 1
            ? `Next: ${GUIDED_STEPS[stepIdx + 1]}`
            : "Review brand ›"}
        </PrimaryButton>
      </div>
      <ProgressDots total={4} active={stepIdx} />
    </FlowShell>
  );
}

function GuidedColors({
  draft,
  setDraft,
}: {
  draft: BrandProfileInput;
  setDraft: (d: BrandProfileInput) => void;
}) {
  return (
    <div>
      <Display size={24} style={{ marginBottom: 16 }}>
        Pick your colors
      </Display>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {PALETTE_SLOTS.map((slot) => (
          <Swatch
            key={slot.key}
            label={slot.label}
            color={draft.palette[slot.key]}
            onChange={(hex) =>
              setDraft({
                ...draft,
                palette: { ...draft.palette, [slot.key]: hex },
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

function GuidedLogo({
  draft,
  setDraft,
}: {
  draft: BrandProfileInput;
  setDraft: (d: BrandProfileInput) => void;
}) {
  return (
    <div>
      <Display size={24} style={{ marginBottom: 6 }}>
        Add your logo
      </Display>
      <p style={{ fontSize: 13, color: C.t2, margin: "0 0 16px" }}>
        Paste a URL for now, or skip — you can drop image files on the review
        screen.
      </p>
      {(["light", "dark", "mark"] as const).map((slot) => (
        <div key={slot} style={{ marginBottom: 12 }}>
          <MicroLabel style={{ display: "block", marginBottom: 6 }}>
            {slot === "mark" ? "Mark (icon)" : `On ${slot}`}
          </MicroLabel>
          <input
            value={draft.logo[slot] ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                logo: { ...draft.logo, [slot]: e.target.value },
              })
            }
            placeholder="https://…/logo.svg"
            style={fieldStyle}
          />
        </div>
      ))}
    </div>
  );
}

const FONT_CHOICES = [
  "Instrument Serif",
  "Söhne",
  "Tiempos",
  "Inter",
  "Georgia",
  "system-ui",
];

function GuidedFonts({
  draft,
  setDraft,
}: {
  draft: BrandProfileInput;
  setDraft: (d: BrandProfileInput) => void;
}) {
  return (
    <div>
      <Display size={24} style={{ marginBottom: 16 }}>
        Choose your fonts
      </Display>
      {(["heading", "body"] as const).map((slot) => (
        <div key={slot} style={{ marginBottom: 14 }}>
          <MicroLabel style={{ display: "block", marginBottom: 6 }}>
            {slot}
          </MicroLabel>
          <input
            list={`bk-fonts-${slot}`}
            value={draft.fonts[slot] ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                fonts: { ...draft.fonts, [slot]: e.target.value },
              })
            }
            placeholder={slot === "heading" ? "Instrument Serif" : "Inter"}
            style={fieldStyle}
          />
          <datalist id={`bk-fonts-${slot}`}>
            {FONT_CHOICES.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
      ))}
    </div>
  );
}

function GuidedVoice({
  draft,
  setDraft,
}: {
  draft: BrandProfileInput;
  setDraft: (d: BrandProfileInput) => void;
}) {
  const doStr = useMemo(() => (draft.voice.doList ?? []).join(", "), [draft]);
  const dontStr = useMemo(
    () => (draft.voice.dontList ?? []).join(", "),
    [draft],
  );
  const splitList = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return (
    <div>
      <Display size={24} style={{ marginBottom: 16 }}>
        Describe your voice
      </Display>
      <MicroLabel style={{ display: "block", marginBottom: 6 }}>
        Tone
      </MicroLabel>
      <input
        value={draft.voice.tone ?? ""}
        onChange={(e) =>
          setDraft({
            ...draft,
            voice: { ...draft.voice, tone: e.target.value },
          })
        }
        placeholder="confident, plain-spoken, warm"
        style={fieldStyle}
      />
      <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
        <div style={{ flex: 1 }}>
          <MicroLabel
            color={C.green}
            style={{ display: "block", marginBottom: 6 }}
          >
            ✓ Do
          </MicroLabel>
          <input
            value={doStr}
            onChange={(e) =>
              setDraft({
                ...draft,
                voice: { ...draft.voice, doList: splitList(e.target.value) },
              })
            }
            placeholder="short sentences, active voice"
            style={fieldStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <MicroLabel
            color={C.amber}
            style={{ display: "block", marginBottom: 6 }}
          >
            ✕ Don't
          </MicroLabel>
          <input
            value={dontStr}
            onChange={(e) =>
              setDraft({
                ...draft,
                voice: { ...draft.voice, dontList: splitList(e.target.value) },
              })
            }
            placeholder="jargon, hype adjectives"
            style={fieldStyle}
          />
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <MicroLabel style={{ display: "block", marginBottom: 6 }}>
          Boilerplate
        </MicroLabel>
        <input
          value={draft.voice.boilerplate ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              voice: { ...draft.voice, boilerplate: e.target.value },
            })
          }
          placeholder="The operating system for people who build."
          style={fieldStyle}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flow chrome
// ---------------------------------------------------------------------------

function FlowShell({
  label,
  children,
  onBack,
  hideBackLink,
}: {
  label: string;
  children: React.ReactNode;
  onBack: () => void;
  hideBackLink?: boolean;
}) {
  return (
    <Panel style={{ maxWidth: 460, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <MicroLabel color={C.blue}>{label}</MicroLabel>
        {!hideBackLink ? (
          <button
            type="button"
            onClick={onBack}
            style={{
              background: "none",
              border: "none",
              color: C.t3,
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            ‹ Back
          </button>
        ) : null}
      </div>
      {children}
    </Panel>
  );
}

function ProgressDots({ total, active }: { total: number; active: number }) {
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          style={{
            flex: 1,
            height: 3,
            borderRadius: 2,
            background: i <= active ? C.blue : C.line2,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const failurePanel: CSSProperties = {
  marginTop: 16,
  border: `1px solid color-mix(in srgb, ${C.danger} 35%, transparent)`,
  background: `color-mix(in srgb, ${C.danger} 8%, transparent)`,
  borderRadius: 12,
  padding: "12px 14px",
  color: C.dangerText,
};

const dropZone: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  border: `1.5px dashed ${C.line2}`,
  borderRadius: 14,
  padding: "30px 18px",
  cursor: "pointer",
  transition: "border-color .12s, background .12s",
};

const fieldStyle: CSSProperties = {
  width: "100%",
  border: `1px solid ${C.line2}`,
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 14,
  color: C.t1,
  background: C.bg,
  outline: "none",
  boxSizing: "border-box",
};

const shimmerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--mv1-green) 22%, transparent) 50%, transparent 80%)",
};

/** Keyframes for the spinner + website-scan shimmer. */
export function BrandPathsStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: [
          "@keyframes bk-spin{to{transform:rotate(360deg)}}",
          ".bk-spin{animation:bk-spin .8s linear infinite}",
          "@keyframes bk-shimmer{0%{transform:translateX(-60%)}100%{transform:translateX(60%)}}",
          ".bk-shimmer{animation:bk-shimmer 1.4s ease-in-out infinite}",
        ].join("\n"),
      }}
    />
  );
}
