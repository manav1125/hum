import { and, asc, desc, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db-connection.js";
import {
  assistantContactMetadata,
  contactChannels,
  contacts,
} from "../memory/schema.js";
import { emitContactChange } from "./contact-events.js";
import type {
  AssistantContactMetadata,
  ChannelPolicy,
  ChannelStatus,
  Contact,
  ContactChannel,
  ContactRole,
  ContactType,
  ContactWithChannels,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Strip LIKE metacharacters so user input is matched literally.
 * SQLite has no default escape character for LIKE, so we strip rather than escape. */
function escapeLike(value: string): string {
  return value.replace(/%/g, "").replace(/_/g, "");
}

/**
 * Pure slug transform applied to a display name. No DB lookup, no collision
 * handling — callers that need a collision-free filename should use
 * `generateUserFileSlug` instead. Exported so the migration classifier can
 * recompute the expected base slug for a given display name.
 */
export function computeUserFileBaseSlug(displayName: string): string {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "user"
  );
}

/**
 * Generate a collision-free slugified filename for a contact's per-user persona file.
 * Produces filenames like "alice.md", "alice-2.md", "alice-3.md", etc.
 */
export function generateUserFileSlug(displayName: string): string {
  const slug = computeUserFileBaseSlug(displayName);

  const db = getDb();
  const rows = db
    .select({ userFile: contacts.userFile })
    .from(contacts)
    .where(like(contacts.userFile, `${escapeLike(slug)}%`))
    .all();

  const taken = new Set(rows.map((r) => r.userFile?.toLowerCase()));

  const base = `${slug}.md`;
  if (!taken.has(base)) return base;

  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

function parseContact(row: typeof contacts.$inferSelect): Contact {
  return {
    id: row.id,
    displayName: row.displayName,
    notes: row.notes,
    lastInteraction: null,
    interactionCount: 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    role: row.role as Contact["role"],
    contactType: (row.contactType as Contact["contactType"]) ?? "human",
    principalId: row.principalId,
    userFile: row.userFile ?? null,
  };
}

function parseChannel(
  row: typeof contactChannels.$inferSelect,
): ContactChannel {
  return {
    id: row.id,
    contactId: row.contactId,
    type: row.type,
    address: row.address,
    isPrimary: row.isPrimary,
    externalUserId: row.externalUserId,
    externalChatId: row.externalChatId,
    status: row.status as ContactChannel["status"],
    policy: row.policy as ContactChannel["policy"],
    verifiedAt: row.verifiedAt,
    verifiedVia: row.verifiedVia,
    inviteId: row.inviteId,
    revokedReason: row.revokedReason,
    blockedReason: row.blockedReason,
    lastSeenAt: row.lastSeenAt,
    interactionCount: row.interactionCount,
    lastInteraction: row.lastInteraction,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

function getChannelsForContact(contactId: string): ContactChannel[] {
  const db = getDb();
  const rows = db
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.contactId, contactId))
    .orderBy(desc(contactChannels.isPrimary), asc(contactChannels.createdAt))
    .all();
  return rows.map(parseChannel);
}

function withChannels(contact: Contact): ContactWithChannels {
  const channels = getChannelsForContact(contact.id);
  const interactionCount = channels.reduce(
    (sum, ch) => sum + ch.interactionCount,
    0,
  );
  const lastInteraction =
    channels.reduce((max, ch) => Math.max(max, ch.lastInteraction ?? 0), 0) ||
    null;
  return { ...contact, interactionCount, lastInteraction, channels };
}

// ── Channel data type for syncChannels ───────────────────────────────

interface SyncChannelData {
  type: string;
  address: string;
  isPrimary?: boolean;
  externalUserId?: string | null;
  externalChatId?: string | null;
  status?: ChannelStatus;
  policy?: ChannelPolicy;
  verifiedAt?: number | null;
  verifiedVia?: string | null;
  inviteId?: string | null;
  revokedReason?: string | null;
  blockedReason?: string | null;
}

// ── CRUD ─────────────────────────────────────────────────────────────

/** Retrieve a contact by ID.
 * Used by functions that have already resolved identity through channel lookups. */
export function getContactInternal(id: string): ContactWithChannels | null {
  const db = getDb();
  const row = db.select().from(contacts).where(eq(contacts.id, id)).get();
  if (!row) return null;
  return withChannels(parseContact(row));
}

export function getContact(id: string): ContactWithChannels | null {
  const db = getDb();
  const row = db.select().from(contacts).where(eq(contacts.id, id)).get();
  if (!row) return null;
  return withChannels(parseContact(row));
}

/**
 * Look up a single contact channel by its primary key.
 * Returns the parsed channel row, or null if it does not exist.
 */
export function getChannelById(channelId: string): ContactChannel | null {
  const db = getDb();
  const row = db
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.id, channelId))
    .get();
  return row ? parseChannel(row) : null;
}

