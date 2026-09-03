/**
 * Cue HQ — per-customer Postgres for the Learn sidecar's server persistence.
 *
 * One shared Postgres CLUSTER (the same Fly Postgres app that backs Manav's
 * own sidecar) holds one DATABASE + LOGIN ROLE per customer, so tenants are
 * isolated by real database credentials rather than by an app-layer token.
 *
 * All-or-nothing env gate, same idiom as learn-sidecar.ts:
 *   HQ_LEARN_PG_ADMIN_URL — superuser/operator URL of the cluster, e.g.
 *     postgres://postgres:<op>@cue-learn-db.internal:5432/postgres
 * Unset ⇒ provisionLearnDatabase answers null and sidecars run without
 * server persistence (browser-only courses), exactly as before.
 *
 * Idempotent by construction: the role's password is (re)set on every call
 * and an existing database is adopted, so a retried provision re-mints
 * working credentials instead of failing on leftovers.
 */

import { randomBytes } from "node:crypto";

/** learn_<8 hex chars of the customer uuid> — safe as a SQL identifier. */
export function learnDbName(customerId: string): string {
  const hex = customerId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase();
  if (hex.length < 8) {
    throw new Error(`learn-pg: customer id ${customerId} has no 8-hex prefix`);
  }
  return `learn_${hex}`;
}

export function isLearnPgConfigured(): boolean {
  return Boolean(process.env.HQ_LEARN_PG_ADMIN_URL?.trim());
}

/**
 * Ensure role + database exist for this customer and return the sidecar's
 * DATABASE_URL. Null when the feature env is unset.
 */
export async function provisionLearnDatabase(
  customerId: string,
): Promise<string | null> {
  const adminUrl = process.env.HQ_LEARN_PG_ADMIN_URL?.trim();
  if (!adminUrl) return null;

  const name = learnDbName(customerId);
  const password = randomBytes(24).toString("hex");
  const sql = new Bun.SQL({ url: adminUrl, max: 1 });
  try {
    // Identifiers cannot be parameterized; `name` is constrained to
    // learn_[0-9a-f]{8} by construction, so interpolation is safe. The
    // password IS a literal — escape single quotes defensively even though
    // hex never contains one.
    const pw = password.replace(/'/g, "''");
    const role = await sql.unsafe(
      `SELECT 1 FROM pg_roles WHERE rolname = '${name}'`,
    );
    if (Array.isArray(role) && role.length > 0) {
      await sql.unsafe(`ALTER ROLE ${name} WITH LOGIN PASSWORD '${pw}'`);
    } else {
      await sql.unsafe(`CREATE ROLE ${name} WITH LOGIN PASSWORD '${pw}'`);
    }
    const db = await sql.unsafe(
      `SELECT 1 FROM pg_database WHERE datname = '${name}'`,
    );
    if (!Array.isArray(db) || db.length === 0) {
      await sql.unsafe(`CREATE DATABASE ${name} OWNER ${name}`);
    } else {
      await sql.unsafe(`ALTER DATABASE ${name} OWNER TO ${name}`);
    }
  } finally {
    await sql.close().catch(() => {});
  }

  const admin = new URL(adminUrl);
  // Keep the admin URL's port and params (e.g. Fly Postgres direct port 5433
  // + sslmode=disable — the 5432 haproxy leg trips some clients' startup).
  return `postgres://${name}:${password}@${admin.hostname}${
    admin.port ? `:${admin.port}` : ""
  }/${name}${admin.search}`;
}
