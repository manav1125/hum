/**
 * Cue HQ — SQLite persistence layer.
 *
 * Follows the daemon's driver pattern (bun:sqlite, WAL mode) with a tiny
 * ordered migration runner. All state transitions for customers and
 * instances are validated here so illegal flips can never be persisted,
 * regardless of which route/webhook attempted them.
 */

import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type CustomerStatus =
  | "waitlist"
  | "invited"
  | "active"
  | "suspended"
  | "churned";

export type CustomerPlan = "founding" | "founding_byo";

export interface Customer {
  id: string;
  email: string;
  name: string;
  status: CustomerStatus;
  plan: CustomerPlan;
  createdAt: number;
}

export interface Invite {
  code: string;
  customerId: string | null;
  percentOff: number;
  maxUses: number;
  uses: number;
  expiresAt: number | null;
  createdAt: number;
}

export type InstanceState = "provisioning" | "live" | "suspended" | "deleted";

export interface Instance {
  id: string;
  customerId: string;
  driver: string;
  externalId: string;
  url: string;
  state: InstanceState;
  /** JSON blob: bootstrap secret, signing key, guardianPrincipalId, etc. */
  secretsJson: string;
  createdAt: number;
}

export interface HqEvent {
  id: string;
  ts: number;
  kind: string;
  customerId: string | null;
  dataJson: string;
}

export interface Subscription {
  customerId: string;
  stripeCustomerId: string;
  stripeSubId: string;
  status: string;
  currentPeriodEnd: number | null;
}

// ---------------------------------------------------------------------------
// State machines
// ---------------------------------------------------------------------------

const CUSTOMER_TRANSITIONS: Record<CustomerStatus, CustomerStatus[]> = {
  waitlist: ["invited", "churned"],
  invited: ["active", "churned", "waitlist"],
  active: ["suspended", "churned"],
  suspended: ["active", "churned"],
  churned: ["invited", "active"], // win-back
};

const INSTANCE_TRANSITIONS: Record<InstanceState, InstanceState[]> = {
  provisioning: ["live", "deleted"],
  live: ["suspended", "deleted"],
  suspended: ["live", "deleted"],
  deleted: [],
};

export class InvalidTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial-schema",
    sql: `
      CREATE TABLE customers (
        id         TEXT PRIMARY KEY,
        email      TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'waitlist'
                   CHECK (status IN ('waitlist','invited','active','suspended','churned')),
        plan       TEXT NOT NULL DEFAULT 'founding'
                   CHECK (plan IN ('founding','founding_byo')),
        createdAt  INTEGER NOT NULL
      );

      CREATE TABLE invites (
        code       TEXT PRIMARY KEY,
        customerId TEXT REFERENCES customers(id),
        percentOff INTEGER NOT NULL DEFAULT 0,
        maxUses    INTEGER NOT NULL DEFAULT 1,
        uses       INTEGER NOT NULL DEFAULT 0,
        expiresAt  INTEGER,
        createdAt  INTEGER NOT NULL
      );

      CREATE TABLE instances (
        id          TEXT PRIMARY KEY,
        customerId  TEXT NOT NULL REFERENCES customers(id),
        driver      TEXT NOT NULL,
        externalId  TEXT NOT NULL,
        url         TEXT NOT NULL,
        state       TEXT NOT NULL DEFAULT 'provisioning'
                    CHECK (state IN ('provisioning','live','suspended','deleted')),
        secretsJson TEXT NOT NULL DEFAULT '{}',
        createdAt   INTEGER NOT NULL
      );
      CREATE INDEX idx_instances_customer ON instances(customerId);
      CREATE INDEX idx_instances_state ON instances(state);

      CREATE TABLE events (
        id         TEXT PRIMARY KEY,
        ts         INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        customerId TEXT,
        dataJson   TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_events_ts ON events(ts);
      CREATE INDEX idx_events_customer ON events(customerId);

      CREATE TABLE subscriptions (
        customerId       TEXT PRIMARY KEY REFERENCES customers(id),
        stripeCustomerId TEXT NOT NULL,
        stripeSubId      TEXT NOT NULL,
        status           TEXT NOT NULL,
        currentPeriodEnd INTEGER
      );
    `,
  },
];

// ---------------------------------------------------------------------------
// HqDb
// ---------------------------------------------------------------------------

export class HqDb {
  readonly db: Database;

