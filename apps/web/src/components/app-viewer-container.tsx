import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChevronLeft, ChevronRight, Minimize2 } from "lucide-react";

import { AppNavBar } from "@/components/app-nav-bar";
import { RemixCluster } from "@/domains/create/create-remix-cluster";
import type { RemixAsset } from "@/domains/create/create-remix";
import type { BrandProfileLike } from "@/domains/create/create-intent";
import { useSandboxFetchProxy } from "@/hooks/use-sandbox-fetch-proxy";
import { cn } from "@/utils/misc";
import { injectBridge } from "@/utils/sandbox-bridge";
import { Button } from "@vellumai/design-library";

/**
 * Create Studio remix wiring for the viewer (SET 3). When supplied, a light
 * remix cluster (Restyle · Rebrand · Make variations) renders under the app.
 * All handlers re-seed the source conversation via the host's `?prompt=` path.
 *
 * The remix *asset* + *brand* are described here (in the shared component layer)
 * so the chat callers stay free of a cross-domain import into `create` — they
 * pass primitives (asset name, active brand) and the re-seed callback; this
 * component assembles the `RemixAsset` the cluster consumes.
 */
export interface AppViewerRemix {
  /** The generated asset the cluster acts on. */
  asset: RemixAsset;
  /** The active brand (carried into make-variations / fan-out generations). */
  brand?: BrandProfileLike | null;
  /** Re-seed the source conversation with a prompt (`?prompt=` path). */
  onReseed: (prompt: string) => void;
  onRestyle: () => void;
  onMakeVariations?: () => void;
  onNewBrandKit: () => void;
  /** Enable the 4g STRETCH multi-format fan-out affordance (later phase). */
  enableFanout?: boolean;
}

export interface AppViewerContainerProps {
  appId: string;
  appName: string;
  html: string;
  assistantId: string;
  onClose: () => void;
  onEdit?: () => void;
  /** When true, the nav bar Edit button shows "Close chat" instead. */
  isEditing?: boolean;
  onShare?: () => void;
  isSharing?: boolean;
  onDeploy?: () => void;
  isDeploying?: boolean;
  /** Deep-link route passed to the app as `window.vellum.route`. */
  route?: string;
  /** Enables the fullscreen toggle (nav-bar button + fullscreen rendering). Default false. */
  enableFullscreen?: boolean;
  /**
   * Create Studio remix cluster (SET 3). When supplied, a light Restyle /
   * Rebrand / Make-variations row renders under the app. Omit to hide it (e.g.
   * while editing, or for non-Create apps).
   */
  remix?: AppViewerRemix;
}

/**
 * Decks are authored to the SLIDES contract: fixed 1280×720 slides with
 * arrow-key navigation. On narrow (phone) viewports that layout is unusable
 * raw, so we render the frame at the contract size and CSS-scale it to fit —
 * same heuristic the Library uses to badge an app as a Deck.
 */
const DECK_NAME_RE = /deck|slide|pitch|presentation/i;
const DECK_VIRTUAL_W = 1280;
const DECK_VIRTUAL_H = 720;
/** Below this container width the deck fit-to-width treatment kicks in. */
const DECK_FIT_MAX_W = 700;

