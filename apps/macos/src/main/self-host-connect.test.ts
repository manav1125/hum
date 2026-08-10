import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  ipcMain: { handle: mock(() => undefined), on: mock(() => undefined) },
  app: { isPackaged: true },
}));
mock.module("./logger", () => ({
  default: { info: mock(() => undefined), warn: mock(() => undefined) },
}));
mock.module("./settings", () => ({
  readSetting: () => null,
  writeSetting: () => undefined,
}));
mock.module("./main-window", () => ({ current: () => null }));

const { normalizeInstanceUrl, redactUrls } =
  await import("./self-host-connect");

describe("normalizeInstanceUrl", () => {
  test("keeps the token on HQ's emailed connect link", () => {
    // This is the link the owner is actually handed. Dropping `?cueToken=`
    // would land them on their own instance's Connect screen — connected, but
    // still signed out.
    expect(
      normalizeInstanceUrl(
        "https://cue-ada-1234.justcue.app/assistant/?cueToken=abc.def.ghi",
      ),
    ).toBe("https://cue-ada-1234.justcue.app/assistant/?cueToken=abc.def.ghi");
  });

  test("mounts the SPA root when given a bare origin", () => {
    expect(normalizeInstanceUrl("https://cue-ada-1234.justcue.app")).toBe(
      "https://cue-ada-1234.justcue.app/assistant/",
    );
  });

  test("adds the trailing slash the SPA root needs", () => {
    // Without it the host serves its `/assistant/*` NotFound route.
    expect(
      normalizeInstanceUrl("https://cue-ada-1234.justcue.app/assistant"),
    ).toBe("https://cue-ada-1234.justcue.app/assistant/");
  });

  test("accepts a custom domain", () => {
    expect(normalizeInstanceUrl("https://cue.example.com")).toBe(
      "https://cue.example.com/assistant/",
    );
  });

  test("rejects http — the token rides in this URL", () => {
    expect(normalizeInstanceUrl("http://cue-ada-1234.justcue.app")).toBeNull();
  });

  test("rejects junk rather than connecting to nothing", () => {
    expect(normalizeInstanceUrl("")).toBeNull();
    expect(normalizeInstanceUrl("   ")).toBeNull();
    expect(normalizeInstanceUrl("not a url")).toBeNull();
    expect(normalizeInstanceUrl("https://localhost")).toBeNull();
    expect(normalizeInstanceUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("the sign-in handoff", () => {
  // REGRESSION: clicking the sign-in link left the desktop app white and never
  // signed in. The token WAS arriving — connectToInstance ran — but it called
  // loadURL unconditionally, and the handoff arrives more than once (macOS can
  // redeliver `open-url`; the web page re-opens the link while it waits). Each
  // call started a navigation that cancelled the one before it, so every load
  // died with ERR_ABORTED (-3) and nothing ever finished.

  test("a load error never carries the token to the log", () => {
    // The live log contained a months-valid actor JWT because Electron's load
    // error embeds the URL it was loading. The failure code is the whole
    // diagnostic value; the credential is not.
    const raw =
      "Error: ERR_ABORTED (-3) loading 'https://example.com/assistant/?cueToken=eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIGNATURE'";
    const safe = redactUrls(raw);
    expect(safe).not.toContain("cueToken");
    expect(safe).not.toContain("PAYLOAD");
    expect(safe).toContain("ERR_ABORTED");
    expect(safe).toContain("https://example.com/assistant/");
  });

  test("redaction leaves token-free text alone", () => {
    expect(redactUrls("plain message")).toBe("plain message");
    expect(redactUrls("see https://example.com/assistant/")).toBe(
      "see https://example.com/assistant/",
    );
  });

  test("every url in a message is redacted, not just the first", () => {
    const two =
      "from https://example.com/a?cueToken=AAA to https://example.org/b?cueToken=BBB";
    const safe = redactUrls(two);
    expect(safe).not.toContain("AAA");
    expect(safe).not.toContain("BBB");
  });
});
