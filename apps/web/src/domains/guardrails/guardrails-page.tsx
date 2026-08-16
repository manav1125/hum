/**
 * Guardrails — the unified control surface that evolved out of the Trust
 * console (Cue-Guardrails design, SET 1 + SET 3 + STATES).
 *
 * One page, three bands over one composed daemon read (`GET guardrails`):
 *   1. CHECKPOINTS — named plain-English rules ("Cue always asks before…")
 *      with on/off toggles, scope chips, DEFAULT badges, and the 3-step
 *      "+ Add a checkpoint" composer (template → scope → name).
 *   2. AGENT SCOPES — one card per registry agent: tier line, editable tool
 *      scopes (chips + "edit ✎" → toggle the known scope set, PATCHed as
 *      `toolScopes`; null = unrestricted; enforced on background runs), live
 *      spend-vs-cap bar (amber ≥80%, red at cap with the raise/keep
 *      decision), the model pin picker (Best · Sonnet / Fast · Haiku /
 *      Custom), and the paused variant.
 *   3. THE LEDGER — recent autonomous acts (real titles, per-act $ + model
 *      where measured, an active "↩ Reverse" that unwinds via
 *      `POST acts/:id/reverse`), named held-for-approval rows, and an honest
 *      rollup, linking out to Mission Control for the full feed.
 * Plus the "Usage & spend" transparency band (SET 3): Week/Month window,
 * per-agent $, per-mission $, model mix, and the share-able summary card.
 *
 * Honesty rules baked in: checkpoints the permission checker doesn't enforce
 * yet carry an ADVISORY tag (payload `enforced:false`); nullable per-act
 * $ / model mean "wasn't measured" and render as nothing (never a fake $0);
 * a 409 from reverse surfaces as a plain "nothing to unwind" note — never a
 * fake success. Tool scopes ride a parallel typed `agents` read because the
 * composed guardrails payload carries `toolScopes` on each agent (R2).
 */

import { Loader2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useHideVendorUi } from "@/assistant/use-managed-mode";
import {
  actsByIdReversePostMutation,
  agentsByIdPatchMutation,
  agentsGetOptions,
  guardrailsCheckpointsByIdDeleteMutation,
  guardrailsCheckpointsByIdPatchMutation,
  guardrailsCheckpointsPostMutation,
  guardrailsGetOptions,
  missionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { GuardrailsGetResponse } from "@/generated/daemon/types.gen";
import { useIsMobile, useMobileLayout } from "@/hooks/use-is-mobile";
import { Mv3LedgerPage } from "@/mobile-v3/you/ledger-page";
import { Mv3RulesPage } from "@/mobile-v3/you/rules-page";
import { AutonomyLedgerBand } from "@/domains/guardrails/autonomy-ledger-panel";
import { ValveBand } from "@/domains/guardrails/valve-band";
import { TrustRulesModal } from "@/components/trust-rules/trust-rules-modal";
import {
  Mv3AgentScopesScreen,
  Mv3GuardrailsBar,
} from "@/domains/guardrails/mobile-guardrails";
import {
  CHECKPOINT_TEMPLATES,
  agentGlyph,
  dollars,
  heldAgeLabel,
  modelPinDisplay,
  MODEL_PIN_OPTIONS,
  normalizeToolScopeSelection,
  parseThresholdCents,
  reverseConflictCode,
  scopeDisplay,
  templateGlyph,
  tierDescriptor,
  TOOL_SCOPE_IDS,
  type CheckpointTemplate,
} from "@/lib/guardrails-kit";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// Local theme — the `--mv1-*` token map every v0.3 surface rides (kept
// domain-local per no-cross-domain-imports; mirrors domains/activity/theme).
// ---------------------------------------------------------------------------

const C = {
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  blueW: "var(--mv1-blue-wash)",
  violet: "var(--mv1-violet)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  greenW: "var(--mv1-green-wash)",
  amber: "var(--mv1-amber)",
  blueText: "var(--mv1-blue-text)",
  violetText: "var(--mv1-violet-text)",
  amberText: "var(--mv1-amber-text)",
  danger: "var(--mv1-danger)",
  /** Text leg for small copy where colour is the only carrier (A1). */
  dangerText: "var(--mv1-danger-text)",
  teal: "var(--gr-teal)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

/** Page-local accent vars (the mock's teal has no `--mv1-*` slot). */
function GrStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: [
          ":root{--gr-teal:#0E8C8C;}",
          '[data-theme="dark"],[data-theme="velvet"]{--gr-teal:#5FD0C8;}',
          // Muted TEXT, named for its ground and its role (the v35 ruling
          // that closed the ninth recurrence of the muted-token class).
          // `--mv1-t3` is a chrome grey that dips under 4:1 on the dark
          // canvas, and this band is nothing but small grey type.
          // Values are design's: #6B6B60 light (5.4:1), #9A9AA8 dark (6.9:1)
          // — never #8A8A7E / #A8A89C (grounds) and never #5B5B68.
          ":root{--gr-muted-on-light:#6B6B60;--gr-muted-on-dark:#9A9AA8;--gr-muted:var(--gr-muted-on-light);}",
          '[data-theme="dark"],[data-theme="velvet"]{--gr-muted:var(--gr-muted-on-dark);}',
        ].join("\n"),
      }}
    />
  );
}

type GuardrailsPayload = GuardrailsGetResponse;
type Checkpoint = GuardrailsPayload["checkpoints"][number];
type Agent = GuardrailsPayload["agents"][number];
type LedgerAct = GuardrailsPayload["ledger"]["recentActs"][number];

/**
 * Tool scopes per agent id, from the parallel typed `agents` read (the
 * agents read carries `toolScopes` since R2). `undefined` =
 * registry not loaded (chips stay display-only); `null` = unrestricted.
 */
type ToolScopesByAgent = ReadonlyMap<string, string[] | null>;

/** Partial-match key for every `guardrailsGet` window (7d + 30d). */
const GUARDRAILS_KEY_PREFIX = [{ _id: "guardrailsGet" }] as const;
/** Partial-match key for the agent registry read (tool scopes ride it). */
const AGENTS_KEY_PREFIX = [{ _id: "agentsGet" }] as const;

/** Per-agent hue — the mock's house palette (Ops teal / Builder blue / Growth violet). */
function agentHue(name: string, index: number): string {
  const n = name.toLowerCase();
  if (n.includes("ops")) return C.teal;
  if (n.includes("build")) return C.blue;
  if (n.includes("growth")) return C.violet;
  if (n === "cue") return C.t3;
  const cycle = [C.teal, C.blue, C.violet, C.green];
  return cycle[index % cycle.length];
}

/**
 * Fallback display chips while the agent registry read is still in flight
 * (real `toolScopes` replace these once loaded): the house agents get the
 * mock's chip sets; anything else falls back to the registry `domain` field
 * split on separators.
 */
function agentToolChips(agent: Agent): string[] {
  const n = agent.name.toLowerCase();
  if (n.includes("ops")) return ["email", "calendar", "research", "files"];
  if (n.includes("build")) return ["code", "docs", "design"];
  if (n.includes("growth")) return ["outreach", "social", "ads"];
  if (n === "cue") return ["triage", "summaries", "capture"];
  if (agent.domain) {
    return agent.domain
      .split(/[,·|/]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);
  }
  return [];
}

/** Epoch (s or ms) → "22 min ago"-style relative label. */
function timeAgo(epoch: number): string {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  return `${d} d ago`;
}

/** Kind-derived fallback labels — used when an act carries no `title`. */
const ACT_TITLES: Record<LedgerAct["kind"], string> = {
  run_completed: "Completed a background run",
  output_produced: "Produced an output",
  message_drafted: "Drafted a message",
  schedule_fired: "Ran a scheduled task",
  other: "Did background work",
};

