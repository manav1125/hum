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

/**
 * Stored plan values. founding / founding_byo are legacy aliases that
 * resolve to chief_of_staff (see plans.ts resolvePlan()).
 */
export type CustomerPlan =
  | "founding"
  | "founding_byo"
  | "assistant"
  | "chief_of_staff"
  | "operator";

export const CUSTOMER_PLANS: CustomerPlan[] = [
  "founding",
  "founding_byo",
  "assistant",
  "chief_of_staff",
  "operator",
];

export interface Customer {
  id: string;
  email: string;
  name: string;
  status: CustomerStatus;
  plan: CustomerPlan;
  createdAt: number;
  /** Stripe Checkout session that activated this customer (welcome page). */
  checkoutSessionId: string | null;
  /** When that checkout completed (ms) — drives the "delayed" threshold. */
  checkoutSessionAt: number | null;
}

export interface SigninToken {
  id: string;
  customerId: string;
  /** SHA-256 hex of the raw token — the raw value is only ever emailed. */
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
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
  /**
   * OpenRouter key hash (the management identifier the provisioning API
   * returns) for this instance's child key — never the key itself.
   */
  openrouterKeyHash: string | null;
  /**
   * Usage-sync cursor: cumulative provider-reported cost (COGS cents) that
   * has already been converted into usage_sync ledger entries.
   */
  usageSyncedCents: number;
  /**
   * Container image the instance is currently running — set at provision
   * and on each successful image update (null on legacy/pre-migration rows).
   */
  imageRef: string | null;
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
  /** Plan the subscription bills for (null/absent on legacy rows). */
  plan?: string | null;
}

export type CreditEntryKind = "grant" | "topup" | "usage_sync" | "adjustment";

