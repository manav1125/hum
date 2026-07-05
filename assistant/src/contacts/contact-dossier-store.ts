/**
 * Contact dossier assembly — the read model behind the Claude-Projects-style
 * contact dossier (Cue-Surfaces S4).
 *
 * Stitches together, for one contact:
 *   - relationship: score/tier (contact-relationship-store),
 *   - memory: "WHAT CUE REMEMBERS" facts (contact-memory-store),
 *   - reachability: "REACHABLE ON" — DERIVED from the contact's existing
 *     contact_channels (no new storage), and
 *   - interactions: a time-ordered list of the contact's touchpoints, stitched
 *     from conversations bound to the contact's channel identities plus calls,
 *     reusing the existing binding tables.
 *
 * Everything here is READ-ONLY and derives from real data — no fabrication. An
 * unknown contact yields honest empty sections (empty memory, empty
 * interactions, score 0/tier weak, and whatever channels exist for reach).
 */

import { and, desc, eq, inArray, or } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import {
  assistantInboxConversationState,
  callSessions,
  contactChannels,
  conversations,
  externalConversationBindings,
} from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";
import { listContactMemory } from "./contact-memory-store.js";
import { getContactRelationship } from "./contact-relationship-store.js";
import { getContactInternal } from "./contact-store.js";
import type {
  ContactDossier,
  ContactInteraction,
  ReachabilityChannel,
} from "./memory-types.js";

const log = getLogger("contact-dossier-store");

/**
 * Wall-clock budget for the interactions sub-query. On a warm SQLite page
 * cache the stitch is sub-200ms; the cold first hit on a large history was
 * ~5.4s before the interaction indexes (migration 295). This budget is a
 * belt to the indexes' suspenders: if the stitch still blows past it (an
 * un-indexed edge case, a pathological history), the dossier degrades to
 * (memory + relationship + reachability, empty interactions + a
 * `couldn'tLoadHistory` flag) rather than hanging the request. The check is
 * evaluated between per-identity source queries — SQLite calls inside a
 * single statement are synchronous and can't be interrupted mid-flight, so
 * the budget bounds the NUMBER of sources scanned, not a single runaway
 * statement (which the per-source LIMIT already caps).
 */
const INTERACTIONS_BUDGET_MS = 2_500;

/** Channel statuses that mean "safe to reach out on right now". */
const REACHABLE_STATUSES = new Set(["active"]);

/**
 * "REACHABLE ON" — derive the reachable channels from the contact's existing
 * contact_channels. Blocked/revoked channels are excluded entirely; the rest
 * are returned with a `reachable` flag (true for active). Primary channels
 * first, then most-recently-seen.
 */
export function getContactReachability(
  contactId: string,
): ReachabilityChannel[] {
  const db = getDb();
  const rows = db
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.contactId, contactId))
    .all();

  return rows
    .filter((r) => r.status !== "blocked" && r.status !== "revoked")
    .map((r) => ({
      channelId: r.id,
      type: r.type,
      address: r.address,
      isPrimary: r.isPrimary,
      status: r.status,
      reachable: REACHABLE_STATUSES.has(r.status),
      lastSeenAt: r.lastSeenAt,
    }))
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
    });
}

/**
 * The contact's channel identities as (channel, externalChatId/externalUserId,
 * address) tuples used to find bound conversations.
 */
interface ChannelIdentity {
  type: string;
  address: string;
  externalUserId: string | null;
  externalChatId: string | null;
}

function channelIdentities(contactId: string): ChannelIdentity[] {
  const db = getDb();
  return db
    .select({
      type: contactChannels.type,
      address: contactChannels.address,
      externalUserId: contactChannels.externalUserId,
      externalChatId: contactChannels.externalChatId,
    })
    .from(contactChannels)
    .where(eq(contactChannels.contactId, contactId))
    .all();
}

/**
 * Interactions timeline — a time-ordered list of the contact's touchpoints.
 *
 * Sources, all reusing existing tables keyed by the contact's channel identity:
 *   - external_conversation_bindings: synced external chats (Slack/Telegram/…)
 *     matched on (source_channel, external_chat_id).
 *   - assistant_inbox_conversation_state: inbound-channel conversations matched
 *     on (source_channel, external_chat_id).
 *   - call_sessions: phone calls matched on the contact's phone-channel address
 *     (from/to number).
 *
 * Conversations are de-duplicated by conversation id (a conversation surfaced
 * through more than one binding table counts once), ordered most-recent first.
 */
