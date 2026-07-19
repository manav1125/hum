/**
 * OfflineTakeover — the full-screen offline / waking-up state (spec frame 23):
 * "Motion stops, glow gone, ring greys, orbit dots frozen — the pause IS the
 * message. No red; not your fault."
 *
 * Two conditions, one layout:
 *   · `navigator.onLine === false`      → "You're offline"
 *   · online but the daemon SSE channel → "Cue may be waking up." (the
 *     has been down for a sustained spell   cold-start / restart case)
 *
 * The SSE signal is the app's existing daemon-unreachability signal
 * (`useSSEConnectedStore`, the same store HQ's degraded banner reads). A
 * sustained-outage grace window keeps route-change reconnect blips from
 * flashing the takeover. Mounted MOBILE-ONLY by root-layout.
 *
 * Reduced-motion: trivially satisfied — everything here is still.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { client } from "@/generated/daemon/client.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useSSEConnectedStore } from "@/stores/sse-connected-store";
import { haptic } from "@/utils/haptics";

import { CueRing } from "./cue-ring";

/** How long the SSE channel must stay down (while online) before the daemon
 *  is even suspected. Short blips (navigation, token refresh) never surface. */
const DAEMON_DOWN_GRACE_MS = 12_000;

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function useIsOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** True once the SSE channel has been down for the full grace window. */
function useDaemonDownSustained(enabled: boolean): boolean {
  const isConnected = useSSEConnectedStore.use.isConnected();
  const [sustained, setSustained] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!enabled || isConnected) {
      setSustained(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      setSustained(true);
    }, DAEMON_DOWN_GRACE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, isConnected]);

  return sustained;
}

export function OfflineTakeover() {
  const online = useIsOnline();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  // Only meaningful once an assistant is active — pre-auth / onboarding /
  // chooser screens manage their own connection states.
  const gateActive = Boolean(assistantId) && assistantStateKind === "active";
  const sseDown = useDaemonDownSustained(gateActive && online);

  // The SSE channel alone can flap while plain HTTP still works, so a
  // sustained drop only takes over after a cheap REST probe ALSO fails —
  // an unreachable/waking daemon fails both.
  const [probeFailed, setProbeFailed] = useState(false);
  useEffect(() => {
    if (!sseDown || !assistantId) {
      setProbeFailed(false);
      return;
    }
    let cancelled = false;
    void client
      .get({
        url: "/v1/assistants/{assistant_id}/company-profile",
        path: { assistant_id: assistantId },
        throwOnError: false,
      })
      .then(({ response }) => {
        if (!cancelled) setProbeFailed(!response?.ok);
      })
      .catch(() => {
        if (!cancelled) setProbeFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sseDown, assistantId]);

  const show = (gateActive && !online) || (sseDown && probeFailed);
  if (!show) return null;

  const waking = online;

  return (
    <div
      data-mv3
      data-slot="mv3-offline-takeover"
      role="alert"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 30px",
          opacity: 0.92,
        }}
      >
        {/* The frozen grey ring — orbit ring solid (not dashed), dots stopped,
            no glow, everything still. */}
        <div style={{ position: "relative", width: 110, height: 110, margin: "0 auto" }}>
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: -12,
              borderRadius: "50%",
              border:
                "1px solid color-mix(in srgb, var(--mv3-muted) 20%, transparent)",
            }}
          />
          {/* Frozen satellite dots. */}
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: -4,
              left: "50%",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--mv3-faint)",
            }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              bottom: 6,
              left: 8,
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--mv3-faint)",
            }}
          />
          <CueRing
            size={110}
            stroke="var(--mv3-muted)"
            dotColor="var(--mv3-faint)"
            style={{ position: "relative", opacity: 0.75 }}
          />
        </div>

        <div
          style={{
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "-0.6px",
            textAlign: "center",
            marginTop: 26,
          }}
        >
          {waking ? "Cue is waking up" : "You're offline"}
        </div>
        <div
          style={{
            fontSize: 14,
            color: "var(--mv3-muted)",
            textAlign: "center",
            marginTop: 10,
            lineHeight: 1.55,
          }}
        >
          {waking ? (
            <>
              Cue may be waking up. Your data is safe.
              <br />
              This usually takes a moment.
            </>
          ) : (
            <>
              The orbit&rsquo;s still here — your work is safe.
              <br />
              Everything picks right back up when you reconnect.
            </>
          )}
        </div>

        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.medium();
            window.location.reload();
          }}
          style={{
            width: "100%",
            background: "var(--mv3-text)",
            color: "var(--mv3-bg)",
            border: "none",
            borderRadius: 15,
            padding: 15,
            minHeight: 48,
            fontSize: 15,
            fontWeight: 600,
            fontFamily: "inherit",
            marginTop: 24,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
      <div
        aria-hidden
        style={{
          flexShrink: 0,
          height: "calc(24px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
        }}
      />
    </div>
  );
}
