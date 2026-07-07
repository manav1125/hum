/**
 * WS4 Slack channel bot tests.
 *
 * Covers the mandated security + flow surface:
 *   - v0 signature verification (valid passes; tampered/stale/missing rejected)
 *   - event_id dedupe (duplicate delivery → exactly one dispatch)
 *   - OAuth install stores the team → customer binding (bot token at rest,
 *     never in any HTTP response)
 *   - mention → instance dispatch (actor token minted + verifiable with the
 *     instance signing key, sourceChannel/interface "slack" tagged, reply
 *     posted back in-thread via chat.postMessage)
 *   - unconfigured mode (no SLACK_* env → 503, no throw at boot)
 *   - per-customer flag gating (installed but disabled → ack, no dispatch)
 *   - /cue slash commands (status | new | help)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  signSlackPayload,
  mintInstallState,
  verifyInstallState,
  verifySlackSignature,
} from "../channels/slack/verify.js";
import {
  slackConversationKey,
  stripBotMention,
} from "../channels/slack/dispatch.js";
import { HqDb, type Customer } from "../db.js";
import { MockDriver } from "../providers/mock-driver.js";
import { generateInstanceSecrets, verifyActorToken } from "../secrets.js";
import { createHandler, type ServerDeps } from "../server.js";

const SIGNING_SECRET = "test-slack-signing-secret";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_BOT_TOKEN",
  "HQ_PUBLIC_SITE_URL",
  "HQ_PUBLIC_URL",
  "HQ_SITE_DIR",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  process.env.SLACK_CLIENT_ID = "111.222";
  process.env.SLACK_CLIENT_SECRET = "shhh";
  process.env.HQ_PUBLIC_SITE_URL = "https://justcue.ai";
  process.env.HQ_SITE_DIR = "/nonexistent-site-dir"; // JSON 404s, not pages
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── fixtures ──────────────────────────────────────────────────────────────

const INSTANCE_URL = "https://acme.justcue.app";

function liveCustomerWithInstance(db: HqDb): {
  customer: Customer;
  signingKeyHex: string;
} {
  const customer = db.createCustomer({
    email: "acme@example.com",
    name: "Acme Ops",
  });
  const secrets = generateInstanceSecrets();
  secrets.guardianPrincipalId = "principal-1";
  const instance = db.createInstance({
    customerId: customer.id,
    driver: "mock",
    externalId: "ext-1",
    url: INSTANCE_URL,
    secretsJson: JSON.stringify(secrets),
  });
  db.transitionInstance(instance.id, "live");
  return { customer, signingKeyHex: secrets.actorTokenSigningKey };
}

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

/**
 * Mock outbound fetch covering the whole dispatch pipeline: the instance's
 * messages routes and Slack's Web API. Reply appears on the second poll.
 */
