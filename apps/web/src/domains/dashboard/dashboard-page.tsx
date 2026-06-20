/**
 * Template-library dashboard — a personal command center.
 *
 * An editorial serif header, a template switcher (Personal / Company /
 * Finances / Founder), an "ask Cue anything" query bar, and a responsive grid
 * of widgets driven by the active template. Every widget either binds to a
 * named real daemon endpoint (next-moves, memory, impact, schedules, work
 * items, assistant state) or is an explicit "via Cue" assistant-routed card
 * (connector-query) — there are no fabricated numbers anywhere.
 */

import { ArrowRight, Loader2 } from "lucide-react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

import { C, mono, serif } from "./theme";
import { useDashboardQuery } from "./use-dashboard-query";
import { useDashboardTemplates } from "./use-dashboard-templates";
import type { DashboardTemplate, WidgetSpec } from "./templates";
import { AssistantStateWidget } from "./widgets/assistant-state-widget";
import { ConnectorQueryWidget } from "./widgets/connector-query-widget";
import { ImpactStatsWidget } from "./widgets/impact-stats-widget";
import { NextMovesWidget } from "./widgets/next-moves-widget";
import { RecentMemoryWidget } from "./widgets/recent-memory-widget";
import { SchedulesWidget } from "./widgets/schedules-widget";
import { WorkItemsWidget } from "./widgets/work-items-widget";

export function DashboardPage() {
  const assistantId = useActiveAssistantId();
  const { templates, activeId, active, setActiveId } = useDashboardTemplates();

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: 24 }}>
        <Header active={active} />

        <TemplateSwitcher
          templates={templates}
          activeId={activeId}
          onSelect={setActiveId}
        />

        <WidgetGrid template={active} assistantId={assistantId} />
      </div>
    </div>
  );
}

function Header({ active }: { active: DashboardTemplate }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          fontFamily: mono,
          fontSize: 11.5,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.blueS,
          marginBottom: 8,
        }}
      >
        Dashboard · {active.name}
      </div>
      <div
        style={{
          fontFamily: serif,
          fontSize: 38,
          letterSpacing: "-0.5px",
          lineHeight: 1.08,
          color: C.ink,
        }}
      >
        Your day, in one place.
      </div>
      <div style={{ fontSize: 14, color: C.t2, marginTop: 6 }}>
        {active.tagline} Widgets pull real data from Cue — ask it anything below.
      </div>
    </div>
  );
}

function TemplateSwitcher({
  templates,
  activeId,
  onSelect,
}: {
  templates: DashboardTemplate[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
      {templates.map((t) => {
        const isActive = t.id === activeId;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            style={{
              fontSize: 13,
              fontWeight: 500,
              border: `1px solid ${isActive ? C.ink : C.line2}`,
              background: isActive ? C.ink : C.surface,
              color: isActive ? "#fff" : C.t1,
              borderRadius: 999,
              padding: "7px 16px",
              cursor: "pointer",
            }}
          >
            {t.name}
          </button>
        );
      })}
    </div>
  );
}

function WidgetGrid({
  template,
  assistantId,
}: {
  template: DashboardTemplate;
  assistantId: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
        gap: 16,
        alignItems: "start",
      }}
    >
      {template.widgets.map((spec, idx) => (
        <Widget
          key={`${spec.id}-${idx}`}
          spec={spec}
          template={template}
          assistantId={assistantId}
        />
      ))}
    </div>
  );
}

function Widget({
  spec,
  template,
  assistantId,
}: {
  spec: WidgetSpec;
  template: DashboardTemplate;
  assistantId: string;
}) {
  switch (spec.id) {
    case "query-bar":
      return (
        <QueryBar assistantId={assistantId} queryContext={template.queryContext} />
      );
    case "next-moves":
      return (
        <NextMovesWidget assistantId={assistantId} categories={spec.categories} />
      );
    case "recent-memory":
      return <RecentMemoryWidget assistantId={assistantId} />;
    case "impact-stats":
      return <ImpactStatsWidget assistantId={assistantId} />;
    case "schedules":
      return <SchedulesWidget assistantId={assistantId} />;
    case "work-items":
      return <WorkItemsWidget assistantId={assistantId} />;
    case "assistant-state":
      return <AssistantStateWidget assistantId={assistantId} />;
    case "connector-query":
      // A connector-query spec without a preset is a template authoring bug;
      // skip rather than render a broken card.
      return spec.preset ? (
        <ConnectorQueryWidget assistantId={assistantId} preset={spec.preset} />
      ) : null;
    default:
      return null;
  }
}

function QueryBar({
  assistantId,
  queryContext,
}: {
  assistantId: string;
  queryContext?: string;
}) {
  const { value, setValue, submitting, error, submit } = useDashboardQuery(
    assistantId,
    queryContext,
  );

  return (
    <section
      style={{
        gridColumn: "1 / -1",
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 14,
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: "flex", gap: 10, alignItems: "center" }}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Ask Cue anything — it’ll open a conversation with the answer…"
          style={{
            flex: 1,
            fontSize: 14,
            border: `1px solid ${C.line2}`,
            borderRadius: 10,
            padding: "11px 14px",
            outline: "none",
            color: C.t1,
            background: C.surface,
            minWidth: 0,
          }}
        />
        <button
          type="submit"
          disabled={submitting || value.trim().length === 0}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 14,
            fontWeight: 500,
            border: `1px solid ${C.blue}`,
            background: C.blue,
            color: "#fff",
            borderRadius: 10,
            padding: "11px 16px",
            cursor:
              submitting || value.trim().length === 0 ? "default" : "pointer",
            opacity: submitting || value.trim().length === 0 ? 0.6 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {submitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowRight size={16} />
          )}
          Ask Cue
        </button>
      </form>
      {error ? (
        <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </section>
  );
}
