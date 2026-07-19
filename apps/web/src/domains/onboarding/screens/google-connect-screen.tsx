import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { Mv3OnboardingShell } from "@/domains/onboarding/screens/mv3/mv3-onboarding-shell";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  assistantsOauthConnectionsListOptions,
  useAssistantsOauthStartCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { useOAuthCompleteDeepLinkListener } from "@/hooks/use-oauth-complete-deep-link-listener";
import {
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
  isOAuthCompletePayloadForRequest,
  oauthCompletionStorageKey,
  type OAuthCompletePayload,
} from "@/lib/auth/oauth-popup";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import type { OAuthCompleteDeepLinkPayload } from "@/runtime/native-deep-link";
import { publicAsset } from "@/utils/public-asset";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

const GOOGLE_PROVIDER_KEY = "google";
const GOOGLE_CONNECT_ITEMS = [
  {
    id: "gmail",
    label: "Gmail",
    logoSrc: publicAsset("/images/integrations/gmail.svg"),
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    logoSrc: publicAsset("/images/integrations/google-calendar.svg"),
  },
  {
    id: "google-drive",
    label: "Google Drive",
    logoSrc: publicAsset("/images/integrations/google-drive.svg"),
  },
];

interface GoogleConnectScreenProps {
  assistantId: string;
  assistantName: string;
  onConnect: (scopes: string[]) => void;
  onSkip: () => void;
  onBack: () => void;
}