function outboundMock(opts: { replyText?: string } = {}) {
  const calls: CapturedCall[] = [];
  let polls = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith(`${INSTANCE_URL}/v1/assistants/self/messages?`)) {
      polls++;
      const messages =
        polls >= 2
          ? [
              { id: "m1", role: "user", content: "hi", timestamp: new Date().toISOString() },
              {
                id: "m2",
                role: "assistant",
                content: opts.replyText ?? "Here you go!",
                timestamp: new Date().toISOString(),
              },
            ]
          : [];
      return Response.json({ messages });
    }
    if (url === `${INSTANCE_URL}/v1/assistants/self/messages`) {
      return Response.json({ ok: true }, { status: 200 });
    }
    if (url.includes("slack.com/api/chat.postMessage")) {
      return Response.json({ ok: true, ts: "1700000000.000100" });
    }
    if (url.includes("slack.com/api/oauth.v2.access")) {
      return Response.json({
        ok: true,
        access_token: "xoxb-test-bot-token",
        bot_user_id: "UBOT",
        team: { id: "T123", name: "Acme" },
      });
    }
    if (url.includes("hooks.slack.com") || url.includes("response-url")) {
      return Response.json({ ok: true });
    }
    return Response.json({ error: `unexpected fetch ${url}` }, { status: 500 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function makeHandler(
  db: HqDb,
  fetchImpl: typeof fetch,
): {
  handle: (req: Request) => Promise<Response>;
  dispatches: Promise<unknown>[];
} {
  const dispatches: Promise<unknown>[] = [];
  const deps: ServerDeps = {
    db,
    driver: new MockDriver(),
    adminToken: "admin-t",
    fetchImpl,
    slack: {
      replyTimeoutMs: 500,
      pollIntervalMs: 1,
      schedule: (p) => dispatches.push(p),
    },
  };
  return { handle: createHandler(deps), dispatches };
}

function signedEventRequest(payload: unknown): Request {
  const rawBody = JSON.stringify(payload);
  const { timestamp, signature } = signSlackPayload(rawBody, SIGNING_SECRET);
  return new Request("https://justcue.ai/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}

function signedCommandRequest(form: Record<string, string>): Request {
  const rawBody = new URLSearchParams(form).toString();
  const { timestamp, signature } = signSlackPayload(rawBody, SIGNING_SECRET);
  return new Request("https://justcue.ai/slack/commands", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}

function mentionEnvelope(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    event_id: eventId,
    team_id: "T123",
    event: {
      type: "app_mention",
      user: "UUSER",
      text: "<@UBOT> what's our runway?",
      channel: "C42",
      ts: "1700000001.000200",
      ...overrides,
    },
  };
}

function installTeam(db: HqDb, customerId: string): void {
  db.upsertSlackInstall({
    teamId: "T123",
    customerId,
    botToken: "xoxb-test-bot-token",
    botUserId: "UBOT",
    teamName: "Acme",
  });
}

// ── signature verification ───────────────────────────────────────────────

describe("slack signature verification", () => {
  const body = JSON.stringify({ type: "event_callback" });

  test("valid signature passes", () => {
    const { timestamp, signature } = signSlackPayload(body, SIGNING_SECRET);
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: timestamp,
        signatureHeader: signature,
        secret: SIGNING_SECRET,
      }),
    ).toBe(true);
  });

  test("tampered body is rejected", () => {
    const { timestamp, signature } = signSlackPayload(body, SIGNING_SECRET);
    expect(
      verifySlackSignature({
        rawBody: body + "x",
        timestampHeader: timestamp,
        signatureHeader: signature,
        secret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test("stale timestamp is rejected (replay window)", () => {
    const staleTs = Math.floor(Date.now() / 1000) - 600; // > 300s tolerance
    const { timestamp, signature } = signSlackPayload(
      body,
      SIGNING_SECRET,
      staleTs,
    );
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: timestamp,
        signatureHeader: signature,
        secret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test("wrong secret / missing headers rejected", () => {
    const { timestamp, signature } = signSlackPayload(body, SIGNING_SECRET);
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: timestamp,
        signatureHeader: signature,
        secret: "other-secret",
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: null,
        signatureHeader: signature,
        secret: SIGNING_SECRET,
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: timestamp,
        signatureHeader: null,
        secret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test("events route 401s on a bad signature", async () => {
    const db = new HqDb(":memory:");
    const { fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);
    const rawBody = JSON.stringify(mentionEnvelope("Ev1"));
    const res = await handle(
      new Request("https://justcue.ai/slack/events", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-slack-signature": "v0=deadbeef",
        },
        body: rawBody,
      }),
    );
    expect(res.status).toBe(401);
  });
});

// ── install state ────────────────────────────────────────────────────────

describe("install state", () => {
  test("round-trips and rejects tampering/expiry", () => {
    const state = mintInstallState("cust-1", SIGNING_SECRET);
    expect(verifyInstallState(state, SIGNING_SECRET)).toEqual({
      ok: true,
      customerId: "cust-1",
    });
    expect(verifyInstallState(state + "x", SIGNING_SECRET).ok).toBe(false);
    expect(verifyInstallState(state, "other").ok).toBe(false);
    const old = mintInstallState("cust-1", SIGNING_SECRET, Date.now() - 2 * 3_600_000);
    expect(verifyInstallState(old, SIGNING_SECRET).ok).toBe(false);
  });
});

// ── DB layer ─────────────────────────────────────────────────────────────

describe("slack db (migration 7)", () => {
  test("fresh db has the slack tables + customer flag default OFF", () => {
    const db = new HqDb(":memory:");
    const c = db.createCustomer({ email: "a@x.io", name: "A" });
    expect(c.slackEnabled).toBe(0);
    expect(db.getCustomer(c.id)!.slackEnabled).toBe(0);
    const flipped = db.setCustomerSlackEnabled(c.id, true);
    expect(flipped.slackEnabled).toBe(1);
    expect(db.getCustomer(c.id)!.slackEnabled).toBe(1);
  });

  test("upsertSlackInstall stores and re-binds; event has no token", () => {
    const db = new HqDb(":memory:");
    const c = db.createCustomer({ email: "a@x.io", name: "A" });
    db.upsertSlackInstall({
      teamId: "T1",
      customerId: c.id,
      botToken: "xoxb-secret",
      teamName: "One",
    });
    expect(db.getSlackInstall("T1")!.botToken).toBe("xoxb-secret");
    db.upsertSlackInstall({
      teamId: "T1",
      customerId: c.id,
      botToken: "xoxb-rotated",
      teamName: "One",
    });
    expect(db.getSlackInstall("T1")!.botToken).toBe("xoxb-rotated");
    const events = db.listEvents(10).filter((e) => e.kind === "slack_installed");
    expect(events.length).toBe(2);
    for (const e of events) expect(e.dataJson).not.toContain("xoxb");
  });

  test("recordSlackEventId dedupes", () => {
    const db = new HqDb(":memory:");
    expect(db.recordSlackEventId("Ev1")).toBe(true);
    expect(db.recordSlackEventId("Ev1")).toBe(false);
    expect(db.recordSlackEventId("Ev2")).toBe(true);
  });
});

// ── OAuth install flow ───────────────────────────────────────────────────

describe("oauth install", () => {
  test("admin mints link → /slack/install redirects to Slack → callback stores binding", async () => {
    const db = new HqDb(":memory:");
    const { customer } = liveCustomerWithInstance(db);
    const { calls, fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);

    const linkRes = await handle(
      new Request(
        `https://justcue.ai/admin/customers/${customer.id}/slack-install-link`,
        { method: "POST", headers: { Authorization: "Bearer admin-t" }, body: "{}" },
      ),
    );
    expect(linkRes.status).toBe(200);
    const { url } = (await linkRes.json()) as { url: string };
    expect(url).toStartWith("https://justcue.ai/slack/install?state=");

    const installRes = await handle(new Request(url));
    expect(installRes.status).toBe(302);
    const location = new URL(installRes.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("111.222");
    const state = location.searchParams.get("state")!;

    const cbRes = await handle(
      new Request(
        `https://justcue.ai/slack/oauth/callback?code=xcode&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("Location")).toBe(
      "https://justcue.ai/account?slack=connected",
    );

    const install = db.getSlackInstall("T123");
    expect(install).not.toBeNull();
    expect(install!.customerId).toBe(customer.id);
    expect(install!.botToken).toBe("xoxb-test-bot-token");
    expect(install!.botUserId).toBe("UBOT");

    // The code exchange hit Slack with our client credentials.
    const exchange = calls.find((c) => c.url.includes("oauth.v2.access"));
    expect(exchange).toBeDefined();
    expect(String(exchange!.init?.body)).toContain("code=xcode");
  });

  test("callback rejects a forged state", async () => {
    const db = new HqDb(":memory:");
    const { fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);
    const res = await handle(
      new Request(
        "https://justcue.ai/slack/oauth/callback?code=x&state=cust-1.123.forged",
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ── mention → dispatch ───────────────────────────────────────────────────

describe("mention dispatch", () => {
  async function runMention(db: HqDb) {
    const { calls, fetchImpl } = outboundMock({ replyText: "42 months." });
    const { handle, dispatches } = makeHandler(db, fetchImpl);
    const res = await handle(signedEventRequest(mentionEnvelope("Ev-disp-1")));
    expect(res.status).toBe(200);
    await Promise.all(dispatches);
    return { calls, dispatches };
  }

  test("mention mints a valid actor token, tags channel slack, replies in-thread", async () => {
    const db = new HqDb(":memory:");
    const { customer, signingKeyHex } = liveCustomerWithInstance(db);
    installTeam(db, customer.id);
    db.setCustomerSlackEnabled(customer.id, true);

    const { calls } = await runMention(db);

    // 1. Message POSTed to the instance with a daemon-verifiable actor JWT.
    const send = calls.find(
      (c) =>
        c.url === `${INSTANCE_URL}/v1/assistants/self/messages` &&
        c.init?.method === "POST",
    );
    expect(send).toBeDefined();
    const auth = (send!.init!.headers as Record<string, string>).Authorization;
    expect(auth).toStartWith("Bearer ");
    const verdict = verifyActorToken(auth.slice(7), signingKeyHex);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.sub).toBe("actor:Cue:principal-1");
    }

    // 2. Channel metadata tagged on the daemon message.
    const sent = JSON.parse(String(send!.init!.body)) as Record<string, string>;
    expect(sent.sourceChannel).toBe("slack");
    expect(sent.interface).toBe("slack");
    expect(sent.content).toBe("what's our runway?"); // bot mention stripped
    expect(sent.conversationKey).toBe("slack:T123:C42:1700000001.000200");

    // 3. Reply posted back in-thread via chat.postMessage.
    const post = calls.find((c) => c.url.includes("chat.postMessage"));
    expect(post).toBeDefined();
    const posted = JSON.parse(String(post!.init!.body)) as Record<string, string>;
    expect(posted.channel).toBe("C42");
    expect(posted.thread_ts).toBe("1700000001.000200");
    expect(posted.text).toBe("42 months.");
    const authHeader = (post!.init!.headers as Record<string, string>)
      .Authorization;
    expect(authHeader).toBe("Bearer xoxb-test-bot-token");

    // 4. Completion audit event.
    expect(
      db.listEvents(20).some((e) => e.kind === "slack_dispatch_completed"),
    ).toBe(true);
  });

  test("duplicate event_id delivery dispatches exactly once", async () => {
    const db = new HqDb(":memory:");
    const { customer } = liveCustomerWithInstance(db);
    installTeam(db, customer.id);
    db.setCustomerSlackEnabled(customer.id, true);
    const { calls, fetchImpl } = outboundMock();
    const { handle, dispatches } = makeHandler(db, fetchImpl);

    const first = await handle(signedEventRequest(mentionEnvelope("Ev-dup")));
    const second = await handle(signedEventRequest(mentionEnvelope("Ev-dup")));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()) as Record<string, unknown>).toMatchObject({
      duplicate: true,
    });
    await Promise.all(dispatches);

    expect(dispatches.length).toBe(1);
    const sends = calls.filter(
      (c) =>
        c.url === `${INSTANCE_URL}/v1/assistants/self/messages` &&
        c.init?.method === "POST",
    );
    expect(sends.length).toBe(1);
    const posts = calls.filter((c) => c.url.includes("chat.postMessage"));
    expect(posts.length).toBe(1);
  });

  test("per-customer flag OFF (default) → ack but no dispatch", async () => {
    const db = new HqDb(":memory:");
    const { customer } = liveCustomerWithInstance(db);
    installTeam(db, customer.id); // flag left at default OFF
    const { calls, fetchImpl } = outboundMock();
    const { handle, dispatches } = makeHandler(db, fetchImpl);

    const res = await handle(signedEventRequest(mentionEnvelope("Ev-off")));
    expect(res.status).toBe(200);
    await Promise.all(dispatches);

    expect(
      calls.filter((c) => c.url.startsWith(INSTANCE_URL)).length,
    ).toBe(0);
    expect(calls.filter((c) => c.url.includes("chat.postMessage")).length).toBe(0);
    const skip = db
      .listEvents(20)
      .find((e) => e.kind === "slack_dispatch_skipped");
    expect(skip).toBeDefined();
    expect(skip!.dataJson).toContain("flag_disabled");
  });

  test("unknown team → ack but no dispatch", async () => {
    const db = new HqDb(":memory:");
    const { calls, fetchImpl } = outboundMock();
    const { handle, dispatches } = makeHandler(db, fetchImpl);
    const res = await handle(signedEventRequest(mentionEnvelope("Ev-unknown")));
    expect(res.status).toBe(200);
    await Promise.all(dispatches);
    expect(calls.length).toBe(0);
  });

  test("bot messages are ignored (loop guard)", async () => {
    const db = new HqDb(":memory:");
    const { customer } = liveCustomerWithInstance(db);
    installTeam(db, customer.id);
    db.setCustomerSlackEnabled(customer.id, true);
    const { calls, fetchImpl } = outboundMock();
    const { handle, dispatches } = makeHandler(db, fetchImpl);
    const res = await handle(
      signedEventRequest(mentionEnvelope("Ev-bot", { bot_id: "B99" })),
    );
    expect(res.status).toBe(200);
    await Promise.all(dispatches);
    expect(calls.length).toBe(0);
  });

  test("DM (message.im) dispatches with a per-DM conversation key, un-threaded reply", async () => {
    const db = new HqDb(":memory:");
    const { customer } = liveCustomerWithInstance(db);
    installTeam(db, customer.id);
    db.setCustomerSlackEnabled(customer.id, true);
    const { calls, fetchImpl } = outboundMock();
    const { handle, dispatches } = makeHandler(db, fetchImpl);

    const res = await handle(
      signedEventRequest({
        type: "event_callback",
        event_id: "Ev-dm",
        team_id: "T123",
        event: {
          type: "message",
          channel_type: "im",
          user: "UUSER",
          text: "remind me about standup",
          channel: "D77",
          ts: "1700000002.000300",
        },
      }),
    );
    expect(res.status).toBe(200);
    await Promise.all(dispatches);

    const send = calls.find(
      (c) =>
        c.url === `${INSTANCE_URL}/v1/assistants/self/messages` &&
        c.init?.method === "POST",
    );
    expect(send).toBeDefined();
    const sent = JSON.parse(String(send!.init!.body)) as Record<string, string>;
    expect(sent.conversationKey).toBe("slack:T123:D77");
    const post = calls.find((c) => c.url.includes("chat.postMessage"));
    const posted = JSON.parse(String(post!.init!.body)) as Record<string, unknown>;
    expect(posted.thread_ts).toBeUndefined();
  });

  test("url_verification challenge is answered", async () => {
    const db = new HqDb(":memory:");
    const { fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);
    const res = await handle(
      signedEventRequest({ type: "url_verification", challenge: "ch-42" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      challenge: "ch-42",
    });
  });
});

// ── /cue slash commands ──────────────────────────────────────────────────

describe("/cue commands", () => {
  test("help (and unknown subcommands) answer usage ephemerally", async () => {
    const db = new HqDb(":memory:");
    const { fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);
    for (const text of ["help", "", "bogus"]) {
      const res = await handle(
        signedCommandRequest({ command: "/cue", text, team_id: "T123" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { response_type: string; text: string };
      expect(body.response_type).toBe("ephemeral");
      expect(body.text).toContain("/cue status");
    }
  });

  test("status reflects connection state", async () => {
    const db = new HqDb(":memory:");
    const { customer } = liveCustomerWithInstance(db);
    const { fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);

    // Not installed yet.
    let res = await handle(
      signedCommandRequest({ command: "/cue", text: "status", team_id: "T123" }),
    );
    let body = (await res.json()) as { text: string };
    expect(body.text).toContain("isn't linked");

    // Installed but flag OFF.
    installTeam(db, customer.id);
    res = await handle(
      signedCommandRequest({ command: "/cue", text: "status", team_id: "T123" }),
    );
    body = (await res.json()) as { text: string };
    expect(body.text).toContain("switched off");

    // Fully connected.
    db.setCustomerSlackEnabled(customer.id, true);
    res = await handle(
      signedCommandRequest({ command: "/cue", text: "status", team_id: "T123" }),
    );
    body = (await res.json()) as { text: string };
    expect(body.text).toContain("Connected");
  });

  test("new dispatches a fresh conversation and answers via response_url", async () => {
    const db = new HqDb(":memory:");
    const { customer } = liveCustomerWithInstance(db);
    installTeam(db, customer.id);
    db.setCustomerSlackEnabled(customer.id, true);
    const { calls, fetchImpl } = outboundMock({ replyText: "Fresh start!" });
    const { handle, dispatches } = makeHandler(db, fetchImpl);

    const res = await handle(
      signedCommandRequest({
        command: "/cue",
        text: "new plan my week",
        team_id: "T123",
        channel_id: "C42",
        response_url: "https://hooks.slack.com/commands/response-url-1",
      }),
    );
    expect(res.status).toBe(200);
    const ack = (await res.json()) as { response_type: string };
    expect(ack.response_type).toBe("ephemeral");
    await Promise.all(dispatches);

    const send = calls.find(
      (c) =>
        c.url === `${INSTANCE_URL}/v1/assistants/self/messages` &&
        c.init?.method === "POST",
    );
    expect(send).toBeDefined();
    const sent = JSON.parse(String(send!.init!.body)) as Record<string, string>;
    expect(sent.content).toBe("plan my week");
    expect(sent.conversationKey).toStartWith("slack:T123:C42:new-");

    const final = calls.find((c) => c.url.includes("hooks.slack.com"));
    expect(final).toBeDefined();
    const finalBody = JSON.parse(String(final!.init!.body)) as Record<string, string>;
    expect(finalBody.text).toBe("Fresh start!");
    expect(finalBody.response_type).toBe("in_channel");
  });

  test("commands route 401s on bad signature", async () => {
    const db = new HqDb(":memory:");
    const { fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);
    const res = await handle(
      new Request("https://justcue.ai/slack/commands", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-slack-signature": "v0=beef",
        },
        body: "command=%2Fcue&text=help",
      }),
    );
    expect(res.status).toBe(401);
  });
});

// ── unconfigured mode ────────────────────────────────────────────────────

describe("unconfigured mode", () => {
  test("no SLACK_* env → slack routes answer 503, rest of HQ unaffected", async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    const db = new HqDb(":memory:");
    const { fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);

    for (const [method, path, body] of [
      ["POST", "/slack/events", "{}"],
      ["POST", "/slack/commands", "command=%2Fcue"],
      ["GET", "/slack/install", undefined],
      ["GET", "/slack/oauth/callback", undefined],
    ] as const) {
      const res = await handle(
        new Request(`https://justcue.ai${path}`, { method, body }),
      );
      expect(res.status).toBe(503);
    }

    // Health stays green — nothing throws at boot or on unrelated routes.
    const health = await handle(new Request("https://justcue.ai/healthz"));
    expect(health.status).toBe(200);
  });

  test("admin install-link answers 503 without OAuth credentials", async () => {
    delete process.env.SLACK_CLIENT_ID;
    const db = new HqDb(":memory:");
    const c = db.createCustomer({ email: "a@x.io", name: "A" });
    const { fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);
    const res = await handle(
      new Request(`https://justcue.ai/admin/customers/${c.id}/slack-install-link`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-t" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(503);
  });
});

// ── admin flag toggle ────────────────────────────────────────────────────

describe("admin slack-toggle", () => {
  test("flips the per-customer flag", async () => {
    const db = new HqDb(":memory:");
    const c = db.createCustomer({ email: "a@x.io", name: "A" });
    const { fetchImpl } = outboundMock();
    const { handle } = makeHandler(db, fetchImpl);

    const on = await handle(
      new Request(`https://justcue.ai/admin/customers/${c.id}/slack-toggle`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-t" },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(on.status).toBe(200);
    expect(((await on.json()) as { slackEnabled: boolean }).slackEnabled).toBe(true);
    expect(db.getCustomer(c.id)!.slackEnabled).toBe(1);

    const bad = await handle(
      new Request(`https://justcue.ai/admin/customers/${c.id}/slack-toggle`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-t" },
        body: JSON.stringify({ enabled: "yes" }),
      }),
    );
    expect(bad.status).toBe(400);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

describe("dispatch helpers", () => {
  test("stripBotMention removes the bot mention only", () => {
    expect(stripBotMention("<@UBOT> hello <@UOTHER>", "UBOT")).toBe(
      "hello <@UOTHER>",
    );
    expect(stripBotMention("  <@UANY> hi ", "")).toBe("hi");
  });

  test("slackConversationKey threads channels, pins DMs", () => {
    expect(
      slackConversationKey({
        teamId: "T1",
        channel: "C1",
        ts: "2.0",
        threadTs: "1.0",
        text: "",
        isDm: false,
      }),
    ).toBe("slack:T1:C1:1.0");
    expect(
      slackConversationKey({
        teamId: "T1",
        channel: "D1",
        ts: "2.0",
        text: "",
        isDm: true,
      }),
    ).toBe("slack:T1:D1");
  });
});
