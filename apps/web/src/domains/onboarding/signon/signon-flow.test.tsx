/**
 * The sign-on arc, driven the way a user drives it.
 *
 * These are click-throughs, not render assertions, on purpose: a screen that
 * renders but cannot be advanced is the failure class that shipped a dead nav
 * row this week. Every test below starts on a screen and ends on the next one.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// Seams. Each spreads the REAL module and overrides only what the test needs —
// an exhaustive factory silently deletes exports and bun's module registry is
// process-global, so the damage would land on unrelated files.
const realSelfHost = await import("@/lib/self-hosted/cue-self-host");
let selfHostFlag = false;
let connectedInstance: string | null = null;
const seedCueTokenMock = mock((_raw: string) => true);
mock.module("@/lib/self-hosted/cue-self-host", () => ({
  ...realSelfHost,
  isSelfHostMode: () => selfHostFlag,
  connectedSelfHostInstance: async () => connectedInstance,
  seedCueToken: seedCueTokenMock,
}));

const realNativeAuth = await import("@/runtime/native-auth");
let native = false;
mock.module("@/runtime/native-auth", () => ({
  ...realNativeAuth,
  isNativePlatform: () => native,
}));

// `openUrl` is the platform-aware "leave the app" primitive — in Electron it
// hands off to the system browser rather than navigating the app window away
// from Cue, which is why the fallback must not call location.assign directly.
const realBrowser = await import("@/runtime/browser");
const opened: string[] = [];
mock.module("@/runtime/browser", () => ({
  ...realBrowser,
  openUrl: async (url: string) => {
    opened.push(url);
  },
}));

const { SignonFlow } = await import("./signon-flow");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sent = () => jsonResponse({ ok: true, status: "sent" });

let assigned: string[] = [];

beforeEach(() => {
  selfHostFlag = false;
  native = false;
  connectedInstance = null;
  assigned = [];
  opened.length = 0;
  localStorage.clear();
  Object.defineProperty(globalThis.navigator, "onLine", {
    value: true,
    configurable: true,
  });
  // happy-dom refuses real navigation; capture the intent instead.
  Object.defineProperty(globalThis.window, "location", {
    value: {
      ...globalThis.window.location,
      assign: (url: string) => assigned.push(url),
      search: "",
      hostname: "cue-ada.justcue.app",
      origin: "https://cue-ada.justcue.app",
    },
    configurable: true,
    writable: true,
  });
});

afterEach(cleanup);

/** Type an address into the sign-in field and submit it. */
function submitEmail(value: string) {
  fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Send sign-in link" }));
}

