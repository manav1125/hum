import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The connect shell is a single self-contained HTML file (it ships as `webDir`,
// no build step), so its logic can't be imported. Load the file, pull the last
// `<script>` out, and eval it against a minimal window so the exact shipped
// helpers are what's under test — not a copy that can drift. The UI wiring is
// verified live in a browser; this locks the pure parsing rules.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const script = html.slice(
  html.lastIndexOf("<script>") + "<script>".length,
  html.lastIndexOf("</script>"),
);

interface BridgeCall {
  plugin: string;
  name: string;
}

function loadShell(opts: { capacitor?: "none" | "bridge-only" | "plugins" } = {}) {
  const store = new Map<string, string>();
  const noop = () => undefined;
  const listeners: BridgeCall[] = [];
  const nativeCalls: BridgeCall[] = [];
  const stubEl = () => {
    const attrs = new Map<string, string>();
    return {
      style: { setProperty: noop, width: "", height: "" },
      attrs,
      addEventListener: noop,
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
      getAttribute: (k: string) => attrs.get(k) ?? null,
      focus: noop,
      appendChild: noop,
      childElementCount: 0,
      textContent: "",
      value: "",
      disabled: false,
      onclick: null,
    };
  };
  // getElementById must be stable — syncViewport sets a style and an attribute
  // on #app and the assertions need to see the same object back.
  type StubEl = ReturnType<typeof stubEl>;
  const els = new Map<string, StubEl>();
  const getEl = (id: string) => {
    if (!els.has(id)) els.set(id, stubEl());
    return els.get(id)!;
  };
  // The shipped app has NO @capacitor/core bundle on this page, so
  // `Capacitor.Plugins` is an empty object and only the injected native
  // bridge's low-level entry points exist. "bridge-only" is what the device
  // actually looks like; "plugins" is the (never-seen) registered-proxy case.
  const capacitor =
    opts.capacitor === "none"
      ? undefined
      : opts.capacitor === "plugins"
        ? {
            Plugins: {
              App: {
                addListener: (name: string) => {
                  listeners.push({ plugin: "App", name });
                },
                getLaunchUrl: () => Promise.resolve({ url: "" }),
              },
            },
          }
        : {
            Plugins: {},
            addListener: (plugin: string, name: string) => {
              listeners.push({ plugin, name });
              return { remove: noop };
            },
            nativePromise: (plugin: string, name: string) => {
              nativeCalls.push({ plugin, name });
              return Promise.resolve({});
            },
          };
  const win: Record<string, unknown> = {
    Capacitor: capacitor,
    addEventListener: noop,
    removeEventListener: noop,
    requestAnimationFrame: noop,
    innerHeight: 812,
    scrollTo: noop,
    location: { search: "", href: "https://localhost/", replace: noop },
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    document: {
      querySelectorAll: () => [],
      getElementById: getEl,
      createElement: stubEl,
      addEventListener: noop,
    },
    URL,
    URLSearchParams,
  };
  // eslint-disable-next-line no-new-func
  new Function(
    "window",
    "document",
    "localStorage",
    "location",
    "URL",
    "URLSearchParams",
    script,
  )(win, win.document, win.localStorage, win.location, URL, URLSearchParams);
  return {
    C: (win as { CueShell: Record<string, (s?: unknown) => unknown> }).CueShell,
    listeners,
    nativeCalls,
    win,
    getEl,
  };
}

describe("mobile connect shell — pure logic", () => {
  const { C } = loadShell();

  test("accepts valid emails, rejects junk", () => {
    expect(C.isEmail("you@example.com")).toBe(true);
    expect(C.isEmail("a@example.com")).toBe(true);
    expect(C.isEmail("not-an-email")).toBe(false);
    expect(C.isEmail("missing@domain")).toBe(false);
    expect(C.isEmail("")).toBe(false);
  });

  test("parses the Cue subdomain from any shape the owner types", () => {
    expect(C.parseCueSubdomain("cue-you")).toBe("cue-you");
    expect(C.parseCueSubdomain("cue-you.justcue.app")).toBe("cue-you");
    expect(C.parseCueSubdomain("https://cue-you.justcue.app/assistant/")).toBe(
      "cue-you",
    );
    expect(C.parseCueSubdomain("  cue-you  ")).toBe("cue-you");
    expect(C.parseCueSubdomain("")).toBeNull();
    expect(C.parseCueSubdomain("   ")).toBeNull();
  });

  test("a whole sign-in link pasted into the address field yields host AND token", () => {
    // App Review rejected 1.0 under 2.1(a): the reviewer typed the demo email,
    // landed on "open your mail", and had no mailbox. The address field is the
    // one way in that needs no mail — but only if it keeps the token. These two
    // helpers are exactly what the submit handler feeds to connectToInstance.
    const link =
      "https://cue-app-review-1d647c14.justcue.app/assistant/?cueToken=a.b.c";
    expect(C.parseCueSubdomain(link)).toBe("cue-app-review-1d647c14");
    expect(C.tokenFromUrl(link)).toBe("a.b.c");

    // A bare address still resolves, and still carries no token — the instance
    // then runs its own sign-in, which is the pre-existing behaviour.
    expect(C.parseCueSubdomain("cue-you")).toBe("cue-you");
    expect(C.tokenFromUrl("cue-you")).toBeNull();
  });

  test("strips the one-time token before remembering the instance", () => {
    expect(
      C.withoutToken(
        "https://cue-you.justcue.app/assistant/?cueToken=a.b.c&cueExp=9",
      ),
    ).toBe("https://cue-you.justcue.app/assistant/");
  });
});

