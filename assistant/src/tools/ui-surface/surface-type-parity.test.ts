/**
 * Every surface the client can render must be one the model can emit.
 *
 * The failure this exists to prevent has already happened once: the conversation
 * surface's `artefact` and `adjacent_offer` cards were built, registered in the
 * client router and fully unit-tested — and rendered nothing, ever, because the
 * `ui_show` tool's enum did not list them so the model had no way to ask for
 * them. Two behaviours shipped inert, and every test on both sides passed.
 *
 * That is the same shape as the browser tools that were named in a prompt but
 * never registered, and the connectors that were callable but undiscoverable. A
 * capability that exists at one end of a contract and not the other is
 * invisible, and invisible is indistinguishable from absent.
 */

import { describe, expect, test } from "bun:test";

import type { SurfaceType } from "../../daemon/message-types/surfaces.js";
import { INTERACTIVE_SURFACE_TYPES } from "../../daemon/message-types/surfaces.js";
import { uiShowTool } from "./definitions.js";

/** The enum the model actually chooses from. */
function emittableTypes(): string[] {
  const schema = uiShowTool.input_schema as {
    properties?: { surface_type?: { enum?: string[] } };
  };
  return schema.properties?.surface_type?.enum ?? [];
}

describe("ui_show surface types", () => {
  test("the two partner surfaces are emittable, not just renderable", () => {
    const types = emittableTypes();
    expect(types).toContain("artefact");
    expect(types).toContain("adjacent_offer");
  });

  test("every emittable type is a known SurfaceType", () => {
    // Catches the mirror-image bug: a type the model can ask for that the
    // daemon has no representation of.
    const known = new Set<string>([
      "card",
      "choice",
      "copy_block",
      "oauth_connect",
      "connector_recommend",
      "form",
      "list",
      "table",
      "confirmation",
      "dynamic_page",
      "file_upload",
      "document_preview",
      "spreadsheet_preview",
      "task_preferences",
      "work_result",
      "artefact",
      "adjacent_offer",
      "external_app",
    ] satisfies (SurfaceType | "connector_recommend")[] as string[]);

    for (const type of emittableTypes()) {
      expect(known.has(type)).toBe(true);
    }
  });

  test("each emittable type is documented in the tool description", () => {
    // An enum entry with no shape documented is a type the model will guess at,
    // and a guessed payload renders as an empty card.
    const description = uiShowTool.description;
    for (const type of emittableTypes()) {
      expect(description).toContain(`- ${type}:`);
    }
  });

  test("neither partner surface parks the turn awaiting the user", () => {
    // The conversation must never block. A draft the owner has not read is not
    // a question being asked of them, and an offer they ignore must not leave
    // the turn hanging. Consequential actions are gated when PRESSED, by the
    // execution layer — never by holding the conversation open.
    expect(INTERACTIVE_SURFACE_TYPES).not.toContain("artefact");
    expect(INTERACTIVE_SURFACE_TYPES).not.toContain("adjacent_offer");
  });

  test("every card template the client renders is documented for the model", () => {
    // Card templates ride inside surface_type "card", so the enum test above
    // cannot catch a template that exists only client-side. The web client's
    // CardSurface dispatches on these template names
    // (apps/web/src/domains/chat/components/surfaces/card-surface.tsx); each
    // one must be named — with a templateData shape — in the tool description,
    // or the model can never emit it and the renderer ships inert.
    const description = uiShowTool.description;
    for (const template of [
      "weather_forecast",
      "task_progress",
      "skill_recommendations",
      "channel_showcase",
    ]) {
      expect(description).toContain(template);
    }
    // Shape docs, not just a name-drop: each new template documents its
    // templateData contract inline.
    expect(description).toContain('card template "skill_recommendations"');
    expect(description).toContain('card template "channel_showcase"');
  });

  test("the recommendation cards are non-blocking by contract", () => {
    // Both cards are display-first: their buttons submit prompts client-side,
    // so the model must not attach actions and park the turn awaiting a click.
    const description = uiShowTool.description;
    const cardTemplateDocs = description
      .split("\n")
      .filter((line) => line.startsWith('- card template "'));
    expect(cardTemplateDocs).toHaveLength(2);
    for (const line of cardTemplateDocs) {
      expect(line).toContain("Non-blocking");
    }
  });

  test("the artefact contract names the approval behaviour, not a soft verb", () => {
    // The client classifies the verb from the label, so a hedged label ("Share
    // this?") silently loses the gate. The description has to tell the model to
    // name the verb plainly.
    const description = uiShowTool.description;
    expect(description).toContain("name the verb plainly");
  });

  test("the adjacent offer is capped and grounded in the description", () => {
    const description = uiShowTool.description;
    expect(description).toContain("AT MOST ONE per turn");
    expect(description.toLowerCase()).toContain("actually touched");
  });
});
