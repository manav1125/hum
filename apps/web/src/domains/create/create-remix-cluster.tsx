/**
 * Create Studio — SET 3 · "Remix on any output".
 *
 * A small, tasteful action row that rides UNDER a generated asset (a deck, a
 * one-pager, an image). Not a toolbar — a light cluster: Restyle · Rebrand ·
 * Make variations, plus "or keep chatting to refine". Each action re-seeds the
 * SAME conversation via the host's `onReseed` callback (the `?prompt=` path),
 * so the backing skill re-renders the asset in context.
 *
 * - **Restyle** reopens the gallery for the asset's mode to swap template/style
 *   (keeps content) — the host owns the gallery, so this fires `onRestyle`.
 * - **Rebrand** opens a menu of saved Brand Kits + "New brand kit"; picking one
 *   re-seeds with that kit's brand contract.
 * - **Make variations** hands off to the parent to open the 4e result grid.
 *
 * Desktop renders the inline cluster row; mobile renders the bottom action
 * sheet (SET 3b). The design uses the shipped HQ `--mv1-*` tokens.
 */

import { useState } from "react";
import { Copy, Palette, RefreshCw, X } from "lucide-react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  buildFanoutPrompts,
  buildMergePrompt,
  buildRebrandPrompt,
  buildVariationPrompts,
  DEFAULT_VARIATIONS,
  type RemixAsset,
} from "@/domains/create/create-remix";
import type { BrandProfileLike } from "@/domains/create/create-intent";
import {
  AlsoMakeChooser,
  KitResultView,
  LaterPhaseBadge,
  type KitAsset,
} from "@/domains/create/create-fanout";
import {
  VariationsResult,
  type VariationResult,
} from "@/domains/create/create-variations-result";
import {
  useActiveBrand,
  useBrandKits,
  type ActiveBrand,
} from "@/domains/create/use-active-brand";

// `buildRestylePrompt` is consumed by the host (when the gallery returns a
// template id); re-exported here so remix consumers import from one module.
export { buildRestylePrompt } from "@/domains/create/create-remix";

const C = {
  ink: "var(--mv1-t1)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  line: "var(--mv1-line)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

/** A tiny swatch pair for a Brand Kit row (primary + accent). */
function BrandSwatches({ brand }: { brand: ActiveBrand }) {
  const primary = brand.palette?.primary ?? "#3D6EE8";
  const accent = brand.palette?.accent ?? "#0E8C8C";
  return (
    <span style={{ display: "flex", gap: 3, flexShrink: 0 }} aria-hidden>
      <span
        style={{ width: 12, height: 12, borderRadius: 3, background: primary }}
      />
      <span
        style={{ width: 12, height: 12, borderRadius: 3, background: accent }}
      />
    </span>
  );
}

/** The Rebrand menu — saved Brand Kits + "New brand kit". */
function RebrandMenu({
  asset,
  onPick,
  onNewKit,
}: {
  asset: RemixAsset;
  onPick: (kit: ActiveBrand) => void;
  onNewKit: () => void;
}) {
  const { kits, isLoading } = useBrandKits();
  return (
    <div
      role="menu"
      aria-label="Rebrand this asset"
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 16,
        boxShadow: "0 20px 44px -24px rgba(0,0,0,0.45)",
        width: 280,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>
        Rebrand this {asset.noun ?? "asset"}
      </div>
      <div style={{ fontSize: 12, color: C.t3, marginTop: 4, marginBottom: 12 }}>
        Re-render in a different Brand Kit — same content.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {isLoading ? (
          <div style={{ fontSize: 12.5, color: C.t3, padding: "8px 2px" }}>
            Loading kits…
          </div>
        ) : kits.length === 0 ? (
          <div style={{ fontSize: 12.5, color: C.t3, padding: "8px 2px" }}>
            No saved kits yet.
          </div>
        ) : (
          kits.map((kit) => {
            const isCurrent = kit.id === asset.brandKitId;
            return (
              <button
                key={kit.id}
                type="button"
                role="menuitem"
                onClick={() => (isCurrent ? undefined : onPick(kit))}
                disabled={isCurrent}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 11px",
                  borderRadius: 10,
                  border: `1px solid ${isCurrent ? C.blue : C.line}`,
                  background: isCurrent
                    ? `color-mix(in srgb, ${C.blue} 10%, transparent)`
                    : "transparent",
                  color: C.t1,
                  cursor: isCurrent ? "default" : "pointer",
                  textAlign: "left",
                }}
              >
                <BrandSwatches brand={kit} />
                <span
                  style={{
                    flex: 1,
                    fontSize: 13,
                    fontWeight: isCurrent ? 600 : 500,
                    color: isCurrent ? C.t1 : C.t2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {kit.name ?? "Untitled kit"}
                </span>
                {isCurrent ? (
                  <span style={{ fontSize: 11, color: C.blueS }}>Current ✓</span>
                ) : (
                  <span style={{ fontSize: 12, color: C.t3 }}>›</span>
                )}
              </button>
            );
          })
        )}
        <button
          type="button"
          role="menuitem"
          onClick={onNewKit}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "9px 11px",
            borderRadius: 10,
            border: `1px dashed ${C.line}`,
            background: "transparent",
            color: C.t2,
            cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 14, width: 12, textAlign: "center" }}>+</span>
          <span style={{ fontSize: 13 }}>New brand kit…</span>
        </button>
      </div>
    </div>
  );
}

