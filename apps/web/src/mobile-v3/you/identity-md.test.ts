/**
 * applyIdentityEdits — the IDENTITY.md rewrite behind the mobile Identity
 * leaf. Exercised against the exact prod file shape (placeholder bullets +
 * comment line + Avatar section) and the daemon parser's alias rules.
 */

import { describe, expect, test } from "bun:test";

import { applyIdentityEdits } from "./identity-md";

/** The real prod IDENTITY.md shape (read 2026-07-21 via /workspace/file/content). */
const PROD_TEMPLATE = [
  "_ Lines starting with _ are comments - they won't appear in the system prompt",
  "",
  "# IDENTITY.md",
  "",
  "- **Name:** _(not yet chosen)_",
  "- **Emoji:** _(not yet chosen)_",
  "- **Nature:** _(not yet established)_",
  "- **Personality:** _(not yet established)_",
  "- **Role:** _(not yet established)_",
  "",
  "## Avatar",
  "",
].join("\n");

describe("applyIdentityEdits", () => {
  test("overwrites placeholder values in place", () => {
    const out = applyIdentityEdits(PROD_TEMPLATE, { name: "Cue" });
    expect(out).toContain("- **Name:** Cue");
    expect(out).not.toContain("- **Name:** _(not yet chosen)_");
    // Everything else untouched.
    expect(out).toContain("- **Emoji:** _(not yet chosen)_");
    expect(out).toContain("## Avatar");
    expect(out).toContain("_ Lines starting with _ are comments");
  });

  test("edits several fields at once", () => {
    const out = applyIdentityEdits(PROD_TEMPLATE, {
      name: "Cue",
      role: "Chief of staff",
      personality: "Candid, brief, no fluff",
    });
    expect(out).toContain("- **Name:** Cue");
    expect(out).toContain("- **Role:** Chief of staff");
    expect(out).toContain("- **Personality:** Candid, brief, no fluff");
  });

  test("personality writes to the legacy **Vibe:** alias when present", () => {
    const content = "# IDENTITY.md\n- **Name:** Cue\n- **Vibe:** old vibe\n";
    const out = applyIdentityEdits(content, { personality: "new vibe" });
    expect(out).toContain("- **Vibe:** new vibe");
    // No duplicate Personality bullet appears.
    expect(out).not.toContain("- **Personality:**");
  });

  test("missing field bullets are inserted after the identity block", () => {
    const content = "# IDENTITY.md\n\n- **Name:** Cue\n\n## Avatar\n";
    const out = applyIdentityEdits(content, { role: "Chief of staff" });
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    const nameIdx = lines.indexOf("- **Name:** Cue");
    expect(lines[nameIdx + 1]).toBe("- **Role:** Chief of staff");
    // The Avatar section survives below.
    expect(out).toContain("## Avatar");
  });

  test("returns null when no identity bullet anchor exists", () => {
    expect(applyIdentityEdits("just prose\n", { name: "Cue" })).toBeNull();
  });

  test("newlines in an edit collapse to one line", () => {
    const out = applyIdentityEdits(PROD_TEMPLATE, {
      role: "Chief\nof   staff",
    });
    expect(out).toContain("- **Role:** Chief of staff");
  });

  test("no-op edits return the content unchanged", () => {
    expect(applyIdentityEdits(PROD_TEMPLATE, {})).toBe(PROD_TEMPLATE);
  });

  test("matches case-insensitively (daemon parser parity)", () => {
    const content = "- **NAME:** Old\n";
    const out = applyIdentityEdits(content, { name: "New" });
    expect(out).toContain("- **NAME:** New");
  });
});
