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
 * (app-builder / document-editor / research / replicate / apify) via its mode.
 *
 * Skill mapping (verified against create-templates.ts CreateSkill):
 *   - app-builder      → dashboards, trackers, calculators, slide decks
 *   - document-editor  → long-form docs (PRDs, blog posts, one-pagers)
 *   - research         → competitor / market / person briefs (web + browser)
 *   - replicate        → image & video generation (replicate_run, any model)
 *   - apify            → lead-gen / contact scraping (apify_run_actor)
 *
 * The Image / Video / Leads templates compose natural-language briefs that name
 * the subject, look and constraints from the user's typed inputs. Routing to the
 * daemon skill (Replicate for media, Apify/web for leads) is handled by that
 * skill's own activation — the prompt never hand-writes tool-call syntax. The
 * Replicate + Apify keys are configured at runtime, so these produce real media
 * / real lead lists.
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
  /**
   * Presentational only (Cue-Surfaces S1): the serif example subject shown in
   * the card's preview band — the sort of thing this template produces
   * ("Northwind — Series A"). Purely illustrative; falls back to the template
   * title when omitted. Never sent to the model.
   */
  sampleContext?: string;
  /**
   * Presentational provenance chip (S1 ⟡ tag). Either a `{ files: "…" }`
   * project-filing hint (blue ⟡ tag) or a `{ source: "…" }` connected-source
   * hint (neutral, no ⟡). Falls back to `files onto {mode skillLabel}`.
   */
  provenance?: { files: string } | { source: string };
  /**
   * The ordered sections this template produces — a real skeleton, not a
   * description of one. Present only where it genuinely exists (Slides and
   * Docs); every
   * other mode has inputs and settings and nothing else, which is why the
   * card's secondary action reads "What's in it" there and "See the outline"
   * here (design v29: "'outline' over-promises on eight types").
   *
   * SINGLE SOURCE OF TRUTH: the same array is joined into `composePrompt`, so
   * the outline the user reads is literally the section list the model is
   * told to produce. Never write the sections out twice.
   */
  outline?: string[];
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

/**
 * Renders a template's `outline` into its prompt ("Produce slides for: Title,
 * Problem, …"). Pairing this with `outline:` on the same definition is what
 * makes the skeleton the card promises and the skeleton the model is asked for
 * the same object — see `TemplateDefinition.outline`.
 */
function sections(lead: string, outline: readonly string[]): string {
  return `${lead}: ${outline.join(", ")}.`;
}

/* --- Outlines (Slides + Docs only — the modes with a real skeleton) ------ */

const OUTLINE_INVESTOR_PITCH = [
  "Title",
  "Problem",
  "Solution",
  "Product",
  "Market size",
  "Traction",
  "Business model",
  "Competition",
  "Team",
  "The funding ask",
];

const OUTLINE_QBR = [
  "Executive summary",
  "KPI scorecard with trend callouts",
  "Wins",
  "Misses with root cause",
  "Customer & revenue highlights",
  "Risks",
  "Next-quarter priorities",
];

const OUTLINE_PRODUCT_LAUNCH = [
  "Positioning & value prop",
  "The problem solved",
  "Key features",
  "Demo walkthrough",
  "Pricing & packaging",
  "Launch timeline",
  "Go-to-market plan",
];

const OUTLINE_PRD = [
  "Overview & problem statement",
  "Goals and non-goals",
  "Target users",
  "User stories",
  "Functional requirements",
  "Success metrics",
  "Risks",
  "Open questions",
];

const OUTLINE_BLOG_POST = [
  "Hook",
  "Body, with a subheading per key point",
  "Call to action",
];

