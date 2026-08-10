/**
 * The `external_app` ui_show surface is gated on the `ventureverse-apps`
 * feature flag and requires a slug.
 *
 * The surface navigates the client to `/assistant/apps/<slug>`, an Apps
 * destination that only exists when the feature is on — so emitting one while
 * the flag is off (a stale skill, a cached prompt) must fail loudly rather than
 * drop a card that opens nothing. And a slug-less card is a dead button, so the
 * resolver rejects it before it can render.
 */
import { describe, expect, mock, test } from "bun:test";

const actualLogger = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...actualLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let flagOn = true;
const actualFlags = await import("../../config/assistant-feature-flags.js");
mock.module("../../config/assistant-feature-flags.js", () => ({
  ...actualFlags,
  isAssistantFeatureFlagEnabled: (key: string) =>
    key === "ventureverse-apps" ? flagOn : false,
}));

const actualLoader = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...actualLoader,
  getConfig: () => ({}),
}));

const { surfaceProxyResolver } = await import("../conversation-surfaces.js");

/** Minimal resolver context — only the fields the ui_show branch reads. */
function makeCtx() {
  const sent: unknown[] = [];
  return {
    sent,
    ctx: {
      conversationId: "c1",
      sendToClient: (m: unknown) => sent.push(m),
      surfaceState: new Map(),
      pendingSurfaceActions: new Map(),
      currentTurnSurfaces: [] as unknown[],
      channelCapabilities: undefined,
    },
  };
}

async function emitExternalApp(data: Record<string, unknown>): Promise<{
  result: { isError?: boolean; content?: string };
  sent: unknown[];
}> {
  const { ctx, sent } = makeCtx();
  const result = (await surfaceProxyResolver(
    ctx as never,
    "ui_show",
    { surface_type: "external_app", data },
    undefined,
    "tool-1",
  )) as { isError?: boolean; content?: string };
  return { result, sent };
}

describe("external_app surface guard", () => {
  test("emits the surface when the flag is on and a slug is present", async () => {
    flagOn = true;
    const { result, sent } = await emitExternalApp({
      slug: "10-alchemy",
      name: "Alchemy",
    });
    expect(result.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "ui_surface_show",
      surfaceType: "external_app",
      data: { slug: "10-alchemy" },
    });
  });

  test("rejects and sends nothing when the flag is off", async () => {
    flagOn = false;
    const { result, sent } = await emitExternalApp({
      slug: "10-alchemy",
      name: "Alchemy",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ventureverse-apps");
    expect(sent).toHaveLength(0);
  });

  test("rejects a slug-less card even when the flag is on", async () => {
    flagOn = true;
    const { result, sent } = await emitExternalApp({ name: "Alchemy" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("slug");
    expect(sent).toHaveLength(0);
  });
});
