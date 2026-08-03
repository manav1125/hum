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
 * On MOBILE this route used to render the whole v3 "You" hub, which is why the
 * phone's Channels leaf never had a screen of its own. Design's R2 gave that
 * hub its real name and its real URL — Your Cue, at `routes.yourCue` — so this
 * route now redirects there. The redirect is deliberate rather than a deletion:
 * a dozen phone screens shipped with `back={routes.channels}` pointing at the
 * hub, and every one of them still lands somewhere real.
 *
 * Per-channel SETUP on a phone is the Connections workbench at
 * `/assistant/contacts`, which is where the Your Cue leaf list sends the
 * Channels row (`your-cue-mobile.ts`). Desktop rendering is untouched.
 */

import { Navigate } from "react-router";

import { useMobileLayout } from "@/hooks/use-is-mobile";
import { ChannelsPage } from "@/domains/intelligence/channels-page";
import { routes } from "@/utils/routes";

export function ChannelsAgentsPage() {
  const isMobile = useMobileLayout();

  if (isMobile) {
    return <Navigate to={routes.yourCue} replace />;
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