export function upsertContact(params: {
  id?: string;
  displayName: string;
  notes?: string | null;
  role?: ContactRole;
  contactType?: ContactType;
  principalId?: string | null;
  userFile?: string | null;
  channels?: SyncChannelData[];
  /** When true, conflicting channels on other contacts are reassigned to this
   *  contact instead of being skipped. Used by invite redemption to bind a
   *  redeemer's existing channel identity to the invite's target contact. */
  reassignConflictingChannels?: boolean;
}): ContactWithChannels & { created: boolean } {
  const db = getDb();
  const now = Date.now();

  let contactId = params.id;

  // If an ID is provided, check if the contact exists for update
  if (contactId) {
    const existing = db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .get();
    if (existing) {
      const updateSet: Record<string, unknown> = {
        displayName: params.displayName,
        updatedAt: now,
      };
      if (params.notes !== undefined) updateSet.notes = params.notes;
      if (params.role !== undefined) updateSet.role = params.role;
      if (params.contactType !== undefined)
        updateSet.contactType = params.contactType;
      if (params.principalId !== undefined)
        updateSet.principalId = params.principalId;
      if (params.userFile !== undefined) updateSet.userFile = params.userFile;

      db.update(contacts)
        .set(updateSet)
        .where(eq(contacts.id, contactId))
        .run();

      if (params.channels) {
        syncChannels(
          contactId,
          params.channels,
          now,
          params.reassignConflictingChannels,
        );
      }

      emitContactChange();
      return { ...getContactInternal(contactId)!, created: false };
    }
  }

  // Try to find by channel address to avoid duplicates
  if (!contactId && params.channels && params.channels.length > 0) {
    for (const ch of params.channels) {
      // Primary lookup: match by (type, address)
      const existingChannel = db
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.type, ch.type),
            eq(contactChannels.address, ch.address.toLowerCase()),
          ),
        )
        .get();

      if (existingChannel) {
        contactId = existingChannel.contactId;
        const updateSet: Record<string, unknown> = {
          displayName: params.displayName,
          updatedAt: now,
        };
        if (params.notes !== undefined) updateSet.notes = params.notes;
        if (params.role !== undefined) updateSet.role = params.role;
        if (params.contactType !== undefined)
          updateSet.contactType = params.contactType;
        if (params.principalId !== undefined)
          updateSet.principalId = params.principalId;
        if (params.userFile !== undefined) updateSet.userFile = params.userFile;

        db.update(contacts)
          .set(updateSet)
          .where(eq(contacts.id, contactId))
          .run();

        syncChannels(contactId, params.channels, now);
        emitContactChange();
        return { ...getContactInternal(contactId)!, created: false };
      }
    }
  }

  // Create new contact
  contactId = contactId ?? uuid();
  // Sibling contacts sharing a principal_id must share a user_file so every
  // channel for one principal resolves to the same persona + journal slug.
  let resolvedUserFile: string | null;
  if (params.userFile !== undefined) {
    resolvedUserFile = params.userFile;
  } else if (params.principalId) {
    const sibling = db
      .select({ userFile: contacts.userFile })
      .from(contacts)
      .where(
        and(
          eq(contacts.principalId, params.principalId),
          isNotNull(contacts.userFile),
        ),
      )
      .get();
    resolvedUserFile =
      sibling?.userFile ?? generateUserFileSlug(params.displayName);
  } else {
    resolvedUserFile = generateUserFileSlug(params.displayName);
  }
  db.insert(contacts)
    .values({
      id: contactId,
      displayName: params.displayName,
      notes: params.notes ?? null,
      role: params.role ?? "contact",
      contactType: params.contactType ?? "human",
      principalId: params.principalId ?? null,
      userFile: resolvedUserFile,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  if (params.channels) {
    syncChannels(
      contactId,
      params.channels,
      now,
      params.reassignConflictingChannels,
    );
  }

  emitContactChange();
  return { ...getContactInternal(contactId)!, created: true };
}

/**
 * Add new channels to a contact without removing existing ones.
 * When a channel already exists (same type+address), updates access/verification
 * fields if provided. Skips channels owned by a different contact.
 */
function syncChannels(
  contactId: string,
  channels: SyncChannelData[],
  now: number,
  reassignConflicting?: boolean,
): void {
  const db = getDb();

  for (const ch of channels) {
    const normalizedAddress = ch.address.toLowerCase();

    // Check if this channel already exists for this contact
    const existing = db
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.contactId, contactId),
          eq(contactChannels.type, ch.type),
          eq(contactChannels.address, normalizedAddress),
        ),
      )
      .get();

    if (existing) {
      // Preserve guardian blocks: if the channel is blocked, do not overwrite
      // its status/policy — mirrors the guard in the cross-contact reassignment
      // path so a blocked channel cannot be unblocked via a same-contact sync.
      const isBlocked = existing.status === "blocked";

      const updateSet: Record<string, unknown> = {};
      if (ch.isPrimary !== undefined) updateSet.isPrimary = ch.isPrimary;
      if (ch.externalUserId !== undefined)
        updateSet.externalUserId = ch.externalUserId;
      if (ch.externalChatId !== undefined)
        updateSet.externalChatId = ch.externalChatId;
      if (!isBlocked) {
        if (ch.status !== undefined) updateSet.status = ch.status;
        if (ch.policy !== undefined) updateSet.policy = ch.policy;
        if (ch.revokedReason !== undefined)
          updateSet.revokedReason = ch.revokedReason;
        if (ch.blockedReason !== undefined)
          updateSet.blockedReason = ch.blockedReason;
      }
      if (ch.verifiedAt !== undefined) updateSet.verifiedAt = ch.verifiedAt;
      if (ch.verifiedVia !== undefined) updateSet.verifiedVia = ch.verifiedVia;
      if (ch.inviteId !== undefined) updateSet.inviteId = ch.inviteId;

      if (Object.keys(updateSet).length > 0) {
        updateSet.updatedAt = now;
        db.update(contactChannels)
          .set(updateSet)
          .where(eq(contactChannels.id, existing.id))
          .run();
      }
      continue;
    }

    // Check if this channel exists for a different contact (unique constraint)
    const conflicting = db
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.type, ch.type),
          eq(contactChannels.address, normalizedAddress),
        ),
      )
      .get();

    if (conflicting) {
      if (reassignConflicting) {
        // Preserve guardian blocks: if the existing channel is blocked, do not
        // overwrite its status/policy — a valid invite must not bypass an
        // explicit guardian block on a different contact.
        const isBlocked = conflicting.status === "blocked";

        // Reassign the channel to the target contact. Used by invite redemption
        // to bind a redeemer's existing channel identity to the invite's target.
        const reassignSet: Record<string, unknown> = {
          contactId,
          updatedAt: now,
        };
        if (ch.externalUserId !== undefined)
          reassignSet.externalUserId = ch.externalUserId;
        if (ch.externalChatId !== undefined)
          reassignSet.externalChatId = ch.externalChatId;
        if (!isBlocked) {
          if (ch.status !== undefined) reassignSet.status = ch.status;
          if (ch.policy !== undefined) reassignSet.policy = ch.policy;
          if (ch.revokedReason !== undefined)
            reassignSet.revokedReason = ch.revokedReason;
          if (ch.blockedReason !== undefined)
            reassignSet.blockedReason = ch.blockedReason;
        }
        if (ch.verifiedAt !== undefined) reassignSet.verifiedAt = ch.verifiedAt;
        if (ch.verifiedVia !== undefined)
          reassignSet.verifiedVia = ch.verifiedVia;
        if (ch.inviteId !== undefined) reassignSet.inviteId = ch.inviteId;

        db.update(contactChannels)
          .set(reassignSet)
          .where(eq(contactChannels.id, conflicting.id))
          .run();
      }
      // When not reassigning, skip to avoid unique constraint violation.
      // The caller should use contact_merge to combine the two contacts.
      continue;
    }

    db.insert(contactChannels)
      .values({
        id: uuid(),
        contactId,
        type: ch.type,
        address: normalizedAddress,
        isPrimary: ch.isPrimary ?? false,
        externalUserId: ch.externalUserId ?? null,
        externalChatId: ch.externalChatId ?? null,
        status: ch.status ?? "unverified",
        policy: ch.policy ?? "allow",
        verifiedAt: ch.verifiedAt ?? null,
        verifiedVia: ch.verifiedVia ?? null,
        inviteId: ch.inviteId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

export function searchContacts(params: {
  query?: string;
  channelAddress?: string;
  channelType?: string;
  role?: ContactRole;
  contactType?: ContactType;
  limit?: number;
}): ContactWithChannels[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(params.limit ?? 20, 100));

  // Search by channel address first (exact or partial match)
  if (params.channelAddress) {
    const normalizedAddress = escapeLike(params.channelAddress.toLowerCase());
    if (!normalizedAddress) return [];
    const channelRows = db
      .select({ contactId: contactChannels.contactId })
      .from(contactChannels)
      .innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
      .where(
        params.channelType
          ? and(
              eq(contactChannels.type, params.channelType),
              like(contactChannels.address, `%${normalizedAddress}%`),
            )
          : and(like(contactChannels.address, `%${normalizedAddress}%`)),
      )
      .all();

    const contactIds = [...new Set(channelRows.map((r) => r.contactId))];
    if (contactIds.length === 0) return [];

    // Pre-compute the sanitized query for display-name filtering so the
    // loop body stays cheap.
    const sanitizedQuery = params.query
      ? escapeLike(params.query).toLowerCase()
      : undefined;

    const results: ContactWithChannels[] = [];
    for (const id of contactIds) {
      if (results.length >= limit) break;
      const contact = getContactInternal(id);
      if (
        contact &&
        (!params.role || contact.role === params.role) &&
        (!params.contactType || contact.contactType === params.contactType) &&
        (!sanitizedQuery ||
          (contact.displayName &&
            contact.displayName.toLowerCase().includes(sanitizedQuery)))
      ) {
        results.push(contact);
      }
    }
    return results;
  }

  // Search by channel type alone (no address)
  if (params.channelType && !params.query) {
    const channelRows = db
      .select({ contactId: contactChannels.contactId })
      .from(contactChannels)
      .innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
      .where(eq(contactChannels.type, params.channelType))
      .all();

    const contactIds = [...new Set(channelRows.map((r) => r.contactId))];
    if (contactIds.length === 0) return [];

    const results: ContactWithChannels[] = [];
    for (const id of contactIds) {
      if (results.length >= limit) break;
      const contact = getContactInternal(id);
      if (
        contact &&
        (!params.role || contact.role === params.role) &&
        (!params.contactType || contact.contactType === params.contactType)
      ) {
        results.push(contact);
      }
    }
    return results;
  }

  // Search by display name, optionally filtered by channelType
  const conditions = [];
  if (params.query) {
    const sanitized = escapeLike(params.query);
    if (!sanitized && !params.role && !params.contactType) return [];
    if (sanitized) {
      conditions.push(like(contacts.displayName, `%${sanitized}%`));
    }
  }
  if (params.role) {
    conditions.push(eq(contacts.role, params.role));
  }
  if (params.contactType) {
    conditions.push(eq(contacts.contactType, params.contactType));
  }
  if (params.channelType) {
    conditions.push(eq(contactChannels.type, params.channelType));
  }

  const whereClause =
    conditions.length > 1 ? and(...conditions) : conditions[0];

  // Join with contactChannels when channelType is specified so the filter
  // can reference the channel table; otherwise query contacts alone.
  if (params.channelType) {
    const rows = db
      .select({ contactId: contacts.id })
      .from(contacts)
      .innerJoin(contactChannels, eq(contacts.id, contactChannels.contactId))
      .where(whereClause)
      .orderBy(desc(contacts.updatedAt))
      .all();

    const contactIds = [...new Set(rows.map((r) => r.contactId))];
    if (contactIds.length === 0) return [];

    const results: ContactWithChannels[] = [];
    for (const id of contactIds) {
      if (results.length >= limit) break;
      const contact = getContactInternal(id);
      if (contact) {
        results.push(contact);
      }
    }
    return results;
  }

  const rows = db
    .select()
    .from(contacts)
    .where(whereClause)
    .orderBy(desc(contacts.updatedAt))
    .limit(limit)
    .all();

  return rows.map((r) => withChannels(parseContact(r)));
}

export function listContacts(
  limit = 50,
  role?: ContactRole,
  contactType?: ContactType,
  opts?: { uncapped?: boolean },
): ContactWithChannels[] {
  const db = getDb();
  const effectiveLimit = opts?.uncapped ? limit : Math.min(limit, 200);
  const conditions = [];
  if (role) conditions.push(eq(contacts.role, role));
  if (contactType) conditions.push(eq(contacts.contactType, contactType));
  const rows = db
    .select()
    .from(contacts)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(sql`${contacts.role} = 'guardian' DESC`, desc(contacts.updatedAt))
    .limit(effectiveLimit)
    .all();
  return rows.map((r) => withChannels(parseContact(r)));
}

/**
 * Merge two contacts into one. The surviving contact keeps the
 * more recent interaction timestamp, concatenated notes, and all channels
 * from both contacts. The donor contact is deleted after merging.
 */
export function mergeContacts(
  keepId: string,
  mergeId: string,
): ContactWithChannels {
  const db = getDb();

  if (keepId === mergeId) throw new Error("Cannot merge a contact with itself");

  db.transaction((tx) => {
    const now = Date.now();

    const keep = tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, keepId))
      .get();
    if (!keep) throw new Error(`Contact "${keepId}" not found`);

    const merge = tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, mergeId))
      .get();
    if (!merge) throw new Error(`Contact "${mergeId}" not found`);

    tx.update(contacts)
      .set({
        notes: [keep.notes, merge.notes].filter(Boolean).join("\n") || null,
        updatedAt: now,
      })
      .where(eq(contacts.id, keepId))
      .run();

    // Move channels from donor to survivor, skipping duplicates
    const donorChannels = tx
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.contactId, mergeId))
      .all();

    for (const ch of donorChannels) {
      const exists = tx
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.contactId, keepId),
            eq(contactChannels.type, ch.type),
            eq(contactChannels.address, ch.address),
          ),
        )
        .get();

      if (!exists) {
        tx.update(contactChannels)
          .set({ contactId: keepId })
          .where(eq(contactChannels.id, ch.id))
          .run();
      }
    }

    // Delete the donor contact (cascading deletes remaining channels)
    tx.delete(contacts).where(eq(contacts.id, mergeId)).run();
  });

  emitContactChange();
  return getContactInternal(keepId)!;
}

