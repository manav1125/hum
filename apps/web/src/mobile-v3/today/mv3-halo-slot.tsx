/**
 * Halo's row on Today — the card's web face.
 *
 * The design gives the Halo card two homes and one job: answer *is it on, and
 * does Cue have what it heard* without anybody opening anything. On a phone
 * the rich surfaces are native (see `HaloPlugin.swift`), so this row is the
 * door rather than the destination: it states the sync line honestly, and a
 * tap hands off to the native Day.
 *
 * Two rules it will not break:
 *
 *  · **Never invents the number.** When nothing has arrived the line reads
 *    "nothing yet"; it never prints a zero, which would claim Cue is current
 *    with a room it has never heard.
 *  · **Only a button when there is somewhere to go.** On the web there are no
 *    native surfaces to open, so the row renders as a statement rather than a
 *    control. A tappable row that does nothing is worse than a plain one.
 *
 * When there is no Halo at all, `useHaloSlot` returns null and nothing renders
 * — see that module for why an empty row would be the wrong thing to build.
 */
import { haptic } from "@/utils/haptics";
import { openHalo } from "@/lib/halo/halo-bridge";

import { mv3Mono } from "../mv3-kit";
import type { HaloSlotFace } from "./use-halo-slot";

/** Amber while behind, green when current, dim when it has nothing to say. */
function dotColour(state: HaloSlotFace["state"]): string {
  if (state === "up_to_date") return "rgb(115 217 141)";
  if (state === "behind") return "rgb(255 184 77)";
  return "rgba(255 255 255 / 0.35)";
}

export function Mv3HaloSlot({
  face,
  style,
}: {
  face: HaloSlotFace;
  style?: React.CSSProperties;
}) {
  const body = (
    <>
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: dotColour(face.state),
          flexShrink: 0,
        }}
      />
      <span
        style={{ fontSize: 14, fontWeight: 500, color: "rgb(244 244 246)" }}
      >
        Halo
      </span>
      <span
        style={{
          fontFamily: mv3Mono,
          fontSize: 11,
          color: "rgba(255 255 255 / 0.55)",
          marginLeft: "auto",
        }}
      >
        {face.line}
      </span>
      {face.canOpen ? (
        <span style={{ color: "rgba(255 255 255 / 0.4)", fontSize: 13 }}>
          ›
        </span>
      ) : null}
    </>
  );

  const frame: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    width: "100%",
    minHeight: 48,
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255 255 255 / 0.09)",
    background: "rgba(255 255 255 / 0.05)",
    ...style,
  };

  // Not a control when there is nowhere to go.
  if (!face.canOpen) {
    return (
      <div style={frame} aria-label={`Halo, ${face.line}`}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      style={{ ...frame, textAlign: "left", cursor: "pointer" }}
      aria-label={`Halo, ${face.line}. Open your day.`}
      onClick={() => {
        haptic.medium();
        void openHalo("day");
      }}
    >
      {body}
    </button>
  );
}
