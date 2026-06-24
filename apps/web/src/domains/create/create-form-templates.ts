/**
 * Structured-input template catalog for the Create surface.
 *
 * Where `create-templates.ts` holds one-tap "Quick start" prompts that seed a
 * thread directly, this file holds *form* templates: the user fills typed input
 * fields, those values are composed into a rich, skill-targeted prompt by
 * `composePrompt(values)`, and that prompt is seeded into a fresh chat thread
 * via the same `?prompt=` auto-send path (see create-page.tsx +
 * domains/chat/hooks/use-auto-send-effects.ts). The backing skill then actually
 * produces the asset — nothing here is a mock.
 *
 * Inspired by mira-ai's template library: "fill a template with your own
 * inputs → get an output". Each template is mapped to an EXISTING Cue skill
 * (app-builder / document-editor / research) via its parent mode.
 *
 * Skill mapping (verified against create-templates.ts CreateSkill):
 *   - app-builder      → dashboards, trackers, calculators, slide decks
 *   - document-editor  → long-form docs (PRDs, blog posts, one-pagers)
 *   - research         → competitor / market / person briefs (web + browser)
 */

import type { CreateSkill } from "@/domains/create/create-templates";

/** A single typed field rendered in a template's input form. */
export interface InputField {
  /** Stable key — becomes the property on the collected `values` record. */
  key: string;
  /** Human label shown above the control. */
  label: string;
  /** Control type. `tags` collects a comma/enter-separated string list. */
  type: "text" | "textarea" | "select" | "number" | "url" | "tags";
  /** Placeholder / hint text for free-form controls. */
  placeholder?: string;
  /** Options for `select`. */
  options?: string[];
  /** When true, submit is blocked until the field has a value. */
  required?: boolean;
  /** Optional one-line helper under the control. */
  help?: string;
}

/** Collected form values, keyed by `InputField.key`. */
export type TemplateValues = Record<string, string | string[]>;

export interface TemplateDefinition {
  /** Stable id (unique across the whole catalog). */
  id: string;
  /** Parent mode id (matches CreateMode.id in create-templates.ts). */
  mode: string;
  /** Card / form title. */
  title: string;
  /** One-line description of the output. */
  description: string;
  /** Backing Cue skill (mirrors the parent mode's skill). */
  skill: CreateSkill;
  /** Typed input fields rendered as the form. */
  inputs: InputField[];
  /** Composes the filled values into a rich, skill-targeted prompt. */
  composePrompt: (values: TemplateValues) => string;
}

/* ----------------------------------------------------------------------- */
/* Compose helpers                                                          */
/* ----------------------------------------------------------------------- */

/** Reads a scalar field as a trimmed string (empty if missing). */
function str(values: TemplateValues, key: string): string {
  const v = values[key];
  if (Array.isArray(v)) return v.join(", ");
  return (v ?? "").toString().trim();
}

