/**
 * Entry chooser — "Set up your brand" · three entry paths.
 *
 * Matches the Create-Studio mock (SET 2 · 2a): a BRAND KIT microlabel, the
 * Instrument-Serif "Set up your brand" headline, a one-line blurb, and three
 * cards — Upload (PDF·PPTX·Figma), From your website (30-second scan), Guided
 * (~2 min). Desktop lays them in a row; mobile stacks them as tappable rows.
 */

import type { CSSProperties } from "react";
import { FileText, Globe, PencilLine } from "lucide-react";

import { useIsMobile } from "@/hooks/use-is-mobile";

import { C, Display, MicroLabel, mono } from "./brand-kit-ui";

export type BrandPath = "upload" | "website" | "guided";

interface PathMeta {
  path: BrandPath;
  icon: typeof FileText;
  tint: string;
  title: string;
  blurb: string;
  meta: string;
}

const PATHS: PathMeta[] = [
  {
    path: "upload",
    icon: FileText,
    tint: C.blue,
    title: "Upload",
    blurb:
      "Drop a deck, PDF or brand-guidelines file. Cue reads the palette, fonts, logo and voice.",
    meta: "PDF · PPTX · FIGMA",
  },
  {
    path: "website",
    icon: Globe,
    tint: C.green,
    title: "From your website",
    blurb: "Paste a URL. Cue scans your live site for colors, fonts, logo and copy.",
    meta: "30-SECOND SCAN",
  },
  {
    path: "guided",
    icon: PencilLine,
    tint: C.violet,
    title: "Guided",
    blurb:
      "No kit yet? Build it by hand — pick colors, add a logo, choose fonts, describe your voice.",
    meta: "~2 MINUTES",
  },
];

export function BrandEntryChooser({
  onPick,
  onSkip,
  showHeader = true,
}: {
  onPick: (path: BrandPath) => void;
  /** Renders the "Skip for now — you can add a brand any time in Settings → Brand" footer. */
  onSkip?: () => void;
  showHeader?: boolean;
}) {
  const isMobile = useIsMobile();

  return (
    <div>
      {showHeader ? (
        <div style={{ textAlign: "center", marginBottom: 30 }}>
          <MicroLabel color={C.blue}>Brand Kit</MicroLabel>
          <Display size={isMobile ? 30 : 40} style={{ margin: "14px 0 12px" }}>
            Set up your brand
          </Display>
          <p
            style={{
              fontSize: 14,
              color: C.t2,
              lineHeight: 1.55,
              maxWidth: 460,
              margin: "0 auto",
            }}
          >
            Cue applies your colors, fonts, logo and voice to every deck, doc,
            dashboard and image it makes. Start any way you like.
          </p>
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)",
          gap: isMobile ? 10 : 16,
        }}
      >
        {PATHS.map((p) => (
          <PathCard key={p.path} meta={p} stacked={isMobile} onPick={onPick} />
        ))}
      </div>

      {onSkip ? (
        <div style={{ textAlign: "center", marginTop: 22 }}>
          <button type="button" onClick={onSkip} style={skipLinkStyle}>
            Skip for now — you can add a brand any time in{" "}
            <span style={{ color: C.t2 }}>Settings → Brand</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PathCard({
  meta,
  stacked,
  onPick,
}: {
  meta: PathMeta;
  stacked: boolean;
  onPick: (path: BrandPath) => void;
}) {
  const Icon = meta.icon;
  if (stacked) {
    // Mobile: a compact tappable row (mock 2f–g mobile entry).
    return (
      <button
        type="button"
        onClick={() => onPick(meta.path)}
        style={{ ...cardBase, ...rowLayout }}
      >
        <span style={{ ...iconChip, background: tintWash(meta.tint), color: meta.tint }}>
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
          <span style={rowTitle}>{meta.title}</span>
          <span style={rowMeta}>{meta.meta.replace(/·/g, "·").toLowerCase()}</span>
        </span>
        <span style={{ color: C.t3, fontSize: 18 }}>›</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onPick(meta.path)}
      style={{ ...cardBase, ...colLayout }}
    >
      <span style={{ ...iconChip, background: tintWash(meta.tint), color: meta.tint }}>
        <Icon size={20} strokeWidth={1.8} />
      </span>
      <span style={{ ...cardTitle }}>{meta.title}</span>
      <span style={cardBlurb}>{meta.blurb}</span>
      <span style={{ marginTop: "auto" }}>
        <MicroLabel style={{ fontSize: 9.5 }}>{meta.meta}</MicroLabel>
      </span>
    </button>
  );
}

function tintWash(tint: string): string {
  return `color-mix(in srgb, ${tint} 16%, transparent)`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const cardBase: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 16,
  cursor: "pointer",
  font: "inherit",
  transition: "border-color .12s, background .12s",
};

const colLayout: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: 22,
  minHeight: 190,
  textAlign: "left",
};

const rowLayout: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 15px",
};

const iconChip: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 11,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const cardTitle: CSSProperties = {
  fontFamily: "'Instrument Serif', Georgia, serif",
  fontSize: 22,
  color: C.t1,
  lineHeight: 1,
};

const cardBlurb: CSSProperties = {
  fontSize: 13,
  color: C.t2,
  lineHeight: 1.5,
};

const rowTitle: CSSProperties = {
  display: "block",
  fontSize: 15,
  fontWeight: 600,
  color: C.t1,
};

const rowMeta: CSSProperties = {
  display: "block",
  fontFamily: mono,
  fontSize: 11,
  color: C.t3,
  marginTop: 2,
};

const skipLinkStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: C.t3,
  fontSize: 12.5,
  cursor: "pointer",
};
