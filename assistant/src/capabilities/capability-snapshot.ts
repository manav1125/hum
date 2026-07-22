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

const log = getLogger("capability-snapshot");

/**
 * What Cue can actually do right now, in the words a caller needs to judge
 * "can I honestly claim this?". Derived from the LIVE tool registry and the
 * linked-account table — never a hardcoded belief about the product.
 */
export interface CapabilitySnapshot {
  /** Human capability lines. */
  lines: string[];
  /** Linked account providers ("google", "slack", …). */
  connectors: string[];
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

  let connectors: string[] = [];
  try {
    // Read the connection table directly rather than through the oauth store:
    // this is a read-only capability probe, and the store sits in the daemon's
    // heavily interlinked startup graph.
    const rows = getDb()
      .select({ provider: oauthConnections.provider })
      .from(oauthConnections)
      .where(eq(oauthConnections.status, "active"))
      .all();
    connectors = [...new Set(rows.map((r) => r.provider))].sort();
  } catch (err) {
    log.debug(
      { err: String(err) },
      "connections unavailable for capability snapshot",
    );
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ lines, connectors }))
    .digest("hex")
    .slice(0, 16);

  return { lines, connectors, fingerprint };
}
