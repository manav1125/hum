/**
 * AutomationsPage (WS-F) — the route entry for `/assistant/automations`.
 * Mobile (≤767px) renders the v3 leaf (frames 69/70); desktop renders the
 * serif-HQ board (web W3). Same daemon data + the same server-enforced
 * autonomy cap under both.
 */
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { Mv3AutomationsPage } from "@/mobile-v3/you/automations-page";

import { WebAutomationsBoard } from "./automations-board";

export function AutomationsPage() {
  const isMobile = useMobileLayout();
  return isMobile ? <Mv3AutomationsPage /> : <WebAutomationsBoard />;
}
