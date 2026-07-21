/**
 * Cue Live summon-accelerator rendering, shared by the desktop control panel
 * and the off-desktop web explainer.
 *
 * The accelerator is *never* hardcoded at a call site. On the desktop the live
 * value comes off the bridge (`CueLiveStatus.hotkey` — the string Electron main
 * actually registered). Off-desktop there is no bridge and therefore no live
 * value to read, so we fall back to `CUE_LIVE_DEFAULT_HOTKEY` from the IPC
 * contract — the same constant Electron main registers — rather than a second
 * copy that can silently drift (the design pack said "⌥Space"; the shipped
 * default is Control+Option+Space).
 */
import { useEffect, useState } from "react";

import { CUE_LIVE_DEFAULT_HOTKEY } from "@vellumai/ipc-contract";

import { C, mono } from "@/lib/hq-theme";
import { getCueLiveStatus, isCueLiveAvailable } from "@/runtime/cue-live";

/** Accelerator part → the glyph macOS shows for it. */
const KEYCAP_LABELS: Record<string, string> = {
  Control: "⌃",
  Ctrl: "⌃",
  Option: "⌥",
  Alt: "⌥",
  Command: "⌘",
  Cmd: "⌘",
  Shift: "⇧",
  Space: "Space",
};

/** Split a hotkey accelerator ("Control+Option+Space") into glyphs. */
export function hotkeyGlyphs(hotkey: string): string {
  return hotkey
    .split("+")
    .map((p) => KEYCAP_LABELS[p] ?? p)
    .join(" ");
}

/**
 * The accelerator to display: the live registered one when the bridge is
 * reachable, else the shipped default. Never a literal at the call site.
 */
export function useCueLiveHotkey(): string {
  const [hotkey, setHotkey] = useState<string>(CUE_LIVE_DEFAULT_HOTKEY);

  useEffect(() => {
    if (!isCueLiveAvailable()) return;
    let cancelled = false;
    void (async () => {
      const status = await getCueLiveStatus();
      if (!cancelled && status?.hotkey) setHotkey(status.hotkey);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return hotkey;
}

/** Render an accelerator string as a single keycap pill matching the mock. */
export function Keycap({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "danger";
}) {
  const danger = tone === "danger";
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 11,
        background: danger
          ? "color-mix(in srgb, var(--mv1-danger) 12%, transparent)"
          : C.sunken,
        border: `1px solid ${
          danger
            ? "color-mix(in srgb, var(--mv1-danger) 40%, transparent)"
            : C.line2
        }`,
        color: danger ? C.danger : C.t1,
        borderRadius: 6,
        padding: "3px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