export function GoogleConnectScreen({
  assistantId,
  assistantName,
  onConnect,
  onSkip,
  onBack,
}: GoogleConnectScreenProps) {
  const electron = isElectron();
  const queryClient = useQueryClient();
  const isNative = useIsNativePlatform();
  const isMobile = useIsMobile();

  const popupRef = useRef<Window | null>(null);
  const pendingRequestRef = useRef<{ requestId: string } | null>(null);
  const popupCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const popupClosedGraceTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const messageListenerRef = useRef<((event: MessageEvent) => void) | null>(
    null,
  );
  const storageListenerRef = useRef<((event: StorageEvent) => void) | null>(
    null,
  );
  const nativeFinishUnsubRef = useRef<(() => void) | null>(null);
  const [oauthInProgress, setOAuthInProgress] = useState(false);

  const clearPendingRequest = useCallback(() => {
    pendingRequestRef.current = null;
    setOAuthInProgress(false);
  }, []);

  const removeEventListeners = useCallback(() => {
    if (messageListenerRef.current) {
      window.removeEventListener("message", messageListenerRef.current);
      messageListenerRef.current = null;
    }
    if (storageListenerRef.current) {
      window.removeEventListener("storage", storageListenerRef.current);
      storageListenerRef.current = null;
    }
  }, []);

  const closePopupWindow = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
    popupRef.current = null;
    if (popupCheckIntervalRef.current) {
      clearInterval(popupCheckIntervalRef.current);
      popupCheckIntervalRef.current = null;
    }
    if (popupClosedGraceTimeoutRef.current) {
      clearTimeout(popupClosedGraceTimeoutRef.current);
      popupClosedGraceTimeoutRef.current = null;
    }
  }, []);

  const startOAuth = useAssistantsOauthStartCreateMutation();

  useEffect(() => {
    return () => {
      if (popupCheckIntervalRef.current)
        clearInterval(popupCheckIntervalRef.current);
      if (popupClosedGraceTimeoutRef.current)
        clearTimeout(popupClosedGraceTimeoutRef.current);
      if (popupRef.current && !popupRef.current.closed)
        popupRef.current.close();
      if (messageListenerRef.current) {
        window.removeEventListener("message", messageListenerRef.current);
      }
      if (storageListenerRef.current) {
        window.removeEventListener("storage", storageListenerRef.current);
      }
      if (nativeFinishUnsubRef.current) {
        nativeFinishUnsubRef.current();
        nativeFinishUnsubRef.current = null;
      }
    };
  }, []);

  const fetchActiveGoogleConnection =
    useCallback(async (): Promise<OAuthConnection | null> => {
      try {
        const connections = await queryClient.fetchQuery({
          ...assistantsOauthConnectionsListOptions({
            path: { assistant_id: assistantId },
          }),
          staleTime: 0,
        });
        return (
          (connections as OAuthConnection[]).find(
            (c) => c.provider === GOOGLE_PROVIDER_KEY && c.connected,
          ) ?? null
        );
      } catch {
        return null;
      }
    }, [assistantId, queryClient]);

  const handleOAuthSuccess = useCallback(async () => {
    closePopupWindow();
    clearPendingRequest();
    const connection = await fetchActiveGoogleConnection();
    onConnect(connection?.scopes_granted ?? []);
  }, [
    clearPendingRequest,
    closePopupWindow,
    fetchActiveGoogleConnection,
    onConnect,
  ]);

  const handleOAuthCompletePayload = useCallback(
    (payload: OAuthCompletePayload) => {
      if (payload.type !== "vellum:oauth-complete") return;
      if (
        !pendingRequestRef.current ||
        payload.requestId !== pendingRequestRef.current.requestId
      ) {
        return;
      }
      if (payload.oauthStatus === "connected") {
        void handleOAuthSuccess();
      } else {
        closePopupWindow();
        clearPendingRequest();
      }
    },
    [clearPendingRequest, closePopupWindow, handleOAuthSuccess],
  );

  const handleOAuthMessage = useCallback(
    (event: MessageEvent) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) return;
      const payload = getOAuthCompleteMessagePayload(
        event,
        window.location.origin,
        pendingRequest.requestId,
      );
      if (payload) handleOAuthCompletePayload(payload);
    },
    [handleOAuthCompletePayload],
  );

  const handleOAuthStorage = useCallback(
    (event: StorageEvent) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) return;
      const payload = getOAuthCompleteStoragePayload(
        event,
        pendingRequest.requestId,
      );
      if (payload) {
        handleOAuthCompletePayload(payload);
        window.localStorage.removeItem(
          oauthCompletionStorageKey(pendingRequest.requestId),
        );
      }
    },
    [handleOAuthCompletePayload],
  );

  const handleOAuthDeepLink = useCallback(
    (payload: OAuthCompleteDeepLinkPayload) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) return;
      if (payload.requestId !== pendingRequest.requestId) return;
      handleOAuthCompletePayload({
        type: "vellum:oauth-complete",
        requestId: payload.requestId,
        oauthStatus: payload.oauthStatus,
        oauthProvider: payload.oauthProvider,
        oauthCode: payload.oauthCode,
      });
    },
    [handleOAuthCompletePayload],
  );
  useOAuthCompleteDeepLinkListener(handleOAuthDeepLink);

  const handleConnect = useCallback(() => {
    const requestId = crypto.randomUUID();

    removeEventListeners();
    messageListenerRef.current = handleOAuthMessage;
    storageListenerRef.current = handleOAuthStorage;

    if (isNative) {
      setOAuthInProgress(true);
      pendingRequestRef.current = { requestId };
      startOAuth.mutate(
        {
          path: { assistant_id: assistantId, provider: GOOGLE_PROVIDER_KEY },
          body: {
            requested_scopes: [],
            redirect_after_connect: `${routes.account.oauth.popupComplete}?requestId=${requestId}&native=1`,
          },
        },
        {
          onSuccess(data) {
            void openUrl(data.connect_url);
          },
          onError() {
            clearPendingRequest();
          },
        },
      );

      window.addEventListener("message", handleOAuthMessage);
      window.addEventListener("storage", handleOAuthStorage);

      if (nativeFinishUnsubRef.current) nativeFinishUnsubRef.current();
      const unsubFinished = openUrlFinishedListener(() => {
        const pendingRequest = pendingRequestRef.current;
        if (!pendingRequest) {
          unsubFinished();
          nativeFinishUnsubRef.current = null;
          return;
        }
        void (async () => {
          const connection = await fetchActiveGoogleConnection();
          if (!pendingRequestRef.current) return;
          if (connection) {
            await handleOAuthSuccess();
          } else {
            clearPendingRequest();
          }
          removeEventListeners();
          unsubFinished();
          nativeFinishUnsubRef.current = null;
        })();
      });
      nativeFinishUnsubRef.current = unsubFinished;
      return;
    }

    const popup = window.open("", "_blank", "width=500,height=600");
    if (popup === null) {
      removeEventListeners();
      return;
    }

    popupRef.current = popup;
    setOAuthInProgress(true);
    pendingRequestRef.current = { requestId };

    window.addEventListener("message", handleOAuthMessage);
    window.addEventListener("storage", handleOAuthStorage);

    popupCheckIntervalRef.current = setInterval(() => {
      if (
        popupRef.current &&
        popupRef.current.closed &&
        pendingRequestRef.current &&
        !popupClosedGraceTimeoutRef.current
      ) {
        popupClosedGraceTimeoutRef.current = setTimeout(async () => {
          popupClosedGraceTimeoutRef.current = null;
          const pendingRequest = pendingRequestRef.current;
          if (!pendingRequest) return;

          const storedCompletion = window.localStorage.getItem(
            oauthCompletionStorageKey(pendingRequest.requestId),
          );
          if (storedCompletion) {
            try {
              const parsed: unknown = JSON.parse(storedCompletion);
              if (
                isOAuthCompletePayloadForRequest(
                  parsed,
                  pendingRequest.requestId,
                )
              ) {
                handleOAuthCompletePayload(parsed);
                window.localStorage.removeItem(
                  oauthCompletionStorageKey(pendingRequest.requestId),
                );
                removeEventListeners();
                return;
              }
            } catch {
              // Fall through to poll path.
            }
          }

          const connection = await fetchActiveGoogleConnection();
          if (!pendingRequestRef.current) return;

          if (connection) {
            await handleOAuthSuccess();
          } else {
            closePopupWindow();
            clearPendingRequest();
          }
          removeEventListeners();
        }, 1000);
      }
    }, 100);

    startOAuth.mutate(
      {
        path: { assistant_id: assistantId, provider: GOOGLE_PROVIDER_KEY },
        body: {
          requested_scopes: [],
          redirect_after_connect: `${routes.account.oauth.popupComplete}?requestId=${requestId}`,
        },
      },
      {
        onSuccess(data) {
          if (popupRef.current && !popupRef.current.closed) {
            popupRef.current.location.href = data.connect_url;
          } else if (pendingRequestRef.current) {
            closePopupWindow();
            clearPendingRequest();
            removeEventListeners();
          }
        },
        onError() {
          closePopupWindow();
          clearPendingRequest();
          removeEventListeners();
        },
      },
    );
  }, [
    assistantId,
    clearPendingRequest,
    closePopupWindow,
    fetchActiveGoogleConnection,
    handleOAuthCompletePayload,
    handleOAuthMessage,
    handleOAuthStorage,
    handleOAuthSuccess,
    isNative,
    removeEventListeners,
    startOAuth,
  ]);

  const assistantInlineName = assistantName || "your assistant";
  const assistantSentenceName = assistantName || "Your assistant";

  // Mobile v3 restyle (spec frame 14 grammar) — same OAuth machinery
  // (handleConnect / oauthInProgress), same skippability; only the frame
  // changes. Desktop keeps the existing layout byte-for-byte below.
  if (isMobile) {
    const busy = oauthInProgress || startOAuth.isPending;
    return (
      <Mv3OnboardingShell
        step="Step 2 of 4"
        onBack={onBack}
        onSkip={busy ? undefined : onSkip}
        cta={busy ? "Waiting for authorization…" : "Connect Google"}
        ctaDisabled={busy}
        onCta={handleConnect}
      >
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: "-0.7px",
            lineHeight: 1.15,
            marginTop: 6,
          }}
        >
          Connect where your
          <br />
          digital world lives.
        </div>
        <div
          style={{
            fontSize: 14,
            color: "var(--mv3-muted)",
            marginTop: 8,
            lineHeight: 1.5,
          }}
        >
          A few now, more anytime. Nothing leaves without your say-so.
        </div>

        {/* Real app logos on glass cards (frame 14's connector grid — scoped
            to what this step can actually connect: the Google trio). */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 9,
            marginTop: 16,
          }}
        >
          {GOOGLE_CONNECT_ITEMS.map((item) => (
            <div
              key={item.id}
              style={{
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 18,
                padding: "13px 14px",
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                boxShadow: "var(--mv3-card-shadow)",
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  background: "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid rgba(0,0,0,.06)",
                }}
              >
                <img
                  src={item.logoSrc}
                  alt=""
                  width={18}
                  height={18}
                  style={{ width: 18, height: 18, objectFit: "contain" }}
                  loading="eager"
                />
              </span>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  marginTop: 9,
                  color: "var(--mv3-text)",
                }}
              >
                {item.label}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--mv3-micro)",
                  marginTop: 2,
                }}
              >
                Connect ›
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            fontSize: 12.5,
            color: "var(--mv3-faint)",
            marginTop: 16,
            lineHeight: 1.55,
          }}
        >
          {`${assistantSentenceName} will never send email, change calendar events, or edit files without your permission. You can disconnect at any time.`}
        </div>
      </Mv3OnboardingShell>
    );
  }

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div
        className={`mx-auto flex w-full max-w-md flex-col items-center ${electron ? "min-h-full px-8 pt-11 pb-8 electron-prechat-type" : "px-6 pt-12 pb-40"} text-[var(--content-default)]`}
      >
        <div
          className="grid w-full grid-cols-[auto_1fr_auto] items-center"
          style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
        >
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-base)]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1
            className={`text-center ${electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}`}
          >
            Connect Google
          </h1>
          <div aria-hidden="true" className="h-8 w-8" />
        </div>

        <p
          className="mt-4 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          {`If you use Google, ${assistantInlineName} can use Gmail, Calendar, and Drive with your permission.`}
        </p>

        <div
          className="mt-6 flex items-stretch justify-center gap-3"
          style={{ animation: "fadeInUp 0.3s ease-out 0.2s both" }}
        >
          {GOOGLE_CONNECT_ITEMS.map((item) => (
            <div
              key={item.id}
              className="flex w-24 flex-col items-center gap-2.5 rounded-2xl bg-[var(--surface-lift)] px-3 pb-3 pt-4"
            >
              <img
                src={item.logoSrc}
                alt=""
                width={28}
                height={28}
                className="h-7 w-7 object-contain"
                loading="eager"
              />
              <span className="text-center text-xs leading-tight text-[var(--content-tertiary)]">
                {item.label}
              </span>
            </div>
          ))}
        </div>

        <p
          className="mt-8 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.25s both" }}
        >
          {`${assistantSentenceName} will never send email, change calendar events, or edit files without your permission. You can disconnect at any time.`}
        </p>

        <div
          className={`${electron ? "mt-auto" : "mt-8"} flex w-full flex-col gap-2`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.35s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            onClick={handleConnect}
            disabled={oauthInProgress || startOAuth.isPending}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            {oauthInProgress || startOAuth.isPending ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Waiting for authorization...
              </span>
            ) : (
              "Connect Google"
            )}
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onSkip}
            disabled={oauthInProgress || startOAuth.isPending}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            Skip for now
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
