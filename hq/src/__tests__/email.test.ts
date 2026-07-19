import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  creditsLowEmail,
  emailReadiness,
  logEmailReadinessAtBoot,
  opsAlertEmail,
  paymentFailedEmail,
  sendEmail,
  signinEmail,
  welcomeEmail,
} from "../email.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["RESEND_API_KEY", "EMAIL_FROM"];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("designed templates (site/emails.html)", () => {
  test("welcome carries the magic link, first name, and designed copy", () => {
    const m = welcomeEmail({
      firstName: "Maya",
      magicLink: "https://cue-x.fly.dev/assistant/?cueToken=tok",
      signinUrl: "https://cue.ai/signin",
    });
    expect(m.subject).toBe("Your Cue is ready.");
    expect(m.html).toContain("Maya — your Cue is live.");
    expect(m.html).toContain("https://cue-x.fly.dev/assistant/?cueToken=tok");
    expect(m.html).toContain("Open Cue");
    expect(m.html).toContain("Save this email");
    expect(m.link).toContain("cueToken=tok");
  });

  test("sign-in link states the 15-minute validity", () => {
    const m = signinEmail({ signinLink: "https://cue.ai/auth?token=abc" });
    expect(m.subject).toBe("Your sign-in link");
    expect(m.html).toContain("https://cue.ai/auth?token=abc");
    expect(m.html).toContain("Valid for 15 minutes");
    expect(m.html).toContain("Sign in to Cue");
  });

  test("credits-low shows the formatted balance box", () => {
    const m = creditsLowEmail({ balance: 1180, accountUrl: "https://cue.ai/account" });
    expect(m.subject).toBe("Running low on credits");
    expect(m.html).toContain("Credits remaining");
    expect(m.html).toContain("1,180");
    expect(m.html).toContain("Top up");
  });

  test("payment-failed keeps the grace-period tone", () => {
    const m = paymentFailedEmail({ portalUrl: "https://cue.ai/account" });
    expect(m.subject).toBe("Payment issue — Cue keeps running for now");
    expect(m.html).toContain("grace period");
    expect(m.html).toContain("Update payment method");
  });

  test("templates escape injected values", () => {
    const m = welcomeEmail({
      firstName: '<script>alert(1)</script>',
      magicLink: "https://x.dev/",
      signinUrl: "https://cue.ai/signin",
    });
    expect(m.html).not.toContain("<script>alert(1)</script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});

describe("sendEmail", () => {
  test("unconfigured mode logs the would-be email (incl. the link) and reports sent:false", async () => {
    const logged: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      const result = await sendEmail(
        "maya@x.io",
        signinEmail({ signinLink: "http://localhost:8790/auth?token=deadbeef" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.sent).toBe(false);
      const line = logged.find((l) => l.includes("[hq/email]"));
      expect(line).toBeDefined();
      expect(line).toContain("maya@x.io");
      expect(line).toContain("http://localhost:8790/auth?token=deadbeef");
    } finally {
      console.info = original;
    }
  });

  test("configured mode posts to Resend with auth + from headers", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    process.env.EMAIL_FROM = "Cue <hello@cue.test>";
    let captured: { url: string; auth: string | null; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({ id: "email_42" });
    }) as typeof fetch;

    const result = await sendEmail(
      "maya@x.io",
      welcomeEmail({ firstName: "Maya", magicLink: "https://x/", signinUrl: "https://cue.ai/signin" }),
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.sent) expect(result.id).toBe("email_42");
    expect(captured!.url).toBe("https://api.resend.com/emails");
    expect(captured!.auth).toBe("Bearer re_test_123");
    expect(captured!.body.from).toBe("Cue <hello@cue.test>");
    expect(captured!.body.to).toEqual(["maya@x.io"]);
    expect(captured!.body.subject).toBe("Your Cue is ready.");
  });

  test("ops alert renders subject prefix and detail lines", () => {
    const m = opsAlertEmail({
      subject: "Fleet sweep: 1 down",
      summary: "2/3 instances healthy.",
      detailLines: ["DOWN http://x.fly.dev"],
      statusUrl: "https://justcue.ai/admin",
    });
    expect(m.subject).toBe("[cue-hq] Fleet sweep: 1 down");
    expect(m.html).toContain("DOWN http://x.fly.dev");
    expect(m.html).toContain("https://justcue.ai/admin");
  });

  test("Resend errors come back typed, never thrown", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    const fetchImpl = (async (_input: RequestInfo | URL) =>
      new Response("rate limited", { status: 429 })) as typeof fetch;
    const result = await sendEmail(
      "maya@x.io",
      signinEmail({ signinLink: "https://x/" }),
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("resend_error_429");
  });
});

describe("emailReadiness (P0-1 operator surface)", () => {
  test("unconfigured: log_only mode, no fabricated domain state", async () => {
    const readiness = await emailReadiness({ probe: true });
    expect(readiness.configured).toBe(false);
    expect(readiness.mode).toBe("log_only");
    expect(readiness.fromDomain).toBe("justcue.ai"); // from the default From
    expect(readiness.domainProbe).toBeUndefined();
  });

  test("configured + probe: reports Resend's own domain status", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "Cue <hello@justcue.ai>";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.resend.com/domains");
      return Response.json({
        data: [
          { name: "other.dev", status: "verified" },
          { name: "justcue.ai", status: "pending" },
        ],
      });
    }) as typeof fetch;
    const readiness = await emailReadiness({ probe: true, fetchImpl });
    expect(readiness.mode).toBe("live");
    expect(readiness.domainProbe).toEqual({ ok: true, found: true, status: "pending" });
  });

  test("configured + probe: From domain missing from Resend is reported found:false", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "Cue <hello@unregistered.dev>";
    const fetchImpl = (async (_input: RequestInfo | URL) =>
      Response.json({ data: [{ name: "justcue.ai", status: "verified" }] })) as typeof fetch;
    const readiness = await emailReadiness({ probe: true, fetchImpl });
    expect(readiness.domainProbe).toEqual({ ok: true, found: false, status: null });
  });

  test("probe API errors come back typed", async () => {
    process.env.RESEND_API_KEY = "re_bad";
    const fetchImpl = (async (_input: RequestInfo | URL) =>
      new Response("unauthorized", { status: 401 })) as typeof fetch;
    const readiness = await emailReadiness({ probe: true, fetchImpl });
    expect(readiness.domainProbe).toEqual({ ok: false, reason: "resend_error_401" });
  });

  test("boot banner screams in log-only mode and stays quiet when configured", () => {
    const errors: string[] = [];
    const infos: string[] = [];
    const origError = console.error;
    const origInfo = console.info;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    console.info = (...args: unknown[]) => infos.push(args.map(String).join(" "));
    try {
      logEmailReadinessAtBoot();
      expect(errors.some((l) => l.includes("LOG-ONLY MODE"))).toBe(true);
      process.env.RESEND_API_KEY = "re_test";
      logEmailReadinessAtBoot();
      expect(infos.some((l) => l.includes("configured"))).toBe(true);
    } finally {
      console.error = origError;
      console.info = origInfo;
    }
  });
});