/**
 * Reconcile multiple `role='guardian'` contacts into a single canonical
 * guardian.
 *
 * There must only ever be ONE guardian — the human owner of the assistant.
 * In normal operation `createGuardianBinding` (gateway) unifies every channel
 * binding under one guardian contact by keying on the canonical (vellum)
 * principal. But a few paths can leave behind duplicate `role='guardian'`
 * rows for the same person:
 *
 *   - A local→cloud migration imports the owner's contacts, then the gateway
 *     re-bootstraps and mints a FRESH `vellum-principal-<uuid>`. The imported
 *     Slack/phone guardian row keeps the OLD principal, so the principal-keyed
 *     unification in `createGuardianBinding` no longer matches it — leaving a
 *     second guardian contact bound to Slack/phone.
 *   - A DB reset without re-bootstrap, or any flow that created a channel
 *     guardian before the vellum guardian existed.
 *
 * The duplicate is the root of the "two Manavs" the Connections UI shows
 * (the second guardian falls into the non-guardian list) AND of the Slack
 * inconsistency: the local owner's chat identity resolves only the
 * vellum-bound guardian, so a Slack binding stranded on a sibling guardian is
 * invisible to "am I connected to Slack?".
 *
 * Canonical selection prefers the guardian with an active `vellum` channel
 * (that is the identity the local owner authenticates as, and the principal
 * `resolveCanonicalPrincipal` keys on); ties break to a guardian that has a
 * principalId, then the oldest row. Every other guardian's channels are
 * merged into the canonical one and the donor rows are deleted, so all channel
 * bindings (vellum + slack + telegram + …) live under a single guardian.
 *
 * Idempotent: a no-op when zero or one guardian exists. Returns the number of
 * duplicate guardians that were merged away.
 */