/** Tail of a provider/model id, prettied ("anthropic/claude-haiku-4.5" → "Haiku 4.5"). */
function modelShortName(model: string): string {
  const tail = model.split("/").pop() ?? model;
  const m = /(haiku|sonnet|opus)[-. ]?([\d.]*)/i.exec(tail);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    return m[2] ? `${fam} ${m[2].replace(/\.$/, "")}` : fam;
  }
  return tail;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GuardrailsPage() {
  // MOBILE — the mobile-v3 Rules screen (spec frame 20) with the act ledger
  // (frame 31) at `?view=ledger` (deep-linked from the You screen's acts
  // tile) and the agent-scope editor (desktop's AGENT SCOPES band) at
  // `?view=scopes` — the target the v3 Agents screen's "Adjust scope"
  // deep-link lands on (task #101; it navigates to the plain guardrails URL,
  // where the pinned bar below the Rules screen is one tap away). The bar
  // also restores the "+ Add a checkpoint" composer as a v3 sheet. No new
  // routes; branch in a thin wrapper so the desktop body's hooks never
  // change count across a breakpoint flip. Desktop keeps the three-band
  // Guardrails console untouched.
  const isMobile = useMobileLayout();
  const [searchParams] = useSearchParams();
  if (isMobile) {
    const view = searchParams.get("view");
    if (view === "ledger") return <Mv3LedgerPage />;
    if (view === "scopes") return <Mv3AgentScopesScreen />;
    return (
      <div
        style={{
          height: "100%",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--mv3-bg)",
        }}
      >
        <div style={{ flex: 1, minHeight: 0 }}>
          <Mv3RulesPage />
        </div>
        <Mv3GuardrailsBar />
      </div>
    );
  }
  return <GuardrailsPageDesktop />;
}

function GuardrailsPageDesktop() {
  const assistantId = useActiveAssistantId();
  const isMobile = useIsMobile();
  // Week/Month window (SET 3) — one knob re-queries the whole payload.
  const [days, setDays] = useState<7 | 30>(7);

  const query = useQuery({
    ...guardrailsGetOptions({
      path: { assistant_id: assistantId },
      query: { days },
    }),
    // Every other query on a page load retries and recovers; this one did not,
    // so a single transient failure left Guardrails permanently on its error
    // card while HQ beside it healed itself. Observed live: one 429 on
    // `guardrails?days=7`, never retried, page dead until you navigated away.
    // Guardrails is also where the valve's REACHING YOU band lives, so a
    // surface that stays broken here hides a control, not just a panel.
    retry: 2,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 5000),
  });

  const data = query.data;
  const pad = isMobile ? "16px 14px 60px" : "24px 24px 80px";

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <GrStyle />
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: pad }}>
        {query.isLoading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: C.t2,
              padding: "40px 0",
            }}
          >
            <Loader2 className="size-4 animate-spin" /> Loading your guardrails…
          </div>
        ) : query.isError || !data ? (
          <div
            style={{
              background: C.surface,
              border: `1px solid ${C.line}`,
              borderLeft: `3px solid ${C.danger}`,
              borderRadius: "0 12px 12px 0",
              padding: "11px 14px",
              fontSize: 13,
              color: C.t2,
              marginTop: 24,
            }}
          >
            Couldn&rsquo;t load your guardrails. Cue stays inside its default
            lines — everyday work runs; sending, money, and deletes ask first.
            {/* The card stated the fail-safe honestly but offered no way out:
                the only escape was navigating away and back. */}
            <button
              type="button"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              style={{
                display: "block",
                marginTop: 8,
                background: "transparent",
                border: "none",
                padding: 0,
                font: "inherit",
                color: C.blue,
                cursor: query.isFetching ? "default" : "pointer",
                textDecoration: "underline",
              }}
            >
              {query.isFetching ? "Trying…" : "Try again"}
            </button>
          </div>
        ) : (
          <GuardrailsBody
            assistantId={assistantId}
            data={data}
            days={days}
            onDaysChange={setDays}
            isMobile={isMobile}
          />
        )}
      </div>
    </div>
  );
}

function GuardrailsBody({
  assistantId,
  data,
  days,
  onDaysChange,
  isMobile,
}: {
  assistantId: string;
  data: GuardrailsPayload;
  days: 7 | 30;
  onDaysChange: (d: 7 | 30) => void;
  isMobile: boolean;
}) {
  const { checkpoints, agents, ledger } = data;
  const summary = ledger.summary;

  // Tool scopes ride the typed agent-registry read — the composed guardrails
  // payload doesn't carry `toolScopes` (chips stay display-only until this
  // resolves; a failure just leaves them display-only, never wrong).
  const registryQuery = useQuery(
    agentsGetOptions({ path: { assistant_id: assistantId } }),
  );
  const toolScopesByAgent = useMemo<ToolScopesByAgent | undefined>(() => {
    const rows = registryQuery.data?.agents;
    if (!rows) return undefined;
    return new Map(rows.map((a) => [a.id, a.toolScopes]));
  }, [registryQuery.data]);

  // Fresh-user state: only seeded defaults, nothing on the ledger yet.
  const isFresh =
    summary.actCount === 0 && checkpoints.every((c) => c.isDefault === 1);

  return (
    <>
      <Header
        summary={summary}
        days={days}
        isMobile={isMobile}
        fresh={isFresh}
      />
      <Band
        label="CHECKPOINTS"
        sub="Cue always asks before…"
        isMobile={isMobile}
      >
        <CheckpointsBand
          assistantId={assistantId}
          checkpoints={checkpoints}
          agents={agents}
          isMobile={isMobile}
          fresh={isFresh}
        />
      </Band>
      {/*
        Per-tool rules. Checkpoints above say "always ask about this kind of
        action"; these say what one named tool is worth on its own — the only
        way to grant or revoke a single tool without moving a threshold that
        covers everything at that risk level. They live here rather than in
        Settings because Guardrails is the one surface that decides what Cue
        may do unattended, and two surfaces disagreeing about that is the
        disagreement this app cannot afford.
      */}
      <Band
        label="TOOL RULES"
        sub="What one specific tool is allowed to do"
        isMobile={isMobile}
      >
        <ToolRulesBand assistantId={assistantId} />
      </Band>
      {/*
        Door 3 of the volume valve (design V2). It sits directly under
        CHECKPOINTS because it answers the same shape of question — what
        reaches you, versus what Cue asks before doing — and above AGENT
        SCOPES, which is about what Cue may touch rather than what you see.
      */}
      <Band
        label="REACHING YOU"
        sub="What interrupts you, and what waits in Work"
        isMobile={isMobile}
      >
        <ValveBand assistantId={assistantId} />
      </Band>
      <Band
        label="AGENT SCOPES"
        sub="What each agent may touch, spend, and run on"
        isMobile={isMobile}
      >
        <AgentScopesBand
          assistantId={assistantId}
          agents={agents}
          toolScopesByAgent={toolScopesByAgent}
          isMobile={isMobile}
        />
      </Band>
      <Band
        label="THE LEDGER"
        sub={
          days === 7
            ? "What your rules did this week"
            : "What your rules did this month"
        }
        right={
          <span
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              color: C.t2,
              whiteSpace: "nowrap",
            }}
          >
            {summary.actCount} acts · {summary.heldCount} held ·{" "}
            {dollars(summary.totalCents)}
            {summary.reversedCount === 0 && summary.actCount > 0
              ? " · everything reversible"
              : ""}
          </span>
        }
        isMobile={isMobile}
      >
        <LedgerBand
          assistantId={assistantId}
          ledger={ledger}
          agents={agents}
          fresh={isFresh}
        />
      </Band>
      {/*
        The consequence ledger, beside the value ledger above: every action
        that reached outside or couldn't be undone, whether anyone was in the
        room, and who approved it. Its own read — an empty or failed fetch
        never affects the rest of the page.
      */}
      <Band
        label="WHAT CUE DID"
        sub="Every action that reached outside or can’t be undone"
        isMobile={isMobile}
      >
        <AutonomyLedgerBand
          assistantId={assistantId}
          days={days}
          isMobile={isMobile}
        />
      </Band>
      <UsageBand
        data={data}
        days={days}
        onDaysChange={onDaysChange}
        isMobile={isMobile}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Header — serif title, the promise line, and the honest rollup stats.
// ---------------------------------------------------------------------------

