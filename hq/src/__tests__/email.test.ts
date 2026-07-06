import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  creditsLowEmail,
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