export function reconcileGuardianContacts(): number {
  const db = getDb();

  const guardianRows = db
    .select()
    .from(contacts)
    .where(eq(contacts.role, "guardian"))
    .all();

  if (guardianRows.length <= 1) return 0;

  // Active-vellum-channel guardians are the canonical owner identity. Build
  // the set of guardian contact ids that have an active vellum channel.
  const vellumGuardianRows = db
    .select({ contactId: contactChannels.contactId })
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, "vellum"),
        eq(contactChannels.status, "active"),
      ),
    )
    .all();
  const vellumGuardianIds = new Set(vellumGuardianRows.map((r) => r.contactId));

  // Rank: prefer a vellum-bound guardian, then a guardian with a principalId,
  // then the oldest row, then id for determinism.
  const ranked = [...guardianRows].sort((a, b) => {
    const aVellum = vellumGuardianIds.has(a.id) ? 0 : 1;
    const bVellum = vellumGuardianIds.has(b.id) ? 0 : 1;
    if (aVellum !== bVellum) return aVellum - bVellum;
    const aPrincipal = a.principalId ? 0 : 1;
    const bPrincipal = b.principalId ? 0 : 1;
    if (aPrincipal !== bPrincipal) return aPrincipal - bPrincipal;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const canonical = ranked[0]!;
  const donors = ranked.slice(1);

  for (const donor of donors) {
    // mergeContacts moves the donor's channels onto the canonical guardian
    // (skipping (type,address) duplicates) and deletes the donor row.
    mergeContacts(canonical.id, donor.id);
  }

  return donors.length;
}

/**
 * Find a contact by a specific channel address. Returns null if not found.
 */
/**
 * Find a contact the owner actually stood behind on this address.
 *
 * A plain {@link findContactByAddress} now matches contacts HARVESTED from
 * inbound mail, because correspondence provisioning mints one per sender. That
 * is right for People — you should be able to browse who writes to you — and
 * wrong for anything that treats "is a contact" as evidence about the sender.
 *
 * It closed a loop in the arrival gate's safety floor: mail minted a contact,
 * the contact satisfied the floor, the floor surfaced the mail, and the
 * surfacing was then read back as evidence the sender was a person. Every turn
 * of that made the next turn easier, and it had already fired once.
 *
 * A harvested channel is `unverified`. A channel the owner invited, verified or
 * added by hand is not. That distinction is the whole difference between "I
 * know this person" and "this address has written to me".
 */
export function findCuratedContactByAddress(
  type: string,
  address: string,
): ContactWithChannels | null {
  const db = getDb();
  const channel = db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, type),
        eq(contactChannels.address, address.toLowerCase()),
        // Anything but `unverified` means somebody deliberately did something
        // about this address. Revoked and blocked are excluded too: a channel
        // the owner turned off is not a person they want surfaced by it.
        inArray(contactChannels.status, ["active", "pending"]),
      ),
    )
    .get();

  if (!channel) return null;
  return getContactInternal(channel.contactId);
}

