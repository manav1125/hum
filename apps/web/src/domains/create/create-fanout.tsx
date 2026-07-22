/**
 * Create Studio — 4g STRETCH · "Multi-format fan-out".
 *
 * One brief → a coordinated asset kit. Two surfaces:
 *
 *   1. **AlsoMakeChooser** — a multi-select of downstream formats (Deck ·
 *      One-pager · Social set · Doc · Email · Landing). The source format is
 *      marked; picking others produces a "Kit: deck +N" intent. On confirm the
 *      host fires one seeded generation per picked format (buildFanoutPrompts).
 *   2. **KitResultView** — the produced kit shown together, per-asset
 *      "regenerate" + a "Download all".
 *
 * Badged as a LATER-PHASE capability: firing N independent generations yields
 * coordinated-BY-brand assets, but true single-pass kit orchestration (one run
 * emitting the whole set off a shared content spine) needs a backend kit
 * endpoint that does not exist yet. The UI is built; the deep orchestration is
 * a TODO (see create-remix.buildFanoutPrompts + the KitResultView note).
 *
 * HONESTY CONTRACT (KitResultView): every tile states the asset's real state —
 * queued / generating (with elapsed, and a "taking longer than usual" note past
 * the stall threshold) / ready / failed-with-reason / finished-but-filed-
 * nothing. A ready asset renders its ACTUAL produced artifact (image bytes for
 * attachment outputs, title + word count for document outputs). "Download all"
 * is disabled until something downloadable exists, and the "in your brand"
 * badge only shows when a brand kit was genuinely applied.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  attachmentsByIdContentGet,
  documentsByIdGet,
} from "@/generated/daemon/sdk.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { FANOUT_FORMATS, type FanoutFormat } from "@/domains/create/create-remix";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const C = {
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  line: "var(--mv1-line)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  amber: "var(--mv1-amber, #E6A23C)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

/** "LATER PHASE" badge — flags the stretch capability. */
export function LaterPhaseBadge() {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 9.5,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "#0B0E13",
        background: C.amber,
        borderRadius: 6,
        padding: "3px 8px",
        fontWeight: 600,
      }}
    >
      Stretch · later phase
    </span>
  );
}

/** The chip a confirmed fan-out selection parks as ("Kit: deck +2"). */
export function fanoutChipLabel(formatIds: string[]): string {
  const extras = formatIds.filter((id) => id !== "slides").length;
  return extras > 0 ? `Kit: deck +${extras}` : "Kit: deck";
}

// ---------------------------------------------------------------------------
// 1 · Also-make chooser
// ---------------------------------------------------------------------------

export interface AlsoMakeChooserProps {
  /** The source format id already produced (marked, non-deselectable). */
  sourceFormatId?: string;
  /** Fire the fan-out for the selected (extra) formats. */
  onGenerate: (formatIds: string[]) => void;
}

/**
 * The "From this brief, also make" multi-select. The source format is preset +
 * locked; the rest toggle. "Generate N assets" fires the picked extras.
 */
export function AlsoMakeChooser({
  sourceFormatId = "slides",
  onGenerate,
}: AlsoMakeChooserProps) {
  const isMobile = useIsMobile();
  // Default-pick the first two non-source formats to match the mock (one-pager
  // + social), but the user drives it from there.
  const [picked, setPicked] = useState<Set<string>>(() => {
    const extras = FANOUT_FORMATS.filter((f) => f.id !== sourceFormatId).slice(
      0,
      2,
    );
    return new Set(extras.map((f) => f.id));
  });

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const count = picked.size;

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 18,
        overflow: "hidden",
        width: isMobile ? "100%" : 320,
      }}
    >
      <div style={{ padding: "18px 20px", borderBottom: `1px solid ${C.line}` }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: C.t3,
          }}
        >
          Also make…
        </div>
        <div
          style={{ fontFamily: serif, fontSize: 19, color: C.t1, marginTop: 6 }}
        >
          From this brief, also make
        </div>
        <div style={{ fontSize: 11.5, color: C.t3, marginTop: 2 }}>
          All in your brand, produced together.
        </div>
      </div>

      <div
        style={{
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 9,
        }}
      >
        {FANOUT_FORMATS.map((fmt) => {
          const isSource = fmt.id === sourceFormatId;
          const on = isSource || picked.has(fmt.id);
          return (
            <FormatRow
              key={fmt.id}
              fmt={fmt}
              on={on}
              isSource={isSource}
              onToggle={() => (isSource ? undefined : toggle(fmt.id))}
            />
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 20px",
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <span style={{ fontSize: 12, color: C.t3 }}>{count} selected</span>
        <button
          type="button"
          onClick={() => onGenerate([...picked])}
          disabled={count === 0}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: "#fff",
            background: count === 0 ? C.line : C.blue,
            border: "none",
            borderRadius: 10,
            padding: "9px 15px",
            cursor: count === 0 ? "not-allowed" : "pointer",
            opacity: count === 0 ? 0.7 : 1,
          }}
        >
          <Sparkles size={14} />
          Generate {count} asset{count === 1 ? "" : "s"} →
        </button>
      </div>
    </div>
  );
}

