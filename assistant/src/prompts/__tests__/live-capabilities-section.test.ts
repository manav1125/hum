/**
 * Tests for the `16-live-capabilities` system-prompt section and the
 * `06-credential-security` refusal it sits alongside.
 *
 * The capability/reach section exists so the conversational agent knows,
 * without probing, what it can do and whose browser/machine it can reach.
 * Before it existed, Cue discovered itself at runtime — `tool_search`, then
 * `assistant --help | grep browser`, then `assistant browser --help` — and
 * still ended up driving the wrong browser.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { ClientRegistryReader } from "../../capabilities/reach-snapshot.js";
import {
  BUNDLED_SYSTEM_SECTIONS,
  renderLiveCapabilities,
} from "../templates/system-sections.js";

type Client = { actorPrincipalId?: string };

function registryOf(entries: {
  extension?: Client[];
  hostBrowser?: Client[];
  hostBash?: Client[];
}): ClientRegistryReader {
  return {
    listClientsByCapability: (capability) =>
      capability === "host_browser"
        ? (entries.hostBrowser ?? [])
        : (entries.hostBash ?? []),
    listClientsByInterface: () => entries.extension ?? [],
  };
}

describe("16-live-capabilities section", () => {
  test("is registered as a dynamic section wired to the renderer", () => {
    const section = BUNDLED_SYSTEM_SECTIONS.find(
      (s) => s.id === "16-live-capabilities",
    );
    expect(section).toBeDefined();
    expect(section!.dynamic).toBe(true);
    expect(typeof section!.transform).toBe("function");
  });

  test("with nothing connected, it says the user's browser is out of reach", () => {
    const body = renderLiveCapabilities({ registry: registryOf({}) })!;
    expect(body).toContain("# What You Can Reach Right Now");
    expect(body).toContain("derived live");
    expect(body).toContain("The user's own browser: NOT reachable");
    expect(body).toContain("throwaway browser inside Cue's own container");
    expect(body).toContain(
      "The user's Mac (shell, files, apps): NOT reachable",
    );
    // The rule the whole section exists to make actionable.
    expect(body).toContain("Never claim reach you do not have");
    expect(body).toContain("do not drive the container browser");
  });

  test("with an extension connected, it says browser tools reach their Chrome", () => {
    const body = renderLiveCapabilities({
      registry: registryOf({
        extension: [{}],
        hostBrowser: [{}],
        hostBash: [{}],
      }),
    })!;
    expect(body).toContain(
      "The user's own Chrome: REACHABLE via the connected Chrome extension",
    );
    expect(body).toContain("The user's Mac (shell, files, apps): REACHABLE");
    expect(body).not.toContain("NOT reachable");
    // When the browser is reachable the snapshot must steer web work to the
    // browser_* tools and away from computer_use screen-control — the whole
    // point of surfacing the connected extension.
    expect(body).toContain("`browser_*` tools");
    expect(body).toContain("Do NOT use `computer_use_*`");
    expect(body).toContain("native desktop apps only");
  });

  // The capability half must come from the SAME derivation the work-item
  // assessor gates its claims on, not a restated belief about the product.
  // Asserted on the source because the alternative (module-mocking the
  // builder) leaks across test files.
  test("shares the capability snapshot rather than duplicating it", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "templates", "system-sections.ts"),
      "utf-8",
    );
    expect(source).toContain(
      'from "../../capabilities/capability-snapshot.js"',
    );
    expect(source).toContain("buildCapabilitySnapshot()");
    // No second copy of the probe table.
    expect(source).not.toContain("CAPABILITY_PROBES");
  });
});

// ── Credential security section ──────────────────────────────────────
//
// Pins the refusal so a future edit cannot quietly reopen the channel that
// produced "Log in with email (I'll provide credentials)" on prod.
describe("06-credential-security section", () => {
  const body = BUNDLED_SYSTEM_SECTIONS.find(
    (s) => s.id === "06-credential-security",
  )!.body;

  test("forbids taking custody of a secret in conversation", () => {
    expect(body).toContain("never take custody");
    expect(body).toContain("not as an option on a question card");
    expect(body).toContain("even when the user explicitly asks you to log in");
  });

  test("forbids OFFERING the channel, not just accepting it", () => {
    expect(body).toContain("Never offer it either");
    expect(body).toContain("Offering the channel is the failure");
  });

  test("names both allowed routes", () => {
    expect(body).toContain("The user signs in themselves");
    expect(body).toContain("credential_store");
    expect(body).toContain('action: "prompt"');
  });

  test("still allows non-secret values conversationally", () => {
    expect(body).toContain("Non-secret values");
    expect(body).toContain("usernames");
  });
});
