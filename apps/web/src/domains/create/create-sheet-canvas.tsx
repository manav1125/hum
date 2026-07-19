/**
 * Canvas v1 for the mobile Create sheet (spec frame 34): an image-source step
 * (photo library + "History" = the assistant's recent image outputs from the
 * REAL `/v1/assistants/:id/outputs` endpoint) and the 6 action tiles
 * (Inpaint / Outpaint / Restyle / Remove BG / Upscale 4× / Create new).
 *
 * Tile → skill mapping: the tiles narrow the existing CANVAS_ACTION_SPECS —
 * Inpaint/Outpaint/Restyle all seed `edit_image` (its promptSeed already
 * names all three edits; the tile appends a focus line), Remove BG →
 * `remove_background`, Upscale 4× → `upscale`, Create new → `create_new`.
 * No new backend anything — the seeds are the same desktop promptSeeds.
 *
 * MARQUEE SELECTION: DEFERRED. Frame 34 shows a finger-drag marquee over the
 * image ("SELECTED" region riding an inpaint). There is no backend mask
 * support today — the daemon skills take a whole image + a text directive,
 * not region masks — so shipping the marquee would be a decorative lie. The
 * prompt field narrates the region instead ("Swap the orb for the Halo
 * device"). Revisit when a mask-capable edit endpoint exists.
 */
import { useEffect, useMemo, useRef } from "react";

import { useQuery } from "@tanstack/react-query";

import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";
import { outputsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { haptic } from "@/utils/haptics";

import { getCanvasActionSpec } from "./studio-specs";

/* ------------------------------------------------------------------------- */
/* Tiles                                                                     */
/* ------------------------------------------------------------------------- */

export type CanvasTileId =
  | "inpaint"
  | "outpaint"
  | "restyle"
  | "remove_bg"
  | "upscale"
  | "create_new";

interface CanvasTile {
  id: CanvasTileId;
  /** Tile label + CTA relabel (frame 34 copy, verbatim). */
  label: string;
  /** One-line description (frame 34 copy; wide tiles carry none). */
  description?: string;
  glyph: string;
  /** Backing CanvasActionSpec id (studio-specs). */
  specId: string;
  /** Rendered as a full-width row tile under the 2×2 grid (frame 34). */
  wide?: boolean;
}

export const CANVAS_TILES: CanvasTile[] = [
  {
    id: "inpaint",
    label: "Inpaint",
    description: "Replace the selection",
    glyph: "🖌",
    specId: "edit_image",
  },
  {
    id: "outpaint",
    label: "Outpaint",
    description: "Extend the frame",
    glyph: "⤢",
    specId: "edit_image",
  },
  {
    id: "restyle",
    label: "Restyle",
    description: "Same image, new look",
    glyph: "🎨",
    specId: "edit_image",
  },
  {
    id: "remove_bg",
    label: "Remove BG",
    description: "Clean cutout",
    glyph: "✂",
    specId: "remove_background",
  },
  { id: "upscale", label: "Upscale 4×", glyph: "⇪", specId: "upscale", wide: true },
  {
    id: "create_new",
    label: "Create new",
    glyph: "✦",
    specId: "create_new",
    wide: true,
  },
];

export function getCanvasTile(id: CanvasTileId): CanvasTile {
  const tile = CANVAS_TILES.find((t) => t.id === id);
  if (!tile) throw new Error(`Unknown canvas tile: ${id}`);
  return tile;
}

/** Focus line appended when a tile narrows edit_image's 3-in-1 promptSeed. */
const TILE_FOCUS: Partial<Record<CanvasTileId, string>> = {
  inpaint:
    "For this edit, inpaint: replace the part of the image I call out below, blending the result seamlessly.",
  outpaint:
    "For this edit, outpaint: extend the image beyond its current frame, continuing the scene naturally.",
  restyle:
    "For this edit, restyle: keep the composition and subject, change the look I describe below.",
};

/**
 * The tile's seed prompt — the EXISTING desktop promptSeed (studio-specs)
 * plus the narrowing focus line for the three edit_image sub-actions.
 */
export function canvasTileSeed(id: CanvasTileId): string {
  const tile = getCanvasTile(id);
  const spec = getCanvasActionSpec(tile.specId);
  const seed = spec?.promptSeed ?? "";
  const focus = TILE_FOCUS[id];
  return focus ? `${seed}\n\n${focus}` : seed;
}

/* ------------------------------------------------------------------------- */
/* Image source                                                              */
/* ------------------------------------------------------------------------- */

/** A picked canvas source image, ready to ride the chat composer. */
export interface CanvasImagePick {
  file: File;
  name: string;
  /** Object URL for the preview card — parent revokes on clear/unmount. */
  previewUrl: string;
}

interface HistoryItem {
  outputId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  title: string;
}

/** Recent image outputs (`GET /v1/assistants/:id/outputs`, kind=image). */
function useCanvasHistory(): HistoryItem[] {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const query = useQuery({
    ...outputsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { limit: 50 },
    }),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });
  return useMemo(() => {
    const outputs = query.data?.outputs ?? [];
    return outputs
      .filter((o) => o.kind === "image" && o.attachment)
      .slice(0, 8)
      .map((o) => ({
        outputId: o.id,
        attachmentId: o.attachment!.id,
        filename: o.attachment!.filename,
        mimeType: o.attachment!.mimeType,
        title: o.title,
      }));
  }, [query.data]);
}