function FormatRow({
  fmt,
  on,
  isSource,
  onToggle,
}: {
  fmt: FanoutFormat;
  on: boolean;
  isSource: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={isSource}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${on ? C.blue : C.line}`,
        background: on
          ? `color-mix(in srgb, ${C.blue} 8%, transparent)`
          : "transparent",
        cursor: isSource ? "default" : "pointer",
        textAlign: "left",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "grid",
          placeItems: "center",
          width: 20,
          height: 20,
          borderRadius: 6,
          background: on ? C.blue : "transparent",
          border: on ? "none" : `1px solid ${C.line}`,
          color: "#fff",
          flexShrink: 0,
        }}
      >
        {on ? <Check size={13} /> : null}
      </span>
      <span aria-hidden style={{ color: on ? C.blueS : C.t3, fontSize: 14 }}>
        {fmt.glyph}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          fontWeight: on ? 600 : 500,
          color: on ? C.t1 : C.t2,
        }}
      >
        {fmt.label}
      </span>
      {isSource ? (
        <span style={{ fontSize: 11, color: C.t3 }}>source</span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 2 · Kit result view
// ---------------------------------------------------------------------------

/** The lifecycle of one asset's background generation run (mirrors the daemon). */
export type KitAssetStatus = "pending" | "running" | "done" | "failed";

/**
 * A produced deliverable, decoded from the daemon's `outputRef`. Attachment
 * outputs are files (images, exports); document outputs are document-editor
 * surfaces (every `docs`-mode format lands here).
 */
export interface KitAssetOutput {
  kind: "attachment" | "document";
  id: string;
}

/**
 * Decode a daemon `outputRef`. Bare ids are attachments (the original
 * encoding); `document:<surfaceId>` refs are document surfaces. Mirrors
 * `parseKitOutputRef` in assistant/src/create/kit-output.ts.
 */
export function parseKitOutputRef(
  ref: string | null | undefined,
): KitAssetOutput | null {
  if (!ref) return null;
  if (ref.startsWith("document:")) {
    const id = ref.slice("document:".length);
    return id ? { kind: "document", id } : null;
  }
  return { kind: "attachment", id: ref };
}

/** One asset row as the daemon's `GET kits/{kid}` reports it. */
export interface KitAssetRow {
  id: string;
  format: string;
  status: KitAssetStatus;
  conversationId: string | null;
  outputRef: string | null;
  error: string | null;
  updatedAt: number;
}

/**
 * Adapt the daemon's rows into the view's assets. Every field the view needs to
 * tell the truth comes across — status, error, the DECODED output ref and the
 * last transition time. Dropping any of them is what made a finished kit look
 * identical to a generating one.
 */
export function kitAssetsFromRows(
  rows: KitAssetRow[],
  labelFor: (format: string) => string,
): KitAsset[] {
  return rows.map((row) => ({
    id: row.id,
    label: labelFor(row.format),
    status: row.status,
    output: parseKitOutputRef(row.outputRef),
    error: row.error,
    conversationId: row.conversationId,
    updatedAt: row.updatedAt,
    isSet: row.format === "social",
  }));
}

/**
 * A run that has not reported in this long is called out as "taking longer than
 * usual" rather than left spinning silently. Kit runs normally settle in 3–8
 * minutes, so this is generous — it exists to stop an interrupted daemon from
 * leaving a tile that claims work is happening forever.
 */
const STALL_AFTER_MS = 12 * 60_000;

/** One asset in the kit, as the result view needs it. */
export interface KitAsset {
  id: string;
  /** Format label ("One-pager", "3 social images") — WITHOUT any status text. */
  label: string;
  /** The run's real state. */
  status: KitAssetStatus;
  /** The produced deliverable, once the run filed one. */
  output?: KitAssetOutput | null;
  /** Failure reason, when `status === "failed"`. */
  error?: string | null;
  /** The background run's conversation, so a user can open what was produced. */
  conversationId?: string | null;
  /** ms epoch of the last status transition — drives the elapsed readout. */
  updatedAt?: number;
  /** Rendered preview node (host injects a richer artifact view). */
  preview?: React.ReactNode;
  /** Whether this asset is a set (label reads "regenerate one"). */
  isSet?: boolean;
}

export interface KitResultViewProps {
  /** Kit name ("Series A launch kit"). */
  title: string;
  /** The kit's assets. */
  assets: KitAsset[];
  /** True while the kit itself is still being created server-side. */
  isLaunching?: boolean;
  /** Set when the launch request failed outright (no kit exists). */
  launchError?: string | null;
  /** Whether a brand kit was genuinely applied to every asset. */
  branded?: boolean;
  /** Open the background run that produced (or is producing) an asset. */
  onOpenAsset?: (asset: KitAsset) => void;
  /** Regenerate a single asset without touching the rest. */
  onRegenerateAsset: (assetId: string) => void;
  /** Download the produced assets. Only offered once something exists. */
  onDownloadAll: () => void;
}

/** "3m" / "1h 04m" — how long a run has been going. */
function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** A one-minute tick, so elapsed readouts advance while runs are in flight. */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** The frame every tile shares — keeps status and artwork the same shape. */
function KitTile({
  children,
  dashed,
}: {
  children: React.ReactNode;
  dashed?: boolean;
}) {
  return (
    <div
      style={{
        aspectRatio: "16 / 10",
        borderRadius: 8,
        border: dashed ? `1px dashed ${C.line}` : "none",
        background: C.sunken,
        display: "grid",
        placeItems: "center",
        padding: 12,
        textAlign: "center",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

function TileCaption({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: tone ?? C.t3,
        lineHeight: 1.5,
      }}
    >
      {children}
    </span>
  );
}

/** An attachment output — the real produced bytes, rendered when they're an image. */
function AttachmentOutputTile({ attachmentId }: { attachmentId: string }) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const query = useQuery({
    queryKey: ["kit-asset-output", attachmentId],
    enabled: Boolean(assistantId && attachmentId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () => {
      const { data, error } = await attachmentsByIdContentGet({
        path: { assistant_id: assistantId ?? "", id: attachmentId },
        parseAs: "blob",
        throwOnError: false,
      });
      if (error || !(data instanceof Blob)) {
        throw new Error("Failed to load the produced file");
      }
      return data;
    },
  });

  const url = useMemo(
    () =>
      query.data && query.data.type.startsWith("image/")
        ? URL.createObjectURL(query.data)
        : null,
    [query.data],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  if (url) {
    return (
      <div
        role="img"
        aria-label="Produced asset"
        data-testid="kit-asset-image"
        style={{
          aspectRatio: "16 / 10",
          borderRadius: 8,
          background: `center / cover no-repeat url("${url}"), ${C.sunken}`,
        }}
      />
    );
  }
  if (query.isError) {
    return (
      <KitTile>
        <TileCaption>Produced · preview unavailable</TileCaption>
      </KitTile>
    );
  }
  return (
    <KitTile>
      <TileCaption>{query.data ? "Produced file" : "Loading…"}</TileCaption>
    </KitTile>
  );
}

/** A document output — the real title + length of the document the run wrote. */
function DocumentOutputTile({ surfaceId }: { surfaceId: string }) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const query = useQuery({
    queryKey: ["kit-asset-document", surfaceId],
    enabled: Boolean(assistantId && surfaceId),
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await documentsByIdGet({
        path: { assistant_id: assistantId ?? "", id: surfaceId },
        throwOnError: false,
      });
      if (error || !data) throw new Error("Failed to load the document");
      return data;
    },
  });

  const doc = query.data;
  return (
    <KitTile>
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <FileText size={20} aria-hidden style={{ color: C.blueS }} />
        <span
          style={{
            fontFamily: serif,
            fontSize: 15,
            color: C.t1,
            lineHeight: 1.25,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {doc?.title ?? (query.isError ? "Document" : "Loading…")}
        </span>
        {doc?.wordCount ? (
          <TileCaption>{doc.wordCount} words</TileCaption>
        ) : null}
      </span>
    </KitTile>
  );
}

/** The tile for one asset — always the asset's REAL state, never a stand-in. */
function KitAssetTile({ asset, now }: { asset: KitAsset; now: number }) {
  if (asset.preview) return <>{asset.preview}</>;

  if (asset.status === "failed") {
    return (
      <KitTile dashed>
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 7,
          }}
        >
          <AlertTriangle size={18} aria-hidden style={{ color: C.amber }} />
          <TileCaption tone={C.amber}>Didn&apos;t generate</TileCaption>
          <span
            style={{
              fontSize: 11,
              color: C.t3,
              lineHeight: 1.4,
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {asset.error?.trim() || "The run ended without a reason."}
          </span>
        </span>
      </KitTile>
    );
  }

  if (asset.status === "done") {
    if (asset.output?.kind === "attachment") {
      return <AttachmentOutputTile attachmentId={asset.output.id} />;
    }
    if (asset.output?.kind === "document") {
      return <DocumentOutputTile surfaceId={asset.output.id} />;
    }
    // Finished, but nothing was filed against the run. Say exactly that rather
    // than showing an empty tile that reads as a missing image.
    return (
      <KitTile dashed>
        <span
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          <TileCaption>Finished · nothing filed</TileCaption>
          <span style={{ fontSize: 11, color: C.t3, lineHeight: 1.4 }}>
            The run completed without saving a file or document. Open it to see
            what it did.
          </span>
        </span>
      </KitTile>
    );
  }

  const elapsed = asset.updatedAt ? now - asset.updatedAt : 0;
  const stalled = asset.status === "running" && elapsed > STALL_AFTER_MS;
  return (
    <KitTile dashed>
      <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <TileCaption>
          {asset.status === "pending" ? "Queued" : "Generating…"}
        </TileCaption>
        {asset.status === "running" && asset.updatedAt ? (
          <span style={{ fontSize: 11, color: stalled ? C.amber : C.t3 }}>
            {stalled
              ? `${formatElapsed(elapsed)} in — longer than usual. Regenerate if it's stuck.`
              : `${formatElapsed(elapsed)} in`}
          </span>
        ) : null}
      </span>
    </KitTile>
  );
}