/** Reads a `tags` field as a clean string array. */
function list(values: TemplateValues, key: string): string[] {
  const v = values[key];
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  return (v ?? "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Renders a labelled "- Label: value" line, or "" when the value is empty so
 * optional fields the user skipped don't leave noise in the prompt.
 */
function line(label: string, value: string): string {
  return value ? `- ${label}: ${value}` : "";
}

/** Joins prompt lines, dropping the empties produced by skipped optionals. */
function block(...lines: string[]): string {
  return lines.filter(Boolean).join("\n");
}

/* ----------------------------------------------------------------------- */
/* Catalog                                                                  */
/* ----------------------------------------------------------------------- */

export const TEMPLATE_DEFINITIONS: TemplateDefinition[] = [
  /* ----------------------------- Slides ------------------------------ */
  {
    id: "form-investor-pitch",
    mode: "slides",
    title: "Investor pitch deck",
    description: "A fundraising deck built from your company's specifics.",
    skill: "app-builder",
    inputs: [
      {
        key: "company",
        label: "Company name",
        type: "text",
        placeholder: "Acme Inc.",
        required: true,
      },
      {
        key: "oneLiner",
        label: "One-liner",
        type: "text",
        placeholder: "The Stripe for carbon credits",
        required: true,
      },
      {
        key: "problem",
        label: "Problem",
        type: "textarea",
        placeholder: "What painful, expensive problem do you solve?",
        required: true,
      },
      {
        key: "solution",
        label: "Solution",
        type: "textarea",
        placeholder: "How your product solves it, concretely.",
        required: true,
      },
      {
        key: "market",
        label: "Market",
        type: "textarea",
        placeholder: "TAM/SAM/SOM, who buys, market trends.",
      },
      {
        key: "traction",
        label: "Traction",
        type: "textarea",
        placeholder: "Revenue, users, growth %, notable logos.",
      },
      {
        key: "stage",
        label: "Raise stage",
        type: "select",
        options: ["Pre-seed", "Seed", "Series A", "Series B", "Growth"],
      },
      {
        key: "ask",
        label: "The ask",
        type: "text",
        placeholder: "Raising $3M to reach $5M ARR in 18 months.",
        required: true,
      },
    ],
    composePrompt: (v) =>
      block(
        `Build an investor pitch deck for ${str(v, "company")} as a slide-deck app.`,
        `Positioning one-liner: ${str(v, "oneLiner")}.`,
        "",
        "Use these inputs as the source of truth for the content:",
        line("Problem", str(v, "problem")),
        line("Solution", str(v, "solution")),
        line("Market", str(v, "market")),
        line("Traction", str(v, "traction")),
        line("Raise stage", str(v, "stage")),
        line("The ask", str(v, "ask")),
        "",
        "Produce slides for: title, problem, solution, product, market size, traction, business model, competition, team, and the funding ask. One clear idea per slide, confident modern visual direction with strong typography. Fill any gaps with sensible placeholders I can edit, and make it presentable as-is.",
      ),
  },
  {
    id: "form-qbr",
    mode: "slides",
    title: "Quarterly business review",
    description: "A QBR deck from your quarter's numbers and narrative.",
    skill: "app-builder",
    inputs: [
      {
        key: "team",
        label: "Team / business unit",
        type: "text",
        placeholder: "Revenue Org",
        required: true,
      },
      {
        key: "quarter",
        label: "Quarter",
        type: "text",
        placeholder: "Q2 FY26",
        required: true,
      },
      {
        key: "metrics",
        label: "Key metrics",
        type: "tags",
        placeholder: "ARR, NRR, CAC, pipeline coverage",
        help: "Press Enter or comma to add each metric.",
        required: true,
      },
      {
        key: "wins",
        label: "Wins this quarter",
        type: "textarea",
        placeholder: "Biggest accomplishments.",
      },
      {
        key: "misses",
        label: "What slipped & why",
        type: "textarea",
        placeholder: "Honest account of misses.",
      },
      {
        key: "priorities",
        label: "Next-quarter priorities",
        type: "textarea",
        placeholder: "Top 3-5 focus areas.",
        required: true,
      },
    ],
    composePrompt: (v) =>
      block(
        `Build a quarterly business review slide deck as an app for ${str(v, "team")}, covering ${str(v, "quarter")}.`,
        "",
        "Base the content on these inputs:",
        line("Key metrics to feature", list(v, "metrics").join(", ")),
        line("Wins", str(v, "wins")),
        line("What slipped and why", str(v, "misses")),
        line("Next-quarter priorities", str(v, "priorities")),
        "",
        "Include: executive summary, a KPI scorecard with trend callouts for each metric above, wins, misses with root cause, customer/revenue highlights, risks, and next-quarter priorities. Clean, data-forward design, one headline per slide. Seed realistic placeholder figures where I haven't given numbers.",
      ),
  },
  {
    id: "form-product-launch",
    mode: "slides",
    title: "Product launch deck",
    description: "Positioning, demo flow, and go-to-market in one deck.",
    skill: "app-builder",
    inputs: [
      {
        key: "product",
        label: "Product name",
        type: "text",
        placeholder: "Cue Live",
        required: true,
      },
      {
        key: "audience",
        label: "Target audience",
        type: "text",
        placeholder: "Sales teams at mid-market SaaS",
        required: true,
      },
      {
        key: "valueProp",
        label: "Value proposition",
        type: "textarea",
        placeholder: "The core promise to the customer.",
        required: true,
      },
      {
        key: "features",
        label: "Key features",
        type: "tags",
        placeholder: "Real-time notes, CRM sync, coaching",
        help: "Press Enter or comma to add each feature.",
      },
      {
        key: "launchDate",
        label: "Launch date",
        type: "text",
        placeholder: "September 2026",
      },
      {
        key: "pricing",
        label: "Pricing / packaging",
        type: "textarea",
        placeholder: "Tiers, price points, what's included.",
      },
    ],
    composePrompt: (v) =>
      block(
        `Build a product launch presentation for ${str(v, "product")} as a slide-deck app.`,
        "",
        "Use these inputs:",
        line("Target audience", str(v, "audience")),
        line("Value proposition", str(v, "valueProp")),
        line("Key features", list(v, "features").join(", ")),
        line("Launch date", str(v, "launchDate")),
        line("Pricing / packaging", str(v, "pricing")),
        "",
        "Cover: positioning & value prop, the problem solved, key features, a demo walkthrough section, pricing/packaging, launch timeline, and the go-to-market plan. Energetic but professional visual direction. Fill gaps with editable placeholders.",
      ),
  },

  /* --------------------------- Dashboards ---------------------------- */
  {
    id: "form-kpi-dashboard",
    mode: "data",
    title: "KPI dashboard",
    description: "A live metrics dashboard built around your KPIs.",
    skill: "app-builder",
    inputs: [
      {
        key: "name",
        label: "Dashboard name",
        type: "text",
        placeholder: "Growth Dashboard",
        required: true,
      },
      {
        key: "metrics",
        label: "Metrics to track",
        type: "tags",
        placeholder: "Revenue, Active users, Churn, NPS",
        help: "Press Enter or comma to add each metric.",
        required: true,
      },
      {
        key: "dataSource",
        label: "Data source",
        type: "text",
        placeholder: "Stripe export / manual entry / placeholder data",
      },
      {
        key: "timeframe",
        label: "Timeframe",
        type: "select",
        options: [
          "Last 7 days",
          "Last 30 days",
          "Last quarter",
          "Last 12 months",
          "Year to date",
        ],
      },
      {
        key: "audience",
        label: "Audience",
        type: "text",
        placeholder: "Exec team / ops / personal",
      },
    ],
    composePrompt: (v) =>
      block(
        `Build a KPI dashboard app called "${str(v, "name")}".`,
        "",
        "Configure it from these inputs:",
        line("Metrics to track", list(v, "metrics").join(", ")),
        line("Data source", str(v, "dataSource")),
        line("Timeframe", str(v, "timeframe")),
        line("Audience", str(v, "audience")),
        "",
        "Show a top-line metric card for each tracked metric with a trend indicator, a line chart of the primary metric over the chosen timeframe, and a bar chart breaking it down by segment. Seed realistic placeholder data I can replace. Precise, finance-grade layout.",
      ),
  },
  {
    id: "form-budget-tracker",
    mode: "data",
    title: "Budget tracker",
    description: "An income/expense tracker for a specific budget.",
    skill: "app-builder",
    inputs: [
      {
        key: "name",
        label: "Budget name",
        type: "text",
        placeholder: "Household 2026",
        required: true,
      },
      {
        key: "categories",
        label: "Expense categories",
        type: "tags",
        placeholder: "Rent, Food, Transport, Subscriptions",
        help: "Press Enter or comma to add each category.",
        required: true,
      },
      {
        key: "income",
        label: "Monthly income",
        type: "number",
        placeholder: "5000",
      },
      {
        key: "currency",
        label: "Currency",
        type: "select",
        options: ["USD", "EUR", "GBP", "INR", "CAD", "AUD"],
      },
    ],
    composePrompt: (v) =>
      block(
        `Build a budget tracker app called "${str(v, "name")}".`,
        "",
        "Configure it from these inputs:",
        line("Expense categories", list(v, "categories").join(", ")),
        line("Monthly income", str(v, "income")),
        line("Currency", str(v, "currency") || "USD"),
        "",
        "Let me add income and expense entries by the categories above, show a running balance, a spending-by-category pie chart, and a monthly total versus income. Persist the entries so they stick between sessions.",
      ),
  },
  {
    id: "form-roi-calculator",
    mode: "data",
    title: "ROI calculator",
    description: "An interactive calculator with your inputs and formula.",
    skill: "app-builder",
    inputs: [
      {
        key: "subject",
        label: "What are you evaluating?",
        type: "text",
        placeholder: "Switching to a new CRM",
        required: true,
      },
      {
        key: "inputs",
        label: "Input variables",
        type: "tags",
        placeholder: "Upfront cost, Monthly saving, Seats, Time horizon",
        help: "Press Enter or comma to add each input.",
        required: true,
      },
      {
        key: "outputs",
        label: "Outputs to compute",
        type: "tags",
        placeholder: "ROI %, Net benefit, Payback period",
        help: "Press Enter or comma to add each output.",
      },
      {
        key: "horizon",
        label: "Default time horizon",
        type: "text",
        placeholder: "24 months",
      },
    ],
    composePrompt: (v) =>
      block(
        `Build an interactive ROI calculator app for: ${str(v, "subject")}.`,
        "",
        "Configure it from these inputs:",
        line("Input variables (as sliders/fields)", list(v, "inputs").join(", ")),
        line(
          "Outputs to compute live",
          list(v, "outputs").join(", ") || "ROI %, net benefit, payback period",
        ),
        line("Default time horizon", str(v, "horizon")),
        "",
        "Recompute the outputs live as I change inputs, and visualize the breakeven point on a small chart. Clean, trustworthy layout.",
      ),
  },

  /* ------------------------------- Docs ------------------------------ */
  {
    id: "form-prd",
    mode: "docs",
    title: "Product requirements doc",
    description: "A PRD structured around your feature.",
    skill: "document-editor",
    inputs: [
      {
        key: "feature",
        label: "Feature name",
        type: "text",
        placeholder: "Inline approvals",
        required: true,
      },
      {
        key: "problem",
        label: "Problem statement",
        type: "textarea",
        placeholder: "What user problem does this solve?",
        required: true,
      },
      {
        key: "users",
        label: "Target users",
        type: "text",
        placeholder: "Admins approving teammate actions",
        required: true,
      },
      {
        key: "goals",
        label: "Goals",
        type: "textarea",
        placeholder: "What success looks like.",
        required: true,
      },
      {
        key: "scope",
        label: "In scope / out of scope",
        type: "textarea",
        placeholder: "What's included now, what's explicitly deferred.",
      },
      {
        key: "metrics",
        label: "Success metrics",
        type: "tags",
        placeholder: "Approval time, adoption %, error rate",
        help: "Press Enter or comma to add each metric.",
      },
    ],
    composePrompt: (v) =>
      block(
        `Write a product requirements document (PRD) for "${str(v, "feature")}" in the document editor.`,
        "",
        "Base it on these inputs:",
        line("Problem statement", str(v, "problem")),
        line("Target users", str(v, "users")),
        line("Goals", str(v, "goals")),
        line("Scope", str(v, "scope")),
        line("Success metrics", list(v, "metrics").join(", ")),
        "",
        "Structure it as: overview & problem statement, goals and non-goals, target users, user stories, functional requirements, success metrics, risks, and open questions. Clear headings; leave editable placeholders where I haven't given detail.",
      ),
  },
  {
    id: "form-blog-post",
    mode: "docs",
    title: "Blog post",
    description: "A drafted article from your topic and angle.",
    skill: "document-editor",
    inputs: [
      {
        key: "topic",
        label: "Topic",
        type: "text",
        placeholder: "How async standups cut meeting load",
        required: true,
      },
      {
        key: "audience",
        label: "Audience",
        type: "text",
        placeholder: "Engineering managers",
        required: true,
      },
      {
        key: "tone",
        label: "Tone",
        type: "select",
        options: [
          "Conversational",
          "Authoritative",
          "Playful",
          "Technical",
          "Inspirational",
        ],
      },
      {
        key: "keyPoints",
        label: "Key points to cover",
        type: "tags",
        placeholder: "Time saved, async culture, tooling",
        help: "Press Enter or comma to add each point.",
      },
      {
        key: "length",
        label: "Length",
        type: "select",
        options: [
          "Short (~500 words)",
          "Medium (~900 words)",
          "Long (~1500 words)",
        ],
      },
    ],
    composePrompt: (v) =>
      block(
        `Write a blog post in the document editor on: ${str(v, "topic")}.`,
        "",
        "Use these inputs:",
        line("Audience", str(v, "audience")),
        line("Tone", str(v, "tone") || "Conversational"),
        line("Key points to cover", list(v, "keyPoints").join(", ")),
        line("Length", str(v, "length") || "Medium (~900 words)"),
        "",
        "Open with a strong hook, structure the body with clear subheadings that cover the key points, and close with a call to action. Make it genuinely readable, not filler.",
      ),
  },
  {
    id: "form-one-pager",
    mode: "docs",
    title: "Strategy one-pager",
    description: "A crisp single-page brief for a decision.",
    skill: "document-editor",
    inputs: [
      {
        key: "title",
        label: "Title / decision",
        type: "text",
        placeholder: "Should we enter the EU market?",
        required: true,
      },
      {
        key: "context",
        label: "Context",
        type: "textarea",
        placeholder: "Background the reader needs.",
        required: true,
      },
      {
        key: "recommendation",
        label: "Recommendation",
        type: "textarea",
        placeholder: "Your proposed decision.",
        required: true,
      },
      {
        key: "tradeoffs",
        label: "Trade-offs considered",
        type: "textarea",
        placeholder: "Alternatives and why you rejected them.",
      },
      {
        key: "nextSteps",
        label: "Next steps",
        type: "textarea",
        placeholder: "Concrete actions if approved.",
      },
    ],
    composePrompt: (v) =>
      block(
        `Write a strategy one-pager in the document editor titled "${str(v, "title")}".`,
        "",
        "Base it on these inputs:",
        line("Context", str(v, "context")),
        line("Recommendation", str(v, "recommendation")),
        line("Trade-offs considered", str(v, "tradeoffs")),
        line("Next steps", str(v, "nextSteps")),
        "",
        "Structure it as: context, the recommendation, supporting rationale, trade-offs, and next steps. Keep it tight and skimmable — it must fit on a single page.",
      ),
  },

  /* ----------------------------- Research ---------------------------- */
  {
    id: "form-competitor-brief",
    mode: "research",
    title: "Competitor brief",
    description: "A researched comparison of named competitors.",
    skill: "research",
    inputs: [
      {
        key: "company",
        label: "Your company / product",
        type: "text",
        placeholder: "Cue",
        required: true,
      },
      {
        key: "competitors",
        label: "Competitors",
        type: "tags",
        placeholder: "Notion AI, Mem, Reflect",
        help: "Press Enter or comma to add each competitor.",
        required: true,
      },
      {
        key: "focus",
        label: "Focus areas",
        type: "tags",
        placeholder: "Pricing, positioning, key features",
        help: "Press Enter or comma to add each focus area.",
      },
      {
        key: "audience",
        label: "Who's this for?",
        type: "text",
        placeholder: "Sales battlecard / product strategy",
      },
    ],
    composePrompt: (v) =>
      block(
        `Research the competitors of ${str(v, "company")} on the web and write a competitor brief.`,
        "",
        "Use these inputs:",
        line("Competitors to cover", list(v, "competitors").join(", ")),
        line(
          "Focus areas",
          list(v, "focus").join(", ") ||
            "what they do, target customer, pricing, key differentiators, recent moves",
        ),
        line("Intended use", str(v, "audience")),
        "",
        "For each competitor capture the focus areas above. Browse their sites where useful and cite sources. End with a short comparison and where there's an opening for us.",
      ),
  },
  {
    id: "form-market-brief",
    mode: "research",
    title: "Market brief",
    description: "Size, trends, and players in a specific space.",
    skill: "research",
    inputs: [
      {
        key: "market",
        label: "Market / space",
        type: "text",
        placeholder: "AI meeting assistants",
        required: true,
      },
      {
        key: "geography",
        label: "Geography",
        type: "text",
        placeholder: "Global / North America / EU",
      },
      {
        key: "questions",
        label: "Questions to answer",
        type: "tags",
        placeholder: "Market size, growth rate, top players",
        help: "Press Enter or comma to add each question.",
      },
      {
        key: "horizon",
        label: "Time horizon",
        type: "select",
        options: ["Current", "Next 12 months", "Next 3 years", "Next 5 years"],
      },
    ],
    composePrompt: (v) =>
      block(
        `Research and write a market brief on: ${str(v, "market")}.`,
        "",
        "Use these inputs:",
        line("Geography", str(v, "geography")),
        line(
          "Questions to answer",
          list(v, "questions").join(", ") ||
            "market size & growth, major trends, key players, customer segments, risks/opportunities",
        ),
        line("Time horizon", str(v, "horizon")),
        "",
        "Cite web sources and keep it to a tight, decision-useful brief.",
      ),
  },
  {
    id: "form-person-company-brief",
    mode: "research",
    title: "Person / company brief",
    description: "Background research before a meeting.",
    skill: "research",
    inputs: [
      {
        key: "subject",
        label: "Person or company",
        type: "text",
        placeholder: "Jane Doe, VP Eng at Acme",
        required: true,
      },
      {
        key: "url",
        label: "Website / LinkedIn (optional)",
        type: "url",
        placeholder: "https://...",
      },
      {
        key: "purpose",
        label: "Why are you meeting?",
        type: "text",
        placeholder: "Sales pitch / partnership / interview",
      },
      {
        key: "wants",
        label: "What do you want out of it?",
        type: "tags",
        placeholder: "Recent news, talking points, mutual connections",
        help: "Press Enter or comma to add each item.",
      },
    ],
    composePrompt: (v) =>
      block(
        `Do background research on ${str(v, "subject")} and write a briefing.`,
        "",
        "Use these inputs:",
        line("Reference link", str(v, "url")),
        line("Purpose of the meeting", str(v, "purpose")),
        line(
          "What to surface",
          list(v, "wants").join(", ") ||
            "who they are, role/history, recent news, notable work, smart talking points",
        ),
        "",
        "Use the web (and the link above if given) and cite where each fact came from.",
      ),
  },
];

/** All template definitions for a given mode id. */
export function templatesForMode(modeId: string): TemplateDefinition[] {
  return TEMPLATE_DEFINITIONS.filter((t) => t.mode === modeId);
}

/** Find a single template by id. */
export function findTemplate(id: string): TemplateDefinition | undefined {
  return TEMPLATE_DEFINITIONS.find((t) => t.id === id);
}

/**
 * Validates required fields. Returns the set of missing required keys
 * (empty set ⇒ valid). A `tags` field counts as filled when it has ≥1 entry.
 */
export function missingRequired(
  template: TemplateDefinition,
  values: TemplateValues,
): Set<string> {
  const missing = new Set<string>();
  for (const field of template.inputs) {
    if (!field.required) continue;
    const v = values[field.key];
    const filled = Array.isArray(v)
      ? v.length > 0
      : (v ?? "").toString().trim().length > 0;
    if (!filled) missing.add(field.key);
  }
  return missing;
}