describe("mobile connect shell — the magic link reaches the app", () => {
  test("reads the token out of every URL shape the app can be opened with", () => {
    const { C } = loadShell();
    // Universal link.
    expect(C.tokenFromUrl("https://justcue.ai/auth?token=abc123")).toBe(
      "abc123",
    );
    // Custom scheme — the hand-off HQ serves to iOS browsers.
    expect(C.tokenFromUrl("vellum-assistant://auth?token=abc123")).toBe(
      "abc123",
    );
    // Scheme with no host at all, and extra params either side.
    expect(
      C.tokenFromUrl("vellum-assistant://?x=1&token=abc123&y=2"),
    ).toBe("abc123");
    expect(C.tokenFromUrl("https://cue.example/?cueToken=jwt.value")).toBe(
      "jwt.value",
    );
    expect(C.tokenFromUrl("https://justcue.ai/auth")).toBeNull();
    expect(C.tokenFromUrl("")).toBeNull();
  });

  // The regression that made the sign-in link open the app and then sit
  // there: the shell reached for `Capacitor.Plugins.App`, which is only
  // populated by @capacitor/core's registerPlugin() — and this page loads no
  // bundle, so it was always empty. No listener, no resolve, no sign-in.
  test("registers appUrlOpen through the low-level bridge when Plugins is empty", () => {
    const { listeners } = loadShell({ capacitor: "bridge-only" });
    expect(listeners).toContainEqual({ plugin: "App", name: "appUrlOpen" });
  });

  test("still uses a registered plugin proxy when one exists", () => {
    const { listeners } = loadShell({ capacitor: "plugins" });
    expect(listeners).toContainEqual({ plugin: "App", name: "appUrlOpen" });
  });

  test("asks the bridge for the launch URL on a cold start from the link", () => {
    const { nativeCalls } = loadShell({ capacitor: "bridge-only" });
    expect(nativeCalls).toContainEqual({ plugin: "App", name: "getLaunchUrl" });
  });

  test("degrades quietly with no native bridge at all (plain browser QA)", () => {
    const { C, listeners } = loadShell({ capacitor: "none" });
    expect(listeners).toHaveLength(0);
    expect(C.nativePlugin("App")).toBeNull();
  });
});

// The sign-in card scrolled off the top of the screen the moment the keyboard
// opened: no @capacitor/keyboard here, so WKWebView does not resize the web
// view — it scrolls its own native scroll view to reveal the caret, and
// `overflow:hidden` cannot stop it. Sizing #app to the visual viewport is what
// keeps the field the user is typing into on screen.
describe("mobile connect shell — the keyboard does not eat the form", () => {
  test("sizes the app to the visible viewport and arms the scroller", () => {
    const { C, win, getEl } = loadShell();
    (win as Record<string, unknown>).innerHeight = 812;
    (win as Record<string, unknown>).visualViewport = { height: 420 };

    C.syncViewport();

    const app = getEl("app");
    expect(app.style.height).toBe("420px");
    expect(app.getAttribute("data-kb")).toBe("");
  });

  test("releases the scroller when the keyboard closes again", () => {
    const { C, win, getEl } = loadShell();
    (win as Record<string, unknown>).innerHeight = 812;
    (win as Record<string, unknown>).visualViewport = { height: 420 };
    C.syncViewport();
    (win as Record<string, unknown>).visualViewport = { height: 812 };
    C.syncViewport();

    const app = getEl("app");
    expect(app.style.height).toBe("812px");
    expect(app.getAttribute("data-kb")).toBeNull();
  });

  test("a small inset (not the keyboard) does not arm the scroller", () => {
    const { C, win, getEl } = loadShell();
    (win as Record<string, unknown>).innerHeight = 812;
    (win as Record<string, unknown>).visualViewport = { height: 780 };
    C.syncViewport();
    expect(getEl("app").getAttribute("data-kb")).toBeNull();
  });
});
