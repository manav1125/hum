/**
 * The live capability snapshot — "what can Cue actually do right now?"
 *
 * Derived from the LIVE tool registry and the linked-account table, never from
 * a hardcoded belief about the product. Capabilities whose tool can be
 * registered while the thing behind it is unconfigured are gated on the thing
 * (a phone line is only claimed when Twilio credentials exist), because an
 * overclaim becomes a promise the run cannot keep.
 *
 * This module is the single home for that derivation. It was extracted from
 * `work-items/work-item-assessment.ts` (which still re-exports it for its own
 * callers) so the CONVERSATIONAL agent can read the same snapshot instead of
 * shelling out to `assistant --help` at runtime to discover itself.
 */

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { getConfig } from "../config/loader.js";
import { getDb } from "../memory/db-connection.js";
import { oauthConnections } from "../memory/schema/oauth.js";
import { getRegisteredToolNames } from "../tasks/tool-sanitizer.js";
import { getLogger } from "../util/logger.js";
import { kickComposioStatusRefresh } from "./composio-connection-status.js";
import { reconcileMcpConnectors } from "./mcp-connectors.js";

const log = getLogger("capability-snapshot");

/**
 * What Cue can actually do right now, in the words a caller needs to judge
 * "can I honestly claim this?". Derived from the LIVE tool registry and the
 * linked-account table — never a hardcoded belief about the product.
 */
export interface CapabilitySnapshot {
  /** Human capability lines. */
  lines: string[];
  /**
   * Providers with a VERIFIED live connection ("google", "slack", …) — safe to
   * assert as a linked account. Native active OAuth ∪ Composio toolkits known
   * to be ACTIVE. A provider configured but not confirmed live is NOT here (see
   * `unverifiedConnectors`), so this list never over-claims.
   */
  connectors: string[];
  /**
   * Providers configured through an enabled Composio server but NOT confirmed
   * live — the connection is `initiated`/expired, or its status is unknown.
   * These may need reconnection; the model must verify before relying and must
   * never treat them as guaranteed linked accounts. Optional so existing
   * snapshot literals (tests, fixtures) need no change; `buildCapabilitySnapshot`
   * always populates it (possibly empty).
   */
  unverifiedConnectors?: string[];
  /** Stable fingerprint — usable as part of a cache key. */
  fingerprint: string;
}

/**
 * Capability probes: a human line, and the tool-name segments whose presence
 * in the live registry proves Cue has it. Segment-matched (names split on
 * non-alphanumerics) rather than substring-matched, so `sort_order` never
 * reads as `order`.
 */
const CAPABILITY_PROBES: ReadonlyArray<{
  line: string;
  segments: readonly string[];
  /**
   * Extra check for capabilities whose tool can be registered while the thing
   * it talks to is not set up. Absent = the tool existing is proof enough.
   * Throwing counts as not configured — an overclaim is worse than an
   * underclaim, because claims turn into promises.
   */
  configured?: () => boolean;
}> = [
  {
    line: "search the web and read web pages",
    segments: ["web", "search", "fetch"],
  },
  {
    line: "drive a real web browser (open sites, fill forms, click through flows)",
    segments: ["browser"],
  },
  {
    line: "see and control the user's Mac — apps, windows, clicking and typing (computer use)",
    segments: ["computer", "cu"],
  },
  {
    line: "run shell commands and read/write files on the user's Mac",
    segments: ["host"],
  },
  {
    line: "read and write files in its own workspace (drafts, documents, data files)",
    segments: ["file"],
  },
  {
    // Gated on real credentials, not on the tool existing. A registered call
    // tool with no Twilio account behind it made the assessor promise to
    // "call the dentist's office and speak with the receptionist" — the exact
    // kind of confident, undeliverable plan this whole pass exists to stop.
    line: "place and take phone calls",
    segments: ["call", "phone", "sms"],
    configured: () => {
      const twilio = getConfig().twilio;
      return Boolean(twilio?.accountSid && twilio?.phoneNumber);
    },
  },
  {
    line: "send messages on the channels the user has connected",
    segments: ["message", "send"],
  },
  {
    line: "recall the user's personal memory — people, preferences, past work",
    segments: ["recall", "remember", "memory"],
  },
  {
    line: "run its installed skills (specialised procedures for particular jobs)",
    segments: ["skill"],
  },
  {
    line: "schedule work to happen later",
    segments: ["schedule", "cron", "reminder"],
  },
];

