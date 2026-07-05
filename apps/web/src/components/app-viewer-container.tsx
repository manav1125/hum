import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Minimize2 } from "lucide-react";

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

  const srcdoc = useMemo(
    () => injectBridge(html, appId, { fetch: true, route }),
    [html, appId, route],
  );

  const iframeKey = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < html.length; i++) {
      hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
    }
    return `app-${appId}-${hash}`;
  }, [html, appId]);

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

      <div className="relative min-h-0 flex-1">
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
        <iframe
          ref={iframeRef}
          key={iframeKey}
          srcDoc={srcdoc}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title={appName}
          className="h-full w-full border-none"
        />
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