export function findContactByAddress(
  type: string,
  address: string,
): ContactWithChannels | null {
  const db = getDb();
  const channel = db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, type),
        eq(contactChannels.address, address.toLowerCase()),
      ),
    )
    .get();

  if (!channel) return null;
  return getContactInternal(channel.contactId);
}

/**
 * Find a contact by channel external user ID. This is the key lookup for trust
 * resolution — maps a channel-native sender identity to its parent Contact.
 */
export function findContactByChannelExternalId(
  channelType: string,
  externalUserId: string,
): ContactWithChannels | null {
  const db = getDb();
  const channel = db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, channelType),
        eq(contactChannels.externalUserId, externalUserId),
      ),
    )
    .get();

  if (!channel) return null;
  return getContactInternal(channel.contactId);
}

/**
 * Find a contact by channel external chat ID. This is the fallback lookup path
 * when externalUserId is not available — matches by (type, externalChatId).
 */
function findContactByChannelExternalChatId(
  channelType: string,
  externalChatId: string,
): ContactWithChannels | null {
  const db = getDb();
  const channel = db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, channelType),
        eq(contactChannels.externalChatId, externalChatId),
      ),
    )
    .get();
  if (!channel) return null;
  return getContactInternal(channel.contactId);
}

/**
 * Find a contact and matching channel by trying externalUserId first, then
 * falling back to externalChatId. Mirrors the findMember lookup strategy.
 */