const OUTLINE_ONE_PAGER = [
  "Context",
  "The recommendation",
  "Supporting rationale",
  "Trade-offs",
  "Next steps",
];

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
    sampleContext: "Northwind — Series A",
    provenance: { files: "Close the $500K seed" },
    outline: OUTLINE_INVESTOR_PITCH,
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
        sections("Produce slides for", OUTLINE_INVESTOR_PITCH),
        "One clear idea per slide, confident modern visual direction with strong typography. Where I have not given detail, use a bracketed placeholder I can spot at a glance — and never a number, since an invented market size or traction figure reads exactly like a measured one.",
      ),
  },
  {
    id: "form-qbr",
    mode: "slides",
    title: "Quarterly business review",
    description: "A QBR deck from your quarter's numbers and narrative.",
    skill: "app-builder",
    sampleContext: "Q3 business review",
    provenance: { source: "Pulls from connected Sheets" },
    outline: OUTLINE_QBR,
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
        sections("Include", OUTLINE_QBR),
        "Clean, data-forward design, one headline per slide. Never invent a figure: where I have not given a number, write a visible blank such as [Q3 revenue — not supplied] and list those gaps on a final slide, so nothing reads as measured that was not.",
      ),
  },
  {
    id: "form-product-launch",
    mode: "slides",
    title: "Product launch deck",
    description: "Positioning, demo flow, and go-to-market in one deck.",
    skill: "app-builder",
    sampleContext: "v2 goes live",
    provenance: { files: "Ship v2" },
    outline: OUTLINE_PRODUCT_LAUNCH,
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
        sections("Cover", OUTLINE_PRODUCT_LAUNCH),
        "Energetic but professional visual direction. Fill gaps with bracketed placeholders I can spot at a glance, and never invent a price or a date.",
      ),
  },

  /* --------------------------- Dashboards ---------------------------- */
  {
    id: "form-kpi-dashboard",
    mode: "data",
    title: "KPI dashboard",
    description: "A live metrics dashboard built around your KPIs.",
    sampleContext: "Growth — Q3",
    provenance: { source: "Pulls from connected Sheets" },
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
        "Show a top-line metric card for each tracked metric with a trend indicator, a line chart of the primary metric over the chosen timeframe, and a bar chart breaking it down by segment. Never invent data: where I have not supplied figures, label the chart clearly as sample shape only and leave the values blank rather than plotting numbers I did not supply. Precise, finance-grade layout.",
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
        line(
          "Input variables (as sliders/fields)",
          list(v, "inputs").join(", "),
        ),
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
    sampleContext: "PRD — v2 launch",
    provenance: { files: "Ship v2" },
    outline: OUTLINE_PRD,
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
        sections("Structure it as", OUTLINE_PRD),
        "Clear headings; leave editable placeholders where I haven't given detail.",
      ),
  },
  {
    id: "form-blog-post",
    mode: "docs",
    title: "Blog post",
    description: "A drafted article from your topic and angle.",
    skill: "document-editor",
    outline: OUTLINE_BLOG_POST,
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
        sections("Structure it as", OUTLINE_BLOG_POST),
        "Open with a strong hook and close with a call to action. Make it genuinely readable, not filler.",
      ),
  },
  {
    id: "form-one-pager",
    mode: "docs",
    title: "Strategy one-pager",
    description: "A crisp single-page brief for a decision.",
    skill: "document-editor",
    outline: OUTLINE_ONE_PAGER,
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
        sections("Structure it as", OUTLINE_ONE_PAGER),
        "Keep it tight and skimmable — it must fit on a single page.",
      ),
  },

  /* ----------------------------- Research ---------------------------- */
  {
    id: "form-competitor-brief",
    mode: "research",
    title: "Competitor brief",
    description: "A researched comparison of named competitors.",
    sampleContext: "Landscape — Q3",
    provenance: { source: "Researched from the live web" },
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

  /* ------------------------------ Images ----------------------------- */
  /* Backed by the `replicate` daemon skill (replicate_run, any model).   */
  {
    id: "form-generate-image",
    mode: "images",
    title: "Generate image",
    description: "Create an image from a prompt with any Replicate model.",
    sampleContext: "Hero — brand key art",
    provenance: { source: "Rendered on Replicate" },
    skill: "replicate",
    inputs: [
      {
        key: "prompt",
        label: "Prompt",
        type: "textarea",
        placeholder:
          "A golden retriever astronaut floating above Earth, cinematic lighting",
        required: true,
      },
      {
        key: "style",
        label: "Style",
        type: "select",
        options: ["Photoreal", "Illustration", "3D render", "Flat / vector"],
      },
      {
        key: "aspect",
        label: "Aspect ratio",
        type: "select",
        options: ["1:1", "16:9", "9:16", "4:5"],
      },
      {
        key: "model",
        label: "Model",
        type: "select",
        options: [
          "black-forest-labs/flux-1.1-pro",
          "black-forest-labs/flux-schnell",
          "stability-ai/sdxl",
        ],
        help: "flux-1.1-pro = highest quality · flux-schnell = fastest · sdxl = classic.",
      },
    ],
    composePrompt: (v) => {
      const model = str(v, "model");
      const aspect = str(v, "aspect") || "1:1";
      return block(
        `Generate an image: ${str(v, "prompt")}.`,
        line("Style", str(v, "style")),
        line("Aspect ratio", aspect),
        model ? line("Preferred model", model) : "",
        "",
        "Render it and show me the result. If I picked a style above, honour it unless it clashes with a design direction already set for this generation.",
      );
    },
  },
  {
    id: "form-logo-concept",
    mode: "images",
    title: "Logo concept",
    description: "Generate a logo direction for a brand with Replicate.",
    skill: "replicate",
    inputs: [
      {
        key: "brand",
        label: "Brand name",
        type: "text",
        placeholder: "Cue",
        required: true,
      },
      {
        key: "vibe",
        label: "Vibe / keywords",
        type: "text",
        placeholder: "minimal, trustworthy, tech-forward",
        required: true,
      },
      {
        key: "symbol",
        label: "Symbol idea (optional)",
        type: "text",
        placeholder: "an abstract speech bubble / soundwave",
      },
      {
        key: "model",
        label: "Model",
        type: "select",
        options: [
          "black-forest-labs/flux-1.1-pro",
          "black-forest-labs/flux-schnell",
          "stability-ai/sdxl",
        ],
        help: "flux-1.1-pro = highest quality · flux-schnell = fastest.",
      },
    ],
    composePrompt: (v) => {
      const model = str(v, "model");
      return block(
        `Generate a logo concept for "${str(v, "brand")}".`,
        line("Vibe / keywords", str(v, "vibe")),
        line("Symbol idea", str(v, "symbol")),
        model ? line("Preferred model", model) : "",
        "",
        "Make it a clean, modern, scalable mark centered on a plain background, square (1:1), with no garbled text. Render it and show me the result.",
      );
    },
  },
  {
    id: "form-social-graphic",
    mode: "images",
    title: "Social graphic",
    description: "An eye-catching post image generated with Replicate.",
    skill: "replicate",
    inputs: [
      {
        key: "theme",
        label: "Theme / message",
        type: "textarea",
        placeholder: "Announcing our Series A — bold, celebratory",
        required: true,
      },
      {
        key: "style",
        label: "Style",
        type: "select",
        options: ["Photoreal", "Illustration", "3D render", "Flat / vector"],
      },
      {
        key: "aspect",
        label: "Aspect ratio",
        type: "select",
        options: ["1:1", "4:5", "9:16", "16:9"],
        help: "1:1 = feed · 4:5 = portrait feed · 9:16 = story/reel.",
      },
      {
        key: "model",
        label: "Model",
        type: "select",
        options: [
          "black-forest-labs/flux-1.1-pro",
          "black-forest-labs/flux-schnell",
          "stability-ai/sdxl",
        ],
        help: "flux-1.1-pro = highest quality · flux-schnell = fastest.",
      },
    ],
    composePrompt: (v) => {
      const model = str(v, "model");
      const aspect = str(v, "aspect") || "1:1";
      return block(
        `Generate a bold, scroll-stopping social graphic: ${str(v, "theme")}.`,
        line("Style", str(v, "style")),
        line("Aspect ratio", aspect),
        model ? line("Preferred model", model) : "",
        "",
        "Give it a strong, confident composition with clear negative space for an overlaid headline. Render it and show me the result.",
      );
    },
  },

  /* ------------------------------ Video ------------------------------ */
  /* Backed by the `replicate` daemon skill (replicate_run, video model). */
  {
    id: "form-generate-video",
    mode: "video",
    title: "Generate video",
    description: "Text-to-video clip generated with a Replicate model.",
    skill: "replicate",
    inputs: [
      {
        key: "prompt",
        label: "Prompt",
        type: "textarea",
        placeholder:
          "A drone shot flying over a misty mountain range at sunrise",
        required: true,
      },
      {
        key: "duration",
        label: "Duration",
        type: "select",
        options: ["5s", "10s"],
      },
      {
        key: "aspect",
        label: "Aspect ratio",
        type: "select",
        options: ["16:9", "9:16", "1:1"],
      },
      {
        key: "model",
        label: "Model",
        type: "select",
        options: [
          "kwaivgi/kling-v1.6-standard",
          "minimax/video-01",
          "wan-video/wan-2.1-t2v-480p",
        ],
        help: "Default Kling 1.6. You can paste any other Replicate text-to-video model id.",
      },
    ],
    composePrompt: (v) => {
      const model = str(v, "model");
      const aspect = str(v, "aspect") || "16:9";
      const duration = str(v, "duration") || "5s";
      return block(
        `Generate a short video from this prompt: ${str(v, "prompt")}.`,
        line("Duration", duration),
        line("Aspect ratio", aspect),
        model ? line("Preferred model", model) : "",
        "",
        "Allow plenty of time — video generation is slow. When it's ready, show me the result.",
      );
    },
  },

  /* ------------------------------ Leads ------------------------------ */
  /* Backed by the `apify` daemon skill (web scraping / contact gathering). */
  {
    id: "form-find-leads",
    mode: "leads",
    title: "Find leads",
    description: "Scrape a structured lead list matching your criteria.",
    skill: "apify",
    inputs: [
      {
        key: "industry",
        label: "Industry",
        type: "text",
        placeholder: "B2B SaaS / fintech / logistics",
        required: true,
      },
      {
        key: "role",
        label: "Role / title",
        type: "text",
        placeholder: "VP of Sales, Head of Growth",
        required: true,
      },
      {
        key: "location",
        label: "Location",
        type: "text",
        placeholder: "San Francisco Bay Area",
        required: true,
      },
      {
        key: "count",
        label: "How many leads",
        type: "number",
        placeholder: "25",
        help: "Number of leads to return.",
      },
    ],
    composePrompt: (v) => {
      const industry = str(v, "industry");
      const role = str(v, "role");
      const location = str(v, "location");
      const count = str(v, "count") || "25";
      return block(
        `Find me a lead list of ${count} ${role} in ${industry} based in ${location}.`,
        "",
        'Use the Apify skill to build this list: load it with skill_load (skill "apify"), then run its apify_run_actor tool with a lead-gen actor (apify/google-search-scraper to find matching people/companies, or apify/contact-info-scraper to enrich contact details) to scrape real prospects matching the profile above.',
        "Do NOT use web_search or answer from general knowledge — lead-gen must run through the Apify actor so the results are real and structured.",
        "Return the results as a clean table with name, title, company, location, and any contact info (email or LinkedIn) you can find.",
      );
    },
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