export function getContactInteractions(
  contactId: string,
  limit = 50,
): ContactInteraction[] {
  return getContactInteractionsBounded(contactId, limit).interactions;
}

/** Result of the bounded interactions stitch. */
export interface BoundedInteractions {
  interactions: ContactInteraction[];
  /**
   * True when the stitch was cut short by the wall-clock budget — the
   * returned interactions are a partial (or empty) prefix and the dossier
   * should surface a "couldn't load full history" hint. False on a complete
   * stitch (the common warm/indexed case).
   */
  degraded: boolean;
}

/**
 * Interactions timeline with a per-source SQL LIMIT and a wall-clock budget.
 *
 * The effective cap is clamped to [1, 200]. It is pushed into each source
 * query as a `LIMIT` (ordered by recency) so a contact with tens of thousands
 * of bound conversations never materializes them all just to slice afterward.
 * Between sources the elapsed time is checked against
 * {@link INTERACTIONS_BUDGET_MS}; if exceeded, the stitch stops and returns
 * `{ degraded: true }` with whatever was gathered so far. On any query error
 * the whole stitch degrades to empty rather than throwing — the dossier's
 * other sections must still render.
 */
export function getContactInteractionsBounded(
  contactId: string,
  limit = 50,
  opts?: { budgetMs?: number },
): BoundedInteractions {
  const cap = Math.max(1, Math.min(limit, 200));
  const budgetMs = opts?.budgetMs ?? INTERACTIONS_BUDGET_MS;
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > budgetMs;

  try {
    const db = getDb();
    const identities = channelIdentities(contactId);
    if (identities.length === 0) return { interactions: [], degraded: false };

    const interactions: ContactInteraction[] = [];
    const seenConversationIds = new Set<string>();

    // ── Conversation touchpoints via external bindings + inbox state ──
    for (const id of identities) {
      if (!id.externalChatId) continue;
      if (overBudget()) {
        return degrade(contactId, interactions, cap);
      }

      // external_conversation_bindings (synced Slack/Telegram/… chats).
      // LIMIT is pushed into SQL, ordered by most-recent binding activity, so
      // a huge chat history is capped at the source instead of after fetch.
      const bindings = db
        .select({
          conversationId: externalConversationBindings.conversationId,
          chatName: externalConversationBindings.externalChatName,
          lastInboundAt: externalConversationBindings.lastInboundAt,
          lastOutboundAt: externalConversationBindings.lastOutboundAt,
          updatedAt: externalConversationBindings.updatedAt,
          title: conversations.title,
          lastMessageAt: conversations.lastMessageAt,
        })
        .from(externalConversationBindings)
        .innerJoin(
          conversations,
          eq(externalConversationBindings.conversationId, conversations.id),
        )
        .where(
          and(
            eq(externalConversationBindings.sourceChannel, id.type),
            eq(externalConversationBindings.externalChatId, id.externalChatId),
          ),
        )
        .orderBy(desc(externalConversationBindings.updatedAt))
        .limit(cap)
        .all();

      for (const b of bindings) {
        if (seenConversationIds.has(b.conversationId)) continue;
        seenConversationIds.add(b.conversationId);
        const at = Math.max(
          b.lastMessageAt ?? 0,
          b.lastInboundAt ?? 0,
          b.lastOutboundAt ?? 0,
          b.updatedAt ?? 0,
        );
        interactions.push({
          kind: "conversation",
          conversationId: b.conversationId,
          channel: id.type,
          title: b.title ?? b.chatName ?? null,
          at,
        });
      }

      // assistant_inbox_conversation_state (inbound-channel conversations).
      const inbox = db
        .select({
          conversationId: assistantInboxConversationState.conversationId,
          displayName: assistantInboxConversationState.displayName,
          lastMessageAt: assistantInboxConversationState.lastMessageAt,
          lastInboundAt: assistantInboxConversationState.lastInboundAt,
          lastOutboundAt: assistantInboxConversationState.lastOutboundAt,
          updatedAt: assistantInboxConversationState.updatedAt,
          title: conversations.title,
        })
        .from(assistantInboxConversationState)
        .innerJoin(
          conversations,
          eq(assistantInboxConversationState.conversationId, conversations.id),
        )
        .where(
          and(
            eq(assistantInboxConversationState.sourceChannel, id.type),
            eq(
              assistantInboxConversationState.externalChatId,
              id.externalChatId,
            ),
          ),
        )
        .orderBy(desc(assistantInboxConversationState.lastMessageAt))
        .limit(cap)
        .all();

      for (const c of inbox) {
        if (seenConversationIds.has(c.conversationId)) continue;
        seenConversationIds.add(c.conversationId);
        const at = Math.max(
          c.lastMessageAt ?? 0,
          c.lastInboundAt ?? 0,
          c.lastOutboundAt ?? 0,
          c.updatedAt ?? 0,
        );
        interactions.push({
          kind: "conversation",
          conversationId: c.conversationId,
          channel: id.type,
          title: c.title ?? c.displayName ?? null,
          at,
        });
      }
    }

    // ── Call touchpoints via phone-channel address ──
    const phoneAddresses = identities
      .filter((i) => i.type === "phone")
      .map((i) => i.address)
      .filter((a): a is string => Boolean(a));

    if (phoneAddresses.length > 0) {
      if (overBudget()) {
        return degrade(contactId, interactions, cap);
      }
      const calls = db
        .select({
          id: callSessions.id,
          conversationId: callSessions.conversationId,
          startedAt: callSessions.startedAt,
          createdAt: callSessions.createdAt,
          task: callSessions.task,
        })
        .from(callSessions)
        .where(
          or(
            inArray(callSessions.fromNumber, phoneAddresses),
            inArray(callSessions.toNumber, phoneAddresses),
          ),
        )
        .orderBy(desc(callSessions.createdAt))
        .limit(cap)
        .all();

      for (const call of calls) {
        // A call already surfaced as a conversation touchpoint is not double
        // counted; but the call row carries the phone-specific "call" kind, so
        // prefer it when the conversation wasn't already added.
        if (seenConversationIds.has(call.conversationId)) continue;
        seenConversationIds.add(call.conversationId);
        interactions.push({
          kind: "call",
          conversationId: call.conversationId,
          channel: "phone",
          title: call.task ?? "Call",
          at: call.startedAt ?? call.createdAt,
        });
      }
    }

    return {
      interactions: interactions.sort((a, b) => b.at - a.at).slice(0, cap),
      degraded: false,
    };
  } catch (err) {
    log.warn(
      { err: String(err), contactId },
      "contact interactions stitch failed; degrading to empty history",
    );
    return { interactions: [], degraded: true };
  }
}

