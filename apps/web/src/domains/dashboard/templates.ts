/**
 * Built-in dashboard templates.
 *
 * Each template names an ordered set of widget ids that the grid renders, plus
 * an optional `queryContext` prepended to the query-bar prompt so "ask Cue
 * anything" is framed by the active surface (e.g. the Finances template asks
 * Cue to reason about money). v1 ships the four built-ins below; there is no
 * backend for custom templates yet (the active selection is remembered in
 * localStorage — see `use-dashboard-templates.ts`).
 */

/** A `FeedItemCategory` subset used to slice the next-moves widget. */
export type FeedCategory =
  | "security"
  | "scheduling"
  | "background"
  | "email"
  | "system";

/** A preset "ask Cue to fetch this from your connected apps" intent. */
export interface ConnectorPreset {
  /** Short label for the card heading (e.g. "This month's spend"). */
  label: string;
  /** One-line description shown under the heading. */
  description: string;
  /** The exact prompt routed to the assistant on click. */
  intent: string;
  /** CTA button copy. */
  cta: string;
}

export type WidgetId =
  | "query-bar"
  | "next-moves"
  | "recent-memory"
  | "impact-stats"
  | "schedules"
  | "work-items"
  | "assistant-state"
  | "connector-query";

/** Per-widget configuration carried on a template instance. */
export interface WidgetSpec {
  id: WidgetId;
  /** Slice next-moves to these categories; omit for "all". */
  categories?: FeedCategory[];
  /** Preset intent for the connector-query widget. */
  preset?: ConnectorPreset;
}

export interface DashboardTemplate {
  id: string;
  name: string;
  /** One-line subtitle shown under the serif header. */
  tagline: string;
  widgets: WidgetSpec[];
  /** Prepended to query-bar submissions to frame the ask. */
  queryContext?: string;
}

const FINANCES_PRESET: ConnectorPreset = {
  label: "This month's spend",
  description: "Cue pulls and summarizes spend across your connected accounts.",
  intent:
    "Summarize this month's spend from my connected financial accounts. Break it down by category and call out anything unusual.",
  cta: "Summarize my spend",
};

const COMPANY_PRESET: ConnectorPreset = {
  label: "Open work-tracker issues",
  description: "Cue fetches your assigned issues from your connected tracker.",
  intent:
    "Show me my open Linear issues, grouped by status, with anything overdue or high-priority flagged first.",
  cta: "Show my open issues",
};

const FOUNDER_PRESET: ConnectorPreset = {
  label: "Key metrics",
  description: "Cue gathers headline metrics from your connected tools.",
  intent:
    "Pull the key company metrics from my connected tools — revenue, active users, runway and pipeline — and give me a one-screen snapshot.",
  cta: "Pull key metrics",
};

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    id: "personal",
    name: "Personal",
    tagline: "Your day, in one place.",
    widgets: [
      { id: "query-bar" },
      { id: "next-moves" },
      { id: "recent-memory" },
      { id: "impact-stats" },
    ],
  },
  {
    id: "company",
    name: "Company",
    tagline: "Work, tracked end to end.",
    queryContext:
      "Context: I'm asking about my company / work. Prefer my connected work tools (issue tracker, docs, email) for the answer.",
    widgets: [
      { id: "query-bar" },
      { id: "next-moves", categories: ["background", "system"] },
      { id: "work-items" },
      { id: "connector-query", preset: COMPANY_PRESET },
    ],
  },
  {
    id: "finances",
    name: "Finances",
    tagline: "Money, fetched by Cue.",
    queryContext:
      "Context: I'm asking about my personal or company finances. Use my connected financial accounts where possible and never invent numbers.",
    widgets: [
      { id: "query-bar" },
      { id: "connector-query", preset: FINANCES_PRESET },
      { id: "schedules" },
      { id: "impact-stats" },
    ],
  },
  {
    id: "founder",
    name: "Founder",
    tagline: "The whole company, on one screen.",
    queryContext:
      "Context: I'm a founder asking about running my company. Reason across my connected tools and surface what needs my attention.",
    widgets: [
      { id: "query-bar" },
      { id: "next-moves" },
      { id: "assistant-state" },
      { id: "schedules" },
      { id: "connector-query", preset: FOUNDER_PRESET },
    ],
  },
];

export function templateById(id: string): DashboardTemplate {
  return DASHBOARD_TEMPLATES.find((t) => t.id === id) ?? DASHBOARD_TEMPLATES[0];
}
