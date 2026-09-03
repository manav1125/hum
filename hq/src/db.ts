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
  "waitlist" | "invited" | "active" | "suspended" | "churned";

/**
 * Stored plan values. founding / founding_byo are legacy aliases that
 * resolve to chief_of_staff (see plans.ts resolvePlan()).
 */
export type CustomerPlan =
  "founding" | "founding_byo" | "assistant" | "chief_of_staff" | "operator";

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
  /**
   * WS4 Slack channel flag (0/1, SQLite boolean). Default OFF — Slack
   * events for this customer's workspace only dispatch when enabled.
   */
  slackEnabled: number;
  /**
   * Argon2id hash of a direct sign-in password, or null (the norm — Cue is
   * magic-link only). Set only for accounts that must sign in without a
   * mailbox; see migration 9. Never serialized into an HTTP response.
   */
  signinPasswordHash: string | null;
}

/**
 * One installed Slack workspace, bound to a customer at OAuth-install time.
 * `botToken` is the workspace's xoxb- token — plaintext at rest like
 * instances.secretsJson, and never serialized into an HTTP response.
 */
export interface SlackInstall {
  teamId: string;
  customerId: string;
  botToken: string;
  botUserId: string;
  teamName: string;
  installedAt: number;
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

/** One allowlisted alpha signin email (P0-7; may pre-date its customer row). */
export interface InviteEmail {
  email: string;
  note: string;
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
  /** Public base URL — the branded custom domain when one was provisioned. */
  url: string;
  /**
   * Provider-native fallback/ops URL (e.g. https://<app>.fly.dev) when
   * `url` is a custom domain; null otherwise (url IS the provider URL).
   */
  flyUrl: string | null;
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
  /** Learn sidecar app name (provider-side), or null when none exists. */
  learnAppName: string | null;
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

/** A customer's shareable referral code (one per customer, minted lazily). */
export interface ReferralCode {
  code: string;
  customerId: string;
  createdAt: number;
}

export type ReferralRedemptionStatus = "pending" | "awarded" | "capped";

/**
 * One referee's use of a referral code. Created pending when the referral
 * code reaches checkout; resolved (awarded/capped) exactly once on the
 * referee's first paid invoice. `refereeCustomerId` is UNIQUE — a customer
 * can only ever be referred once (first touch wins).
 */
export interface ReferralRedemption {
  id: string;
  code: string;
  refereeCustomerId: string;
  status: ReferralRedemptionStatus;
  /** Credits actually granted to the referrer (0 when capped). */
  creditsAwarded: number;
  awardedAt: number | null;
  /** Stripe invoice that triggered the award (webhook-replay audit key). */
  invoiceId: string | null;
  createdAt: number;
}

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
  {
    version: 5,
    name: "instance-fly-url",
    // Custom instance domains: `url` becomes the branded hostname
    // (https://<app>.justcue.app) and the provider-native .fly.dev URL
    // moves here as the fallback/ops URL. NULL on legacy rows and whenever
    // no custom domain was provisioned (url IS the provider URL).
    sql: `
      ALTER TABLE instances ADD COLUMN flyUrl TEXT
    `,
  },
  {
    // WS6 growth loops. NOTE for the merge orchestrator: another workstream
    // (WS4 Slack) also adds an HQ migration — renumber whichever lands
    // second (the runner is strictly additive, keyed on `version`).
    version: 6,
    name: "ws6-referrals",
    // Referral program: one shareable code per customer; one redemption row
    // per referred customer (UNIQUE refereeCustomerId — first touch wins),
    // resolved exactly once on the referee's first paid invoice.
    sql: `
      CREATE TABLE referral_codes (
        code       TEXT PRIMARY KEY,
        customerId TEXT NOT NULL UNIQUE REFERENCES customers(id),
        createdAt  INTEGER NOT NULL
      );

      CREATE TABLE referral_redemptions (
        id                TEXT PRIMARY KEY,
        code              TEXT NOT NULL REFERENCES referral_codes(code),
        refereeCustomerId TEXT NOT NULL UNIQUE REFERENCES customers(id),
        status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','awarded','capped')),
        creditsAwarded    INTEGER NOT NULL DEFAULT 0,
        awardedAt         INTEGER,
        invoiceId         TEXT,
        createdAt         INTEGER NOT NULL
      );
      CREATE INDEX idx_referral_redemptions_code ON referral_redemptions(code)
    `,
  },
  {
    version: 7,
    name: "ws4-slack-channel",
    // WS4 Slack channel bot. Additive only:
    //   customers.slackEnabled — per-customer routing flag, default OFF.
    //   slack_installs — one row per installed Slack workspace (team →
    //     customer binding + the workspace bot token). botToken follows the
    //     instances.secretsJson precedent: plaintext at rest in HQ's SQLite,
    //     NEVER serialized into any HTTP response (see redactSlackInstall).
    //   slack_event_dedupe — Slack redelivers events (3s ack window, up to
    //     3 retries); event_id is the dedupe key. Rows expire after 24h.
    sql: `
      ALTER TABLE customers ADD COLUMN slackEnabled INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE slack_installs (
        teamId      TEXT PRIMARY KEY,
        customerId  TEXT NOT NULL REFERENCES customers(id),
        botToken    TEXT NOT NULL,
        botUserId   TEXT NOT NULL DEFAULT '',
        teamName    TEXT NOT NULL DEFAULT '',
        installedAt INTEGER NOT NULL
      );
      CREATE INDEX idx_slack_installs_customer ON slack_installs(customerId);

      CREATE TABLE slack_event_dedupe (
        eventId TEXT PRIMARY KEY,
        ts      INTEGER NOT NULL
      );
      CREATE INDEX idx_slack_event_dedupe_ts ON slack_event_dedupe(ts)
    `,
  },
  {
    version: 8,
    name: "alpha-invite-emails",
    // P0-7 (alpha-readiness audit): the private-alpha signin allowlist.
    // /signin used to answer a silent {ok:true} for strangers ("check your
    // email" → nothing ever arrives). Emails on this list are recognized at
    // signin even before they have a customer row; everyone else gets an
    // honest "private alpha — request an invite" response. Managed via
    // POST/GET/DELETE /admin/invites/emails.
    sql: `
      CREATE TABLE invite_emails (
        email     TEXT PRIMARY KEY,
        note      TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL
      )
    `,
  },
  {
    version: 9,
    name: "signin-password",
    // Direct password sign-in for accounts that cannot use a mailbox.
    //
    // Cue is magic-link only by design and stays that way: this column is
    // NULL for every ordinary customer, and /signin behaves exactly as
    // before for them. It exists because App Review rejected the app twice
    // under Guideline 2.1 — a reviewer has no access to the demo account's
    // inbox, reads only the User Name / Password fields in App Store
    // Connect, and (per Apple) will not follow instructions to act outside
    // the app. An account with a hash set is asked for a password instead
    // of being emailed a link.
    sql: `ALTER TABLE customers ADD COLUMN signinPasswordHash TEXT`,
  },
  {
    version: 10,
    name: "instances-learn-app",
    // Per-customer Learn sidecar (private Fly app the instance's gateway
    // proxies at /learn). NULL = no sidecar; teardown and sweeps must check
    // it so the second app neither leaks nor goes unwatched.
    sql: `ALTER TABLE instances ADD COLUMN learnAppName TEXT`,
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
        .query<{ version: number }, []>("SELECT version FROM schema_migrations")
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

  /**
   * Latest event of a kind whose dataJson contains a fragment — e.g.
   * `"email":"a@x.io"` for /testflight idempotency, where the interested
   * party may not be a customer yet.
   */
  findLatestEventByKindData(kind: string, fragment: string): HqEvent | null {
    return (
      this.db
        .query<HqEvent, [string, string]>(
          "SELECT * FROM events WHERE kind = ? AND dataJson LIKE ? ORDER BY ts DESC LIMIT 1",
        )
        .get(kind, `%${fragment}%`) ?? null
    );
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
      .query<HqEvent, [number]>("SELECT * FROM events ORDER BY ts DESC LIMIT ?")
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
      slackEnabled: 0,
      signinPasswordHash: null,
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
  consumeSigninToken(
    tokenHash: string,
    now: number = Date.now(),
  ): SigninToken | null {
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

  // ── alpha invite-email allowlist (P0-7) ───────────────────────────────

  /** Add (or refresh the note on) an allowlisted signin email. Idempotent. */
  addInviteEmail(email: string, note = ""): InviteEmail {
    const row: InviteEmail = {
      email: email.trim().toLowerCase(),
      note,
      createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO invite_emails (email, note, createdAt) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET note = excluded.note`,
      [row.email, row.note, row.createdAt],
    );
    this.recordEvent("invite_email_added", null, { email: row.email });
    return row;
  }

  isEmailInvited(email: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM invite_emails WHERE email = ?",
        )
        .get(email.trim().toLowerCase())!.n > 0
    );
  }

  listInviteEmails(): InviteEmail[] {
    return this.db
      .query<InviteEmail, []>(
        "SELECT * FROM invite_emails ORDER BY createdAt DESC",
      )
      .all();
  }

  /** Returns true when the email was on the list (and is now removed). */
  removeInviteEmail(email: string): boolean {
    this.db.run("DELETE FROM invite_emails WHERE email = ?", [
      email.trim().toLowerCase(),
    ]);
    const changed = this.db
      .query<{ n: number }, []>("SELECT changes() AS n")
      .get();
    const removed = (changed?.n ?? 0) > 0;
    if (removed) {
      this.recordEvent("invite_email_removed", null, {
        email: email.trim().toLowerCase(),
      });
    }
    return removed;
  }

  // ── backup (P0-5, HQ half) ────────────────────────────────────────────

  /**
   * Flush the WAL into the main database file. Called at boot and before
   * every backup so a copy of hq.db is complete on its own (the signing-key
   * store must never depend on a sidecar -wal file surviving).
   */
  checkpointWal(): void {
    this.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  /**
   * Write a consistent snapshot of the whole database to `destPath` using
   * SQLite's VACUUM INTO (single transaction — safe against concurrent
   * writers, no -wal/-shm sidecars in the output). Fails if the file exists.
   */
  backupTo(destPath: string): void {
    this.checkpointWal();
    this.db.run("VACUUM INTO ?", [destPath]);
  }

  // ── instances ─────────────────────────────────────────────────────────

  createInstance(params: {
    customerId: string;
    driver: string;
    externalId: string;
    url: string;
    flyUrl?: string | null;
    secretsJson?: string;
    state?: InstanceState;
    imageRef?: string | null;
    learnAppName?: string | null;
  }): Instance {
    const instance: Instance = {
      id: randomUUID(),
      customerId: params.customerId,
      driver: params.driver,
      externalId: params.externalId,
      url: params.url,
      flyUrl: params.flyUrl ?? null,
      state: params.state ?? "provisioning",
      secretsJson: params.secretsJson ?? "{}",
      openrouterKeyHash: null,
      usageSyncedCents: 0,
      imageRef: params.imageRef ?? null,
      learnAppName: params.learnAppName ?? null,
      createdAt: Date.now(),
    };
    this.db.run(
      "INSERT INTO instances (id, customerId, driver, externalId, url, flyUrl, state, secretsJson, imageRef, learnAppName, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        instance.id,
        instance.customerId,
        instance.driver,
        instance.externalId,
        instance.url,
        instance.flyUrl,
        instance.state,
        instance.secretsJson,
        instance.imageRef,
        instance.learnAppName,
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
  setInstanceLearnAppName(id: string, learnAppName: string | null): void {
    this.db.run("UPDATE instances SET learnAppName = ? WHERE id = ?", [
      learnAppName,
      id,
    ]);
  }

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
      entry.balanceAfter =
        this.getCreditBalance(params.customerId) + params.delta;
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
   * True when the customer has ever received a grant — any grant, from any
   * source (a paid invoice, or the one-off provisioning grant). This is the
   * idempotency gate for the provisioning grant: it is not keyed to a
   * billing period, because the question it answers is "has this account
   * ever been funded at all", and the answer must stay no-after-yes forever.
   */
  hasCreditGrant(customerId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM credit_ledger WHERE customerId = ? AND kind = 'grant'",
        )
        .get(customerId)!.n > 0
    );
  }

  /**
   * Idempotency lookup: does an entry of `kind` with exactly this note
   * already exist? Grants and top-ups encode their dedupe key in the note.
   */
  findCreditEntryByNote(
    kind: CreditEntryKind,
    note: string,
  ): CreditEntry | null {
    return (
      this.db
        .query<CreditEntry, [string, string]>(
          "SELECT * FROM credit_ledger WHERE kind = ? AND note = ? LIMIT 1",
        )
        .get(kind, note) ?? null
    );
  }

  // ── referrals (WS6 growth loops) ──────────────────────────────────────

  /**
   * The customer's referral code, minting one on first use. Codes read
   * `REF-XXXXXXXX` (same unambiguous alphabet as invites, distinct prefix
   * so the two can never be confused at a glance or in support threads).
   */
  ensureReferralCode(customerId: string): ReferralCode {
    if (!this.getCustomer(customerId)) {
      throw new Error(`Unknown customer: ${customerId}`);
    }
    const existing = this.getReferralCodeByCustomer(customerId);
    if (existing) return existing;
    const referral: ReferralCode = {
      code: "REF-" + readableCode(8),
      customerId,
      createdAt: Date.now(),
    };
    this.db.run(
      "INSERT INTO referral_codes (code, customerId, createdAt) VALUES (?, ?, ?)",
      [referral.code, referral.customerId, referral.createdAt],
    );
    this.recordEvent("referral_code_created", customerId, {
      code: referral.code,
    });
    return referral;
  }

  getReferralCode(code: string): ReferralCode | null {
    return (
      this.db
        .query<ReferralCode, [string]>(
          "SELECT * FROM referral_codes WHERE code = ?",
        )
        .get(code.trim().toUpperCase()) ?? null
    );
  }

  getReferralCodeByCustomer(customerId: string): ReferralCode | null {
    return (
      this.db
        .query<ReferralCode, [string]>(
          "SELECT * FROM referral_codes WHERE customerId = ?",
        )
        .get(customerId) ?? null
    );
  }

  /**
   * Record a referee's pending redemption of a referral code. A customer
   * can only ever be referred once — when a redemption already exists for
   * this referee (any status, any code), it wins and is returned unchanged.
   */
  createReferralRedemption(params: {
    code: string;
    refereeCustomerId: string;
  }): ReferralRedemption {
    const existing = this.getReferralRedemptionByReferee(
      params.refereeCustomerId,
    );
    if (existing) return existing;
    const redemption: ReferralRedemption = {
      id: randomUUID(),
      code: params.code,
      refereeCustomerId: params.refereeCustomerId,
      status: "pending",
      creditsAwarded: 0,
      awardedAt: null,
      invoiceId: null,
      createdAt: Date.now(),
    };
    this.db.run(
      "INSERT INTO referral_redemptions (id, code, refereeCustomerId, status, creditsAwarded, awardedAt, invoiceId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        redemption.id,
        redemption.code,
        redemption.refereeCustomerId,
        redemption.status,
        redemption.creditsAwarded,
        redemption.awardedAt,
        redemption.invoiceId,
        redemption.createdAt,
      ],
    );
    this.recordEvent("referral_redemption_created", params.refereeCustomerId, {
      code: params.code,
    });
    return redemption;
  }

  getReferralRedemptionByReferee(
    refereeCustomerId: string,
  ): ReferralRedemption | null {
    return (
      this.db
        .query<ReferralRedemption, [string]>(
          "SELECT * FROM referral_redemptions WHERE refereeCustomerId = ?",
        )
        .get(refereeCustomerId) ?? null
    );
  }

  listReferralRedemptionsByCode(code: string): ReferralRedemption[] {
    return this.db
      .query<ReferralRedemption, [string]>(
        "SELECT * FROM referral_redemptions WHERE code = ? ORDER BY createdAt DESC",
      )
      .all(code);
  }

  /**
   * Resolve a pending redemption exactly once. Atomic on status='pending' —
   * a raced or replayed resolve returns null and changes nothing.
   */
  resolveReferralRedemption(
    id: string,
    outcome: {
      status: "awarded" | "capped";
      creditsAwarded: number;
      invoiceId: string | null;
    },
    now: number = Date.now(),
  ): ReferralRedemption | null {
    let resolved: ReferralRedemption | null = null;
    const tx = this.db.transaction(() => {
      const row = this.db
        .query<ReferralRedemption, [string]>(
          "SELECT * FROM referral_redemptions WHERE id = ?",
        )
        .get(id);
      if (!row || row.status !== "pending") return;
      this.db.run(
        "UPDATE referral_redemptions SET status = ?, creditsAwarded = ?, awardedAt = ?, invoiceId = ? WHERE id = ?",
        [outcome.status, outcome.creditsAwarded, now, outcome.invoiceId, id],
      );
      resolved = {
        ...row,
        status: outcome.status,
        creditsAwarded: outcome.creditsAwarded,
        awardedAt: now,
        invoiceId: outcome.invoiceId,
      };
    });
    tx();
    return resolved;
  }

  /** Total referral credits a code has earned (awarded redemptions only). */
  sumReferralCreditsAwarded(code: string): number {
    const row = this.db
      .query<{ total: number | null }, [string]>(
        "SELECT SUM(creditsAwarded) AS total FROM referral_redemptions WHERE code = ? AND status = 'awarded'",
      )
      .get(code);
    return row?.total ?? 0;
  }

  // ── Direct password sign-in (migration 9) ─────────────────────────────

  /**
   * Set or clear a customer's direct sign-in password hash. Pass null to
   * take the password away and return the account to magic-link only.
   *
   * The hash itself is never logged or echoed — the audit event records
   * only whether a password now exists, which is the operationally useful
   * fact and the one an operator needs to see in the ledger.
   */
  setCustomerSigninPasswordHash(id: string, hash: string | null): Customer {
    const customer = this.getCustomer(id);
    if (!customer) throw new Error(`Unknown customer: ${id}`);
    this.db.run("UPDATE customers SET signinPasswordHash = ? WHERE id = ?", [
      hash,
      id,
    ]);
    this.recordEvent("customer_signin_password_changed", id, {
      hasPassword: hash !== null,
    });
    return { ...customer, signinPasswordHash: hash };
  }

  // ── Slack channel (WS4) ───────────────────────────────────────────────

  /** Flip the per-customer Slack routing flag (default OFF at creation). */
  setCustomerSlackEnabled(id: string, enabled: boolean): Customer {
    const customer = this.getCustomer(id);
    if (!customer) throw new Error(`Unknown customer: ${id}`);
    const value = enabled ? 1 : 0;
    if (customer.slackEnabled === value) return customer;
    this.db.run("UPDATE customers SET slackEnabled = ? WHERE id = ?", [
      value,
      id,
    ]);
    this.recordEvent("customer_slack_flag_changed", id, { enabled });
    return { ...customer, slackEnabled: value };
  }

  /**
   * Store (or refresh) a workspace's team → customer binding. Re-installing
   * the app into the same workspace replaces the token and can re-bind the
   * team to a different customer (last install wins — Slack team ids are
   * globally unique, so a team belongs to exactly one customer).
   */
  upsertSlackInstall(params: {
    teamId: string;
    customerId: string;
    botToken: string;
    botUserId?: string;
    teamName?: string;
  }): SlackInstall {
    if (!this.getCustomer(params.customerId)) {
      throw new Error(`Unknown customer: ${params.customerId}`);
    }
    const install: SlackInstall = {
      teamId: params.teamId,
      customerId: params.customerId,
      botToken: params.botToken,
      botUserId: params.botUserId ?? "",
      teamName: params.teamName ?? "",
      installedAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO slack_installs (teamId, customerId, botToken, botUserId, teamName, installedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(teamId) DO UPDATE SET
         customerId = excluded.customerId,
         botToken = excluded.botToken,
         botUserId = excluded.botUserId,
         teamName = excluded.teamName,
         installedAt = excluded.installedAt`,
      [
        install.teamId,
        install.customerId,
        install.botToken,
        install.botUserId,
        install.teamName,
        install.installedAt,
      ],
    );
    // Audit event carries the binding only — never the bot token.
    this.recordEvent("slack_installed", install.customerId, {
      teamId: install.teamId,
      teamName: install.teamName,
    });
    return install;
  }

  getSlackInstall(teamId: string): SlackInstall | null {
    return (
      this.db
        .query<SlackInstall, [string]>(
          "SELECT * FROM slack_installs WHERE teamId = ?",
        )
        .get(teamId) ?? null
    );
  }

  listSlackInstallsByCustomer(customerId: string): SlackInstall[] {
    return this.db
      .query<SlackInstall, [string]>(
        "SELECT * FROM slack_installs WHERE customerId = ? ORDER BY installedAt DESC",
      )
      .all(customerId);
  }

  /**
   * Record a Slack event id for dedupe. Returns true when this delivery is
   * the first (process it), false on a redelivery (skip it). Atomic via the
   * primary key — racing deliveries can never both see "first". Rows older
   * than 24h are purged opportunistically (Slack retries within minutes).
   */
  recordSlackEventId(eventId: string, now: number = Date.now()): boolean {
    this.db.run("DELETE FROM slack_event_dedupe WHERE ts < ?", [
      now - 86_400_000,
    ]);
    this.db.run(
      "INSERT OR IGNORE INTO slack_event_dedupe (eventId, ts) VALUES (?, ?)",
      [eventId, now],
    );
    const changed = this.db
      .query<{ n: number }, []>("SELECT changes() AS n")
      .get();
    return (changed?.n ?? 0) > 0;
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
