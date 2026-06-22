import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getRendererBaseProd,
  getRendererRootUrl,
  resolveSelfHostUrl,
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
  test("defaults to the pilot Render URL when CUE_SERVER_URL is unset", () => {
    delete process.env.CUE_SERVER_URL;
    expect(resolveSelfHostUrl()?.toString()).toBe(
      "https://cue-app-3yne.onrender.com/assistant/",
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

  test("packaged builds default to the self-host SPA root with a trailing slash", () => {
    delete process.env.CUE_SERVER_URL;
    expect(getRendererRootUrl(true)).toBe(
      "https://cue-app-3yne.onrender.com/assistant/",
    );
  });

  test("getRendererBaseProd defaults to the self-host base without a trailing slash so aux windows can append a subpath", () => {
    delete process.env.CUE_SERVER_URL;
    expect(getRendererBaseProd()).toBe(
      "https://cue-app-3yne.onrender.com/assistant",
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
