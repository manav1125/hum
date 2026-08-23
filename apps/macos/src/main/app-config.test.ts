import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getRendererBaseProd,
  getRendererRootUrl,
  resolveSelfHostUrl,
  setPersistedSelfHostUrlReader,
} from "./app-config";

const ORIGINAL_DEV_URL = process.env.VELLUM_DEV_URL;
const ORIGINAL_CUE_SERVER_URL = process.env.CUE_SERVER_URL;

beforeEach(() => {
  delete process.env.VELLUM_DEV_URL;
  // Default to the self-host opt-out so legacy-path assertions hold; the
  // self-host suite sets its own value.
  process.env.CUE_SERVER_URL = "";
});

afterEach(() => {
  // Back to "no instance connected" — the shipped default.
  setPersistedSelfHostUrlReader(() => null);
  if (ORIGINAL_DEV_URL === undefined) {
    delete process.env.VELLUM_DEV_URL;
  } else {
    process.env.VELLUM_DEV_URL = ORIGINAL_DEV_URL;
  }
  if (ORIGINAL_CUE_SERVER_URL === undefined) {
    delete process.env.CUE_SERVER_URL;
  } else {
    process.env.CUE_SERVER_URL = ORIGINAL_CUE_SERVER_URL;
  }
});

describe("resolveSelfHostUrl", () => {
  test("connects to NOTHING until the owner names an instance", () => {
    // The guard that matters: every owner runs their own deployment, so a
    // build must never ship pointing at a real one. It used to default to a
    // personal instance, which sent every other install's owner there.
    delete process.env.CUE_SERVER_URL;
    setPersistedSelfHostUrlReader(() => null);
    expect(resolveSelfHostUrl()).toBeNull();
  });

  test("uses the instance the owner connected to", () => {
    delete process.env.CUE_SERVER_URL;
    setPersistedSelfHostUrlReader(
      () => "https://cue-ada-1234.justcue.app/assistant/",
    );
    expect(resolveSelfHostUrl()?.toString()).toBe(
      "https://cue-ada-1234.justcue.app/assistant/",
    );
  });

  test("CUE_SERVER_URL overrides the connected instance (dev/QA)", () => {
    process.env.CUE_SERVER_URL = "https://cue.example.com/assistant/";
    setPersistedSelfHostUrlReader(
      () => "https://cue-ada-1234.justcue.app/assistant/",
    );
    expect(resolveSelfHostUrl()?.toString()).toBe(
      "https://cue.example.com/assistant/",
    );
  });

  test("returns null (legacy bundle path) when CUE_SERVER_URL is empty", () => {
    process.env.CUE_SERVER_URL = "";
    expect(resolveSelfHostUrl()).toBeNull();
  });

  test("honors an overridden CUE_SERVER_URL", () => {
    process.env.CUE_SERVER_URL = "https://cue.example.com/assistant/";
    expect(resolveSelfHostUrl()?.toString()).toBe(
      "https://cue.example.com/assistant/",
    );
  });
});

describe("getRendererRootUrl", () => {
  test("packaged builds with self-host disabled load the slashless app:// base the handler maps to index.html", () => {
    expect(getRendererRootUrl(true)).toBe(getRendererBaseProd());
    expect(getRendererRootUrl(true)).toBe("app://vellum.ai/assistant");
  });

  test("packaged builds load the connected instance's SPA root with a trailing slash", () => {
    delete process.env.CUE_SERVER_URL;
    setPersistedSelfHostUrlReader(
      () => "https://cue-ada-1234.justcue.app/assistant/",
    );
    expect(getRendererRootUrl(true)).toBe(
      "https://cue-ada-1234.justcue.app/assistant/",
    );
  });

  test("packaged builds load the BUNDLED SPA (the Connect screen) when no instance is connected", () => {
    delete process.env.CUE_SERVER_URL;
    setPersistedSelfHostUrlReader(() => null);
    expect(getRendererRootUrl(true)).toBe("app://vellum.ai/assistant");
  });

  test("getRendererBaseProd gives the connected instance's base without a trailing slash so aux windows can append a subpath", () => {
    delete process.env.CUE_SERVER_URL;
    setPersistedSelfHostUrlReader(
      () => "https://cue-ada-1234.justcue.app/assistant/",
    );
    expect(getRendererBaseProd()).toBe(
      "https://cue-ada-1234.justcue.app/assistant",
    );
  });

  /**
   * The white floating panel, 2026-08-23.
   *
   * A magic-link connect persists the instance URL with its `?cueToken=…`
   * still attached. `selfHostRendererBase` used to hand that whole string to
   * auxiliary windows, which append `/<subpath>` by concatenation — so the
   * route landed inside the query and every one of them loaded the SPA root
   * instead. In the root they sit outside `ActiveAssistantGate`, throw, and
   * paint white.
   */
  describe("REGRESSION: a token in the persisted URL must not swallow the route", () => {
    const WITH_TOKEN = "https://manav.justcue.app/assistant/?cueToken=abc123";

    // The outer beforeEach forces the self-host opt-out; this suite is about
    // the connected path, so it hands control back to the persisted reader.
    beforeEach(() => {
      delete process.env.CUE_SERVER_URL;
    });

    test("the base for auxiliary windows drops the query", () => {
      setPersistedSelfHostUrlReader(() => WITH_TOKEN);
      expect(getRendererBaseProd()).toBe("https://manav.justcue.app/assistant");
    });

    test("appending a floating route resolves to that route, not the root", () => {
      setPersistedSelfHostUrlReader(() => WITH_TOKEN);
      const url = new URL(`${getRendererBaseProd()}/floating/corner`);
      expect(url.pathname).toBe("/assistant/floating/corner");
      expect(url.search).toBe("");
    });

    test("the MAIN window still carries the token — it is the credential", () => {
      setPersistedSelfHostUrlReader(() => WITH_TOKEN);
      expect(getRendererRootUrl(true)).toContain("cueToken=abc123");
    });

    test("an instance pasted as a bare origin still gets the /assistant prefix", () => {
      setPersistedSelfHostUrlReader(() => "https://manav.justcue.app");
      expect(getRendererBaseProd()).toBe("https://manav.justcue.app/assistant");
    });

    test("the prefix is never doubled", () => {
      setPersistedSelfHostUrlReader(() => "https://manav.justcue.app/assistant");
      expect(getRendererBaseProd()).toBe("https://manav.justcue.app/assistant");
    });
  });

  test("dev loads the standalone Vite fallback with a trailing slash to match Vite's base", () => {
    expect(getRendererRootUrl(false)).toBe("http://localhost:5173/assistant/");
  });

  test("dev appends exactly one trailing slash to VELLUM_DEV_URL", () => {
    process.env.VELLUM_DEV_URL = "http://localhost:3000/assistant";
    expect(getRendererRootUrl(false)).toBe("http://localhost:3000/assistant/");
  });

  test("dev collapses a VELLUM_DEV_URL that already carries a trailing slash", () => {
    process.env.VELLUM_DEV_URL = "http://localhost:3000/assistant/";
    expect(getRendererRootUrl(false)).toBe("http://localhost:3000/assistant/");
  });
});