function Header({
  summary,
  days,
  isMobile,
  fresh,
}: {
  summary: GuardrailsPayload["ledger"]["summary"];
  days: 7 | 30;
  isMobile: boolean;
  fresh: boolean;
}) {
  const reversiblePct =
    summary.actCount > 0
      ? Math.round(
          ((summary.actCount - summary.reversedCount) / summary.actCount) * 100,
        )
      : null;
  const wk = days === 7 ? "WK" : "MO";

  const stats = (
    <div
      style={{
        display: "flex",
        gap: isMobile ? 14 : 22,
        fontFamily: mono,
        textAlign: isMobile ? "left" : "right",
        flexWrap: "wrap",
      }}
    >
      <Stat
        value={String(summary.actCount)}
        label={`ACTS THIS ${wk}`}
        small={isMobile}
      />
      <Stat
        value={String(summary.heldCount)}
        label="HELD FOR YOU"
        color={summary.heldCount > 0 ? C.amber : undefined}
        small={isMobile}
      />
      <Stat
        value={dollars(summary.totalCents)}
        label="SPENT"
        small={isMobile}
      />
      <Stat
        value={reversiblePct === null ? "—" : `${reversiblePct}%`}
        label="REVERSIBLE"
        color={reversiblePct === 100 ? C.green : undefined}
        small={isMobile}
      />
    </div>
  );

  return (
    <div
      style={{
        padding: isMobile ? "6px 0 14px" : "8px 0 24px",
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 20,
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: isMobile ? 9 : 10,
              letterSpacing: "0.16em",
              color: C.t3,
            }}
          >
            SETTINGS · GUARDRAILS
          </div>
          <div
            style={{
              fontFamily: serif,
              fontSize: isMobile ? 27 : 34,
              marginTop: isMobile ? 5 : 8,
              lineHeight: 1,
              color: C.t1,
            }}
          >
            Guardrails
          </div>
          <div style={{ fontSize: 13.5, color: C.t2, marginTop: 8 }}>
            {fresh
              ? "You haven't drawn any lines yet — so Cue starts careful."
              : "Cue works autonomously — inside lines you draw."}
          </div>
        </div>
        {stats}
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  color,
  small,
}: {
  value: string;
  label: string;
  color?: string;
  small?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: small ? 16 : 20, color: color ?? C.t1 }}>
        {value}
      </div>
      <div
        style={{
          fontSize: 9.5,
          letterSpacing: "0.1em",
          color: C.t3,
          marginTop: 3,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
    </div>
  );
}

/** A band: DM Mono accent microlabel + quiet sub, hairline-separated. */
function Band({
  label,
  sub,
  right,
  isMobile,
  children,
}: {
  label: string;
  sub: string;
  right?: ReactNode;
  isMobile: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        padding: isMobile ? "20px 0" : "26px 0",
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            letterSpacing: "0.16em",
            color: C.blueS,
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: 12.5, color: C.t3 }}>{sub}</span>
        {right ? <span style={{ marginLeft: "auto" }}>{right}</span> : null}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Band · TOOL RULES
// ---------------------------------------------------------------------------

/**
 * The entry point to per-tool trust rules.
 *
 * The rule list, editor and create form already exist as a modal; what was
 * missing was any route to them — the Settings card that used to hold it was
 * retired when Guardrails became the single place that decides what Cue may
 * do unattended, and nothing took its place. Without this, a tool that never
 * raises a permission prompt (a browser write, which the interactive
 * threshold already auto-approves) could not be given a rule at all.
 */
function ToolRulesBand({ assistantId }: { assistantId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <p
        style={{
          fontSize: 12.5,
          color: C.t2,
          margin: "0 0 12px",
          maxWidth: 620,
        }}
      >
        A rule sets what one named tool is worth on its own — so a single tool
        can run unattended, or always stop for you, without changing anything
        else at the same risk level.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          border: `1.5px dashed color-mix(in srgb, ${C.blue} 40%, transparent)`,
          background: "transparent",
          borderRadius: 12,
          padding: 12,
          color: C.blueS,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Manage tool rules
      </button>
      {open && (
        <TrustRulesModal
          assistantId={assistantId}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Band 1 · CHECKPOINTS
// ---------------------------------------------------------------------------

function CheckpointsBand({
  assistantId,
  checkpoints,
  agents,
  isMobile,
  fresh,
}: {
  assistantId: string;
  checkpoints: Checkpoint[];
  agents: Agent[];
  isMobile: boolean;
  fresh: boolean;
}) {
  const queryClient = useQueryClient();
  const [composerOpen, setComposerOpen] = useState(false);

  const patchMutation = useMutation({
    ...guardrailsCheckpointsByIdPatchMutation(),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: GUARDRAILS_KEY_PREFIX }),
  });

  const deleteMutation = useMutation({
    ...guardrailsCheckpointsByIdDeleteMutation(),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: GUARDRAILS_KEY_PREFIX }),
  });

  const remove = (cp: Checkpoint) => {
    // Optimistic removal; the invalidate reconciles. Defaults are protected in
    // the row (toggle-only) — deleting a default would resurrect confusion
    // about the seeded baseline, disabling it is the honest off-switch.
    queryClient.setQueriesData<GuardrailsPayload>(
      { queryKey: GUARDRAILS_KEY_PREFIX },
      (prev) =>
        prev
          ? {
              ...prev,
              checkpoints: prev.checkpoints.filter((c) => c.id !== cp.id),
            }
          : prev,
    );
    deleteMutation.mutate({
      path: { assistant_id: assistantId, id: cp.id },
    });
  };

  const toggle = (cp: Checkpoint) => {
    // Optimistic: flip the toggle in every cached window immediately.
    queryClient.setQueriesData<GuardrailsPayload>(
      { queryKey: GUARDRAILS_KEY_PREFIX },
      (prev) =>
        prev
          ? {
              ...prev,
              checkpoints: prev.checkpoints.map((c) =>
                c.id === cp.id ? { ...c, enabled: c.enabled === 1 ? 0 : 1 } : c,
              ),
            }
          : prev,
    );
    patchMutation.mutate({
      path: { assistant_id: assistantId, id: cp.id },
      body: { enabled: cp.enabled !== 1 },
    });
  };

  const hasUserRule = checkpoints.some((c) => c.isDefault !== 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {checkpoints.length === 0 && (
        <div style={{ fontSize: 13, color: C.t2 }}>
          No checkpoints yet — Cue asks before anything consequential until you
          draw lines here.
        </div>
      )}
      {checkpoints.map((cp) => (
        <CheckpointRow
          key={cp.id}
          checkpoint={cp}
          agents={agents}
          isMobile={isMobile}
          onToggle={() => toggle(cp)}
          onRemove={cp.isDefault === 1 ? undefined : () => remove(cp)}
        />
      ))}
      {fresh && (
        <div
          style={{
            fontSize: 11.5,
            color: C.t3,
            lineHeight: 1.5,
            padding: "2px 2px 0",
          }}
        >
          The ledger is empty — it fills as Cue works. Loosen these anytime;
          most people do it from the approval dialog.
        </div>
      )}
      {composerOpen ? (
        <CheckpointComposer
          assistantId={assistantId}
          agents={agents}
          isMobile={isMobile}
          onClose={() => setComposerOpen(false)}
        />
      ) : (
        <button
          type="button"
          data-coach="guardrails-checkpoint"
          onClick={() => setComposerOpen(true)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            border: `1.5px dashed color-mix(in srgb, ${C.blue} 40%, transparent)`,
            background: "transparent",
            borderRadius: 12,
            padding: 12,
            color: C.blueS,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
            marginTop: 4,
          }}
        >
          + Add {hasUserRule ? "a checkpoint" : "your first checkpoint"}
        </button>
      )}
    </div>
  );
}

