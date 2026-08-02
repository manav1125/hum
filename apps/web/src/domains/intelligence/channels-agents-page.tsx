/**
 * Channels — how Cue reaches you.
 *
 * DESKTOP: the "One you, every channel" reach overview — active/available
 * channel status, hero stats, deep-links to per-channel setup.
 *
 * The A2A block (`AgentsPage`) used to render beneath it under an "Agent
 * network" eyebrow. It is now its own leaf at `/assistant/agent-network`: a
 * section with no URL cannot be linked to or landed on, and agent pairing is a
 * different trust decision from channel connection.
 *
 * Per-channel SETUP (token entry, connect/disconnect, the A2A invite dialog)
 * still lives in the Connections workbench at `/assistant/contacts`, which
 * this page deep-links into for the actual wiring. Connections has no leaf of
 * its own — see `your-cue-model.ts` — because it is per-person channel
 * verification, and that belongs on the person's row in People.
 *
 * On MOBILE this route is the "You" tab of the native shell and renders the
 * mobile-v3 You screen (`Mv3YouPage`, spec frame 9 — trust HQ): the autonomy
 * mode dial, the track-record receipts, and native grouped rows into Memory /
 * Connections / Skills / Agents / Brand kit. Channel setup stays reachable
 * through the Connections screen + the quiet Channels footer link (the
 * `/assistant/contacts` workbench is unchanged). Desktop rendering is
 * untouched.
 */

import { useMobileLayout } from "@/hooks/use-is-mobile";
import { ChannelsPage } from "@/domains/intelligence/channels-page";
import { Mv3YouPage } from "@/mobile-v3/you/you-page";

export function ChannelsAgentsPage() {
  const isMobile = useMobileLayout();

  // MOBILE "You" tab — the mobile-v3 trust-HQ screen (spec frame 9). Desktop
  // path below is left exactly as it was.
  if (isMobile) {
    return <Mv3YouPage />;
  }

  // DESKTOP: channels only. The A2A block that used to hang below the channel
  // grid is now its own leaf at `/assistant/agent-network` — design's "Agent
  // network". It was a section with an eyebrow and no URL, so it could not be
  // linked to, bookmarked or landed on; and pairing with another agent is a
  // different trust decision from connecting Slack, which is exactly the test
  // for whether two things belong on one page.
  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ChannelsPage />
    </div>
  );
}