/**
 * One history thumbnail — bytes via the real attachment content route
 * (`GET /v1/assistants/:id/attachments/:id/content`), shown as a tile;
 * tapping re-uses those bytes as the canvas source File.
 */
function HistoryThumb({
  item,
  onPick,
}: {
  item: HistoryItem;
  onPick: (pick: CanvasImagePick) => void;
}) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const query = useQuery({
    queryKey: ["create-canvas-history-thumb", item.attachmentId],
    enabled: Boolean(assistantId),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await attachmentsByIdContentGet({
        path: { assistant_id: assistantId ?? "", id: item.attachmentId },
        parseAs: "blob",
        throwOnError: false,
      });
      if (error || !(data instanceof Blob)) {
        throw new Error("Failed to load image");
      }
      return data;
    },
  });

  const url = useMemo(
    () => (query.data ? URL.createObjectURL(query.data) : null),
    [query.data],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  return (
    <button
      type="button"
      className="cue-pressable"
      title={item.title}
      aria-label={`Use ${item.filename} from history`}
      onClick={() => {
        if (!query.data) return;
        haptic.light();
        const file = new File([query.data], item.filename, {
          type: item.mimeType,
        });
        onPick({
          file,
          name: item.filename,
          previewUrl: URL.createObjectURL(query.data),
        });
      }}
      style={{
        flexShrink: 0,
        width: 66,
        height: 66,
        borderRadius: 13,
        padding: 0,
        overflow: "hidden",
        cursor: "pointer",
        border: "1px solid var(--mv3-card-border)",
        background: url
          ? `center / cover no-repeat url("${url}")`
          : "var(--mv3-btn2-bg)",
      }}
    />
  );
}

/* ------------------------------------------------------------------------- */
/* Composer block                                                            */
/* ------------------------------------------------------------------------- */