export interface RemixClusterProps {
  /** The generated asset the cluster acts on. */
  asset: RemixAsset;
  /**
   * Re-seed the CURRENT conversation with a prompt (the `?prompt=` path). The
   * asset re-renders in context. Restyle/Rebrand/Pick/Merge/variations/fan-out
   * all route through this.
   */
  onReseed: (prompt: string) => void;
  /**
   * The active brand, so make-variations / fan-out can carry the brand contract
   * into their seeded generations. Optional — when omitted the cluster resolves
   * the active brand itself (it lives in the create domain, so it can), which
   * keeps cross-domain hosts (chat) from having to import the brand hook.
   */
  brand?: BrandProfileLike | null;
  /**
   * Optional notification that make-variations was invoked (e.g. for the host
   * to open a side view). The cluster owns the actual generation — it builds the
   * N variation prompts and fires them via `onReseed`.
   */
  onMakeVariations?: () => void;
  /**
   * Live variation artifacts to show in the 4e grid, when the host can render
   * them. Absent → the grid shows labelled placeholder tiles (demo treatment).
   */
  variations?: VariationResult[];
  /**
   * Open the gallery for the asset's mode to pick a new template/style. The
   * host owns the gallery; on confirm it should call `buildRestylePrompt` +
   * `onReseed`.
   */
  onRestyle: () => void;
  /** Open the Brand Kit creation flow ("New brand kit…"). */
  onNewBrandKit: () => void;
  /**
   * Enable the 4g STRETCH multi-format fan-out affordance. Off by default — it's
   * a later-phase capability (see create-fanout). When on, an "Also make…"
   * action opens the chooser; generating fires one seeded generation per format.
   */
  enableFanout?: boolean;
}

type RemixPanel = "none" | "variations" | "fanout" | "kit";

/**
 * The remix cluster. Desktop = inline row; mobile = bottom action sheet.
 * "Make variations" and (when enabled) "Also make…" open inline panels that
 * host the 4e grid / 4g chooser.
 */
