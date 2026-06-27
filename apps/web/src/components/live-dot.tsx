/**
 * Live-stream indicator. Reads the shared SSE connection store
 * (`stores/sse-connected-store.ts`) reactively and renders a small pulsing
 * dot + label that reflects whether the command center is being driven by the
 * real-time event stream (green ● live) or has fallen back to the 60s
 * safety-net poll (grey ○ reconnecting…).
 *
 * Used by the Activity page and Mission Control header so the freshness
 * guarantee is honest: green means "you're seeing changes the instant they
 * happen"; grey means "catching up on a poll."
 */

import { useSSEConnectedStore } from "@/stores/sse-connected-store";

import { C, mono } from "@/domains/activity/theme";

export function LiveDot({ label = true }: { label?: boolean }) {
  const isConnected = useSSEConnectedStore.use.isConnected();

  return (
    <span
      data-slot="live-dot"
      role="status"
      aria-live="polite"
      aria-label={isConnected ? "Live — real-time updates on" : "Reconnecting"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: mono,
        fontSize: 11.5,
        letterSpacing: "0.04em",
        color: isConnected ? C.green : C.t3,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: isConnected ? C.green : C.t3,
          boxShadow: isConnected ? `0 0 0 0 ${C.green}66` : "none",
          animation: isConnected ? "cueLivePulse 2s ease-out infinite" : "none",
        }}
      />
      {label ? (isConnected ? "live" : "reconnecting…") : null}
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@keyframes cueLivePulse{0%{box-shadow:0 0 0 0 rgba(39,126,65,.45)}70%{box-shadow:0 0 0 5px rgba(39,126,65,0)}100%{box-shadow:0 0 0 0 rgba(39,126,65,0)}}",
        }}
      />
    </span>
  );
}
