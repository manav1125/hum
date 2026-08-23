import { isElectron } from "@/runtime/is-electron";

import type { NeedsYouItem } from "@vellumai/ipc-contract";

/**
 * Per-capability wrapper for the menu-bar "needs you" count, matching the
 * shape of `runtime/dock.ts`: feature code calls this named function and the
 * cross-platform branch lives here rather than at every call site.
 *
 * The count exists so the floating corner never has to interrupt. Approvals
 * reach the owner as something they pull down, not as a panel that seizes
 * focus over their work — one surface you summon, one that waits.
 *
 * Fire-and-forget, and a no-op off Electron, so the publisher can run
 * unconditionally on every state change.
 */
export function setNeedsYou(payload: {
  count: number;
  items: NeedsYouItem[];
}): void {
  if (!isElectron()) return;
  window.vellum?.needsYou?.set(payload);
}