export function findContactChannel(params: {
  channelType: string;
  externalUserId?: string;
  externalChatId?: string;
}): { contact: ContactWithChannels; channel: ContactChannel } | null {
  if (params.externalUserId) {
    const contact = findContactByChannelExternalId(
      params.channelType,
      params.externalUserId,
    );
    if (contact) {
      const ch = contact.channels.find(
        (c) =>
          c.type === params.channelType &&
          c.externalUserId === params.externalUserId,
      );
      if (ch) return { contact, channel: ch };
    }
  }
  if (params.externalChatId) {
    const contact = findContactByChannelExternalChatId(
      params.channelType,
      params.externalChatId,
    );
    if (contact) {
      const ch = contact.channels.find(
        (c) =>
          c.type === params.channelType &&
          c.externalChatId === params.externalChatId,
      );
      if (ch) return { contact, channel: ch };
    }
  }
  return null;
}

/**
 * Find the guardian contact and their specific channel entry for a given channel type.
 * This is the contacts-based equivalent of getGuardianBinding(assistantId, channel).
 * Returns null if no guardian contact has a channel of the specified type.
 */
export function findGuardianForChannel(
  channelType: string,
): { contact: Contact; channel: ContactChannel } | null {
  const db = getDb();
  const conditions = [
    eq(contacts.role, "guardian"),
    eq(contactChannels.type, channelType),
    eq(contactChannels.status, "active"),
  ];
  const rows = db
    .select({
      contact: contacts,
      channel: contactChannels,
    })
    .from(contacts)
    .innerJoin(contactChannels, eq(contacts.id, contactChannels.contactId))
    .where(and(...conditions))
    .orderBy(desc(contactChannels.verifiedAt))
    .limit(1)
    .all();

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    contact: parseContact(row.contact),
    channel: parseChannel(row.channel),
  };
}