  constructor(path: string = process.env.HQ_DB_PATH ?? "hq.db") {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         appliedAt INTEGER NOT NULL
       );`,
    );
    const applied = new Set(
      this.db
        .query<{ version: number }, []>(
          "SELECT version FROM schema_migrations",
        )
        .all()
        .map((r) => r.version),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      const tx = this.db.transaction(() => {
        // bun:sqlite prepares one statement at a time — split the migration
        // into individual statements (none of ours embed literal ';').
        for (const stmt of m.sql.split(";")) {
          if (stmt.trim()) this.db.run(stmt);
        }
        this.db.run(
          "INSERT INTO schema_migrations (version, name, appliedAt) VALUES (?, ?, ?)",
          [m.version, m.name, Date.now()],
        );
      });
      tx();
    }
  }

  close(): void {
    this.db.close();
  }

  // ── events (append-only audit) ────────────────────────────────────────

  recordEvent(
    kind: string,
    customerId: string | null = null,
    data: Record<string, unknown> = {},
  ): HqEvent {
    const event: HqEvent = {
      id: randomUUID(),
      ts: Date.now(),
      kind,
      customerId,
      dataJson: JSON.stringify(data),
    };
    this.db.run(
      "INSERT INTO events (id, ts, kind, customerId, dataJson) VALUES (?, ?, ?, ?, ?)",
      [event.id, event.ts, event.kind, event.customerId, event.dataJson],
    );
    return event;
  }

  listEvents(limit = 100): HqEvent[] {
    return this.db
      .query<HqEvent, [number]>(
        "SELECT * FROM events ORDER BY ts DESC LIMIT ?",
      )
      .all(limit);
  }

  // ── customers ─────────────────────────────────────────────────────────

  createCustomer(params: {
    email: string;
    name: string;
    plan?: CustomerPlan;
    status?: CustomerStatus;
  }): Customer {
    const customer: Customer = {
      id: randomUUID(),
      email: params.email.trim().toLowerCase(),
      name: params.name.trim(),
      status: params.status ?? "waitlist",
      plan: params.plan ?? "founding",
      createdAt: Date.now(),
    };
    this.db.run(
      "INSERT INTO customers (id, email, name, status, plan, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      [
        customer.id,
        customer.email,
        customer.name,
        customer.status,
        customer.plan,
        customer.createdAt,
      ],
    );
    this.recordEvent("customer_created", customer.id, {
      email: customer.email,
      status: customer.status,
    });
    return customer;
  }

  getCustomer(id: string): Customer | null {
    return (
      this.db
        .query<Customer, [string]>("SELECT * FROM customers WHERE id = ?")
        .get(id) ?? null
    );
  }

  getCustomerByEmail(email: string): Customer | null {
    return (
      this.db
        .query<Customer, [string]>("SELECT * FROM customers WHERE email = ?")
        .get(email.trim().toLowerCase()) ?? null
    );
  }

  listCustomers(): Customer[] {
    return this.db
      .query<Customer, []>("SELECT * FROM customers ORDER BY createdAt DESC")
      .all();
  }

  /** Validated customer state transition. Throws InvalidTransitionError. */
  transitionCustomer(id: string, to: CustomerStatus): Customer {
    const customer = this.getCustomer(id);
    if (!customer) throw new Error(`Unknown customer: ${id}`);
    if (customer.status === to) return customer; // idempotent no-op
    if (!CUSTOMER_TRANSITIONS[customer.status].includes(to)) {
      throw new InvalidTransitionError("customer", customer.status, to);
    }
    this.db.run("UPDATE customers SET status = ? WHERE id = ?", [to, id]);
    this.recordEvent("customer_status_changed", id, {
      from: customer.status,
      to,
    });
    return { ...customer, status: to };
  }

  // ── invites ───────────────────────────────────────────────────────────

  createInvite(params: {
    customerId?: string | null;
    percentOff?: number;
    maxUses?: number;
    expiresAt?: number | null;
  }): Invite {
    const invite: Invite = {
      // Readable, unambiguous code: CUE-XXXXXXXX (no 0/O/1/I).
      code: "CUE-" + readableCode(8),
      customerId: params.customerId ?? null,
      percentOff: params.percentOff ?? 0,
      maxUses: params.maxUses ?? 1,
      uses: 0,
      expiresAt: params.expiresAt ?? null,
      createdAt: Date.now(),
    };
    this.db.run(
      "INSERT INTO invites (code, customerId, percentOff, maxUses, uses, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        invite.code,
        invite.customerId,
        invite.percentOff,
        invite.maxUses,
        invite.uses,
        invite.expiresAt,
        invite.createdAt,
      ],
    );
    this.recordEvent("invite_created", invite.customerId, {
      code: invite.code,
      percentOff: invite.percentOff,
      maxUses: invite.maxUses,
    });
    return invite;
  }

  getInvite(code: string): Invite | null {
    return (
      this.db
        .query<Invite, [string]>("SELECT * FROM invites WHERE code = ?")
        .get(code.trim().toUpperCase()) ?? null
    );
  }

  listInvites(): Invite[] {
    return this.db
      .query<Invite, []>("SELECT * FROM invites ORDER BY createdAt DESC")
      .all();
  }

  /**
   * Redeem an invite code. Returns the updated invite or throws with a
   * reason (unknown / expired / exhausted).
   */
  redeemInvite(code: string): Invite {
    const invite = this.getInvite(code);
    if (!invite) throw new Error("invite_unknown");
    if (invite.expiresAt !== null && invite.expiresAt < Date.now()) {
      throw new Error("invite_expired");
    }
    if (invite.uses >= invite.maxUses) {
      throw new Error("invite_exhausted");
    }
    this.db.run("UPDATE invites SET uses = uses + 1 WHERE code = ?", [
      invite.code,
    ]);
    this.recordEvent("invite_redeemed", invite.customerId, {
      code: invite.code,
      uses: invite.uses + 1,
    });
    return { ...invite, uses: invite.uses + 1 };
  }

  // ── instances ─────────────────────────────────────────────────────────

  createInstance(params: {
    customerId: string;
    driver: string;
    externalId: string;
    url: string;
    secretsJson?: string;
    state?: InstanceState;
  }): Instance {
    const instance: Instance = {
      id: randomUUID(),
      customerId: params.customerId,
      driver: params.driver,
      externalId: params.externalId,
      url: params.url,
      state: params.state ?? "provisioning",
      secretsJson: params.secretsJson ?? "{}",
      createdAt: Date.now(),
    };
    this.db.run(
      "INSERT INTO instances (id, customerId, driver, externalId, url, state, secretsJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        instance.id,
        instance.customerId,
        instance.driver,
        instance.externalId,
        instance.url,
        instance.state,
        instance.secretsJson,
        instance.createdAt,
      ],
    );
    this.recordEvent("instance_created", instance.customerId, {
      instanceId: instance.id,
      driver: instance.driver,
      externalId: instance.externalId,
    });
    return instance;
  }

  getInstance(id: string): Instance | null {
    return (
      this.db
        .query<Instance, [string]>("SELECT * FROM instances WHERE id = ?")
        .get(id) ?? null
    );
  }

  listInstances(): Instance[] {
    return this.db
      .query<Instance, []>("SELECT * FROM instances ORDER BY createdAt DESC")
      .all();
  }

  listInstancesByCustomer(customerId: string): Instance[] {
    return this.db
      .query<Instance, [string]>(
        "SELECT * FROM instances WHERE customerId = ? ORDER BY createdAt DESC",
      )
      .all(customerId);
  }

  listInstancesByState(state: InstanceState): Instance[] {
    return this.db
      .query<Instance, [string]>("SELECT * FROM instances WHERE state = ?")
      .all(state);
  }

  /** Validated instance state transition. Throws InvalidTransitionError. */
  transitionInstance(id: string, to: InstanceState): Instance {
    const instance = this.getInstance(id);
    if (!instance) throw new Error(`Unknown instance: ${id}`);
    if (instance.state === to) return instance; // idempotent no-op
    if (!INSTANCE_TRANSITIONS[instance.state].includes(to)) {
      throw new InvalidTransitionError("instance", instance.state, to);
    }
    this.db.run("UPDATE instances SET state = ? WHERE id = ?", [to, id]);
    this.recordEvent("instance_state_changed", instance.customerId, {
      instanceId: id,
      from: instance.state,
      to,
    });
    return { ...instance, state: to };
  }

  updateInstanceSecrets(id: string, secretsJson: string): void {
    this.db.run("UPDATE instances SET secretsJson = ? WHERE id = ?", [
      secretsJson,
      id,
    ]);
  }

  // ── subscriptions ─────────────────────────────────────────────────────

  upsertSubscription(sub: Subscription): void {
    this.db.run(
      `INSERT INTO subscriptions (customerId, stripeCustomerId, stripeSubId, status, currentPeriodEnd)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(customerId) DO UPDATE SET
         stripeCustomerId = excluded.stripeCustomerId,
         stripeSubId = excluded.stripeSubId,
         status = excluded.status,
         currentPeriodEnd = excluded.currentPeriodEnd`,
      [
        sub.customerId,
        sub.stripeCustomerId,
        sub.stripeSubId,
        sub.status,
        sub.currentPeriodEnd,
      ],
    );
    this.recordEvent("subscription_upserted", sub.customerId, {
      stripeSubId: sub.stripeSubId,
      status: sub.status,
    });
  }

  getSubscription(customerId: string): Subscription | null {
    return (
      this.db
        .query<Subscription, [string]>(
          "SELECT * FROM subscriptions WHERE customerId = ?",
        )
        .get(customerId) ?? null
    );
  }

  getSubscriptionByStripeSubId(stripeSubId: string): Subscription | null {
    return (
      this.db
        .query<Subscription, [string]>(
          "SELECT * FROM subscriptions WHERE stripeSubId = ?",
        )
        .get(stripeSubId) ?? null
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Uppercase code from an unambiguous alphabet (no 0/O/1/I/L). */
function readableCode(len: number): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