function CheckpointRow({
  checkpoint,
  agents,
  isMobile,
  onToggle,
  onRemove,
}: {
  checkpoint: Checkpoint;
  agents: Agent[];
  isMobile: boolean;
  onToggle: () => void;
  /** Absent on DEFAULT rows — the seeded baseline is toggle-only. */
  onRemove?: () => void;
}) {
  const scope = scopeDisplay(checkpoint.scope, agents);
  const on = checkpoint.enabled === 1;

  const scopeChip = (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10,
        color: scope.kind === "agent" ? C.violet : C.t3,
        background:
          scope.kind === "agent"
            ? `color-mix(in srgb, ${C.violet} 12%, transparent)`
            : C.sunken,
        borderRadius: 6,
        padding: "4px 9px",
        whiteSpace: "nowrap",
      }}
    >
      {scope.label}
    </span>
  );

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: isMobile ? 11 : 13,
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        padding: isMobile ? "12px 13px" : "13px 16px",
        opacity: on ? 1 : 0.62,
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: checkpoint.template === "contact" ? C.blueW : C.sunken,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          color: checkpoint.template === "contact" ? C.blueS : C.t2,
          flexShrink: 0,
        }}
      >
        {templateGlyph(checkpoint.template)}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: isMobile ? 12.5 : 13.5,
            fontWeight: 500,
            color: C.t1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {checkpoint.label}
        </span>
        {isMobile && scope.kind !== "everywhere" && (
          <span
            style={{
              fontFamily: mono,
              fontSize: 9,
              letterSpacing: "0.08em",
              color: C.violetText,
            }}
          >
            {scope.label}
          </span>
        )}
      </span>
      {!isMobile && scopeChip}
      {checkpoint.isDefault === 1 && (
        <span
          style={{
            fontFamily: mono,
            fontSize: 8.5,
            letterSpacing: "0.06em",
            color: C.t3,
            background: C.sunken,
            borderRadius: 4,
            padding: "3px 7px",
            flexShrink: 0,
          }}
        >
          DEFAULT
        </span>
      )}
      {!checkpoint.enforced && (
        // Honest tag: this rule is declarative today — the permission
        // checker doesn't enforce it yet ("coming online").
        <span
          title="This rule is advisory — enforcement is coming online."
          style={{
            fontFamily: mono,
            fontSize: 8.5,
            letterSpacing: "0.06em",
            color: C.amberText,
            background: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
            borderRadius: 4,
            padding: "3px 7px",
            flexShrink: 0,
          }}
        >
          {isMobile ? "ADVISORY" : "ADVISORY · COMING ONLINE"}
        </span>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove checkpoint: ${checkpoint.label}`}
          title="Remove this checkpoint"
          style={{
            border: "none",
            background: "transparent",
            color: C.t3,
            fontSize: 13,
            lineHeight: 1,
            padding: "6px 4px",
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      ) : null}
      <Toggle on={on} label={checkpoint.label} onChange={onToggle} />
    </div>
  );
}

function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      style={{
        width: 34,
        height: 20,
        borderRadius: 11,
        border: "none",
        padding: 0,
        position: "relative",
        flexShrink: 0,
        cursor: "pointer",
        background: on ? C.blue : C.line2,
        transition: "background 120ms",
      }}
    >
      <span
        style={{
          position: "absolute",
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          top: 2,
          left: on ? 16 : 2,
          transition: "left 120ms",
        }}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// The 3-step composer — template → scope → name → POST.
// ---------------------------------------------------------------------------

type ScopeKind = "everywhere" | "agent" | "mission";

function CheckpointComposer({
  assistantId,
  agents,
  isMobile,
  onClose,
}: {
  assistantId: string;
  agents: Agent[];
  isMobile: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [template, setTemplate] = useState<CheckpointTemplate>("send_message");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("everywhere");
  const [scopeAgentId, setScopeAgentId] = useState<string | null>(null);
  const [scopeMissionId, setScopeMissionId] = useState<string | null>(null);
  const [label, setLabel] = useState(CHECKPOINT_TEMPLATES[0].defaultLabel);
  const [pattern, setPattern] = useState("");
  const [touchedName, setTouchedName] = useState(false);

  // Missions load lazily, only when "One mission" is picked.
  const missionsQuery = useQuery({
    ...missionsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "active" },
    }),
    enabled: scopeKind === "mission",
  });

  const createMutation = useMutation({
    ...guardrailsCheckpointsPostMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GUARDRAILS_KEY_PREFIX });
      onClose();
    },
  });

  const pickTemplate = (t: CheckpointTemplate) => {
    setTemplate(t);
    if (!touchedName) {
      setLabel(
        CHECKPOINT_TEMPLATES.find((m) => m.template === t)?.defaultLabel ?? "",
      );
    }
  };

  const scope =
    scopeKind === "agent" && scopeAgentId
      ? `agent:${scopeAgentId}`
      : scopeKind === "mission" && scopeMissionId
        ? `mission:${scopeMissionId}`
        : "everywhere";

  const canSave =
    label.trim().length > 0 &&
    (template !== "custom" || pattern.trim().length > 0) &&
    (scopeKind !== "agent" || scopeAgentId !== null) &&
    (scopeKind !== "mission" || scopeMissionId !== null) &&
    !createMutation.isPending;

  const save = () => {
    if (!canSave) return;
    const thresholdCents =
      template === "spend_over" ? parseThresholdCents(label) : undefined;
    createMutation.mutate({
      path: { assistant_id: assistantId },
      body: {
        template,
        label: label.trim(),
        scope,
        ...(template === "custom" ? { pattern: pattern.trim() } : {}),
        ...(thresholdCents !== undefined ? { thresholdCents } : {}),
      },
    });
  };

  const stepLabel = (text: string) => (
    <div style={{ fontSize: 11, color: C.t3, marginBottom: 7 }}>{text}</div>
  );

  return (
    <div
      style={{
        border: `1.5px dashed color-mix(in srgb, ${C.blue} 40%, transparent)`,
        background: `color-mix(in srgb, ${C.blue} 6%, transparent)`,
        borderRadius: 12,
        padding: 16,
        marginTop: 4,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.14em",
          color: C.blueS,
          marginBottom: 12,
        }}
      >
        + ADD A CHECKPOINT
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          {stepLabel("1 · Cue should ask before…")}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {CHECKPOINT_TEMPLATES.map((t) => {
              const active = t.template === template;
              return (
                <button
                  key={t.template}
                  type="button"
                  onClick={() => pickTemplate(t.template)}
                  style={{
                    fontSize: 12,
                    fontWeight: active ? 600 : 400,
                    color: active ? "#fff" : C.t2,
                    background: active ? C.blue : C.surface,
                    border: active
                      ? "1px solid transparent"
                      : `1px solid ${C.line2}`,
                    borderRadius: 8,
                    padding: "7px 12px",
                    cursor: "pointer",
                  }}
                >
                  {t.glyph} {t.chip}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          {stepLabel("2 · Where does it apply?")}
          <div
            style={{
              display: "inline-flex",
              background: C.sunken,
              borderRadius: 9,
              padding: 3,
              flexWrap: isMobile ? "wrap" : undefined,
            }}
          >
            {(
              [
                ["everywhere", "Everywhere"],
                ["agent", "One agent"],
                ["mission", "One mission"],
              ] as const
            ).map(([kind, text]) => {
              const active = scopeKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setScopeKind(kind)}
                  style={{
                    fontSize: 12,
                    fontWeight: active ? 600 : 400,
                    color: active ? C.t1 : C.t2,
                    background: active ? C.surface : "transparent",
                    border: active
                      ? `1px solid ${C.line2}`
                      : "1px solid transparent",
                    borderRadius: 7,
                    padding: "7px 14px",
                    cursor: "pointer",
                  }}
                >
                  {text}
                </button>
              );
            })}
          </div>
          {scopeKind === "agent" && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 8,
              }}
            >
              {agents.map((a) => {
                const active = scopeAgentId === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setScopeAgentId(a.id)}
                    style={{
                      fontSize: 11.5,
                      color: active ? C.blueS : C.t2,
                      background: active ? C.blueW : C.surface,
                      border: `1px solid ${active ? C.blueS : C.line2}`,
                      borderRadius: 7,
                      padding: "5px 10px",
                      cursor: "pointer",
                    }}
                  >
                    {agentGlyph(a.name, a.emoji)} {a.name}
                  </button>
                );
              })}
              {agents.length === 0 && (
                <span style={{ fontSize: 12, color: C.t3 }}>
                  No agents in the registry yet.
                </span>
              )}
            </div>
          )}
          {scopeKind === "mission" && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 8,
              }}
            >
              {missionsQuery.isLoading ? (
                <span style={{ fontSize: 12, color: C.t3 }}>
                  Loading missions…
                </span>
              ) : (missionsQuery.data?.missions.length ?? 0) === 0 ? (
                <span style={{ fontSize: 12, color: C.t3 }}>
                  No active missions yet.
                </span>
              ) : (
                missionsQuery.data?.missions.map((m) => {
                  const active = scopeMissionId === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setScopeMissionId(m.id)}
                      style={{
                        fontSize: 11.5,
                        color: active ? C.blueS : C.t2,
                        background: active ? C.blueW : C.surface,
                        border: `1px solid ${active ? C.blueS : C.line2}`,
                        borderRadius: 7,
                        padding: "5px 10px",
                        cursor: "pointer",
                        maxWidth: 220,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.title}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        {template === "custom" && (
          <div>
            {stepLabel("Custom pattern (tool or action to match)")}
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="e.g. email_send or shell:rm *"
              style={{
                width: "100%",
                fontSize: 13,
                fontFamily: mono,
                color: C.t1,
                background: C.surface,
                border: `1px solid ${C.line2}`,
                borderRadius: 9,
                padding: "10px 13px",
                outline: "none",
              }}
            />
          </div>
        )}

        <div>
          {stepLabel("3 · Name it")}
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: isMobile ? "wrap" : undefined,
            }}
          >
            <input
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setTouchedName(true);
              }}
              placeholder="e.g. Spending over $25 on ads"
              style={{
                flex: 1,
                minWidth: isMobile ? "100%" : 220,
                fontSize: 13,
                color: C.t1,
                background: C.surface,
                border: `1px solid ${C.line2}`,
                borderRadius: 9,
                padding: "10px 13px",
                outline: "none",
              }}
            />
            <button
              type="button"
              disabled={!canSave}
              onClick={save}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                background: C.blue,
                color: "#fff",
                border: "none",
                borderRadius: 9,
                padding: "10px 17px",
                cursor: canSave ? "pointer" : "default",
                opacity: canSave ? 1 : 0.55,
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              {createMutation.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              Save checkpoint
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                fontSize: 12.5,
                color: C.t3,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "10px 4px",
              }}
            >
              Cancel
            </button>
          </div>
          {createMutation.isError && (
            <div style={{ fontSize: 12, color: C.dangerText, marginTop: 7 }}>
              Couldn&rsquo;t save the checkpoint — try again.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Band 2 · AGENT SCOPES
// ---------------------------------------------------------------------------

function AgentScopesBand({
  assistantId,
  agents,
  toolScopesByAgent,
  isMobile,
}: {
  assistantId: string;
  agents: Agent[];
  toolScopesByAgent: ToolScopesByAgent | undefined;
  isMobile: boolean;
}) {
  if (agents.length === 0) {
    return (
      <div style={{ fontSize: 13, color: C.t2 }}>
        No agents in the registry yet — hire one from HQ and its scopes show up
        here.
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
        gap: 14,
        alignItems: "start",
      }}
    >
      {agents.map((agent, i) => (
        <AgentCard
          key={agent.id}
          assistantId={assistantId}
          agent={agent}
          toolScopes={toolScopesByAgent?.get(agent.id)}
          hue={agentHue(agent.name, i)}
        />
      ))}
    </div>
  );
}

function AgentCard({
  assistantId,
  agent,
  toolScopes,
  hue,
}: {
  assistantId: string;
  agent: Agent;
  /** Real scopes from the registry read; undefined = not loaded yet. */
  toolScopes: string[] | null | undefined;
  hue: string;
}) {
  const queryClient = useQueryClient();
  const patchAgent = useMutation({
    ...agentsByIdPatchMutation(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GUARDRAILS_KEY_PREFIX });
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY_PREFIX });
    },
  });

  const paused = agent.paused === 1;
  const cap = agent.spend.capCents;
  const spent = agent.spend.spentCents;
  const ratio = cap && cap > 0 ? spent / cap : 0;
  // A cap only actually stops the agent when hard-stop is enabled; otherwise
  // `capCents` is advisory and background runs keep going past it.
  const enforced = agent.hardStopEnabled === 1;
  const overCap = !paused && cap !== null && cap > 0 && spent >= cap;
  const atCap = overCap && enforced;
  const overAdvisory = overCap && !enforced;
  const nearCap =
    !paused && !overCap && cap !== null && cap > 0 && ratio >= 0.8;

  const barColor = atCap ? C.danger : overAdvisory || nearCap ? C.amber : hue;
  const fallbackChips = agentToolChips(agent);

  const badge = paused
    ? { text: "▪ PAUSED", color: C.t3, bg: C.sunken }
    : atCap
      ? {
          text: "◼ AT CAP",
          color: C.danger,
          bg: `color-mix(in srgb, ${C.danger} 12%, transparent)`,
        }
      : overAdvisory
        ? {
            text: "OVER CAP",
            color: C.amberText,
            bg: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
          }
        : nearCap
          ? {
              text: "NEAR CAP",
              color: C.amberText,
              bg: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
            }
          : { text: "ACTIVE", color: C.green, bg: C.greenW };

  const raiseCapCents =
    cap !== null && cap > 0 ? Math.ceil((cap * 1.5) / 100) * 100 : null;

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${
          atCap ? `color-mix(in srgb, ${C.danger} 35%, transparent)` : C.line
        }`,
        borderRadius: 13,
        padding: "17px 18px",
        opacity: paused ? 0.72 : 1,
      }}
    >
      {/* identity line */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: `color-mix(in srgb, ${hue} 14%, transparent)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: hue,
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          {agentGlyph(agent.name, agent.emoji)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
            {agent.name}
          </div>
          <div style={{ fontSize: 10.5, color: C.t3 }}>
            Tier {agent.tier} · {tierDescriptor(agent.tier)}
          </div>
        </div>
        <span
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            letterSpacing: "0.04em",
            color: badge.color,
            background: badge.bg,
            borderRadius: 5,
            padding: "3px 8px",
            whiteSpace: "nowrap",
          }}
        >
          {badge.text}
        </span>
      </div>

      {atCap && (
        <div style={{ fontSize: 10.5, color: C.t3, marginTop: 6 }}>
          Stopped itself at the line — nothing overran.
        </div>
      )}

      {/* tool scopes — real chips + edit once the registry read resolves;
          enforced by the daemon on this agent's background runs. */}
      <ToolScopesRow
        toolScopes={toolScopes}
        fallbackChips={fallbackChips}
        paused={paused}
        saving={patchAgent.isPending}
        onSave={(scopes, done) =>
          patchAgent.mutate(
            {
              path: { assistant_id: assistantId, id: agent.id },
              body: { toolScopes: scopes },
            },
            { onSuccess: done },
          )
        }
      />

      {/* spend vs cap */}
      <div style={{ marginTop: 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            marginBottom: 6,
          }}
        >
          <span style={{ color: C.t3 }}>Spend</span>
          <span
            style={{
              fontFamily: mono,
              color: atCap ? C.danger : nearCap ? C.amber : C.t2,
            }}
          >
            {paused
              ? `${dollars(spent)} while paused`
              : cap !== null && cap > 0
                ? `${dollars(spent)} of ${dollars(cap)}/wk`
                : `${dollars(spent)} · no cap`}
          </span>
        </div>
        <div
          style={{
            height: 5,
            borderRadius: 3,
            background: C.sunken,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, Math.round(ratio * 100))}%`,
              height: "100%",
              background: barColor,
              borderRadius: 3,
            }}
          />
        </div>
      </div>

      {atCap ? (
        // Over-cap decision (STATES · "over cap · agent paused itself").
        <>
          <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
            {raiseCapCents !== null && (
              <button
                type="button"
                disabled={patchAgent.isPending}
                onClick={() =>
                  patchAgent.mutate({
                    path: { assistant_id: assistantId, id: agent.id },
                    body: { capCents: raiseCapCents },
                  })
                }
                style={{
                  flex: 1.3,
                  fontSize: 12,
                  fontWeight: 600,
                  background: C.blue,
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "10px 0",
                  cursor: "pointer",
                }}
              >
                Raise to {dollars(raiseCapCents)} &amp; continue
              </button>
            )}
            <button
              type="button"
              disabled={patchAgent.isPending}
              onClick={() =>
                patchAgent.mutate({
                  path: { assistant_id: assistantId, id: agent.id },
                  body: { paused: true },
                })
              }
              style={{
                flex: 1,
                fontSize: 12,
                color: C.t2,
                background: C.sunken,
                border: `1px solid ${C.line2}`,
                borderRadius: 8,
                padding: "10px 0",
                cursor: "pointer",
              }}
            >
              Keep paused
            </button>
          </div>
          <div
            style={{
              fontSize: 10,
              color: C.t3,
              marginTop: 10,
              textAlign: "center",
            }}
          >
            Resumes Monday either way · cap lives in Guardrails
          </div>
        </>
      ) : overAdvisory ? (
        // Over the cap, but the cap is advisory — runs did NOT stop. Offer to
        // enforce it (arm the hard-stop) or raise it.
        <>
          <div style={{ fontSize: 10.5, color: C.amberText, marginTop: 6 }}>
            Over the weekly cap — advisory only, so runs kept going.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
            <button
              type="button"
              disabled={patchAgent.isPending}
              onClick={() =>
                patchAgent.mutate({
                  path: { assistant_id: assistantId, id: agent.id },
                  body: { hardStopEnabled: true },
                })
              }
              style={{
                flex: 1.3,
                fontSize: 12,
                fontWeight: 600,
                background: C.blue,
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "10px 0",
                cursor: "pointer",
              }}
            >
              Enforce cap — stop future runs
            </button>
            {raiseCapCents !== null && (
              <button
                type="button"
                disabled={patchAgent.isPending}
                onClick={() =>
                  patchAgent.mutate({
                    path: { assistant_id: assistantId, id: agent.id },
                    body: { capCents: raiseCapCents },
                  })
                }
                style={{
                  flex: 1,
                  fontSize: 12,
                  color: C.t2,
                  background: C.sunken,
                  border: `1px solid ${C.line2}`,
                  borderRadius: 8,
                  padding: "10px 0",
                  cursor: "pointer",
                }}
              >
                Raise to {dollars(raiseCapCents)}
              </button>
            )}
          </div>
        </>
      ) : paused ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginTop: 14,
            paddingTop: 13,
            borderTop: `1px solid ${C.line}`,
          }}
        >
          <span style={{ fontSize: 11.5, color: C.t3 }}>Paused</span>
          <button
            type="button"
            disabled={patchAgent.isPending}
            onClick={() =>
              patchAgent.mutate({
                path: { assistant_id: assistantId, id: agent.id },
                body: { paused: false },
              })
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              color: C.blueS,
              background: C.blueW,
              border: "none",
              borderRadius: 8,
              padding: "7px 14px",
              cursor: "pointer",
            }}
          >
            ▶ Resume
          </button>
        </div>
      ) : (
        <>
          <ModelPinRow
            agent={agent}
            onPin={(model) =>
              patchAgent.mutate({
                path: { assistant_id: assistantId, id: agent.id },
                body: { model },
              })
            }
          />
          {cap !== null && cap > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                marginTop: 12,
                paddingTop: 12,
                borderTop: `1px solid ${C.line}`,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11.5, color: C.t2 }}>
                  Cap enforcement
                </div>
                <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>
                  {enforced
                    ? "Hard-stops background runs at the cap"
                    : "Advisory — warns but keeps running"}
                </div>
              </div>
              <button
                type="button"
                disabled={patchAgent.isPending}
                onClick={() =>
                  patchAgent.mutate({
                    path: { assistant_id: assistantId, id: agent.id },
                    body: { hardStopEnabled: !enforced },
                  })
                }
                style={{
                  flexShrink: 0,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: enforced ? C.blueS : C.t2,
                  background: enforced ? C.blueW : C.sunken,
                  border: `1px solid ${enforced ? "transparent" : C.line2}`,
                  borderRadius: 8,
                  padding: "7px 14px",
                  cursor: "pointer",
                }}
              >
                {enforced ? "◼ Enforced" : "Enforce"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The tool-scope chips row. Three states:
 *   - registry not loaded (`toolScopes` undefined): fallback chips,
 *     display-only, no edit affordance;
 *   - loaded, scoped (array): the real allowlist chips + "edit ✎";
 *   - loaded, null: subtle "unrestricted" label + "edit ✎".
 * Edit mode toggles chips over the daemon's known scope set and PATCHes
 * `toolScopes` (all-on collapses to null = unrestricted).
 */
function ToolScopesRow({
  toolScopes,
  fallbackChips,
  paused,
  saving,
  onSave,
}: {
  toolScopes: string[] | null | undefined;
  fallbackChips: string[];
  paused: boolean;
  saving: boolean;
  onSave: (scopes: string[] | null, done: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const loaded = toolScopes !== undefined;
  const chips = loaded ? (toolScopes ?? []) : fallbackChips;

  if (!loaded && fallbackChips.length === 0) return null;

  const chipStyle = (active: boolean): CSSProperties => ({
    fontSize: 11,
    color: active ? C.t2 : C.t3,
    background: active ? C.sunken : "transparent",
    border: active ? "1px solid transparent" : `1px dashed ${C.line2}`,
    borderRadius: 6,
    padding: "4px 9px",
  });

  if (editing) {
    const toggle = (id: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };
    return (
      <div style={{ marginTop: 13 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {TOOL_SCOPE_IDS.map((id) => {
            const on = selected.has(id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(id)}
                style={{ ...chipStyle(on), cursor: "pointer" }}
              >
                {on ? "✓ " : ""}
                {id}
              </button>
            );
          })}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 9,
          }}
        >
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              onSave(normalizeToolScopeSelection(selected), () =>
                setEditing(false),
              )
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              fontWeight: 600,
              color: "#fff",
              background: C.blue,
              border: "none",
              borderRadius: 7,
              padding: "5px 12px",
              cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving && <Loader2 className="size-3 animate-spin" />}
            Save scopes
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            style={{
              fontSize: 11.5,
              color: C.t3,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Cancel
          </button>
          <span style={{ fontSize: 10, color: C.t3, marginLeft: "auto" }}>
            all on = unrestricted
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        marginTop: 13,
        opacity: paused ? 0.7 : 1,
      }}
    >
      {loaded && toolScopes === null ? (
        <span style={{ fontSize: 11, color: C.t3, fontStyle: "italic" }}>
          unrestricted — every tool
        </span>
      ) : (
        chips.map((chip) => (
          <span
            key={chip}
            style={{
              fontSize: 11,
              color: C.t2,
              background: C.sunken,
              borderRadius: 6,
              padding: "4px 9px",
            }}
          >
            {chip}
          </span>
        ))
      )}
      {loaded && (
        <button
          type="button"
          onClick={() => {
            setSelected(new Set(toolScopes ?? TOOL_SCOPE_IDS));
            setEditing(true);
          }}
          style={{
            fontSize: 11,
            color: C.blueS,
            background: "transparent",
            border: `1px dashed color-mix(in srgb, ${C.blue} 30%, transparent)`,
            borderRadius: 6,
            padding: "4px 9px",
            cursor: "pointer",
          }}
        >
          edit ✎
        </button>
      )}
    </div>
  );
}

/** The model pin picker — Best / Fast / Custom, wired to PATCH agents/:id. */
function ModelPinRow({
  agent,
  onPin,
}: {
  agent: Agent;
  onPin: (model: string | null) => void;
}) {
  // A per-agent model pin is vendor machinery — it names models ("Best ·
  // Sonnet 4.5") and lets the user type a raw slug. Managed instances hide
  // it for the same reason Settings → Models & Services is hidden there.
  const hideVendor = useHideVendorUi();
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customModel, setCustomModel] = useState(agent.model ?? "");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCustomOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (hideVendor) return null;

  const display = modelPinDisplay(agent.model);

  const pin = (model: string | null) => {
    onPin(model);
    setOpen(false);
    setCustomOpen(false);
  };

  return (
    <div
      ref={rootRef}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        marginTop: 14,
        paddingTop: 13,
        borderTop: `1px solid ${C.line}`,
        position: "relative",
      }}
    >
      <span style={{ fontSize: 11, color: C.t3 }}>Model</span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontSize: 11.5,
          color: display.pinned ? C.blueS : C.t1,
          background: display.pinned ? C.blueW : C.sunken,
          border: `1px solid ${
            display.pinned
              ? `color-mix(in srgb, ${C.blue} 35%, transparent)`
              : C.line2
          }`,
          borderRadius: 7,
          padding: "5px 10px",
          cursor: "pointer",
        }}
      >
        {display.glyph} {display.label}{" "}
        <span style={{ color: C.t3 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 5,
            background: C.surface,
            border: `1px solid ${C.line2}`,
            borderRadius: 12,
            padding: 8,
            boxShadow: "0 30px 60px -20px rgba(0,0,0,0.45)",
          }}
        >
          {MODEL_PIN_OPTIONS.map((opt) => {
            const selected =
              opt.id !== "custom" &&
              agent.model !== null &&
              opt.model === agent.model;
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  if (opt.id === "custom") {
                    setCustomOpen(true);
                  } else {
                    pin(opt.model);
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                  borderRadius: 8,
                  padding: "9px 11px",
                  background: selected ? C.blueW : "transparent",
                  border: selected
                    ? `1px solid color-mix(in srgb, ${C.blue} 30%, transparent)`
                    : "1px solid transparent",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: selected ? 600 : 400,
                    color: selected ? C.blueS : C.t2,
                  }}
                >
                  {opt.glyph} {opt.label}
                </span>
                <span
                  style={{ fontSize: 10.5, color: C.t3, marginLeft: "auto" }}
                >
                  {opt.hint}
                </span>
                {selected && (
                  <span style={{ color: C.blue, fontSize: 12 }}>✓</span>
                )}
              </button>
            );
          })}
          {customOpen && (
            <div style={{ display: "flex", gap: 6, padding: "8px 6px 4px" }}>
              <input
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="provider/model-id"
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  fontFamily: mono,
                  color: C.t1,
                  background: C.sunken,
                  border: `1px solid ${C.line2}`,
                  borderRadius: 7,
                  padding: "6px 9px",
                  outline: "none",
                }}
              />
              <button
                type="button"
                disabled={customModel.trim().length === 0}
                onClick={() => pin(customModel.trim())}
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "#fff",
                  background: C.blue,
                  border: "none",
                  borderRadius: 7,
                  padding: "6px 12px",
                  cursor: "pointer",
                }}
              >
                Pin
              </button>
            </div>
          )}
          {agent.model !== null && (
            <button
              type="button"
              role="menuitem"
              onClick={() => pin(null)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "center",
                fontSize: 11,
                color: C.t3,
                background: "transparent",
                border: "none",
                borderTop: `1px solid ${C.line}`,
                padding: "8px 0 4px",
                marginTop: 4,
                cursor: "pointer",
              }}
            >
              Clear pin — use the workspace default
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Band 3 · THE LEDGER
// ---------------------------------------------------------------------------

function LedgerBand({
  assistantId,
  ledger,
  agents,
  fresh,
}: {
  assistantId: string;
  ledger: GuardrailsPayload["ledger"];
  agents: Agent[];
  fresh: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hideVendor = useHideVendorUi();
  const { recentActs, heldItems, summary } = ledger;

  // Honest per-act note when reverse 409s (nothing concrete to unwind).
  const [reverseNotes, setReverseNotes] = useState<Record<string, string>>({});

  const reverseMutation = useMutation({
    ...actsByIdReversePostMutation(),
    onMutate: (vars) => {
      // Optimistic strike-through in every cached window.
      queryClient.setQueriesData<GuardrailsPayload>(
        { queryKey: GUARDRAILS_KEY_PREFIX },
        (prev) =>
          prev
            ? {
                ...prev,
                ledger: {
                  ...prev.ledger,
                  recentActs: prev.ledger.recentActs.map((a) =>
                    a.id === vars.path.id ? { ...a, reversed: 1 } : a,
                  ),
                },
              }
            : prev,
      );
    },
    onError: (error, vars) => {
      const code = reverseConflictCode(error);
      setReverseNotes((prev) => ({
        ...prev,
        [vars.path.id]:
          code === "already_reversed"
            ? "Already reversed."
            : code === "no_undo"
              ? "Nothing to unwind — already executed."
              : "Couldn't reverse — try again.",
      }));
    },
    onSettled: () =>
      // Refetch gives the truth either way (rolls back a failed optimistic
      // flip; picks up the real reversedAt on success).
      queryClient.invalidateQueries({ queryKey: GUARDRAILS_KEY_PREFIX }),
  });

  const agentByName = useMemo(() => {
    const map = new Map<string, { agent: Agent; hue: string }>();
    agents.forEach((a, i) =>
      map.set(a.name.toLowerCase(), { agent: a, hue: agentHue(a.name, i) }),
    );
    return map;
  }, [agents]);

  // Up to 3 named held rows; the rest collapse into "and N more".
  const shownHeld = heldItems.slice(0, 3);
  const moreHeld = summary.heldCount - shownHeld.length;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {shownHeld.map((item) => {
        const meta = item.agent
          ? agentByName.get(item.agent.toLowerCase())
          : undefined;
        const agentLabel = item.agent
          ? `${
              meta
                ? agentGlyph(meta.agent.name, meta.agent.emoji)
                : agentGlyph(item.agent)
            } ${meta?.agent.name ?? item.agent}`
          : null;
        return (
          <HeldRow
            key={item.requestId}
            title={`Held for your approval — ${item.title}`}
            sub={`${agentLabel ? `${agentLabel} · ` : ""}${heldAgeLabel(
              item.ageMs,
            )} ago · waiting in HQ's `}
            onReview={() => navigate(routes.hq)}
          />
        );
      })}
      {shownHeld.length === 0 && summary.heldCount > 0 && (
        // Fallback count-only row when the payload named none.
        <HeldRow
          title={`Held for your approval — ${
            summary.heldCount === 1
              ? "1 action waiting"
              : `${summary.heldCount} actions waiting`
          }`}
          sub="A checkpoint fired · waiting in HQ's "
          onReview={() => navigate(routes.hq)}
        />
      )}
      {moreHeld > 0 && shownHeld.length > 0 && (
        <div
          style={{
            fontSize: 11,
            color: C.t3,
            padding: "0 14px 8px",
          }}
        >
          and {moreHeld} more waiting in HQ&rsquo;s{" "}
          <span style={{ color: C.amberText }}>Needs you</span>
        </div>
      )}

      {recentActs.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.t3, padding: "8px 2px" }}>
          {fresh
            ? "The ledger is empty — it fills as Cue works."
            : "No acts in this window yet."}
        </div>
      ) : (
        recentActs.map((act, i) => {
          const meta = agentByName.get(act.agent.toLowerCase());
          const hue = meta?.hue ?? C.t3;
          const glyph = meta
            ? agentGlyph(meta.agent.name, meta.agent.emoji)
            : agentGlyph(act.agent);
          const reversing =
            reverseMutation.isPending &&
            reverseMutation.variables?.path.id === act.id;
          const note = reverseNotes[act.id];
          return (
            <div
              key={act.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 13,
                padding: "11px 14px",
                borderBottom:
                  i < recentActs.length - 1 ? `1px solid ${C.line}` : "none",
                opacity: act.reversed === 1 ? 0.6 : 1,
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: C.sunken,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: hue,
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                {glyph}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: C.t1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textDecoration:
                      act.reversed === 1 ? "line-through" : "none",
                  }}
                >
                  {act.title ?? ACT_TITLES[act.kind]}
                </div>
                <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>
                  {/* mock meta: "⚙ Ops · 1 h ago · $0.06 · Haiku" — $ and
                      model only when measured (null = unknown, never $0). */}
                  {glyph} {act.agent} · {timeAgo(act.createdAt)}
                  {act.costCents !== null ? ` · ${dollars(act.costCents)}` : ""}
                  {act.model !== null && !hideVendor
                    ? ` · ${modelShortName(act.model)}`
                    : ""}
                  {act.estMinutesSaved !== null && act.reversed !== 1
                    ? ` · ~${act.estMinutesSaved} min saved`
                    : ""}
                </div>
                {note && act.reversed !== 1 && (
                  <div
                    style={{ fontSize: 10.5, color: C.amberText, marginTop: 3 }}
                  >
                    {note}
                  </div>
                )}
              </div>
              {act.reversed === 1 ? (
                <span style={{ fontSize: 11, color: C.t3, flexShrink: 0 }}>
                  ↩ reversed
                </span>
              ) : act.kind === "message_drafted" ? (
                <span style={{ fontSize: 11, color: C.t3, flexShrink: 0 }}>
                  draft — nothing sent
                </span>
              ) : (
                <button
                  type="button"
                  disabled={reversing}
                  onClick={() =>
                    reverseMutation.mutate({
                      path: { assistant_id: assistantId, id: act.id },
                    })
                  }
                  style={{
                    fontSize: 11,
                    color: C.blueS,
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: reversing ? "default" : "pointer",
                    opacity: reversing ? 0.6 : 1,
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  ↩ Reverse
                </button>
              )}
            </div>
          );
        })
      )}

      <button
        type="button"
        onClick={() => navigate(routes.missionControl)}
        style={{
          textAlign: "center",
          fontSize: 12,
          color: C.t3,
          background: "transparent",
          border: "none",
          borderTop: `1px solid ${C.line}`,
          paddingTop: 12,
          marginTop: recentActs.length === 0 ? 4 : 0,
          cursor: "pointer",
        }}
      >
        See the full ledger — every act since day one ›
      </button>
    </div>
  );
}