export function AppViewerContainer({
  appId,
  appName,
  html,
  assistantId,
  onClose,
  onEdit,
  isEditing,
  onShare,
  isSharing,
  onDeploy,
  isDeploying,
  route,
  enableFullscreen = false,
  remix,
}: AppViewerContainerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => setIsFullscreen((v) => !v), []);

  // Reset fullscreen when the rendered app changes.
  useEffect(() => {
    setIsFullscreen(false);
  }, [appId]);

  // Escape-to-exit handler, active only while fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  // --- Mobile deck treatment (fit-to-width scaled slide + swipe/arrows) ----
  const isDeck = DECK_NAME_RE.test(appName);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(
    null,
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setStageSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit-to-width only on narrow (phone) stages — desktop renders unscaled.
  const deckFit =
    isDeck && stageSize && stageSize.w > 0 && stageSize.w < DECK_FIT_MAX_W
      ? {
          scale: Math.min(
            stageSize.w / DECK_VIRTUAL_W,
            stageSize.h / DECK_VIRTUAL_H,
          ),
        }
      : null;

  const srcdoc = useMemo(
    () => injectBridge(html, appId, { fetch: true, route, deckNav: isDeck }),
    [html, appId, route, isDeck],
  );

  /** Forward a pagination key into the sandboxed deck frame. */
  const sendDeckNav = useCallback((key: "ArrowLeft" | "ArrowRight") => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "vellum_deck_nav", key },
      "*",
    );
  }, []);

  // Deck fit changes the frame's virtual viewport (e.g. 390 → 1280): remount
  // so decks that measure the viewport once at load lay out for the new size.
  // Keyed on the boolean (not the scale) so plain resizes don't remount.
  const deckFitActive = deckFit !== null;
  const iframeKey = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < html.length; i++) {
      hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
    }
    return `app-${appId}-${hash}${deckFitActive ? "-deckfit" : ""}`;
  }, [html, appId, deckFitActive]);

  // Decks wait for the first stage measurement before mounting the iframe:
  // mounting unscaled and then remounting when the ResizeObserver flips
  // `deckFitActive` double-loads a heavy srcdoc document (a large chunk of
  // the slow first paint on phones). The RO fires within a frame, so the
  // deferral is invisible; a shimmer skeleton covers the document load.
  const deckAwaitingMeasure = isDeck && stageSize === null;
  const [frameLoaded, setFrameLoaded] = useState(false);
  useEffect(() => {
    setFrameLoaded(false);
  }, [iframeKey]);

  useSandboxFetchProxy(iframeRef, {
    frameId: appId,
    assistantId,
  });

  return (
    <div
      data-testid="app-viewer-root"
      className={cn(
        "flex flex-col overflow-hidden bg-[var(--surface-base)]",
        isFullscreen ? "fixed inset-0 z-[60]" : "h-full rounded-xl",
      )}
    >
      {!isFullscreen && (
        <AppNavBar
          appName={appName}
          onEdit={onEdit}
          isEditing={isEditing}
          onShare={onShare}
          isSharing={isSharing}
          onDeploy={onDeploy}
          isDeploying={isDeploying}
          onToggleFullscreen={enableFullscreen ? toggleFullscreen : undefined}
          onClose={onClose}
        />
      )}

      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden">
        {isFullscreen && (
          <div
            className="absolute z-10"
            style={{
              top: "max(0.75rem, var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
              right:
                "max(0.75rem, var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
            }}
          >
            <Button
              variant="primary"
              iconOnly={<Minimize2 />}
              onClick={toggleFullscreen}
              tooltip="Exit fullscreen"
            />
          </div>
        )}
        {!deckAwaitingMeasure ? (
          <iframe
            ref={iframeRef}
            key={iframeKey}
            srcDoc={srcdoc}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            title={appName}
            onLoad={() => setFrameLoaded(true)}
            className={deckFit ? "border-none" : "h-full w-full border-none"}
            style={
              deckFit
                ? {
                    // Render at the SLIDES contract size and scale to fit the
                    // stage — the deck lays out exactly as on desktop and the
                    // whole slide is visible (letterboxed) on a phone.
                    width: DECK_VIRTUAL_W,
                    height: DECK_VIRTUAL_H,
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    transform: `translate(-50%, -50%) scale(${deckFit.scale})`,
                  }
                : undefined
            }
          />
        ) : null}
        {isDeck && (deckAwaitingMeasure || !frameLoaded) ? (
          // First-paint skeleton — a letterboxed slide-shaped shimmer so the
          // stage never reads as blank while the deck document loads.
          <div
            aria-hidden
            data-testid="deck-loading-skeleton"
            className="absolute inset-0 flex items-center justify-center"
          >
            <div
              className="animate-pulse rounded-md bg-[var(--surface-lift)]"
              style={{
                width: "88%",
                aspectRatio: "16 / 9",
                maxHeight: "88%",
              }}
            />
          </div>
        ) : null}
        {deckFit ? (
          // Letterbox pagination — swipe works on the slide itself (bridge),
          // these give a visible, thumb-sized affordance since the deck's own
          // nav chrome is scaled too small to tap.
          <div
            className="absolute inset-x-0 bottom-2 z-10 flex items-center justify-center gap-3"
            style={{ pointerEvents: "none" }}
          >
            {(
              [
                ["ArrowLeft", "Previous slide", ChevronLeft],
                ["ArrowRight", "Next slide", ChevronRight],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                aria-label={label}
                onClick={() => sendDeckNav(key)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border-element)] bg-[var(--surface-lift)] text-[var(--content-secondary)]"
                style={{ pointerEvents: "auto" }}
              >
                <Icon size={20} aria-hidden />
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Create Studio remix cluster (SET 3) — hidden in fullscreen + editing. */}
      {remix && !isFullscreen && !isEditing ? (
        <RemixCluster
          asset={remix.asset}
          brand={remix.brand}
          onReseed={remix.onReseed}
          onRestyle={remix.onRestyle}
          onMakeVariations={remix.onMakeVariations}
          onNewBrandKit={remix.onNewBrandKit}
          enableFanout={remix.enableFanout}
        />
      ) : null}
    </div>
  );
}
