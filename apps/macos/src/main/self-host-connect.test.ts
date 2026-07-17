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

const { normalizeInstanceUrl } = await import("./self-host-connect");

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