describe("the arc: landing → sign up → link in flight", () => {
  test("the splash advances into sign-in and does not replay on the next visit", () => {
    const { unmount } = render(<SignonFlow />);
    // S — the landing screen, with the product's promise in words, not just motion.
    expect(screen.getByText("Already in motion, before you ask.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByLabelText("EMAIL")).toBeTruthy();

    unmount();
    cleanup();
    render(<SignonFlow />);
    // Warm start: straight to A, no nine-second story a second time.
    expect(screen.getByLabelText("EMAIL")).toBeTruthy();
  });

  test("submitting an email reaches 'your link is in flight' with the address echoed", async () => {
    render(<SignonFlow initialStep="signin" fetchImpl={mock(sent) as never} />);
    submitEmail("ada@example.com");

    await waitFor(() => {
      expect(screen.getByText("Your link is in flight")).toBeTruthy();
    });
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    // The link's lifetime is stated, with a glyph and not only a colour.
    expect(screen.getByText("The link is good for 15 minutes.")).toBeTruthy();
  });

  test("'use a different email' goes back to a usable sign-in field", async () => {
    render(<SignonFlow initialStep="signin" fetchImpl={mock(sent) as never} />);
    submitEmail("ada@example.com");
    await waitFor(() => screen.getByText("Your link is in flight"));

    fireEvent.click(
      screen.getByRole("button", { name: "Use a different email" }),
    );
    expect(screen.getByLabelText("EMAIL")).toBeTruthy();
  });

  test("resend is disabled behind a countdown, so one click sends one link", async () => {
    const fetchImpl = mock(sent);
    render(<SignonFlow initialStep="signin" fetchImpl={fetchImpl as never} />);
    submitEmail("ada@example.com");
    await waitFor(() => screen.getByText("Your link is in flight"));

    const resend = screen.getByRole("button", { name: /Resend link · 0:/ });
    expect((resend as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(resend);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("no password, ever", () => {
  test("neither the sign-in screen nor the address screen has a password input", () => {
    const { container, rerender } = render(<SignonFlow initialStep="signin" />);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    rerender(<SignonFlow initialStep="address" />);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
});

describe("honest failure — a self-host instance has no account service of its own", () => {
  test("an unreachable HQ says no link was sent and offers a route that works", async () => {
    const fetchImpl = mock(async () => {
      throw new TypeError("Failed to fetch");
    });
    render(<SignonFlow initialStep="signin" fetchImpl={fetchImpl as never} />);
    submitEmail("ada@example.com");

    await waitFor(() => {
      expect(screen.getByText(/no link was sent/)).toBeTruthy();
    });
    // Not a dead end: the hosted page is one click away.
    const fallback = screen.getByRole("button", {
      name: /Continue on justcue.ai/,
    });
    fireEvent.click(fallback);
    expect(opened).toEqual(["https://justcue.ai/signin"]);
    // And nothing personal rode along in that URL.
    expect(opened[0]).not.toContain("ada@example.com");
    // It opens OUTSIDE the app window — a desktop user navigated to
    // justcue.ai in-place would have no way back to Cue.
    expect(assigned).toEqual([]);
  });

  test("an unrecognised email lands on D2 with the address echoed, not on 'check your inbox'", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({
        ok: true,
        status: "invite_required",
        message: "Cue is in private alpha.",
      }),
    );
    render(<SignonFlow initialStep="signin" fetchImpl={fetchImpl as never} />);
    submitEmail("nobody@example.com");

    await waitFor(() => {
      expect(
        screen.getByText("We couldn't find a Cue for that email"),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Your link is in flight")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try another email" }));
    expect(screen.getByLabelText("EMAIL")).toBeTruthy();
  });

  test("an allowlisted-but-unprovisioned email stays on sign-in with the real reason", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({
        ok: true,
        status: "invited_no_account",
        message: "You're on the alpha list, but your Cue isn't set up yet.",
      }),
    );
    render(<SignonFlow initialStep="signin" fetchImpl={fetchImpl as never} />);
    submitEmail("ada@example.com");

    await waitFor(() => {
      expect(
        screen.getByText(
          "You're on the alpha list, but your Cue isn't set up yet.",
        ),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Your link is in flight")).toBeNull();
  });

  test("a mailer-less HQ never claims a link is in flight", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ ok: true, status: "email_not_configured" }),
    );
    render(<SignonFlow initialStep="signin" fetchImpl={fetchImpl as never} />);
    submitEmail("ada@example.com");

    await waitFor(() => {
      expect(screen.getByText(/no link went out/)).toBeTruthy();
    });
    expect(screen.queryByText("Your link is in flight")).toBeNull();
  });

  test("offline is a retry, and the retry returns to a usable screen", async () => {
    Object.defineProperty(globalThis.navigator, "onLine", {
      value: false,
      configurable: true,
    });
    render(<SignonFlow initialStep="signin" />);
    submitEmail("ada@example.com");

    await waitFor(() =>
      expect(screen.getByText("You're offline")).toBeTruthy(),
    );
    // The state carries a glyph, not just a colour.
    expect(screen.getByText("No network connection.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Your link is in flight")).toBeTruthy();
  });

  test("a malformed address is refused before any request goes out", () => {
    const fetchImpl = mock(sent);
    render(<SignonFlow initialStep="signin" fetchImpl={fetchImpl as never} />);
    submitEmail("not-an-email");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByText(/doesn't look like an email address/)).toBeTruthy();
  });
});

describe("D1 — a lapsed device is told what happened", () => {
  test("self-host flag with no usable token opens on 'your sign-in expired', which leads back to sign-in", () => {
    selfHostFlag = true;
    render(<SignonFlow />);
    expect(screen.getByText("Your sign-in expired")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send a new link" }));
    expect(screen.getByLabelText("EMAIL")).toBeTruthy();
  });
});

describe("E — enter your Cue address", () => {
  test("a bare name becomes the instance origin and nothing else", () => {
    render(<SignonFlow initialStep="signin" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Enter your Cue address instead" }),
    );

    fireEvent.change(screen.getByLabelText("Your Cue address"), {
      target: { value: "cue-ada" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(assigned).toEqual(["https://cue-ada.justcue.app"]);
  });

  test("a nonsense address is refused with a fix, not a navigation", () => {
    render(<SignonFlow initialStep="address" />);
    fireEvent.change(screen.getByLabelText("Your Cue address"), {
      target: { value: "not a host" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(assigned).toEqual([]);
    expect(screen.getByText(/Enter just the name/)).toBeTruthy();
  });

  test("the access-token recovery path is still reachable and still seeds", () => {
    render(<SignonFlow initialStep="address" />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Have an access token? Paste it instead",
      }),
    );
    fireEvent.change(screen.getByLabelText("ACCESS TOKEN"), {
      target: { value: "aaa.bbb.ccc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect with token" }));

    expect(seedCueTokenMock).toHaveBeenCalledWith("aaa.bbb.ccc");
    expect(assigned).toEqual(["/assistant/"]);
  });

  test("← back returns to email sign-in", () => {
    render(<SignonFlow initialStep="address" />);
    fireEvent.click(
      screen.getByRole("button", { name: "← Back to email sign-in" }),
    );
    expect(screen.getByLabelText("EMAIL")).toBeTruthy();
  });
});

describe("no dead controls", () => {
  test("on the desktop web there is no 'Open Mail' button with nothing behind it", async () => {
    native = false;
    render(<SignonFlow initialStep="signin" fetchImpl={mock(sent) as never} />);
    submitEmail("ada@example.com");
    await waitFor(() => screen.getByText("Your link is in flight"));
    expect(screen.queryByRole("button", { name: "Open Mail" })).toBeNull();
  });

  test("on a native shell, where it opens something, 'Open Mail' is offered", async () => {
    native = true;
    render(<SignonFlow initialStep="signin" fetchImpl={mock(sent) as never} />);
    submitEmail("ada@example.com");
    await waitFor(() => screen.getByText("Your link is in flight"));
    expect(screen.getByRole("button", { name: "Open Mail" })).toBeTruthy();
  });
});

describe("the desktop app names the instance it found", () => {
  test("a connected instance is shown, so 'sign in to Cue' becomes 'sign in to YOUR Cue'", async () => {
    connectedInstance = "https://cue-ada.justcue.app";
    render(<SignonFlow initialStep="signin" />);
    await waitFor(() => {
      expect(screen.getByText("cue-ada.justcue.app")).toBeTruthy();
    });
  });

  test("with no connection it says nothing rather than showing a placeholder host", async () => {
    connectedInstance = null;
    render(<SignonFlow initialStep="signin" />);
    await waitFor(() => screen.getByLabelText("EMAIL"));
    expect(screen.queryByText(/justcue\.app$/)).toBeNull();
  });
});