export function CanvasComposer({
  image,
  tile,
  onImage,
  onClearImage,
  onTile,
}: {
  image: CanvasImagePick | null;
  tile: CanvasTileId | null;
  onImage: (pick: CanvasImagePick) => void;
  onClearImage: () => void;
  onTile: (id: CanvasTileId | null) => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const history = useCanvasHistory();

  return (
    <div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && file.type.startsWith("image/")) {
            haptic.light();
            onImage({
              file,
              name: file.name || "photo",
              previewUrl: URL.createObjectURL(file),
            });
          }
          e.target.value = "";
        }}
      />

      {image ? (
        /* Selected source — preview card with mono filename badge. */
        <div
          style={{
            position: "relative",
            borderRadius: 20,
            overflow: "hidden",
            border: "1px solid var(--mv3-card-border)",
            height: 170,
            background: `center / cover no-repeat url("${image.previewUrl}"), var(--mv3-btn2-bg)`,
          }}
        >
          <span
            style={{
              position: "absolute",
              bottom: 10,
              left: 12,
              fontFamily: "var(--mv3-mono)",
              fontSize: 9.5,
              color: "#F4F4F6",
              background: "rgba(10,12,18,.75)",
              padding: "4px 9px",
              borderRadius: 6,
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              maxWidth: "70%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {image.name}
          </span>
          <button
            type="button"
            aria-label="Remove image"
            onClick={() => {
              haptic.light();
              onClearImage();
            }}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 32,
              height: 32,
              display: "grid",
              placeItems: "center",
              borderRadius: 99,
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              color: "#F4F4F6",
              background: "rgba(10,13,20,.55)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
            }}
          >
            ✕
          </button>
        </div>
      ) : (
        /* Source affordance — photo library (dashed pill, frame-36 grammar). */
        <button
          type="button"
          className="cue-pressable"
          onClick={() => fileInput.current?.click()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minHeight: 44,
            background: "var(--mv3-btn2-bg)",
            border:
              "1px dashed color-mix(in srgb, var(--mv3-muted) 55%, transparent)",
            borderRadius: 99,
            padding: "7px 15px",
            fontSize: 12.5,
            color: "var(--mv3-pill-text)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          ＋ Drop image or paste URL
        </button>
      )}

      {/* History — recent image outputs, only when the endpoint has some. */}
      {history.length > 0 ? (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.09em",
              textTransform: "uppercase",
              color: "var(--mv3-muted)",
              marginTop: 12,
              marginBottom: 7,
            }}
          >
            History
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              overflowX: "auto",
              WebkitOverflowScrolling: "touch",
              scrollbarWidth: "none",
            }}
          >
            {history.map((item) => (
              <HistoryThumb key={item.outputId} item={item} onPick={onImage} />
            ))}
          </div>
        </>
      ) : null}

      {/* Action tiles — 2×2 grid + 2 wide rows (frame 34). */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 9,
          marginTop: 14,
        }}
      >
        {CANVAS_TILES.filter((t) => !t.wide).map((t) => {
          const selected = t.id === tile;
          return (
            <button
              key={t.id}
              type="button"
              className="cue-pressable"
              aria-pressed={selected}
              onClick={() => {
                haptic.light();
                onTile(selected ? null : t.id);
              }}
              style={{
                textAlign: "left",
                borderRadius: 18,
                padding: "13px 14px",
                minHeight: 44,
                cursor: "pointer",
                fontFamily: "inherit",
                background: selected
                  ? "color-mix(in srgb, var(--mv3-accent) 14%, var(--mv3-card))"
                  : "var(--mv3-card)",
                border: selected
                  ? "1.5px solid var(--mv3-accent)"
                  : "1px solid var(--mv3-card-border)",
                boxShadow: selected
                  ? "0 16px 36px -16px color-mix(in srgb, var(--mv3-accent) 50%, transparent)"
                  : "none",
              }}
            >
              <span aria-hidden style={{ fontSize: 17 }}>
                {t.glyph}
              </span>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  marginTop: 7,
                  color: "var(--mv3-text)",
                }}
              >
                {t.label}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--mv3-muted)",
                  marginTop: 2,
                }}
              >
                {t.description}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 9, marginTop: 9 }}>
        {CANVAS_TILES.filter((t) => t.wide).map((t) => {
          const selected = t.id === tile;
          return (
            <button
              key={t.id}
              type="button"
              className="cue-pressable"
              aria-pressed={selected}
              onClick={() => {
                haptic.light();
                onTile(selected ? null : t.id);
              }}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                gap: 9,
                borderRadius: 16,
                padding: "11px 14px",
                minHeight: 44,
                cursor: "pointer",
                fontFamily: "inherit",
                background: selected
                  ? "color-mix(in srgb, var(--mv3-accent) 14%, var(--mv3-card))"
                  : "var(--mv3-card)",
                border: selected
                  ? "1.5px solid var(--mv3-accent)"
                  : "1px solid var(--mv3-card-border)",
                boxShadow: selected
                  ? "0 16px 36px -16px color-mix(in srgb, var(--mv3-accent) 50%, transparent)"
                  : "none",
              }}
            >
              <span aria-hidden style={{ fontSize: 14 }}>
                {t.glyph}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "var(--mv3-text)",
                }}
              >
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