/**
 * List all active channels for guardian contacts.
 * This is the contacts-based equivalent of listActiveBindingsByAssistant(assistantId).
 * Joins contacts+channels with status='active' in a single query so we never
 * pick a guardian that has no active channels.
 * Returns channels ordered by most-recently-verified first.
 */
export function listGuardianChannels(): {
  contact: Contact;
  channels: ContactChannel[];
} | null {
  const db = getDb();
  const rows = db
    .select({
      contact: contacts,
      channel: contactChannels,
    })
    .from(contacts)
    .innerJoin(contactChannels, eq(contacts.id, contactChannels.contactId))
    .where(
      and(eq(contacts.role, "guardian"), eq(contactChannels.status, "active")),
    )
    .orderBy(desc(contactChannels.verifiedAt))
    .all();

  if (rows.length === 0) return null;

  // Use the first row's contact (the guardian with the most-recently-verified
  // active channel) and collect all active channels for that contact.
  const guardian = parseContact(rows[0].contact);
  const channels = rows
    .filter((r) => r.contact.id === guardian.id)
    .map((r) => parseChannel(r.channel));

  return { contact: guardian, channels };
}

/**
 * Update a channel's access-control fields (status, policy, reasons).
 * Returns the updated channel, or null if the channel does not exist.
 */
