import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse is a no-op. Merging duplicate guardian contacts is destructive
 * (donor rows and their channel ownership are folded into the survivor); the
 * pre-merge split cannot be reconstructed, and there is no schema change.
 */
export function downReconcileDuplicateGuardians(_database: DrizzleDb): void {
  /* no-op */
}

/**
 * Collapse multiple `role='guardian'` contacts into one.
 *
 * There must only ever be a single guardian — the human owner. A local→cloud
 * migration (import contacts, then gateway re-bootstrap mints a fresh
 * `vellum-principal-<uuid>`) can strand a Slack/phone guardian on the OLD
 * principal, leaving a second `role='guardian'` row for the same person. That
 * duplicate is what the Connections UI renders as a second "you", and it hides
 * the Slack binding from the local owner's chat identity (which resolves only
 * the vellum-bound guardian) — so "are you connected to Slack?" was answered
 * inconsistently.
 *
 * This migration runs the same reconciliation `reconcileGuardianContacts()`
 * performs at runtime: pick the canonical guardian (prefer the one with an
 * active vellum channel, then a principalId, then the oldest row), move every
 * other guardian's channels onto it (skipping (type,address) duplicates), and
 * delete the donor rows.
 *
 * Implemented directly in SQL (rather than calling the store) to stay
 * self-contained and avoid pulling the contacts module's runtime side effects
 * (event emission) into the migration path. Idempotent: a no-op when zero or
 * one guardian exists.
 */
export function migrateReconcileDuplicateGuardians(database: DrizzleDb): void {
  withCrashRecovery(
    database,
    "migration_reconcile_duplicate_guardians_v1",
    () => {
      const raw = getSqliteFrom(database);

      const contactsExists = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contacts'`,
        )
        .get();
      const channelsExists = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contact_channels'`,
        )
        .get();
      if (!contactsExists || !channelsExists) return;

      const guardians = raw
        .query(
          `SELECT id, principal_id AS principalId, created_at AS createdAt
           FROM contacts WHERE role = 'guardian'`,
        )
        .all() as Array<{
        id: string;
        principalId: string | null;
        createdAt: number;
      }>;

      if (guardians.length <= 1) return;

      const vellumRows = raw
        .query(
          `SELECT DISTINCT contact_id AS contactId
           FROM contact_channels
           WHERE type = 'vellum' AND status = 'active'`,
        )
        .all() as Array<{ contactId: string }>;
      const vellumGuardianIds = new Set(vellumRows.map((r) => r.contactId));

      const ranked = [...guardians].sort((a, b) => {
        const aVellum = vellumGuardianIds.has(a.id) ? 0 : 1;
        const bVellum = vellumGuardianIds.has(b.id) ? 0 : 1;
        if (aVellum !== bVellum) return aVellum - bVellum;
        const aPrincipal = a.principalId ? 0 : 1;
        const bPrincipal = b.principalId ? 0 : 1;
        if (aPrincipal !== bPrincipal) return aPrincipal - bPrincipal;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      const canonicalId = ranked[0]!.id;
      const donorIds = ranked.slice(1).map((g) => g.id);

      try {
        raw.exec("BEGIN");
        const now = Date.now();

        for (const donorId of donorIds) {
          const donorChannels = raw
            .query(
              `SELECT id, type, address FROM contact_channels WHERE contact_id = ?`,
            )
            .all(donorId) as Array<{
            id: string;
            type: string;
            address: string;
          }>;

          for (const ch of donorChannels) {
            const conflict = raw
              .query(
                `SELECT 1 FROM contact_channels
                 WHERE contact_id = ? AND type = ? AND address = ? LIMIT 1`,
              )
              .get(canonicalId, ch.type, ch.address);

            if (conflict) {
              // Survivor already has this (type,address); drop the donor's copy
              // so the donor delete cannot violate the unique constraint.
              raw
                .prepare(`DELETE FROM contact_channels WHERE id = ?`)
                .run(ch.id);
            } else {
              raw
                .prepare(
                  `UPDATE contact_channels SET contact_id = ?, updated_at = ? WHERE id = ?`,
                )
                .run(canonicalId, now, ch.id);
            }
          }

          raw.prepare(`DELETE FROM contacts WHERE id = ?`).run(donorId);
        }

        raw
          .prepare(`UPDATE contacts SET updated_at = ? WHERE id = ?`)
          .run(now, canonicalId);

        raw.exec("COMMIT");
      } catch (e) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* no active transaction */
        }
        throw e;
      }
    },
  );
}
