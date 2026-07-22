import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { toast } from "@vellumai/design-library";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { AppViewerContainer } from "@/components/app-viewer-container";
import { appsByIdOpenPost } from "@/generated/daemon/sdk.gen";
import { useEditApp } from "@/hooks/use-edit-app";
import { primeAppHtmlCache } from "@/utils/app-html-cache";
import { routes } from "@/utils/routes";
import { shareApp } from "@/utils/share-app";

interface LoadedApp {
  appId: string;
  dirName?: string;
  name: string;
  html: string;
}

/**
 * Turn whatever `appsByIdOpenPost` threw into a message worth showing.
 *
 * With `throwOnError: true` the generated client throws the *parsed error
 * body*, not an `Error` — so the previous `err instanceof Error` check
 * essentially never matched and every failure, including a gateway 504 or a
 * dropped connection, rendered the same contentless "Failed to open app".
 * Naming the actual failure is what lets a user (or a support bundle) tell a
 * missing app apart from a stalled daemon.
 */
export function describeOpenFailure(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const body = err as { error?: unknown; message?: unknown; detail?: unknown };
    for (const field of [body.error, body.message, body.detail]) {
      if (typeof field === "string" && field) return field;
      if (field && typeof field === "object") {
        const nested = (field as { message?: unknown }).message;
        if (typeof nested === "string" && nested) return nested;
      }
    }
  }
  return "Failed to open app";
}

export function LibraryDetailPage() {
  const { appId } = useParams<{ appId: string }>();
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const [app, setApp] = useState<LoadedApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  // Bumping this re-runs the load effect. The open request is a one-shot
  // POST with no query-client retry behind it, so a daemon that was briefly
  // stalled (gateway 504, transport drop) used to strand the user on a
  // terminal "Failed to open app / Back to Library" screen even though the
  // very next request would have succeeded.
  const [reloadNonce, setReloadNonce] = useState(0);
  const requestRef = useRef<string | null>(null);

  useEffect(() => {
    if (!appId) return;
    requestRef.current = appId;
    setApp(null);
    setError(null);

    appsByIdOpenPost({
      path: { assistant_id: assistantId, id: appId },
      throwOnError: true,
    })
      .then(({ data: result }) => {
        if (requestRef.current !== appId) return;
        primeAppHtmlCache(assistantId, result.appId, result.html);
        setApp({
          appId: result.appId,
          dirName: result.dirName,
          name: result.name,
          html: result.html,
        });
      })
      .catch((err) => {
        if (requestRef.current !== appId) return;
        setError(describeOpenFailure(err));
      });

    return () => {
      requestRef.current = null;
    };
  }, [assistantId, appId, reloadNonce]);

  const handleRetry = useCallback(() => {
    setReloadNonce((n) => n + 1);
  }, []);

  const handleClose = useCallback(() => {
    void navigate(routes.library.root);
  }, [navigate]);

  const editApp = useEditApp();
  const handleEdit = useCallback(() => {
    if (app) editApp(app);
  }, [app, editApp]);

  const handleShare = useCallback(async () => {
    if (!app || isSharing) return;
    setIsSharing(true);
    try {
      await shareApp(assistantId, app.appId, app.name);
      toast.success("App exported", { description: `${app.name}.vellum` });
    } catch (err) {
      toast.error("Failed to share app", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsSharing(false);
    }
  }, [assistantId, app, isSharing]);

  if (!appId) return null;

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {error}
        </p>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleRetry}
            className="text-body-medium-default text-[var(--primary-base)] underline"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="text-body-medium-default text-[var(--content-tertiary)] underline"
          >
            Back to Library
          </button>
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
      </div>
    );
  }

  return (
    // The route renders full-bleed (no shell header), so it must clear the
    // iOS status bar itself — otherwise the viewer nav bar sits under the
    // clock. Zero on desktop where the inset resolves to 0px.
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
      }}
    >
      <AppViewerContainer
        appId={app.appId}
        appName={app.name}
        html={app.html}
        assistantId={assistantId}
        onClose={handleClose}
        onEdit={handleEdit}
        onShare={handleShare}
        isSharing={isSharing}
        enableFullscreen
      />
    </div>
  );
}