function KitAssetCard({
  asset,
  now,
  onOpen,
  onRegenerate,
}: {
  asset: KitAsset;
  now: number;
  onOpen?: () => void;
  onRegenerate: () => void;
}) {
  const statusText =
    asset.status === "done"
      ? asset.output
        ? "Ready"
        : "Finished · nothing filed"
      : asset.status === "failed"
        ? "Failed"
        : asset.status === "running"
          ? "Generating…"
          : "Queued";
  const statusTone =
    asset.status === "failed"
      ? C.amber
      : asset.status === "done" && asset.output
        ? "var(--mv1-green-strong, #17936B)"
        : C.t3;

  return (
    <div
      data-testid={`kit-asset-${asset.id}`}
      data-status={asset.status}
      style={{
        borderRadius: 12,
        overflow: "hidden",
        border: `1px solid ${C.line}`,
        background: C.surface,
      }}
    >
      <div style={{ padding: 12 }}>
        <KitAssetTile asset={asset} now={now} />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "8px 12px",
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <span style={{ minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 12,
              fontWeight: 600,
              color: C.t1,
            }}
          >
            {asset.label}
          </span>
          <span style={{ display: "block", fontSize: 11, color: statusTone }}>
            {statusText}
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {onOpen && asset.conversationId ? (
            <button
              type="button"
              onClick={onOpen}
              style={{
                fontSize: 12,
                color: C.t3,
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              open run
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRegenerate}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 12,
              color: C.t3,
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            <RefreshCw size={12} />
            {asset.status === "failed"
              ? "retry"
              : asset.isSet
                ? "regenerate one"
                : "regenerate"}
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * The produced kit, shown together. Per-asset regenerate keeps the rest intact.
 *
 * TODO(kit-orchestration): today each asset is an independent seeded generation
 * (coordinated only by shared brand). A real "launch kit" wants one backend run
 * that emits the whole set off a shared content spine so headline/messaging
 * stay consistent across formats, and "regenerate one" re-derives from that
 * spine. That endpoint does not exist yet — this view renders the honest
 * approximation and is the seam to upgrade when it lands.
 */
export function KitResultView({
  title,
  assets,
  isLaunching = false,
  launchError = null,
  branded = false,
  onOpenAsset,
  onRegenerateAsset,
  onDownloadAll,
}: KitResultViewProps) {
  const isMobile = useIsMobile();
  const working = assets.some(
    (a) => a.status === "pending" || a.status === "running",
  );
  const now = useMinuteTick(working);
  const readyCount = assets.filter(
    (a) => a.status === "done" && a.output,
  ).length;
  const failedCount = assets.filter((a) => a.status === "failed").length;
  const canDownload = readyCount > 0;

  // The sub-line states what is actually true right now: how many of the
  // tracked assets have a filed deliverable, and how many failed.
  const subline = launchError
    ? "Nothing was launched"
    : isLaunching || assets.length === 0
      ? "Starting the runs…"
      : [
          `${readyCount} of ${assets.length} ready`,
          working ? "still generating" : null,
          failedCount > 0
            ? `${failedCount} failed`
            : !working && readyCount < assets.length
              ? `${assets.length - readyCount} filed nothing`
              : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: isMobile ? "18px 18px 0 0" : 18,
        overflow: "hidden",
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: isMobile ? "14px 16px" : "16px 22px",
          borderBottom: `1px solid ${C.line}`,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "grid",
            placeItems: "center",
            width: 30,
            height: 30,
            borderRadius: 8,
            background: `color-mix(in srgb, ${C.blue} 12%, transparent)`,
            color: C.blueS,
            flexShrink: 0,
          }}
        >
          <Sparkles size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
            {title}
          </div>
          <div style={{ fontSize: 11, color: C.t3 }}>{subline}</div>
        </div>
        {branded ? (
          <span
            style={{
              fontFamily: mono,
              fontSize: 9.5,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--mv1-green-strong, #17936B)",
              background:
                "color-mix(in srgb, var(--mv1-green, #17936B) 14%, transparent)",
              borderRadius: 6,
              padding: "3px 8px",
              whiteSpace: "nowrap",
            }}
          >
            In your brand ✓
          </span>
        ) : null}
      </div>

      {launchError ? (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: isMobile ? 16 : 22,
            fontSize: 12.5,
            color: C.t2,
            lineHeight: 1.5,
          }}
        >
          <AlertTriangle
            size={16}
            aria-hidden
            style={{ color: C.amber, flexShrink: 0, marginTop: 1 }}
          />
          <span>
            The kit couldn&apos;t be started, so nothing is generating.{" "}
            <span style={{ color: C.t3 }}>{launchError}</span> Close this and
            try &ldquo;Also make…&rdquo; again.
          </span>
        </div>
      ) : assets.length === 0 ? (
        <div
          style={{
            padding: isMobile ? 16 : 22,
            fontSize: 12.5,
            color: C.t3,
          }}
        >
          {isLaunching
            ? "Starting the background runs…"
            : "No assets are tracked in this kit."}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "1.4fr 1fr",
            gap: 16,
            padding: isMobile ? 16 : 22,
          }}
        >
          {assets.map((asset) => (
            <div
              key={asset.id}
              style={{
                gridColumn: asset.isSet && !isMobile ? "1 / -1" : "auto",
              }}
            >
              <KitAssetCard
                asset={asset}
                now={now}
                onOpen={onOpenAsset ? () => onOpenAsset(asset) : undefined}
                onRegenerate={() => onRegenerateAsset(asset.id)}
              />
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: isMobile ? "12px 16px 16px" : "14px 22px",
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <span style={{ fontSize: 12, color: C.t3 }}>
          {canDownload
            ? "Regenerate any one asset without touching the rest"
            : "Nothing to download yet"}
        </span>
        <button
          type="button"
          onClick={onDownloadAll}
          disabled={!canDownload}
          title={
            canDownload
              ? undefined
              : "Available once at least one asset has produced a file"
          }
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 13,
            fontWeight: 600,
            color: canDownload ? "#fff" : C.t3,
            background: canDownload ? C.blue : C.sunken,
            border: `1px solid ${canDownload ? C.blue : C.line}`,
            borderRadius: 10,
            padding: "9px 15px",
            cursor: canDownload ? "pointer" : "not-allowed",
            opacity: canDownload ? 1 : 0.75,
          }}
        >
          <Download size={14} />
          {canDownload ? `Download all (${readyCount})` : "Download all"}
        </button>
      </div>
    </div>
  );
}
