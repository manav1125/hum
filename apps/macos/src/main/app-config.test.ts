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
