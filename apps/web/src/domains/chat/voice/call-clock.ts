/**
 * The call clock, shared by the ladder surfaces (bar · pill · room header).
 *
 * A timer is a claim ("this call has run for 3:12"), so it is computed from a
 * real epoch start or not rendered at all — no placeholder clocks. The start
 * itself is owned by the voice-call store's session (see `voice-call-store.ts`)
 * precisely so every surface shows the same number across collapse/expand.
 */

import { useEffect, useState } from "react";

/** `m:ss`, or `h:mm:ss` past an hour. Mirrors the mobile call screen. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Ticking elapsed label for a call that started at `startedAt` (epoch ms), or
 * `null` when there is no start to count from — the caller renders nothing in
 * that case rather than a made-up number.
 */
export function useCallClock(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (startedAt === null) return null;
  return formatElapsed(now - startedAt);
}