export function updateChannelStatus(
  channelId: string,
  params: {
    status?: ChannelStatus;
    policy?: ChannelPolicy;
    revokedReason?: string | null;
    blockedReason?: string | null;
  },
): ContactChannel | null {
  const db = getDb();
  const existing = db
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.id, channelId))
    .get();

  if (!existing) return null;

  const updateSet: Record<string, unknown> = {};
  if (params.status !== undefined) updateSet.status = params.status;
  if (params.policy !== undefined) updateSet.policy = params.policy;
  if (params.revokedReason !== undefined)
    updateSet.revokedReason = params.revokedReason;
  if (params.blockedReason !== undefined)
    updateSet.blockedReason = params.blockedReason;

  if (Object.keys(updateSet).length > 0) {
    updateSet.updatedAt = Date.now();
    db.update(contactChannels)
      .set(updateSet)
      .where(eq(contactChannels.id, channelId))
      .run();

    const updated = db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, channelId))
      .get();

    const result = updated ? parseChannel(updated) : null;
    emitContactChange();
    return result;
  }

  return parseChannel(existing);
}

/**
 * Update a guardian contact's principalId and its channel's identity fields.
 * Used for healing guardian binding drift when the JWT principal no longer
 * matches the stored guardian binding after a DB reset.
 *
 * Returns false if the update would violate the unique (type, address)
 * constraint on contact_channels — e.g. when the incoming principal already
 * exists on another channel record (a revoked former guardian entry).
 * In that case the heal is skipped and trust stays `unknown`.
 */
export function updateContactPrincipalAndChannel(
  contactId: string,
  channelId: string,
  newPrincipalId: string,
): boolean {
  const db = getDb();
  const now = Date.now();
  const normalizedAddress = newPrincipalId.toLowerCase();

  // Look up the channel we're about to update so we know its type.
  const channel = db
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.id, channelId))
    .get();
  if (!channel) return false;

  // Guard: check if another channel row already holds this (type, address).
  const conflicting = db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, channel.type),
        eq(contactChannels.address, normalizedAddress),
      ),
    )
    .get();

  if (conflicting && conflicting.id !== channelId) {
    return false;
  }

  db.transaction(() => {
    db.update(contacts)
      .set({ principalId: newPrincipalId, updatedAt: now })
      .where(eq(contacts.id, contactId))
      .run();

    db.update(contactChannels)
      .set({
        externalUserId: newPrincipalId,
        address: normalizedAddress,
        updatedAt: now,
      })
      .where(eq(contactChannels.id, channelId))
      .run();
  });

  emitContactChange();
  return true;
}

// ── Assistant Contact Metadata ──────────────────────────────────────

function parseAssistantMetadata(
  row: typeof assistantContactMetadata.$inferSelect,
): AssistantContactMetadata {
  // Species–metadata pairing is enforced at write time; the cast bridges the
  // runtime DB row into the compile-time discriminated union.
  return {
    contactId: row.contactId,
    species: row.species,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  } as AssistantContactMetadata;
}

export function getAssistantContactMetadata(
  contactId: string,
): AssistantContactMetadata | null {
  const db = getDb();
  const row = db
    .select()
    .from(assistantContactMetadata)
    .where(eq(assistantContactMetadata.contactId, contactId))
    .get();

  if (!row) return null;
  return parseAssistantMetadata(row);
}