export interface CreditEntry {
  id: string;
  customerId: string;
  ts: number;
  /** Signed credit delta (grants/topups positive, usage_sync negative). */
  delta: number;
  /** Running balance after this entry. */
  balanceAfter: number;
  kind: CreditEntryKind;
  /**
   * Human-readable note. Also carries the idempotency key for grants
   * (`grant <stripeSubId>@<periodStart>`) and top-ups (`topup <ref>`).
   */
  note: string;
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
  {
    version: 2,
    name: "plans-and-credits",
    // Rebuilds customers to widen the plan CHECK to the tier ids (SQLite
    // cannot ALTER a CHECK constraint). Safe because migrations run before
    // PRAGMA foreign_keys = ON — child tables reference customers by name,
    // which survives the drop + rename.
    sql: `
      CREATE TABLE customers_v2 (
        id         TEXT PRIMARY KEY,
        email      TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'waitlist'
                   CHECK (status IN ('waitlist','invited','active','suspended','churned')),
        plan       TEXT NOT NULL DEFAULT 'founding'
                   CHECK (plan IN ('founding','founding_byo','assistant','chief_of_staff','operator')),
        createdAt  INTEGER NOT NULL
      );
      INSERT INTO customers_v2 (id, email, name, status, plan, createdAt)
        SELECT id, email, name, status, plan, createdAt FROM customers;
      DROP TABLE customers;
      ALTER TABLE customers_v2 RENAME TO customers;

      CREATE TABLE credit_ledger (
        id           TEXT PRIMARY KEY,
        customerId   TEXT NOT NULL REFERENCES customers(id),
        ts           INTEGER NOT NULL,
        delta        INTEGER NOT NULL,
        balanceAfter INTEGER NOT NULL,
        kind         TEXT NOT NULL
                     CHECK (kind IN ('grant','topup','usage_sync','adjustment')),
        note         TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_credit_ledger_customer ON credit_ledger(customerId, ts);

      ALTER TABLE instances ADD COLUMN openrouterKeyHash TEXT;
      ALTER TABLE instances ADD COLUMN usageSyncedCents INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE subscriptions ADD COLUMN plan TEXT;
    `,
  },
  {
    version: 3,
    name: "site-sessions",
    // Website integration: link Stripe checkout sessions back to customers
    // (so /welcome/status can find them) and store hashed one-time sign-in
    // tokens for the magic-link email flow.
    sql: `
      ALTER TABLE customers ADD COLUMN checkoutSessionId TEXT;
      ALTER TABLE customers ADD COLUMN checkoutSessionAt INTEGER;
      CREATE INDEX idx_customers_checkout_session ON customers(checkoutSessionId);

      CREATE TABLE signin_tokens (
        id         TEXT PRIMARY KEY,
        customerId TEXT NOT NULL REFERENCES customers(id),
        tokenHash  TEXT NOT NULL UNIQUE,
        createdAt  INTEGER NOT NULL,
        expiresAt  INTEGER NOT NULL,
        consumedAt INTEGER
      );
      CREATE INDEX idx_signin_tokens_customer ON signin_tokens(customerId)
    `,
  },
  {
    version: 4,
    name: "instance-image-ref",
    // Fleet image updates: track the image each instance runs. Existing
    // rows backfill to NULL (image unknown until their next update).
    sql: `
      ALTER TABLE instances ADD COLUMN imageRef TEXT
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
    // Migrations run with foreign keys OFF (SQLite's documented procedure
    // for table rebuilds — see migration 2); enforcement starts right after.
    this.migrate();
    this.db.run("PRAGMA foreign_keys = ON;");
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

  /** Latest event of a kind for a customer (welcome-status failure check). */
  findLatestEvent(kind: string, customerId: string): HqEvent | null {
    return (
      this.db
        .query<HqEvent, [string, string]>(
          "SELECT * FROM events WHERE kind = ? AND customerId = ? ORDER BY ts DESC LIMIT 1",
        )
        .get(kind, customerId) ?? null
    );
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
      checkoutSessionId: null,
      checkoutSessionAt: null,
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

  /** Move a customer onto a plan tier (idempotent no-op when unchanged). */
  setCustomerPlan(id: string, plan: CustomerPlan): Customer {
    const customer = this.getCustomer(id);
    if (!customer) throw new Error(`Unknown customer: ${id}`);
    if (customer.plan === plan) return customer;
    this.db.run("UPDATE customers SET plan = ? WHERE id = ?", [plan, id]);
    this.recordEvent("customer_plan_changed", id, {
      from: customer.plan,
      to: plan,
    });
    return { ...customer, plan };
  }

  /** Link the customer to the Stripe Checkout session that activated them. */
  setCustomerCheckoutSession(
    id: string,
    sessionId: string,
    at: number = Date.now(),
  ): void {
    this.db.run(
      "UPDATE customers SET checkoutSessionId = ?, checkoutSessionAt = ? WHERE id = ?",
      [sessionId, at, id],
    );
  }

  getCustomerByCheckoutSession(sessionId: string): Customer | null {
    return (
      this.db
        .query<Customer, [string]>(
          "SELECT * FROM customers WHERE checkoutSessionId = ?",
        )
        .get(sessionId) ?? null
    );
  }

  // ── sign-in tokens (magic-link email flow) ────────────────────────────

  createSigninToken(params: {
    customerId: string;
    tokenHash: string;
    ttlMs: number;
  }): SigninToken {
    const token: SigninToken = {
      id: randomUUID(),
      customerId: params.customerId,
      tokenHash: params.tokenHash,
      createdAt: Date.now(),
      expiresAt: Date.now() + params.ttlMs,
      consumedAt: null,
    };
    this.db.run(
      "INSERT INTO signin_tokens (id, customerId, tokenHash, createdAt, expiresAt, consumedAt) VALUES (?, ?, ?, ?, ?, ?)",
      [
        token.id,
        token.customerId,
        token.tokenHash,
        token.createdAt,
        token.expiresAt,
        token.consumedAt,
      ],
    );
    return token;
  }

  /**
   * Consume a one-time sign-in token by hash. Atomic: only an unconsumed,
   * unexpired token flips — a raced or replayed consume returns null.
   */
  consumeSigninToken(tokenHash: string, now: number = Date.now()): SigninToken | null {
    let consumed: SigninToken | null = null;
    const tx = this.db.transaction(() => {
      const row = this.db
        .query<SigninToken, [string]>(
          "SELECT * FROM signin_tokens WHERE tokenHash = ?",
        )
        .get(tokenHash);
      if (!row || row.consumedAt !== null || row.expiresAt < now) return;
      this.db.run("UPDATE signin_tokens SET consumedAt = ? WHERE id = ?", [
        now,
        row.id,
      ]);
      consumed = { ...row, consumedAt: now };
    });
    tx();
    return consumed;
  }

  /** Housekeeping: drop tokens that expired more than a day ago. */
  purgeExpiredSigninTokens(now: number = Date.now()): void {
    this.db.run("DELETE FROM signin_tokens WHERE expiresAt < ?", [
      now - 86_400_000,
    ]);
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
    imageRef?: string | null;
  }): Instance {
    const instance: Instance = {
      id: randomUUID(),
      customerId: params.customerId,
      driver: params.driver,
      externalId: params.externalId,
      url: params.url,
      state: params.state ?? "provisioning",
      secretsJson: params.secretsJson ?? "{}",
      openrouterKeyHash: null,
      usageSyncedCents: 0,
      imageRef: params.imageRef ?? null,
      createdAt: Date.now(),
    };
    this.db.run(
      "INSERT INTO instances (id, customerId, driver, externalId, url, state, secretsJson, imageRef, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        instance.id,
        instance.customerId,
        instance.driver,
        instance.externalId,
        instance.url,
        instance.state,
        instance.secretsJson,
        instance.imageRef,
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

  /** Record the OpenRouter child-key hash (never the key itself). */
  setInstanceOpenrouterKeyHash(id: string, keyHash: string | null): void {
    this.db.run("UPDATE instances SET openrouterKeyHash = ? WHERE id = ?", [
      keyHash,
      id,
    ]);
  }

  /** Record the container image the instance now runs (provision/update). */
  setInstanceImageRef(id: string, imageRef: string | null): void {
    this.db.run("UPDATE instances SET imageRef = ? WHERE id = ?", [
      imageRef,
      id,
    ]);
  }

  /** Advance the usage-sync cursor (cumulative reported COGS cents). */
  setInstanceUsageSyncedCents(id: string, cents: number): void {
    this.db.run("UPDATE instances SET usageSyncedCents = ? WHERE id = ?", [
      cents,
      id,
    ]);
  }

  // ── subscriptions ─────────────────────────────────────────────────────

  upsertSubscription(sub: Subscription): void {
    this.db.run(
      `INSERT INTO subscriptions (customerId, stripeCustomerId, stripeSubId, status, currentPeriodEnd, plan)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(customerId) DO UPDATE SET
         stripeCustomerId = excluded.stripeCustomerId,
         stripeSubId = excluded.stripeSubId,
         status = excluded.status,
         currentPeriodEnd = excluded.currentPeriodEnd,
         plan = COALESCE(excluded.plan, subscriptions.plan)`,
      [
        sub.customerId,
        sub.stripeCustomerId,
        sub.stripeSubId,
        sub.status,
        sub.currentPeriodEnd,
        sub.plan ?? null,
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

  // ── credit ledger (append-only) ───────────────────────────────────────

  /**
   * Append a credit-ledger entry, computing the running balance inside a
   * transaction so concurrent appends can never interleave balances.
   */
  appendCreditEntry(params: {
    customerId: string;
    delta: number;
    kind: CreditEntryKind;
    note: string;
  }): CreditEntry {
    if (!this.getCustomer(params.customerId)) {
      throw new Error(`Unknown customer: ${params.customerId}`);
    }
    if (!Number.isInteger(params.delta)) {
      throw new Error(`Credit delta must be an integer: ${params.delta}`);
    }
    const entry: CreditEntry = {
      id: randomUUID(),
      customerId: params.customerId,
      ts: Date.now(),
      delta: params.delta,
      balanceAfter: 0, // set inside the transaction
      kind: params.kind,
      note: params.note,
    };
    const tx = this.db.transaction(() => {
      entry.balanceAfter = this.getCreditBalance(params.customerId) + params.delta;
      this.db.run(
        "INSERT INTO credit_ledger (id, customerId, ts, delta, balanceAfter, kind, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          entry.id,
          entry.customerId,
          entry.ts,
          entry.delta,
          entry.balanceAfter,
          entry.kind,
          entry.note,
        ],
      );
    });
    tx();
    this.recordEvent("credit_entry_appended", entry.customerId, {
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      kind: entry.kind,
      note: entry.note,
    });
    return entry;
  }

  /** Current credit balance (0 for customers with no ledger entries). */
  getCreditBalance(customerId: string): number {
    const row = this.db
      .query<{ balance: number | null }, [string]>(
        "SELECT SUM(delta) AS balance FROM credit_ledger WHERE customerId = ?",
      )
      .get(customerId);
    return row?.balance ?? 0;
  }

  listCreditEntries(customerId: string, limit = 100): CreditEntry[] {
    return this.db
      .query<CreditEntry, [string, number]>(
        "SELECT * FROM credit_ledger WHERE customerId = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
      )
      .all(customerId, limit);
  }

  /** True when the customer has any ledger entries at all. */
  hasCreditHistory(customerId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM credit_ledger WHERE customerId = ?",
        )
        .get(customerId)!.n > 0
    );
  }

  /**
   * Idempotency lookup: does an entry of `kind` with exactly this note
   * already exist? Grants and top-ups encode their dedupe key in the note.
   */
  findCreditEntryByNote(kind: CreditEntryKind, note: string): CreditEntry | null {
    return (
      this.db
        .query<CreditEntry, [string, string]>(
          "SELECT * FROM credit_ledger WHERE kind = ? AND note = ? LIMIT 1",
        )
        .get(kind, note) ?? null
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