export function RemixCluster({
  asset,
  onReseed,
  brand: brandProp,
  onMakeVariations,
  variations,
  onRestyle,
  onNewBrandKit,
  enableFanout = false,
}: RemixClusterProps) {
  const isMobile = useIsMobile();
  // Resolve the active brand ourselves when the host didn't pass one, so the
  // seeded make-variations / fan-out generations still carry the brand contract.
  const { brand: activeBrand } = useActiveBrand();
  const brand = brandProp ?? activeBrand;
  const [rebrandOpen, setRebrandOpen] = useState(false);
  const [panel, setPanel] = useState<RemixPanel>("none");
  // The kit assets produced by a fan-out, shown in the 4g result view.
  const [kitAssets, setKitAssets] = useState<KitAsset[]>([]);

  const pickBrand = (kit: ActiveBrand) => {
    setRebrandOpen(false);
    onReseed(buildRebrandPrompt(asset, kit.id, kit));
  };

  // Make variations (4e): build N variation prompts and fire the first via the
  // re-seed path (the rest are the same path a batched endpoint / the user can
  // fire — we don't stack navigations), then open the comparison grid.
  const fireVariations = () => {
    const prompts = buildVariationPrompts(asset, undefined, brand ?? null);
    if (prompts[0]) onReseed(prompts[0]);
  };
  const openVariations = () => {
    fireVariations();
    onMakeVariations?.();
    setPanel("variations");
  };

  // Fan-out (4g): fire one seeded generation per picked format, then show the
  // kit result shell. NOTE: coordinated-by-brand only — true single-pass kit
  // orchestration is a backend TODO (see create-fanout / create-remix).
  const generateFanout = (formatIds: string[]) => {
    const built = buildFanoutPrompts(asset, formatIds, brand ?? null);
    built.forEach((b) => onReseed(b.prompt));
    const assets: KitAsset[] = [
      { id: "source", label: `${asset.noun ?? "Deck"} · source` },
      ...built.map((b) => ({
        id: b.format.id,
        label: b.format.label,
        isSet: b.format.id === "social",
        setSize: 3,
      })),
    ];
    setKitAssets(assets);
    setPanel("kit");
  };

  const variationResults: VariationResult[] =
    variations ??
    DEFAULT_VARIATIONS.map((v) => ({ index: v.index, variant: v.variant }));

  const panelOverlay =
    panel === "none" ? null : (
      <RemixPanelHost onClose={() => setPanel("none")} mobile={isMobile}>
        {panel === "variations" ? (
          <VariationsResult
            title={`${variationResults.length} variations`}
            subtitle={`${asset.name} · in your brand`}
            variations={variationResults}
            onRegenerateAll={fireVariations}
            onPick={(index) => {
              setPanel("none");
              onReseed(
                `Pick variation ${index} of this ${asset.noun ?? "asset"} and ` +
                  `promote it to the final version — keep it exactly as generated.`,
              );
            }}
            onMerge={(indexes) => {
              setPanel("none");
              onReseed(buildMergePrompt(asset, indexes, brand ?? null));
            }}
          />
        ) : panel === "fanout" ? (
          <AlsoMakeChooser
            sourceFormatId="slides"
            onGenerate={generateFanout}
          />
        ) : (
          <KitResultView
            title={`${asset.name} launch kit`}
            assets={kitAssets}
            onRegenerateAsset={(id) =>
              onReseed(
                `Regenerate just the "${id}" asset of the kit — leave the ` +
                  `others untouched.`,
              )
            }
            onDownloadAll={() =>
              onReseed("Bundle the whole kit and give me a download link.")
            }
          />
        )}
      </RemixPanelHost>
    );

  if (isMobile) {
    return (
      <>
        <RemixSheet
          asset={asset}
          rebrandOpen={rebrandOpen}
          onToggleRebrand={() => setRebrandOpen((v) => !v)}
          onRestyle={onRestyle}
          onMakeVariations={openVariations}
          onPickBrand={pickBrand}
          onNewBrandKit={onNewBrandKit}
          onFanout={enableFanout ? () => setPanel("fanout") : undefined}
        />
        {panelOverlay}
      </>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      {panelOverlay}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: C.t3,
            marginRight: 4,
          }}
        >
          Remix
        </span>
        <RemixChip
          icon={<RefreshCw size={13} />}
          label="Restyle"
          onClick={onRestyle}
        />
        <RemixChip
          icon={<Palette size={13} />}
          label="Rebrand"
          active={rebrandOpen}
          onClick={() => setRebrandOpen((v) => !v)}
        />
        <RemixChip
          icon={<Copy size={13} />}
          label="Make variations"
          onClick={openVariations}
        />
        {enableFanout ? (
          <button
            type="button"
            onClick={() => setPanel("fanout")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 12.5,
              fontWeight: 600,
              color: C.t1,
              background: C.surface,
              border: `1px solid ${C.line}`,
              borderRadius: 9,
              padding: "7px 12px",
              cursor: "pointer",
            }}
          >
            Also make…
            <LaterPhaseBadge />
          </button>
        ) : null}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 12,
            color: C.t3,
          }}
        >
          or just keep chatting to refine ›
        </span>
      </div>

      {rebrandOpen ? (
        <>
          {/* click-catcher */}
          <button
            type="button"
            aria-label="Close rebrand menu"
            onClick={() => setRebrandOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 40,
              background: "transparent",
              border: "none",
              cursor: "default",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: "calc(100% + 8px)",
              right: 12,
              zIndex: 41,
            }}
          >
            <RebrandMenu
              asset={asset}
              onPick={pickBrand}
              onNewKit={() => {
                setRebrandOpen(false);
                onNewBrandKit();
              }}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The overlay that hosts a remix sub-panel (4e grid / 4g chooser / kit). A
 * centered modal on desktop, a bottom sheet on mobile, over a scrim.
 */
function RemixPanelHost({
  children,
  onClose,
  mobile,
}: {
  children: React.ReactNode;
  onClose: () => void;
  mobile: boolean;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: mobile ? "flex-end" : "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
        padding: mobile ? 0 : 24,
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "transparent",
          border: "none",
          cursor: "default",
        }}
      />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: mobile ? "100%" : "min(760px, 100%)",
          maxHeight: mobile ? "88dvh" : "88vh",
          overflowY: "auto",
        }}
      >
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          style={{
            position: "absolute",
            top: mobile ? 12 : -14,
            right: mobile ? 12 : -14,
            zIndex: 2,
            width: 30,
            height: 30,
            borderRadius: 999,
            display: "grid",
            placeItems: "center",
            border: `1px solid ${C.line}`,
            background: C.surface,
            color: C.t2,
            cursor: "pointer",
          }}
        >
          <X size={15} />
        </button>
        {children}
      </div>
    </div>
  );
}

