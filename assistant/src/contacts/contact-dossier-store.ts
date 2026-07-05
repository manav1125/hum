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

import { and, eq, inArray, or } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import {
  assistantInboxConversationState,
  callSessions,
  contactChannels,
  conversations,
  externalConversationBindings,
} from "../memory/schema/index.js";
import { listContactMemory } from "./contact-memory-store.js";
import { getContactRelationship } from "./contact-relationship-store.js";
import { getContactInternal } from "./contact-store.js";
import type {
  ContactDossier,
  ContactInteraction,
  ReachabilityChannel,
} from "./memory-types.js";

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
  const db = getDb();
  const identities = channelIdentities(contactId);
  if (identities.length === 0) return [];

  const interactions: ContactInteraction[] = [];
  const seenConversationIds = new Set<string>();

  // ── Conversation touchpoints via external bindings + inbox state ──
  for (const id of identities) {
    if (!id.externalChatId) continue;

    // external_conversation_bindings (synced Slack/Telegram/… chats)
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

    // assistant_inbox_conversation_state (inbound-channel conversations)
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
          eq(assistantInboxConversationState.externalChatId, id.externalChatId),
        ),
      )
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

  return interactions
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, Math.min(limit, 200)));
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

  return {
    contactId: contact.id,
    displayName: contact.displayName,
    contactType: contact.contactType,
    role: contact.role,
    relationship,
    memory: listContactMemory(contactId),
    reachability: getContactReachability(contactId),
    interactions: getContactInteractions(
      contactId,
      opts?.interactionLimit ?? 50,
    ),
  };
}