/**
 * One held-for-approval row — a checkpoint fired and the act is waiting.
 * Pending confirmations live in HQ's "Needs you" lane; Review jumps there.
 */
function HeldRow({
  title,
  sub,
  onReview,
}: {
  title: string;
  sub: string;
  onReview: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        padding: "12px 14px",
        background: `color-mix(in srgb, ${C.amber} 7%, transparent)`,
        border: `1px solid color-mix(in srgb, ${C.amber} 25%, transparent)`,
        borderRadius: 11,
        marginBottom: 8,
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: `color-mix(in srgb, ${C.amber} 14%, transparent)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: C.amber,
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        ⏸
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: C.t1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>
          {sub}
          <span style={{ color: C.amberText }}>Needs you</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onReview}
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          background: C.blue,
          color: "#fff",
          border: "none",
          borderRadius: 7,
          padding: "6px 12px",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        Review
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SET 3 · Usage & spend — the honest rollup.
// ---------------------------------------------------------------------------

const MIX_HUES = [C.teal, C.blue, C.violet, C.green, C.amber];

function UsageBand({
  data,
  days,
  onDaysChange,
  isMobile,
}: {
  data: GuardrailsPayload;
  days: 7 | 30;
  onDaysChange: (d: 7 | 30) => void;
  isMobile: boolean;
}) {
  const { agents, ledger } = data;
  const summary = ledger.summary;
  const [copied, setCopied] = useState(false);
  // The mix band's entire content is model names; there is no vendor-neutral
  // version of "62% Sonnet / 38% Haiku" worth showing, so managed instances
  // drop the band rather than render N identical neutral labels.
  const hideVendor = useHideVendorUi();

  const byModel = summary.byModel.filter((m) => m.share > 0);
  const windowWord = days === 7 ? "week" : "month";

  const share = async () => {
    const text = `This ${windowWord} Cue did ${summary.actCount} things for ${dollars(
      summary.totalCents,
    )} — ${summary.heldCount} held for approval, ${summary.reversedCount} reversed. Every act on the ledger.`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div style={{ padding: isMobile ? "20px 0" : "26px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: C.blueW,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: C.blueS,
            fontSize: 13,
          }}
        >
          $
        </span>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.t1 }}>
            Usage &amp; spend
          </div>
          <div style={{ fontSize: 11, color: C.t3 }}>
            Inside Guardrails · resets Monday
          </div>
        </div>
        <span
          style={{
            display: "inline-flex",
            background: C.sunken,
            borderRadius: 8,
            padding: 3,
          }}
        >
          {(
            [
              [7, "Week"],
              [30, "Month"],
            ] as const
          ).map(([d, text]) => {
            const active = days === d;
            return (
              <button
                key={d}
                type="button"
                onClick={() => onDaysChange(d)}
                style={{
                  fontSize: 11.5,
                  fontWeight: active ? 600 : 400,
                  color: active ? C.t1 : C.t2,
                  background: active ? C.surface : "transparent",
                  border: active
                    ? `1px solid ${C.line2}`
                    : "1px solid transparent",
                  borderRadius: 6,
                  padding: "6px 13px",
                  cursor: "pointer",
                }}
              >
                {text}
              </button>
            );
          })}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1.2fr 1fr",
          gap: isMobile ? 20 : 34,
          alignItems: "start",
        }}
      >
        {/* left — per-agent $ vs cap */}
        <div>
          <MicroLabel>BY AGENT</MicroLabel>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              marginTop: 13,
            }}
          >
            {agents.map((agent, i) => {
              const cap = agent.spend.capCents;
              const spent = agent.spend.spentCents;
              const ratio = cap && cap > 0 ? spent / cap : 0;
              const paused = agent.paused === 1;
              const over = cap !== null && cap > 0 && spent >= cap;
              const near = !over && cap !== null && cap > 0 && ratio >= 0.8;
              const hue = over
                ? C.danger
                : near
                  ? C.amber
                  : agentHue(agent.name, i);
              return (
                <div key={agent.id}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 12,
                      marginBottom: 6,
                    }}
                  >
                    <span style={{ color: paused ? C.t2 : C.t1 }}>
                      {agentGlyph(agent.name, agent.emoji)} {agent.name}
                    </span>
                    <span
                      style={{
                        fontFamily: mono,
                        color: paused
                          ? C.t3
                          : over
                            ? C.danger
                            : near
                              ? C.amber
                              : C.t2,
                      }}
                    >
                      {paused ? (
                        `${dollars(spent)} · paused`
                      ) : cap !== null && cap > 0 ? (
                        <>
                          {dollars(spent)}{" "}
                          <span style={{ color: C.t3 }}>/ {dollars(cap)}</span>
                        </>
                      ) : (
                        `${dollars(spent)} · no cap`
                      )}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 5,
                      borderRadius: 3,
                      background: C.sunken,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, Math.round(ratio * 100))}%`,
                        height: "100%",
                        background: hue,
                        borderRadius: 3,
                      }}
                    />
                  </div>
                </div>
              );
            })}
            {agents.length === 0 && (
              <span style={{ fontSize: 12, color: C.t3 }}>
                No agents yet — per-agent spend shows up here.
              </span>
            )}
          </div>
          {summary.byMission.length > 0 && (
            // Per-mission attributed $, highest first (mirrors BY AGENT;
            // bars scale against the costliest mission). Omitted when the
            // window attributed nothing to a mission.
            <div style={{ marginTop: 22 }}>
              <MicroLabel>BY MISSION</MicroLabel>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  marginTop: 13,
                }}
              >
                {summary.byMission.map((m, i) => {
                  const max = summary.byMission[0]?.costCents ?? 0;
                  const ratio = max > 0 ? m.costCents / max : 0;
                  const hue = MIX_HUES[i % MIX_HUES.length];
                  return (
                    <div key={m.missionId}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          fontSize: 12,
                          marginBottom: 6,
                        }}
                      >
                        <span
                          style={{
                            color: C.t1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.missionTitle}
                        </span>
                        <span
                          style={{
                            fontFamily: mono,
                            color: C.t2,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {dollars(m.costCents)}{" "}
                          <span style={{ color: C.t3 }}>
                            · {m.runs} {m.runs === 1 ? "run" : "runs"}
                          </span>
                        </span>
                      </div>
                      <div
                        style={{
                          height: 5,
                          borderRadius: 3,
                          background: C.sunken,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.min(100, Math.round(ratio * 100))}%`,
                            height: "100%",
                            background: hue,
                            borderRadius: 3,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* right — model mix + the share-able summary card */}
        <div>
          {hideVendor ? null : <MicroLabel>MODEL MIX</MicroLabel>}
          {hideVendor ? null : byModel.length === 0 ? (
            <div style={{ fontSize: 12, color: C.t3, marginTop: 12 }}>
              No model usage in this window yet.
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  height: 8,
                  borderRadius: 4,
                  overflow: "hidden",
                  marginTop: 13,
                }}
              >
                {byModel.map((m, i) => (
                  <span
                    key={m.model}
                    style={{
                      width: `${Math.max(1, Math.round(m.share * 100))}%`,
                      background: MIX_HUES[i % MIX_HUES.length],
                    }}
                  />
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 13,
                  marginTop: 8,
                  fontSize: 10.5,
                  color: C.t2,
                  flexWrap: "wrap",
                }}
              >
                {byModel.map((m, i) => (
                  <span key={m.model}>
                    <span style={{ color: MIX_HUES[i % MIX_HUES.length] }}>
                      ●
                    </span>{" "}
                    {Math.round(m.share * 100)}% {modelShortName(m.model)}
                  </span>
                ))}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: C.t3,
                  marginTop: 10,
                  lineHeight: 1.5,
                }}
              >
                Routine acts run on the cheap model; drafting and judgment run
                on the best one. You set this per agent.
              </div>
            </>
          )}

          {/* share-able summary — stays dark in both themes, like the HQ hero */}
          <div
            style={{
              background: "linear-gradient(150deg, #16202E, #0C121B)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 13,
              padding: "16px 18px",
              marginTop: 16,
            }}
          >
            <div
              style={{
                fontFamily: mono,
                fontSize: 9,
                letterSpacing: "0.14em",
                color: "rgba(234,238,244,0.4)",
              }}
            >
              THIS {days === 7 ? "WEEK" : "MONTH"}
            </div>
            <div
              style={{
                fontFamily: serif,
                fontSize: 21,
                color: "#EAEEF4",
                marginTop: 7,
              }}
            >
              Cue did {summary.actCount}{" "}
              {summary.actCount === 1 ? "thing" : "things"} for{" "}
              <span style={{ color: "#9DB8F4", fontStyle: "italic" }}>
                {dollars(summary.totalCents)}
              </span>
            </div>
            <div
              style={{
                fontSize: 11,
                color: "rgba(234,238,244,0.55)",
                marginTop: 6,
              }}
            >
              {summary.heldCount} held for approval · {summary.reversedCount}{" "}
              reversed · every act on the ledger
            </div>
            <button
              type="button"
              onClick={() => void share()}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: "#EAEEF4",
                background: "rgba(255,255,255,0.10)",
                border: "1px solid rgba(255,255,255,0.16)",
                borderRadius: 7,
                padding: "6px 12px",
                marginTop: 12,
                cursor: "pointer",
              }}
            >
              {copied ? "✓ Copied" : "⤴ Share"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MicroLabel({ children }: { children: ReactNode }) {
  const style: CSSProperties = {
    fontFamily: mono,
    fontSize: 9.5,
    letterSpacing: "0.14em",
    color: C.t3,
  };
  return <div style={style}>{children}</div>;
}
