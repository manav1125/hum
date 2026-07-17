import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The connect shell is a single self-contained HTML file (it ships as `webDir`,
// no build step), so its logic can't be imported. Load the file, pull the
// `<script>` out, and eval it against a minimal window so the exact shipped
// functions are what's under test — not a copy that can drift.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const script = html.slice(
  html.indexOf("<script>") + "<script>".length,
  html.lastIndexOf("</script>"),
);

function loadShell() {
  const store = new Map<string, string>();
  const win: Record<string, unknown> = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    location: { replace: () => undefined },
    // The shell calls boot() at the end, which touches document; stub the two
    // reads it makes before it would branch into DOM work, and make the saved
    // path short-circuit so it never reaches getElementById.
    document: {
      getElementById: () => ({
        style: {},
        addEventListener: () => undefined,
        focus: () => undefined,
        textContent: "",
        value: "",
      }),
    },
    URL,
  };
  // Preseed a saved instance so boot()'s `location.replace(saved); return;`
  // path runs and never touches the form DOM.
  store.set("cue:instanceUrl", "https://preseeded.justcue.app/assistant/");
  // eslint-disable-next-line no-new-func
  new Function("window", "localStorage", "document", "URL", `${script}`)(
    win,
    win.localStorage,
    win.document,
    URL,
  );
  return (win as { CueConnect: Record<string, (s: string) => unknown> })
    .CueConnect;
}

describe("mobile connect shell", () => {
  const C = loadShell();

  test("keeps the token on the emailed connect link", () => {
    expect(
      C.normalizeInstanceUrl(
        "https://cue-ada-1234.justcue.app/assistant/?cueToken=a.b.c",
      ),
    ).toBe("https://cue-ada-1234.justcue.app/assistant/?cueToken=a.b.c");
  });

  test("assumes https and mounts /assistant/ on a bare address", () => {
    expect(C.normalizeInstanceUrl("cue-you.justcue.app")).toBe(
      "https://cue-you.justcue.app/assistant/",
    );
  });

  test("adds the trailing slash the SPA root needs", () => {
    expect(
      C.normalizeInstanceUrl("https://cue-you.justcue.app/assistant"),
    ).toBe("https://cue-you.justcue.app/assistant/");
  });

  test("accepts a custom domain", () => {
    expect(C.normalizeInstanceUrl("https://cue.example.com")).toBe(
      "https://cue.example.com/assistant/",
    );
  });

  test("rejects what isn't a usable instance", () => {
    expect(C.normalizeInstanceUrl("http://cue-you.justcue.app")).toBeNull();
    expect(C.normalizeInstanceUrl("not a url")).toBeNull();
    expect(C.normalizeInstanceUrl("https://localhost")).toBeNull();
    expect(C.normalizeInstanceUrl("   ")).toBeNull();
  });

  test("strips the one-time token before remembering the instance", () => {
    expect(
      C.withoutToken(
        "https://cue-ada-1234.justcue.app/assistant/?cueToken=a.b.c&cueExp=9",
      ),
    ).toBe("https://cue-ada-1234.justcue.app/assistant/");
  });
});