function toolNameSegments(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Build the live capability snapshot. Never throws: a registry or DB failure
 * degrades to an empty snapshot, which callers report honestly as "unknown"
 * rather than asserting Cue can't do things it can.
 */
export function buildCapabilitySnapshot(): CapabilitySnapshot {
  let segments = new Set<string>();
  try {
    for (const tool of getRegisteredToolNames()) {
      for (const segment of toolNameSegments(tool)) segments.add(segment);
    }
  } catch (err) {
    log.debug(
      { err: String(err) },
      "tool registry unavailable for capability snapshot",
    );
    segments = new Set<string>();
  }

  const lines = CAPABILITY_PROBES.filter((probe) => {
    if (!probe.segments.some((segment) => segments.has(segment))) return false;
    if (!probe.configured) return true;
    try {
      return probe.configured();
    } catch (err) {
      log.debug(
        { err: String(err), line: probe.line },
        "capability probe unreadable — treating as not configured",
      );
      return false;
    }
  }).map((probe) => probe.line);

  // Reconcile the TWO connector systems into one HONEST view. A provider wired
  // through an enabled MCP/Composio server (composio_gmail, …) can be just as
  // usable, from the agent's standpoint, as a native OAuth link — but only when
  // the Composio connection is actually ACTIVE. The `enabled` config flag is
  // set once at connect time and never cleared when the connection dies, so it
  // over-claims on its own: an enabled `composio_gmail` whose connection is
  // `initiated`/expired must NOT read as a linked account. So the MCP side is
  // reconciled against real per-toolkit ACTIVE status and split into verified
  // vs needs-attention. Each source is independently fail-soft.
  //
  // Warm the cached Composio status snapshot for next time without blocking:
  // single-flight, TTL-bounded, fire-and-forget (never a per-turn network call
  // on this hot path). This read returns immediately with what is already known.
  try {
    kickComposioStatusRefresh();
  } catch (err) {
    log.debug({ err: String(err) }, "composio status refresh kick failed");
  }

  const native = new Set<string>();
  try {
    // Read the connection table directly rather than through the oauth store:
    // this is a read-only capability probe, and the store sits in the daemon's
    // heavily interlinked startup graph.
    const rows = getDb()
      .select({ provider: oauthConnections.provider })
      .from(oauthConnections)
      .where(eq(oauthConnections.status, "active"))
      .all();
    for (const r of rows) native.add(r.provider);
  } catch (err) {
    log.debug(
      { err: String(err) },
      "native connections unavailable for capability snapshot",
    );
  }
  // `reconcileMcpConnectors` never throws (it degrades to empty sets), so an
  // MCP config problem can never take down the whole connector view. A native
  // active OAuth token is authoritative on its own, so native providers count
  // as verified regardless of the Composio copy's status.
  const { verified: mcpVerified, needsAttention: mcpAttention } =
    reconcileMcpConnectors();
  const connectors = [...new Set([...native, ...mcpVerified])].sort();
  // A provider verified via native OR MCP is not "unverified", even if another
  // of its backing toolkits looks broken — it demonstrably works one way.
  const verifiedSet = new Set(connectors);
  const unverifiedConnectors = [...mcpAttention]
    .filter((p) => !verifiedSet.has(p))
    .sort();

  if (unverifiedConnectors.length > 0) {
    // Injected as a capability line so the honesty reaches BOTH the system
    // prompt and the work-item assessor (both render `lines`) without either
    // treating these as guaranteed linked accounts. Also steers reconnection to
    // Cue's own on-demand Connectors surface — which mints a fresh, working
    // link at click time — instead of a pre-generated, short-lived link.
    lines.push(
      `integrations set up but NOT confirmed working right now (may need reconnection — verify before relying on them, do not promise them): ${unverifiedConnectors.join(
        ", ",
      )}. To reconnect one, open Cue → Connectors and reconnect it there.`,
    );
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ lines, connectors, unverifiedConnectors }))
    .digest("hex")
    .slice(0, 16);

  return { lines, connectors, unverifiedConnectors, fingerprint };
}