/** A single remix action chip (desktop). */
function RemixChip({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontSize: 12.5,
        fontWeight: 600,
        color: active ? C.blueS : C.t1,
        background: active
          ? `color-mix(in srgb, ${C.blue} 12%, transparent)`
          : C.surface,
        border: `1px solid ${active ? C.blue : C.line}`,
        borderRadius: 9,
        padding: "7px 12px",
        cursor: "pointer",
      }}
    >
      <span style={{ color: active ? C.blueS : C.t2, display: "flex" }}>
        {icon}
      </span>
      {label}
    </button>
  );
}

/** SET 3b — the mobile remix bottom action sheet. */
function RemixSheet({
  asset,
  rebrandOpen,
  onToggleRebrand,
  onRestyle,
  onMakeVariations,
  onPickBrand,
  onNewBrandKit,
  onFanout,
}: {
  asset: RemixAsset;
  rebrandOpen: boolean;
  onToggleRebrand: () => void;
  onRestyle: () => void;
  onMakeVariations: () => void;
  onPickBrand: (kit: ActiveBrand) => void;
  onNewBrandKit: () => void;
  onFanout?: () => void;
}) {
  return (
    <div
      style={{
        borderTop: `1px solid ${C.line}`,
        background: C.surface,
        borderRadius: "18px 18px 0 0",
        padding: "10px 16px 16px",
      }}
    >
      <div
        aria-hidden
        style={{
          width: 36,
          height: 4,
          borderRadius: 999,
          background: C.line,
          margin: "0 auto 12px",
        }}
      />
      <div
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.t3,
          marginBottom: 10,
        }}
      >
        Remix this {asset.noun ?? "asset"}
      </div>

      {rebrandOpen ? (
        <RebrandMenuMobile
          asset={asset}
          onPick={onPickBrand}
          onNewKit={onNewBrandKit}
          onBack={onToggleRebrand}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <SheetRow
            icon={<RefreshCw size={16} />}
            title="Restyle"
            hint="Swap template"
            onClick={onRestyle}
          />
          <SheetRow
            icon={<Palette size={16} />}
            title="Rebrand"
            hint="Another Brand Kit"
            emphasis
            onClick={onToggleRebrand}
          />
          <SheetRow
            icon={<Copy size={16} />}
            title="Make variations"
            hint="Compare alternates"
            onClick={onMakeVariations}
          />
          {onFanout ? (
            <SheetRow
              icon={<Copy size={16} />}
              title="Also make…"
              hint="Multi-format kit · later phase"
              onClick={onFanout}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function SheetRow({
  icon,
  title,
  hint,
  emphasis,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  emphasis?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        background: C.sunken,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        padding: "12px 14px",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: 34,
          height: 34,
          borderRadius: 9,
          color: emphasis ? C.blueS : C.t2,
          background: emphasis
            ? `color-mix(in srgb, ${C.blue} 12%, transparent)`
            : C.surface,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1 }}>
        <span
          style={{
            display: "block",
            fontSize: 14,
            fontWeight: 600,
            color: emphasis ? C.blueS : C.t1,
          }}
        >
          {title}
        </span>
        <span style={{ display: "block", fontSize: 11, color: C.t3 }}>
          {hint}
        </span>
      </span>
      <span style={{ color: emphasis ? C.blueS : C.t3 }}>›</span>
    </button>
  );
}

/** Mobile variant of the Rebrand menu (list within the sheet). */
function RebrandMenuMobile({
  asset,
  onPick,
  onNewKit,
  onBack,
}: {
  asset: RemixAsset;
  onPick: (kit: ActiveBrand) => void;
  onNewKit: () => void;
  onBack: () => void;
}) {
  const { kits, isLoading } = useBrandKits();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          alignSelf: "flex-start",
          fontSize: 12,
          color: C.t3,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
          marginBottom: 2,
        }}
      >
        ‹ Back
      </button>
      {isLoading ? (
        <div style={{ fontSize: 12.5, color: C.t3 }}>Loading kits…</div>
      ) : (
        kits.map((kit) => {
          const isCurrent = kit.id === asset.brandKitId;
          return (
            <button
              key={kit.id}
              type="button"
              disabled={isCurrent}
              onClick={() => onPick(kit)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: C.sunken,
                border: `1px solid ${isCurrent ? C.blue : C.line}`,
                borderRadius: 12,
                padding: "12px 14px",
                cursor: isCurrent ? "default" : "pointer",
                textAlign: "left",
              }}
            >
              <BrandSwatches brand={kit} />
              <span
                style={{ flex: 1, fontSize: 14, fontWeight: 600, color: C.t1 }}
              >
                {kit.name ?? "Untitled kit"}
              </span>
              {isCurrent ? (
                <span style={{ fontSize: 11, color: C.blueS }}>Current ✓</span>
              ) : (
                <span style={{ color: C.t3 }}>›</span>
              )}
            </button>
          );
        })
      )}
      <button
        type="button"
        onClick={onNewKit}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          background: "transparent",
          border: `1px dashed ${C.line}`,
          borderRadius: 12,
          padding: "12px 14px",
          color: C.t2,
          cursor: "pointer",
        }}
      >
        <span style={{ fontSize: 15 }}>+</span>
        <span style={{ fontSize: 14 }}>New brand kit…</span>
      </button>
    </div>
  );
}
