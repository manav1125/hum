import { afterEach, describe, expect, test } from "bun:test";

import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import { applyRuntimeInjections } from "../daemon/conversation-runtime-assembly.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import { createApp } from "../memory/app-store.js";
import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Fixture messages
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

// `applyRuntimeInjections` synthesizes this conversation id when no
// `turnContext` is supplied, so the `workspace-context` injector resolves the
// live workspace block from the registry under this key.
const FALLBACK_CONVERSATION_ID = "runtime-assembly-fallback";

// Register the fallback conversation in the live registry so the runtime
// injectors resolve their blocks from it (the orchestrator no longer threads
// workspace or active-surface content as options).
function registerFallbackConversation(fields: Record<string, unknown>): void {
  setConversation(FALLBACK_CONVERSATION_ID, {
    conversationId: FALLBACK_CONVERSATION_ID,
    workingDir: "/sandbox",
    // Non-dirty empty workspace by default so the workspace-context injector
    // skips both the filesystem rescan and the DB refresh unless a test
    // explicitly seeds a block via `workspaceTopLevelContext`.
    workspaceTopLevelContext: "",
    workspaceTopLevelDirty: false,
    ...fields,
  } as never);
}

// Seed the live conversation registry with a pre-rendered top-level block. The
// cache is non-dirty with non-null content, so `resolveWorkspaceTopLevelContext`
// returns it verbatim without rescanning the filesystem.
function seedWorkspaceContext(text: string): void {
  registerFallbackConversation({
    workspaceTopLevelContext: text,
    workspaceTopLevelDirty: false,
  });
}

// Build the conversation surface-state map that `buildActiveSurfaceContext`
// reads to render the `<active_workspace>` block.
function makeSurfaceState(
  surfaceId: string,
  data: SurfaceData,
): Map<string, { surfaceType: SurfaceType; data: SurfaceData }> {
  return new Map([[surfaceId, { surfaceType: "dynamic_page", data }]]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sampleContext =
  "<workspace>\nRoot: /sandbox\nDirectories: src, lib, tests\n</workspace>";

// The workspace-context default injector emits the workspace block as an
// EPHEMERAL `append-user-tail` placement during `applyRuntimeInjections`:
// each full-mode assembly strips any previous `<workspace>` copy from history
// and appends one fresh block to the current user tail, so the volatile
// directory listing never sits mid-history invalidating the provider's
// prompt-cache prefix. The suite seeds the registry and exercises that
// end-to-end path.

describe("applyRuntimeInjections — workspace top-level context", () => {
  afterEach(() => {
    clearConversations();
  });

  test("injects workspace context when registered", async () => {
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
    expect((result[0].content[1] as { text: string }).text).toBe(sampleContext);
  });

  test("does not inject when no workspace context is registered", async () => {
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
  });

  test("strip-and-replaces a stale workspace block onto the current tail", async () => {
    // GIVEN the registry holds a workspace block AND an EARLIER message
    // already carries an (older) copy of that block.
    seedWorkspaceContext(sampleContext);
    const staleContext =
      "<workspace>\nRoot: /sandbox\nDirectories: old-listing\n</workspace>";
    const messages: Message[] = [userMsg(staleContext), userMsg("Hello")];

    // WHEN injections are applied
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    // THEN the stale historical copy is stripped and exactly one fresh copy
    // rides the current tail — the history prefix carries no volatile bytes.
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
    expect((result[0].content[1] as { text: string }).text).toBe(sampleContext);
  });

  test("workspace context appears after active surface context in content", async () => {
    registerFallbackConversation({
      workspaceTopLevelContext: sampleContext,
      workspaceTopLevelDirty: false,
      currentActiveSurfaceId: "sf_1",
      surfaceState: makeSurfaceState("sf_1", { html: "<div>test</div>" }),
    });
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    // activeSurface prepends; workspace appends.
    // Result: [activeSurface, original, workspace]
    expect(result[0].content).toHaveLength(3);
    expect((result[0].content[0] as { text: string }).text).toContain(
      "<active_workspace>",
    );
    expect((result[0].content[1] as { text: string }).text).toBe("Hello");
    expect((result[0].content[2] as { text: string }).text).toBe(sampleContext);
  });

  test("app-backed active surface tells the model to load app-builder with the right argument", async () => {
    const app = createApp({
      name: "Example App",
      schemaJson: "{}",
      htmlDefinition: "<div>test</div>",
    });
    registerFallbackConversation({
      currentActiveSurfaceId: "sf_1",
      surfaceState: makeSurfaceState("sf_1", {
        html: "<div>test</div>",
        appId: app.id,
      }),
    });
    const messages: Message[] = [userMsg("Edit this app")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    const activeWorkspaceText = (result[0].content[0] as { text: string }).text;
    expect(activeWorkspaceText).toContain('skill: "app-builder"');
    expect(activeWorkspaceText).not.toContain('id: "app-builder"');
  });
});

describe("applyRuntimeInjections — minimal mode skips workspace blocks", () => {
  afterEach(() => {
    clearConversations();
  });

  test("minimal mode skips workspace top-level context", async () => {
    seedWorkspaceContext(sampleContext);
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
      mode: "minimal",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
  });

  test("minimal mode skips active surface context", async () => {
    registerFallbackConversation({
      currentActiveSurfaceId: "sf_1",
      surfaceState: makeSurfaceState("sf_1", { html: "<div>test</div>" }),
    });
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
      mode: "minimal",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
  });

  test("full mode (default) still includes workspace blocks", async () => {
    registerFallbackConversation({
      workspaceTopLevelContext: sampleContext,
      workspaceTopLevelDirty: false,
      currentActiveSurfaceId: "sf_1",
      surfaceState: makeSurfaceState("sf_1", { html: "<div>test</div>" }),
    });
    const messages: Message[] = [userMsg("Hello")];
    const { messages: result } = await applyRuntimeInjections(messages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    expect(result[0].content).toHaveLength(3);
    expect((result[0].content[0] as { text: string }).text).toContain(
      "<active_workspace>",
    );
    expect((result[0].content[2] as { text: string }).text).toBe(sampleContext);
  });
});