/**
 * Budget-exceeded exit: sort + cap whatever was gathered so far and flag the
 * result degraded. Logs once so a persistently slow contact history is
 * observable.
 */
function degrade(
  contactId: string,
  gathered: ContactInteraction[],
  cap: number,
): BoundedInteractions {
  log.warn(
    { contactId, gathered: gathered.length, budgetMs: INTERACTIONS_BUDGET_MS },
    "contact interactions stitch exceeded budget; returning partial history",
  );
  return {
    interactions: gathered.sort((a, b) => b.at - a.at).slice(0, cap),
    degraded: true,
  };
}

/**
 * Assemble the full dossier for a contact: relationship + memory + reachability
 * + recent interactions. Returns null if the contact does not exist.
 */
export function getContactDossier(
  contactId: string,
  opts?: { interactionLimit?: number },
): ContactDossier | null {
  const contact = getContactInternal(contactId);
  if (!contact) return null;

  const relationship = getContactRelationship(contactId);
  // getContactRelationship only returns null when the contact is missing, which
  // we already ruled out — but guard defensively for the types.
  if (!relationship) return null;

  const bounded = getContactInteractionsBounded(
    contactId,
    opts?.interactionLimit ?? 50,
  );

  return {
    contactId: contact.id,
    displayName: contact.displayName,
    contactType: contact.contactType,
    role: contact.role,
    relationship,
    memory: listContactMemory(contactId),
    reachability: getContactReachability(contactId),
    interactions: bounded.interactions,
    // Surface the honest "history couldn't fully load" state to the UI so it
    // can render a hint instead of implying the contact has no interactions.
    interactionsDegraded: bounded.degraded,
  };
}
