import { beforeEach, describe, expect, mock, test } from "bun:test";

type PermissionCheckHandler = NonNullable<
  Parameters<Electron.Session["setPermissionCheckHandler"]>[0]
>;
type PermissionRequestHandler = NonNullable<
  Parameters<Electron.Session["setPermissionRequestHandler"]>[0]
>;

let permissionCheckHandler: PermissionCheckHandler | null = null;
let permissionRequestHandler: PermissionRequestHandler | null = null;

const setPermissionCheckHandlerMock = mock(
  (handler: typeof permissionCheckHandler) => {
    permissionCheckHandler = handler;
  },
);
const setPermissionRequestHandlerMock = mock(
  (handler: typeof permissionRequestHandler) => {
    permissionRequestHandler = handler;
  },
);

// These assertions pin the renderer origin to the legacy `app://vellum.ai`
// scheme, so disable the self-host cloud default (which would otherwise make
// `resolveAllowedOrigin()` return the Render https origin).
process.env.CUE_SERVER_URL = "";

mock.module("electron", () => ({
  app: { isPackaged: true },
  session: {
    defaultSession: {
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
    },
  },
}));

const {
  denyAllPermissions,
  installPermissionHandler,
  shouldGrantPermissionCheck,
  shouldGrantPermissionRequest,
} = await import("./permissions");

beforeEach(() => {
  permissionCheckHandler = null;
  permissionRequestHandler = null;
  setPermissionCheckHandlerMock.mockClear();
  setPermissionRequestHandlerMock.mockClear();
});

describe("permission policy", () => {
  test("allows audio-only media requests from the app renderer", () => {
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["audio"],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(true);
  });

  test("allows video media requests from the app renderer (voice-room camera)", () => {
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["video"],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(true);
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["audio", "video"],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(true);
  });

  test("denies non-capture media types even from the app renderer", () => {
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: [],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(false);
  });

  test("denies audio and video requests from untrusted origins", () => {
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["audio"],
        securityOrigin: "https://example.com",
      }),
    ).toBe(false);
    expect(
      shouldGrantPermissionRequest("media", {
        mediaTypes: ["video"],
        securityOrigin: "https://example.com",
      }),
    ).toBe(false);
  });

  test("denies non-media permissions", () => {
    expect(
      shouldGrantPermissionRequest("notifications", {
        mediaTypes: ["audio"],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(false);
  });

  test("allows clipboard-sanitized-write from the app renderer", () => {
    expect(
      shouldGrantPermissionRequest("clipboard-sanitized-write", {
        mediaTypes: [],
        securityOrigin: "app://vellum.ai",
      }),
    ).toBe(true);
  });

  test("denies clipboard-sanitized-write from untrusted origins", () => {
    expect(
      shouldGrantPermissionRequest("clipboard-sanitized-write", {
        mediaTypes: [],
        securityOrigin: "https://example.com",
      }),
    ).toBe(false);
  });

  test("allows matching audio permission checks", () => {
    expect(
      shouldGrantPermissionCheck("media", "app://vellum.ai", {
        mediaType: "audio",
      }),
    ).toBe(true);
  });

  test("allows matching video permission checks (must agree with the request handler)", () => {
    expect(
      shouldGrantPermissionCheck("media", "app://vellum.ai", {
        mediaType: "video",
      }),
    ).toBe(true);
  });

  test("denies video permission checks from untrusted origins", () => {
    expect(
      shouldGrantPermissionCheck("media", "https://example.com", {
        mediaType: "video",
      }),
    ).toBe(false);
  });

  test("allows clipboard-sanitized-write checks from the app renderer", () => {
    expect(
      shouldGrantPermissionCheck("clipboard-sanitized-write", "app://vellum.ai", {}),
    ).toBe(true);
  });

  test("denies clipboard-sanitized-write checks from untrusted origins", () => {
    expect(
      shouldGrantPermissionCheck("clipboard-sanitized-write", "https://example.com", {}),
    ).toBe(false);
  });

  test("installs check and request handlers on the default session", () => {
    installPermissionHandler();

    expect(setPermissionCheckHandlerMock).toHaveBeenCalledTimes(1);
    expect(setPermissionRequestHandlerMock).toHaveBeenCalledTimes(1);
    expect(permissionCheckHandler).toBeTruthy();
    expect(permissionRequestHandler).toBeTruthy();
  });

  test("installed request handler grants renderer audio requests", () => {
    installPermissionHandler();

    const handler = permissionRequestHandler;
    if (!handler) throw new Error("expected permission request handler");

    let granted = false;
    handler(
      { getURL: () => "app://vellum.ai/assistant" } as Electron.WebContents,
      "media",
      (value) => {
        granted = value;
      },
      { mediaTypes: ["audio"] } as Electron.MediaAccessPermissionRequest,
    );

    expect(granted).toBe(true);
  });
});

describe("denyAllPermissions", () => {
  test("installs blanket deny handlers on the target session", () => {
    let requestHandler: ((...args: unknown[]) => void) | null = null;
    let checkHandler: ((...args: unknown[]) => boolean) | null = null;

    const targetSession = {
      setPermissionRequestHandler: mock((h: typeof requestHandler) => {
        requestHandler = h;
      }),
      setPermissionCheckHandler: mock((h: typeof checkHandler) => {
        checkHandler = h;
      }),
    };

    denyAllPermissions(targetSession as never);

    expect(targetSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(targetSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);

    let granted = true;
    requestHandler!({}, "media", (allowed: boolean) => { granted = allowed; });
    expect(granted).toBe(false);

    expect(checkHandler!({}, "clipboard-read", "vellumapp://bundle")).toBe(false);
  });
});
