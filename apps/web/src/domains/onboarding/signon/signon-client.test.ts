/**
 * The sign-on flow's one network seam.
 *
 * These tests exist because the failure mode this module guards against is
 * silent: an instance origin HQ has not been taught about gets a browser-level
 * CORS block that looks exactly like a network error, and the tempting
 * shortcut — treat any failure as "check your email" — tells every user a
 * link is coming when none is. Every branch below asserts we say what actually
 * happened.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  INSTANCE_DOMAIN,
  instanceUrlFromAddress,
  looksLikeEmail,
  requestSigninLink,
  signinPageUrl,
} from "./signon-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realOnLine = Object.getOwnPropertyDescriptor(
  globalThis.navigator ?? {},
  "onLine",
);

function setOnLine(value: boolean): void {
  Object.defineProperty(globalThis.navigator, "onLine", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  if (realOnLine) {
    Object.defineProperty(globalThis.navigator, "onLine", realOnLine);
  } else {
    setOnLine(true);
  }
});

describe("requestSigninLink — HQ's answers, reported verbatim", () => {
  test("status:sent is the only thing that becomes 'sent'", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ ok: true, status: "sent" }),
    );
    expect(
      await requestSigninLink("ada@example.com", fetchImpl as never),
    ).toEqual({
      kind: "sent",
    });
  });

  test("an unrecognised email is 'invite_required', never 'sent'", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({
        ok: true,
        status: "invite_required",
        message: "private alpha",
      }),
    );
    expect(
      await requestSigninLink("nobody@example.com", fetchImpl as never),
    ).toEqual({
      kind: "invite_required",
      message: "private alpha",
    });
  });

  test("allowlisted-but-unprovisioned is its own outcome, not 'not found'", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({
        ok: true,
        status: "invited_no_account",
        message: "not set up yet",
      }),
    );
    expect(
      await requestSigninLink("ada@example.com", fetchImpl as never),
    ).toEqual({
      kind: "invited_no_account",
      message: "not set up yet",
    });
  });

  test("HQ's mailer failure (502) is reported as a send failure", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ ok: false, status: "send_failed" }, 502),
    );
    expect(
      await requestSigninLink("ada@example.com", fetchImpl as never),
    ).toEqual({
      kind: "send_failed",
    });
  });

  test("log-only HQ (no mailer key) never claims a link was sent", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ ok: true, status: "email_not_configured" }),
    );
    expect(
      await requestSigninLink("ada@example.com", fetchImpl as never),
    ).toEqual({
      kind: "email_not_configured",
    });
  });
});

describe("requestSigninLink — no account service reachable", () => {
  test("a thrown fetch (CORS block / DNS) degrades to a usable page, not an error", async () => {
    setOnLine(true);
    const fetchImpl = mock(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(
      await requestSigninLink("ada@example.com", fetchImpl as never),
    ).toEqual({
      kind: "unreachable",
      signinUrl: signinPageUrl(),
    });
  });

  test("offline is offline — a retry, not a failure", async () => {
    setOnLine(false);
    const fetchImpl = mock(async () =>
      jsonResponse({ ok: true, status: "sent" }),
    );
    expect(
      await requestSigninLink("ada@example.com", fetchImpl as never),
    ).toEqual({
      kind: "offline",
    });
    // The network was never even attempted.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a non-JSON answer (proxy error page) does not become a success", async () => {
    setOnLine(true);
    const fetchImpl = mock(
      async () => new Response("<html>502</html>", { status: 502 }),
    );
    expect(
      await requestSigninLink("ada@example.com", fetchImpl as never),
    ).toEqual({
      kind: "unreachable",
      signinUrl: signinPageUrl(),
    });
  });

  test("an unknown status is not optimistically read as sent", async () => {
    setOnLine(true);
    const fetchImpl = mock(async () =>
      jsonResponse({ error: "signin not configured" }, 503),
    );
    expect(
      (await requestSigninLink("ada@example.com", fetchImpl as never)).kind,
    ).toBe("unreachable");
  });
});

describe("the email never travels in a URL", () => {
  test("it is sent in the POST body and the request URL carries no query at all", async () => {
    setOnLine(true);
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse({ ok: true, status: "sent" });
    });
    await requestSigninLink("ada@example.com", fetchImpl as never);

    expect(seenUrl).not.toContain("ada@example.com");
    expect(seenUrl).not.toContain("?");
    expect(seenUrl.endsWith("/signin")).toBe(true);
    expect(seenInit?.method).toBe("POST");
    expect(String(seenInit?.body)).toContain("ada@example.com");
  });

  test("the fallback page is the bare sign-in URL — no address, no token", () => {
    const url = signinPageUrl();
    expect(url).not.toContain("?");
    expect(url).not.toContain("@");
    expect(url.endsWith("/signin")).toBe(true);
  });
});

describe("looksLikeEmail", () => {
  test.each([
    ["ada@example.com", true],
    ["  ada@example.com  ", true],
    ["ada", false],
    ["", false],
    ["ada @example.com", false],
  ])("%s → %s", (value, expected) => {
    expect(looksLikeEmail(value)).toBe(expected);
  });
});

describe("instanceUrlFromAddress", () => {
  test("a bare name gets the fixed suffix", () => {
    expect(instanceUrlFromAddress("cue-ada")).toBe(
      "https://cue-ada.justcue.app",
    );
  });

  test("a full host is accepted unchanged", () => {
    expect(instanceUrlFromAddress("cue-ada.justcue.app")).toBe(
      "https://cue-ada.justcue.app",
    );
  });

  test("uppercase and surrounding space are normalised", () => {
    expect(instanceUrlFromAddress("  CUE-Ada  ")).toBe(
      "https://cue-ada.justcue.app",
    );
  });

  test("a pasted https URL keeps only its origin — never a token-bearing path", () => {
    expect(
      instanceUrlFromAddress(
        "https://cue-ada.justcue.app/assistant/?cueToken=a.b.c",
      ),
    ).toBe("https://cue-ada.justcue.app");
  });

  test.each([
    ["", "empty"],
    ["a b", "a space"],
    ["a/b", "a path separator"],
    ["a.b", "a second label"],
    ["-ada", "a leading hyphen"],
    ["http://cue-ada.justcue.app", "plain http"],
  ])("rejects %p (%s)", (value) => {
    expect(instanceUrlFromAddress(value)).toBeNull();
  });

  test("the suffix is the real instance domain", () => {
    expect(INSTANCE_DOMAIN).toBe(".justcue.app");
  });
});
