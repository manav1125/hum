/**
 * Types for the People "relationship memory" backend — the data model behind
 * the Claude-Projects-style contact dossier (Cue-Surfaces S4).
 */

export type ContactMemoryKind =
  | "fact"
  | "preference"
  | "relationship"
  | "context";

export type ContactMemorySource = "told" | "inferred" | "from_conversation";

/** One durable statement Cue remembers about a contact. */
export interface ContactMemory {
  id: string;
  contactId: string;
  statement: string;
  kind: ContactMemoryKind;
  source: ContactMemorySource;
  /** Conversation/message id the fact came from, when source=from_conversation. */
  sourceRef: string | null;
  /** 0..1. */
  confidence: number;
  createdAt: number;
  lastSeenAt: number;
}

export type RelationshipTier = "weak" | "building" | "strong";

/** Materialized relationship signal for a contact. */
export interface ContactRelationship {
  contactId: string;
  /** 0..100. */
  score: number;
  tier: RelationshipTier;
  lastInteractionAt: number | null;
  interactionCount: number;
  updatedAt: number;
}

/** One "REACHABLE ON" channel row, derived from contact_channels. */
export interface ReachabilityChannel {
  channelId: string;
  type: string;
  address: string;
  isPrimary: boolean;
  status: string;
  /** True when the channel is verified/active — safe to reach out on. */
  reachable: boolean;
  lastSeenAt: number | null;
}

/** One time-ordered touchpoint in the interactions timeline. */
export interface ContactInteraction {
  kind: "conversation" | "call";
  /** The conversation this touchpoint belongs to. */
  conversationId: string;
  /** Channel the touchpoint happened on (e.g. "slack", "phone", "vellum"). */
  channel: string;
  title: string | null;
  /** Epoch ms the touchpoint is ordered by (most recent activity). */
  at: number;
}

/** The full dossier payload the frontend renders. */
export interface ContactDossier {
  contactId: string;
  displayName: string;
  contactType: string;
  role: string;
  relationship: ContactRelationship;
  memory: ContactMemory[];
  reachability: ReachabilityChannel[];
  interactions: ContactInteraction[];
  /**
   * True when the interactions stitch was cut short (query error or wall-clock
   * budget). `interactions` is then a partial/empty prefix and the UI should
   * show a "couldn't load full history" hint rather than "no interactions".
   */
  interactionsDegraded: boolean;
}
