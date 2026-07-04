/**
 * "Your Home is now HQ" — the one-time switch-over orientation (§1 of the
 * Cue-HQ-Build doc: "returning users get one calm orientation — not a tour").
 *
 * Dismissible, localStorage-gated, shows exactly once per browser profile —
 * on desktop and mobile alike (the card is width-capped and margin-safe at
 * 390px). Two panels map the two Home modules that moved:
 *   Up next · Scheduled → Queued & scheduled
 *   Your Next Move      → Top of Needs you
 */

import { useEffect, useState } from "react";

import { C, mono, serif } from "./hq-kit";

const STORAGE_KEY = "cue:hq-orientation-seen";

/** True once (per profile) — whether to show the switch-over orientation. */
export function useHqOrientation(): { show: boolean; dismiss: () => void } {
  const [show, setShow] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) == null;
    } catch {
      return false;
    }
  });
  const dismiss = () => {
    setShow(false);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, "1");
    } catch {
      // Private-mode storage failures just mean it may show again.
    }
  };
  return { show, dismiss };
}

function MovedPanel({ was, now }: { was: string; now: string }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 140,
        background: C.sunken,
        borderRadius: 12,
        padding: "13px 14px",
      }}
    >
      <div
        style={{ fontSize: 12.5, color: C.t3, textDecoration: "line-through" }}
      >
        {was}
      </div>
      <div
        style={{
          fontSize: 13,
          color: C.ink,
          marginTop: 6,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span aria-hidden style={{ color: C.blueS }}>
          →
        </span>{" "}
        {now}
      </div>
    </div>
  );
}

export function HqOrientationPanel({ onDismiss }: { onDismiss: () => void }) {
  // Escape dismisses — it's an orientation, never a wall.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Your Home is now HQ"
      onClick={onDismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background:
          "linear-gradient(160deg, rgba(22,32,46,.78), rgba(12,18,27,.85))",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 520,
          background: C.surface,
          borderRadius: 18,
          padding: "28px 30px",
          boxShadow: "0 50px 110px -50px rgba(0,0,0,.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            marginBottom: 18,
          }}
        >
          <span
            aria-hidden
            style={{
              position: "relative",
              width: 34,
              height: 34,
              borderRadius: 10,
              background: "#0F1620",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                boxShadow: "0 0 0 2.5px #3D6EE8 inset",
                mask: "radial-gradient(circle, transparent 52%, #000 53%)",
                WebkitMask:
                  "radial-gradient(circle, transparent 52%, #000 53%)",
                transform: "rotate(40deg)",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  width: "27%",
                  height: "27%",
                  borderRadius: "50%",
                  background: "#3D6EE8",
                  top: "8%",
                  left: "8%",
                }}
              />
            </span>
          </span>
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              letterSpacing: "0.13em",
              color: C.t3,
            }}
          >
            WHAT CHANGED
          </span>
        </div>

        <div
          style={{
            fontFamily: serif,
            fontSize: 27,
            lineHeight: 1.1,
            color: C.ink,
            marginBottom: 8,
          }}
        >
          Your Home is now{" "}
          <span style={{ fontStyle: "italic", color: C.blueS }}>HQ</span>.
        </div>
        <p
          style={{
            fontSize: 13.5,
            color: C.t2,
            lineHeight: 1.55,
            margin: "0 0 18px",
          }}
        >
          Same daily brief and next move — now it runs the company too. Nothing
          was lost; here&rsquo;s where a few things went.
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <MovedPanel was="Up next · Scheduled" now="Queued & scheduled" />
          <MovedPanel was="Your Next Move" now="Top of Needs you" />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 20,
          }}
        >
          <button
            type="button"
            onClick={onDismiss}
            style={{
              flex: 1,
              textAlign: "center",
              fontSize: 13.5,
              fontWeight: 600,
              background: "#1A2230",
              color: "#fff",
              border: "none",
              borderRadius: 11,
              padding: 12,
              cursor: "pointer",
            }}
          >
            Take me to HQ
          </button>
          <button
            type="button"
            onClick={onDismiss}
            style={{
              fontSize: 13,
              color: C.t3,
              background: "none",
              border: "none",
              padding: "12px 8px",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Show me around ›
          </button>
        </div>
      </div>
    </div>
  );
}
