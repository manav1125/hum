/**
 * UI surface tool definitions.
 *
 * These tools allow the model to show, update, and dismiss just-in-time UI
 * surfaces (cards, forms, lists, confirmations) on a connected macOS client.
 * They are proxy tools -- execution is forwarded to the client and never
 * handled locally by the daemon.
 */

import { RiskLevel } from "../../permissions/types.js";
import { ACTIVATION_MOMENT_PARAMS } from "../../telemetry/activation-funnel.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_BUILDER_ARTIFACT_RE =
  /\b(app|apps|application|applications|website|websites|site|sites|dashboard|dashboards|game|games|calculator|calculators|tracker|trackers|visualization|visualizations|visualisation|visualisations|visualize|visualise|artifact|artifacts|chart|charts|graph|graphs|tool|tools|utility|utilities|counter|counters)\b/i;
const APP_BUILDER_BUILD_RE =
  /\b(build|building|built|create|creating|created|make|making|made|generate|generating|generated)\b/i;

/**
 * Forward execution to the connected macOS client via the request-bound
 * `proxyToolResolver`. Returns a structured error when no resolver is
 * configured (e.g. no client connected) so callers see a normal tool
 * failure rather than an unhandled throw.
 */
function proxyExecute(toolName: string) {
  return async (
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> => {
    if (toolName === "ui_show" && isDynamicPageAppSubstitute(input)) {
      return {
        content:
          'Error: ui_show dynamic_page is for transient UI surfaces only. This request is building an app-like experience, so load the app-builder skill first with `skill_load` using `skill: "app-builder"`, then create a persistent Library app with the app-builder workflow.',
        isError: true,
      };
    }

    if (!context.proxyToolResolver) {
      return {
        content: `No proxy resolver configured for proxy tool "${toolName}". This tool requires an external resolver (e.g. a connected macOS client).`,
        isError: true,
      };
    }
    return context.proxyToolResolver(toolName, input);
  };
}

function isDynamicPageAppSubstitute(input: Record<string, unknown>): boolean {
  if (input.surface_type !== "dynamic_page") {
    return false;
  }

  const text = collectRoutingText(input).join(" ");
  if (
    APP_BUILDER_ARTIFACT_RE.test(text) &&
    (APP_BUILDER_BUILD_RE.test(text) || /\b(app|application)\b/i.test(text))
  ) {
    return true;
  }

  // Second signal: even when the model gives the surface a clean,
  // non-app-sounding title (dodging the text regex above), substantial
  // interactive HTML is an app being smuggled in as a transient surface.
  // A genuinely transient page is small and static; an app has real
  // scripted markup. Keep the bar high so simple snippets still pass.
  return isSubstantialInteractiveHtml(input);
}

const INTERACTIVE_HTML_RE =
  /<script\b|on[a-z]+\s*=|addEventListener|new Chart\b|window\.vellum\b/i;

function isSubstantialInteractiveHtml(input: Record<string, unknown>): boolean {
  const data = asRecord(input.data);
  const html = data?.html;
  if (typeof html !== "string") {
    return false;
  }
  return html.length > 2000 && INTERACTIVE_HTML_RE.test(html);
}

function collectRoutingText(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  addString(values, input.title);
  addString(values, input.activity);

  const data = asRecord(input.data);
  if (data) {
    const preview = asRecord(data.preview);
    if (preview) {
      addString(values, preview.title);
      addString(values, preview.subtitle);
      addString(values, preview.description);
    }
  }

  return values;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function addString(values: string[], value: unknown): void {
  if (typeof value === "string") {
    values.push(value);
  }
}

// ---------------------------------------------------------------------------
// ui_show
// ---------------------------------------------------------------------------

export const uiShowTool = {
  name: "ui_show",
  description:
    'Surface structured data or UI in the conversation. For long-form writing use the document skill. For interactive apps, dashboards, games, calculators, or durable tools, call `skill_load` with `skill: "app-builder"` and use the app-builder workflow; do not use `dynamic_page` as a substitute for a persistent app. App-like `dynamic_page` calls are rejected.\n\n' +
    "Surface types (data shapes):\n" +
    '- card: { title, subtitle?, body, metadata?: [{ label, value }], template?, templateData? }. Templates: "weather_forecast" (native weather widget), "task_progress" (live step tracker - update via ui_update on data.templateData; shape: { title, status: "in_progress"|"completed"|"failed", steps: [{ label, status: "pending"|"in_progress"|"completed"|"failed", detail? }] })\n' +
    "- copy_block: { text, label?, language? }. Shows copyable text with a visible copy button; use for prompts, commands, paths, or snippets the user should copy.\n" +
    '- choice: { description?, options: [{ id, title, description?, recommended?, data? }], selectionMode?: "single"|"multiple", commitOnSelect?, submitLabel? }. Single-select choices commit on option click by default. Use for outcome offers and follow-up choices; mark the strongest option with recommended: true.\n' +
    "- oauth_connect: { providerKey, displayName?, description?, logoUrl? }. Shows a managed OAuth connection CTA in chat; use when the current task needs a managed integration account (Google, Linear, GitHub, etc.) instead of asking the user to visit settings or attempting OAuth through shell/tools. The client supplies the CTA label. Do not include OAuth scopes in the surface; managed providers use the platform's configured scopes.\n" +
    "- connector_recommend: { intro?, connectors: [{ providerKey, displayName?, description?, connected? }] }. A 'connectors that could help' card recommending SEVERAL integrations at once. Use when the user's goal needs data or actions from services they haven't fully connected (e.g. 'set up my marketing systems', 'be my sales assistant', 'analyze my ads') — instead of listing connectors as plain text. Set connected:true for ones already linked (they render a 'Use' button; the rest render 'Connect', running the managed-OAuth flow inline). Prefer this over multiple oauth_connect cards when suggesting a stack; use a single oauth_connect for one specific provider a task needs right now.\n" +
    '- table: { columns: [{ id, label }], rows: [{ id, cells: Record<id, string | { text, icon?, iconColor?: "success"|"warning"|"error"|"muted" }>, selectable?, selected? }], selectionMode?: "none"|"single"|"multiple", caption? }\n' +
    '- form: { description?, fields: [{ id, type: "text"|"textarea"|"select"|"toggle"|"number"|"password", label, placeholder?, required?, defaultValue?, options?: [{ label, value }] }], submitLabel? }. Multi-page: { pages: [{ id, title, description?, fields }], pageLabels?: { next?, back?, submit? }, submitLabel? }\n' +
    '- list: { items: [{ id, title, subtitle?, icon?, selected? }], selectionMode: "single"|"multiple"|"none" }\n' +
    "- confirmation: { message, detail?, confirmLabel?, confirmedLabel?, cancelLabel?, destructive? }\n" +
    "- dynamic_page: { html, width?, height?, preview?: { title, subtitle?, description?, icon?, metrics?: [{ label, value }] } }\n" +
    "- file_upload: { prompt, acceptedTypes?, maxFiles? }\n" +
    "- task_preferences: {} (no data needed — categories are rendered client-side)\n" +
    '- work_result: { eyebrow?, status?: "completed"|"partial"|"failed"|"in_progress", summary?, metrics?: [{ label, value, detail?, tone?: "neutral"|"positive"|"warning"|"negative" }], sections?: [{ id?, title, description?, type?: "items"|"timeline"|"diff"|"artifacts"|"warnings", items?: [{ id?, title, description?, status?, tone?, metadata?: [{ label, value }], href? }], diffs?: [{ label?, before?, after? }] }] }. Shows a structured receipt after real work: what changed, what was skipped, proof points, and next actions. Keep display-only unless explicit follow-up buttons are needed.\n\n' +
    '- artefact: { kind?, title, body?, fields?: [{ label, value }], actions?: [{ id, label, primary? }] }. ANYTHING SENDABLE, SAVABLE OR SCHEDULABLE MUST BE AN ARTEFACT, never prose in your reply — a drafted email, a proposed meeting, a document. Never make someone copy text out of a message. `body` is the artefact\'s own words shown in full; `fields` are the facts about it (To, When, Amount). Each action\'s `label` is the verb ("Send", "Book it"). Consequential verbs are detected from the label and the client marks them as needing your approval, so name the verb plainly rather than softening it.\n\n' +
    '- adjacent_offer: { note, from?: "mail"|"calendar"|"messages"|"documents"|"spreadsheets"|"crm", actions?: [{ id, label }] }. AT MOST ONE per turn, and ONLY about something you actually touched while doing the work you were asked to do. One sentence naming what you noticed and what you would do. Two is nagging; something you did not touch is unsettling. `from` must name the source family you genuinely read — the client DROPS the offer when it names a family the turn never touched. If nothing came up, say nothing: this is the rarest surface you emit.\n\n' +
    "- external_app: { slug, name, category?, description?, iconUrl? }. An OPTIONAL bonus card offering a VentureVerse founder app that ALSO does the current task (e.g. a term sheet -> Alchemy, a pitch deck -> Deck Analysis). Surface it ALONGSIDE your own full answer, never instead of it: do the work in chat first, then — only if the task cleanly maps to an app — add one card (at most one per turn) as a low-key 'try this too'. `slug` and `name` must come from the ventureverse skill catalog, never invented. Load the `ventureverse` skill for the catalog and rules before using this.\n\n" +
    "Emit a task_progress card BEFORE your first tool call on any multi-step, long-running, or post-form turn (web searches, file operations, research), and keep its steps updated as work progresses. Skills that estimate >30s of work should declare progress upfront with concrete step labels (and counts when known).",
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      surface_type: {
        type: "string",
        enum: [
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
          "task_preferences",
          "work_result",
          "artefact",
          "adjacent_offer",
          "external_app",
        ],
        description: "The type of surface to display",
      },
      title: {
        type: "string",
        description: "Optional title for the surface window",
      },
      data: {
        type: "object",
        description:
          "Surface data; structure depends on surface_type (see tool description)",
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique action identifier" },
            label: { type: "string", description: "Button label text" },
            style: {
              type: "string",
              enum: ["primary", "secondary", "destructive"],
              description: "Visual style of the button",
            },
          },
          required: ["id", "label"],
        },
        description: "Optional action buttons to display on the surface",
      },
      display: {
        type: "string",
        enum: ["inline", "panel"],
        description:
          'Where to render the surface. "inline" embeds it in the chat message. "panel" shows a floating window. Defaults to "inline". Prefer inline — only use panel when a separate window is explicitly requested.',
      },
      await_action: {
        type: "boolean",
        description:
          "Whether to block until an action is selected. Defaults to true when actions are provided.",
      },
      persistent: {
        type: "boolean",
        description:
          "When true, clicking an action does not dismiss the surface — the card stays visible and only the clicked action is marked as spent. Use for launcher or menu-style cards where multiple buttons may be clicked. Defaults to false.",
      },
      activation_moment: {
        type: "string",
        enum: ACTIVATION_MOMENT_PARAMS,
        description:
          "Activation-rail telemetry tag (cohort only). Set this when this surface IS one of the activation funnel moments; the milestone is recorded automatically when the user commits the surface. Omit for all non-activation surfaces.",
      },
    },
    required: ["surface_type", "data"],
  },

  execute: proxyExecute("ui_show"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// ui_update
// ---------------------------------------------------------------------------

const uiUpdateTool = {
  name: "ui_update",
  description:
    "Update an existing surface's data. The provided data object is merged into the surface's current data.\n" +
    "For card templates (for example `task_progress`), update nested fields under `data.templateData` rather than sending template fields at the top level.",
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      surface_id: {
        type: "string",
        description: "The ID of the surface to update",
      },
      data: {
        type: "object",
        description: "Partial data to merge into the existing surface data",
      },
    },
    required: ["surface_id", "data"],
  },

  execute: proxyExecute("ui_update"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// ui_dismiss
// ---------------------------------------------------------------------------

const uiDismissTool = {
  name: "ui_dismiss",
  description: "Dismiss a currently displayed surface.",
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      surface_id: {
        type: "string",
        description: "The ID of the surface to dismiss",
      },
    },
    required: ["surface_id"],
  },

  execute: proxyExecute("ui_dismiss"),
} satisfies ToolDefinition;

export const allUiSurfaceTools: ToolDefinition[] = [
  uiShowTool,
  uiUpdateTool,
  uiDismissTool,
];
