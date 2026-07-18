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

function loadShell() {
  const store = new Map<string, string>();
  const noop = () => undefined;
  const stubEl = () => ({
    style: { setProperty: noop, width: "" },
    addEventListener: noop,
    setAttribute: noop,
    removeAttribute: noop,
    getAttribute: () => null,
    focus: noop,
    appendChild: noop,
    childElementCount: 0,
    textContent: "",
    value: "",
    disabled: false,
    onclick: null,
  });
  const win: Record<string, unknown> = {
    location: { search: "", href: "https://localhost/", replace: noop },
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    document: {
      querySelectorAll: () => [],
      getElementById: stubEl,
      createElement: stubEl,
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
  return (win as { CueShell: Record<string, (s: string) => unknown> }).CueShell;
}

describe("mobile connect shell — pure logic", () => {
  const C = loadShell();

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

  test("strips the one-time token before remembering the instance", () => {
    expect(
      C.withoutToken(
        "https://cue-you.justcue.app/assistant/?cueToken=a.b.c&cueExp=9",
      ),
    ).toBe("https://cue-you.justcue.app/assistant/");
  });
});
