/**
 * Channels & Agents — the unified "reach + pairing" overview.
 *
 * Composes two existing surfaces into one tab, deliberately reusing their
 * component bodies unchanged:
 *  - `ChannelsPage` — the "One you, every channel" reach overview (active /
 *    available channel status, hero stats, deep-links to per-channel setup).
 *  - `AgentsPage` — the A2A section (Enable-A2A toggle, paired-agents grid,
 *    one-time invite flow).
 *
 * Per-channel SETUP (token entry, connect/disconnect, the A2A invite dialog)
 * still lives in the Connections workbench at `/assistant/contacts`; both
 * sections deep-link there for the actual wiring. This page is the single
 * place where reachability and agent pairing are surfaced together.
 */

import { AgentsPage } from "@/domains/intelligence/agents-page";
import { ChannelsPage } from "@/domains/intelligence/channels-page";

const sectionLabelStyle = {
  fontFamily: "'DM Mono', ui-monospace, monospace",
  fontSize: 10.5,
  letterSpacing: ".1em",
  textTransform: "uppercase" as const,
  color: "#8D99A5",
  margin: "8px 0 16px",
};

export function ChannelsAgentsPage() {
  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ChannelsPage />

      {/* Agents (A2A) section — its own labelled block beneath the channel
          reach overview. The AgentsPage body carries its own hero, so a thin
          divider + eyebrow is enough to set the two apart. */}
      <div
        style={{
          borderTop: "1px solid #E5E9F0",
          marginTop: 8,
          paddingTop: 28,
        }}
      >
        <div style={sectionLabelStyle}>Agent network</div>
        <AgentsPage />
      </div>
    </div>
  );
}
