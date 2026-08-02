/**
 * Brand Profile review/edit — the shared destination all three paths converge
 * on, and the body of the Settings → Brand screen (mock SET 2 · 2e).
 *
 * Sections: palette swatches (edit/add), type specimens (heading/body), logo
 * on light + dark + mark, voice (tone + do/don't + boilerplate), and a live
 * "same deck in your brand" preview. Header carries "+ Add another brand" and
 * "Save & apply everywhere".
 *
 * Wiring:
 *   · Save (new draft)   → POST /brand-profiles         (first profile = active)
 *   · Save (existing)    → PATCH /brand-profiles/:bid
 *   · "apply everywhere" → PATCH /brand-profiles/:bid/activate
 * On a fresh save the newly-created profile is activated so the kit applies to
 * every Create output immediately (matching "Save & apply everywhere").
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";

import {
  C,
  CardAction,
  GhostButton,
  MicroLabel,
  PALETTE_SLOTS,
  Panel,
  PrimaryButton,
  SectionHead,
  Swatch,
  Tag,
  BrandPreviewSlide,
  mono,
  serif,
} from "./brand-kit-ui";
import {
  useActivateBrandProfile,
  useCreateBrandProfile,
  useUpdateBrandProfile,
  brandKitPath,
  type BrandProfile,
  type BrandProfileInput,
} from "./use-brand-kit";

export function BrandReview({
  assistantId,
  initial,
  existing,
  onSaved,
  onAddAnother,
}: {
  assistantId: string;
  /** The draft/profile to edit. */
  initial: BrandProfileInput;
  /** When editing a saved profile, its id + active flag (enables PATCH path). */
  existing?: Pick<BrandProfile, "id" | "isActive"> | null;
  onSaved?: (profileId: string) => void;
  onAddAnother?: () => void;
}) {
  const isMobile = useIsMobile();
  const [draft, setDraft] = useState<BrandProfileInput>(initial);
  useEffect(() => setDraft(initial), [initial]);

  const create = useCreateBrandProfile(assistantId);
  const update = useUpdateBrandProfile(assistantId);
  const activate = useActivateBrandProfile(assistantId);
  const [saved, setSaved] = useState(false);

  const saving = create.isPending || update.isPending || activate.isPending;
  const sourceLabel = draft.source ? `From ${draft.source}` : "Brand profile";

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
    if (existing?.id) {
      update.mutate(
        {
          path: { ...brandKitPath(assistantId), bid: existing.id },
          body,
        },
        {
          onSuccess: () => {
            // Ensure it's the applied kit.
            if (existing.isActive !== 1) {
              activate.mutate({
                path: { ...brandKitPath(assistantId), bid: existing.id },
              });
            }
            setSaved(true);
            onSaved?.(existing.id);
          },
        },
      );
    } else {
      create.mutate(
        { path: brandKitPath(assistantId), body },
        {
          onSuccess: (res) => {
            const id = res.brandProfile.id;
            // A freshly-saved kit becomes the one applied everywhere.
            if (res.brandProfile.isActive !== 1) {
              activate.mutate({
                path: { ...brandKitPath(assistantId), bid: id },
              });
            }
            setSaved(true);
            onSaved?.(id);
          },
        },
      );
    }
  };

  return (
    <div>
      {/* Header row */}
      <div
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "flex-start" : "center",
          justifyContent: "space-between",
          gap: 14,
          marginBottom: 22,
        }}
      >
        <div>
          <MicroLabel color={C.blue}>Brand profile · {sourceLabel}</MicroLabel>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={{
              display: "block",
              fontFamily: serif,
              fontSize: isMobile ? 30 : 38,
              fontWeight: 400,
              color: C.t1,
              background: "transparent",
              border: "none",
              outline: "none",
              padding: 0,
              marginTop: 8,
              width: "100%",
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {onAddAnother ? (
            <GhostButton onClick={onAddAnother}>
              + Add another brand
            </GhostButton>
          ) : null}
          <PrimaryButton onClick={save} disabled={saving}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save & apply everywhere"}
          </PrimaryButton>
        </div>
      </div>

      {(create.isError || update.isError) && !saving ? (
        <div style={errorBanner}>Couldn't save — please try again.</div>
      ) : null}

      {/* Two-column grid: identity (palette+type+voice) | logo+preview */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <PaletteCard draft={draft} setDraft={setDraft} />
          <TypeCard draft={draft} setDraft={setDraft} />
          <VoiceCard draft={draft} setDraft={setDraft} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <LogoCard draft={draft} setDraft={setDraft} />
          <PreviewCard draft={draft} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function PaletteCard({
  draft,
  setDraft,
}: {
  draft: BrandProfileInput;
  setDraft: (d: BrandProfileInput) => void;
}) {
  const [editing, setEditing] = useState(false);
  const setSlot = (key: (typeof PALETTE_SLOTS)[number]["key"], hex: string) =>
    setDraft({ ...draft, palette: { ...draft.palette, [key]: hex } });
  return (
    <Panel>
      <SectionHead
        label="Palette"
        action={
          <CardAction onClick={() => setEditing((v) => !v)}>
            {editing ? "Done" : "Edit"}
          </CardAction>
        }
      />
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {PALETTE_SLOTS.map((slot) => (
          <Swatch
            key={slot.key}
            label={slot.label}
            color={draft.palette[slot.key]}
            onChange={editing ? (hex) => setSlot(slot.key, hex) : undefined}
          />
        ))}
        {editing ? (
          <span
            style={{ display: "inline-flex", flexDirection: "column", gap: 6 }}
          >
            <span style={addSwatch} aria-hidden>
              +
            </span>
            <MicroLabel style={{ fontSize: 9 }}>Add</MicroLabel>
          </span>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Type specimens
// ---------------------------------------------------------------------------

function TypeCard({
  draft,
  setDraft,
}: {
  draft: BrandProfileInput;
  setDraft: (d: BrandProfileInput) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <Panel>
      <SectionHead
        label="Type"
        action={
          <CardAction onClick={() => setEditing((v) => !v)}>
            {editing ? "Done" : "Change"}
          </CardAction>
        }
      />
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ minWidth: 130 }}>
          {/* An undetected font used to render as the literal word "Tiempos"
              (and "Söhne" below) in the specimen slot — a real typeface name,
              indistinguishable from a detected one, identical for every brand.
              An absent value now reads as absent. */}
          <div
            style={{
              fontFamily: draft.fonts.heading || serif,
              fontSize: draft.fonts.heading ? 30 : 20,
              color: draft.fonts.heading ? C.t1 : C.t2,
              lineHeight: 1.2,
            }}
          >
            {draft.fonts.heading || "— not detected"}
          </div>
          <MicroLabel style={{ display: "block", marginTop: 6 }}>
            Heading · serif
          </MicroLabel>
          {editing ? (
            <input
              value={draft.fonts.heading ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  fonts: { ...draft.fonts, heading: e.target.value },
                })
              }
              placeholder="Instrument Serif"
              style={miniField}
            />
          ) : null}
        </div>
        <div style={{ minWidth: 130 }}>
          <div
            style={{
              fontFamily: draft.fonts.body || "inherit",
              fontSize: draft.fonts.body ? 24 : 20,
              fontWeight: draft.fonts.body ? 600 : 400,
              color: draft.fonts.body ? C.t1 : C.t2,
              lineHeight: 1.2,
            }}
          >
            {draft.fonts.body || "— not detected"}
          </div>
          <MicroLabel style={{ display: "block", marginTop: 6 }}>
            Body · sans
          </MicroLabel>
          {editing ? (
            <input
              value={draft.fonts.body ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  fonts: { ...draft.fonts, body: e.target.value },
                })
              }
              placeholder="Inter"
              style={miniField}
            />
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Logo — on light / on dark / mark
// ---------------------------------------------------------------------------

/** Logo images above this size are refused (stored inline on the profile). */
const MAX_LOGO_BYTES = 1_000_000;

function LogoCard({
  draft,
  setDraft,
}: {
  draft: BrandProfileInput;
  setDraft: (d: BrandProfileInput) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const mark = draft.logo.mark;
  const primary = draft.palette.primary || C.blue;

  /** Read a picked image and store it inline (data URI) on the draft slot. */
  const uploadLogo = (slot: "light" | "dark" | "mark", file: File) => {
    setUploadError(null);
    if (!file.type.startsWith("image/")) {
      setUploadError("That file isn't an image.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setUploadError("Logo images must be under 1 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : null;
      if (!src) return;
      setDraft({ ...draft, logo: { ...draft.logo, [slot]: src } });
    };
    reader.readAsDataURL(file);
  };
  return (
    <Panel>
      <SectionHead
        label="Logo"
        action={
          <CardAction onClick={() => setEditing((v) => !v)}>
            {editing ? "Done" : "Replace"}
          </CardAction>
        }
      />
      <div style={{ display: "flex", gap: 12 }}>
        <LogoChip
          bg="#F4F1EA"
          ink="#12161C"
          markColor={primary}
          src={draft.logo.light}
          name={draft.name}
          caption="On light"
        />
        <LogoChip
          bg="#12161C"
          ink="#F4F1EA"
          markColor={primary}
          src={draft.logo.dark}
          name={draft.name}
          caption="On dark"
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 14,
        }}
      >
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: mark ? "transparent" : primary,
            color: "#fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 15,
            fontWeight: 700,
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {mark ? (
            <img
              src={mark}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          ) : (
            (draft.name[0] ?? "N").toUpperCase()
          )}
        </span>
        <span style={{ fontSize: 12.5, color: C.t2 }}>
          Mark only — used on covers & favicons
        </span>
      </div>

      {editing ? (
        <div
          style={{
            marginTop: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {(["light", "dark", "mark"] as const).map((slot) => (
            <div
              key={slot}
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <input
                value={draft.logo[slot] ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    logo: { ...draft.logo, [slot]: e.target.value },
                  })
                }
                placeholder={`${slot} logo URL`}
                style={{ ...miniField, flex: 1, minWidth: 0 }}
              />
              {/* Upload from device — the only workable path on mobile, where
                  pasting an image URL is a dead end. Stored inline (data URI),
                  which every logo consumer already renders. */}
              <label
                style={{
                  fontSize: 11.5,
                  fontFamily: mono,
                  color: C.t2,
                  border: `1px solid ${C.line2}`,
                  borderRadius: 8,
                  padding: "7px 10px",
                  cursor: "pointer",
                  flexShrink: 0,
                  minHeight: 32,
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                Upload
                <input
                  type="file"
                  accept="image/*"
                  aria-label={`Upload ${slot} logo`}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadLogo(slot, file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          ))}
          {uploadError ? (
            <div style={{ fontSize: 11.5, color: "#C4553B" }}>
              {uploadError}
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function LogoChip({
  bg,
  ink,
  markColor,
  src,
  name,
  caption,
}: {
  bg: string;
  ink: string;
  markColor: string;
  src?: string;
  name: string;
  caption: string;
}) {
  return (
    <div style={{ flex: 1 }}>
      <div
        style={{
          background: bg,
          borderRadius: 10,
          border: `1px solid ${C.line2}`,
          height: 58,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 14px",
        }}
      >
        {src ? (
          <img
            src={src}
            alt={name}
            style={{ maxHeight: 26, maxWidth: "100%", objectFit: "contain" }}
          />
        ) : (
          <>
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                background: markColor,
                display: "inline-block",
              }}
            />
            <span style={{ fontSize: 14, fontWeight: 600, color: ink }}>
              {name}
            </span>
          </>
        )}
      </div>
      <MicroLabel style={{ display: "block", marginTop: 6, fontSize: 9 }}>
        {/* HONESTY (mobile UAT P2): with no stored image this chip renders a
            SYNTHESIZED wordmark (name + mark color) — say so, so it can't be
            mistaken for a saved logo (the Logos sheet elsewhere honestly
            reports "none saved"). */}
        {src ? caption : `${caption} · preview — no image saved`}
      </MicroLabel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

function VoiceCard({
  draft,
  setDraft,
}: {
  draft: BrandProfileInput;
  setDraft: (d: BrandProfileInput) => void;
}) {
  const [editing, setEditing] = useState(false);
  const doList = draft.voice.doList ?? [];
  const dontList = draft.voice.dontList ?? [];
  const splitList = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return (
    <Panel>
      <SectionHead
        label="Voice"
        action={
          <CardAction onClick={() => setEditing((v) => !v)}>
            {editing ? "Done" : "Edit"}
          </CardAction>
        }
      />
      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={draft.voice.tone ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                voice: { ...draft.voice, tone: e.target.value },
              })
            }
            placeholder="Tone — confident, plain-spoken, warm"
            style={miniField}
          />
          <input
            value={doList.join(", ")}
            onChange={(e) =>
              setDraft({
                ...draft,
                voice: { ...draft.voice, doList: splitList(e.target.value) },
              })
            }
            placeholder="Do — short sentences, active voice"
            style={miniField}
          />
          <input
            value={dontList.join(", ")}
            onChange={(e) =>
              setDraft({
                ...draft,
                voice: { ...draft.voice, dontList: splitList(e.target.value) },
              })
            }
            placeholder="Don't — jargon, hype adjectives"
            style={miniField}
          />
          <input
            value={draft.voice.boilerplate ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                voice: { ...draft.voice, boilerplate: e.target.value },
              })
            }
            placeholder="Boilerplate — one-liner / tagline"
            style={miniField}
          />
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 13.5, color: C.t1, marginBottom: 12 }}>
            Tone:{" "}
            <strong style={{ fontWeight: 600 }}>
              {draft.voice.tone || "—"}
            </strong>
          </div>
          <div style={{ display: "flex", gap: 20 }}>
            <div style={{ flex: 1 }}>
              <MicroLabel color={C.green}>✓ Do</MicroLabel>
              <div style={listText}>
                {doList.length ? doList.join(" · ") : "—"}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <MicroLabel color={C.amber}>✕ Don't</MicroLabel>
              <div style={listText}>
                {dontList.length ? dontList.join(" · ") : "—"}
              </div>
            </div>
          </div>
          {draft.voice.boilerplate ? (
            <div
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: `1px solid ${C.line}`,
                fontStyle: "italic",
                fontSize: 13,
                color: C.t2,
              }}
            >
              “{draft.voice.boilerplate}”
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------

function PreviewCard({ draft }: { draft: BrandProfileInput }) {
  // The slide has to paint *something*, so it falls back to neutral stand-in
  // colours. Say which it is: claiming "now in your colors" over a kit with no
  // colours in it is the same fabrication the extractor used to commit.
  const hasBrandValues = useMemo(
    () =>
      Object.values(draft.palette).some(
        (v) => typeof v === "string" && v.trim(),
      ) || !!(draft.fonts.heading || draft.fonts.body),
    [draft.palette, draft.fonts],
  );
  const caption = hasBrandValues
    ? `The Startup template, now in ${draft.name}'s colors, fonts, logo and tone — not the demo.`
    : "Stand-in colors and type — this kit has none set yet, so the preview isn't your brand.";
  return (
    <Panel>
      <SectionHead
        label="Live preview"
        badge={
          hasBrandValues ? (
            <Tag tone="green">Same deck · in your brand</Tag>
          ) : (
            <Tag tone="neutral">Same deck · stand-in styling</Tag>
          )
        }
      />
      <BrandPreviewSlide
        palette={draft.palette}
        fonts={draft.fonts}
        name={draft.name}
      />
      <p
        style={{
          fontSize: 11.5,
          color: C.t2,
          margin: "12px 0 0",
          lineHeight: 1.5,
        }}
      >
        {caption}
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const addSwatch: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 12,
  border: `1.5px dashed ${C.line2}`,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: C.t3,
  fontSize: 20,
};

const miniField: CSSProperties = {
  width: "100%",
  border: `1px solid ${C.line2}`,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  color: C.t1,
  background: C.bg,
  outline: "none",
  boxSizing: "border-box",
  marginTop: 8,
  fontFamily: "inherit",
};

const listText: CSSProperties = {
  fontSize: 12.5,
  color: C.t2,
  lineHeight: 1.55,
  marginTop: 5,
};

const errorBanner: CSSProperties = {
  fontFamily: mono,
  fontSize: 12,
  color: C.dangerText,
  background: `color-mix(in srgb, ${C.danger} 10%, transparent)`,
  border: `1px solid color-mix(in srgb, ${C.danger} 35%, transparent)`,
  borderRadius: 10,
  padding: "10px 12px",
  marginBottom: 16,
};
