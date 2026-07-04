/**
 * Trust & consent console (design v0.3 §03).
 *
 * The "who can reach Cue" audit is wired to real data: contacts grouped by
 * actor role (guardian = full, everyone else = scoped, unknown = fail-closed —
 * the daemon's default-deny policy). The capture toggles are real consent
 * preferences persisted to localStorage; they set defaults for the always-on
 * capture pipeline (net-new, Phase 3) — consent-first, off until you opt in.
 */

import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  contactsGetOptions,
  trustrulesGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  getAutonomyPolicies,
  setAutonomyPolicies,
  type AutonomyCategory,
  type AutonomyMode,
  type AutonomyPolicies,
} from "@/lib/autonomy-policies-api";

const C = {
  ink: "var(--mv1-t1)",
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
  danger: "var(--mv1-danger)",
  amber: "var(--mv1-amber)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

// One entry of the daemon's default-deny permission policy (trustrulesGet).
type TrustRule = {
  id: string;
  tool: string;
  pattern: string;
  risk: "low" | "medium" | "high";
  description: string;
  origin: "default" | "user_defined";
  userModified: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
};

// Riskiest first, so the most consequential capabilities are most visible.
const RISK_ORDER: ReadonlyArray<TrustRule["risk"]> = ["high", "medium", "low"];
const RISK_META: Record<TrustRule["risk"], { label: string; dot: string }> = {
  high: { label: "High risk", dot: C.danger },
  medium: { label: "Medium risk", dot: C.amber },
  low: { label: "Low risk", dot: C.green },
};

// Capture consent prefs — real, persisted, but not yet enforced by a capture
// backend (Phase 3). Kept here so the user's choices stick.
const PREF_KEYS = {
  alwaysOn: "cue:trust:alwaysOnCapture",
  indicator: "cue:trust:recordingIndicator",
  autoDelete: "cue:trust:autoDeleteAudio",
} as const;

function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* localStorage unavailable */
  }
}

export function TrustConsolePage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const contactsQuery = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.contacts,
  });

  // The real default-deny permission policy: what tools Cue may use, on what
  // patterns, by risk. Read-only here — the contract exposes get + suggest only.
  const rulesQuery = useQuery({
    ...trustrulesGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.rules.filter((rule) => !rule.deleted),
  });

  const { guardians, trusted } = useMemo(() => {
    const list = contactsQuery.data ?? [];
    return {
      guardians: list.filter((c) => c.role === "guardian"),
      trusted: list.filter(
        (c) => c.role !== "guardian" && c.role !== "assistant",
      ),
    };
  }, [contactsQuery.data]);

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: 24 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 11.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: C.blueS,
            marginBottom: 10,
          }}
        >
          Trust &amp; consent
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 500,
            color: C.t1,
            marginBottom: 16,
          }}
        >
          Trust &amp; consent console
        </div>

        <div style={{ marginBottom: 18 }}>
          <AutonomyPolicyPanel assistantId={assistantId} />
        </div>

        <div style={{ marginBottom: 18 }}>
          <PermissionRulesPanel
            loading={rulesQuery.isLoading}
            error={rulesQuery.isError}
            rules={rulesQuery.data ?? []}
            onSuggest={() => navigate("/assistant/")}
          />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
            gap: 18,
            alignItems: "start",
          }}
        >
          <CapturePanel />
          <AuditPanel
            loading={contactsQuery.isLoading}
            guardianName={guardians[0]?.displayName ?? "You"}
            trusted={trusted.map((c) => c.displayName)}
          />
        </div>
      </div>
    </div>
  );
}

// ── Autonomy policy matrix ─────────────────────────────────────────────────
// The heart of "trust": the user sets autonomy per ACTION CATEGORY. Research
// and drafting can auto-run; sending, money, and deletes ask by default. This
// is enforced in the daemon's permission gate — "ask" holds even at Full
// access, and "never" denies outright.

const AUTONOMY_ROWS: ReadonlyArray<{
  category: AutonomyCategory;
  label: string;
  sub: string;
  accent: string;
}> = [
  {
    category: "research",
    label: "Research / Read",
    sub: "Search, read, fetch, look things up",
    accent: C.green,
  },
  {
    category: "draft",
    label: "Drafting",
    sub: "Write files, compose drafts, edits",
    accent: C.green,
  },
  {
    category: "send",
    label: "Messages / Send",
    sub: "Send email, post, message, (un)subscribe",
    accent: C.amber,
  },
  {
    category: "money",
    label: "Money / Payments",
    sub: "Charge, transfer, order, refund, checkout",
    accent: C.danger,
  },
  {
    category: "delete",
    label: "Deletes",
    sub: "Delete, remove, archive, destructive shell",
    accent: C.danger,
  },
  {
    category: "other",
    label: "Other",
    sub: "Everything else — asks by default",
    accent: C.t3,
  },
];

const AUTONOMY_MODE_OPTIONS: ReadonlyArray<{
  mode: AutonomyMode;
  label: string;
}> = [
  { mode: "auto", label: "Auto-run" },
  { mode: "ask", label: "Ask" },
  { mode: "never", label: "Never" },
];

// ---------------------------------------------------------------------------
// Master autonomy presets — a one-tap way to set every category at once. The
// per-category controls below stay the source of truth; these just write a
// whole map. The current selection is DERIVED from the policies (so editing a
// single category drops the master into "Custom").
// ---------------------------------------------------------------------------

type MasterMode = "autonomous" | "balanced" | "careful";

const MASTER_PRESETS: Record<MasterMode, AutonomyPolicies> = {
  // Full autonomy — the "bypass permissions" equivalent. Deny rules + risk
  // checks still apply; this only flips the ask/auto policy per category.
  autonomous: {
    research: "auto",
    draft: "auto",
    send: "auto",
    money: "auto",
    delete: "auto",
    other: "auto",
  },
  // The recommended default: everyday work runs itself; only irreversible /
  // costly actions (money, deletes) pause for a yes.
  balanced: {
    research: "auto",
    draft: "auto",
    send: "auto",
    money: "ask",
    delete: "ask",
    other: "auto",
  },
  // Maximum oversight — every category asks first.
  careful: {
    research: "ask",
    draft: "ask",
    send: "ask",
    money: "ask",
    delete: "ask",
    other: "ask",
  },
};

const MASTER_OPTIONS: ReadonlyArray<{
  mode: MasterMode;
  label: string;
  sub: string;
}> = [
  {
    mode: "autonomous",
    label: "Autonomous",
    sub: "Run everything without asking",
  },
  {
    mode: "balanced",
    label: "Balanced",
    sub: "Auto-run, but ask for money & deletes",
  },
  { mode: "careful", label: "Careful", sub: "Ask before every action" },
];

const MASTER_MODES: readonly MasterMode[] = [
  "autonomous",
  "balanced",
  "careful",
];

/** Which preset (if any) the current per-category policies exactly match. */
function deriveMasterMode(p: AutonomyPolicies): MasterMode | "custom" {
  for (const mode of MASTER_MODES) {
    const preset = MASTER_PRESETS[mode];
    const matches = (Object.keys(preset) as AutonomyCategory[]).every(
      (key) => preset[key] === p[key],
    );
    if (matches) return mode;
  }
  return "custom";
}

function AutonomyPolicyPanel({ assistantId }: { assistantId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["autonomyPolicies", assistantId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => getAutonomyPolicies(assistantId),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (next: Partial<AutonomyPolicies>) =>
      setAutonomyPolicies(assistantId, next),
    // Optimistic: reflect the click immediately, roll back on error.
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<AutonomyPolicies>(queryKey);
      if (previous) {
        queryClient.setQueryData<AutonomyPolicies>(queryKey, {
          ...previous,
          ...next,
        });
      }
      return { previous };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const setMode = useCallback(
    (category: AutonomyCategory, mode: AutonomyMode) => {
      mutation.mutate({ [category]: mode });
    },
    [mutation],
  );

  const setMaster = useCallback(
    (mode: MasterMode) => {
      mutation.mutate(MASTER_PRESETS[mode]);
    },
    [mutation],
  );

  const policies = query.data;

  return (
    <Panel title="What runs on its own · autonomy by action type">
      {query.isLoading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: C.t2,
          }}
        >
          <Loader2 className="size-4 animate-spin" /> Loading autonomy policy…
        </div>
      ) : query.isError || !policies ? (
        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderLeft: `3px solid ${C.danger}`,
            borderRadius: "0 12px 12px 0",
            padding: "11px 14px",
            fontSize: 13,
            color: C.t2,
          }}
        >
          Couldn&rsquo;t load your autonomy policy. Until it loads, Cue applies
          its safe defaults — everyday work auto-runs; only money and deletes
          always ask.
        </div>
      ) : (
        <>
          <MasterModeToggle
            current={deriveMasterMode(policies)}
            disabled={mutation.isPending}
            onSelect={setMaster}
          />
          <div style={{ fontSize: 12.5, color: C.t2 }}>
            Or fine-tune by action type. <b>Ask</b> always prompts you first —
            even at Full access. <b>Never</b> blocks the category outright.
            These never weaken Cue&rsquo;s deny rules or risk checks.
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {AUTONOMY_ROWS.map((row) => (
              <AutonomyRow
                key={row.category}
                row={row}
                mode={policies[row.category]}
                disabled={mutation.isPending}
                onSelect={(mode) => setMode(row.category, mode)}
              />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function MasterModeToggle({
  current,
  disabled,
  onSelect,
}: {
  current: MasterMode | "custom";
  disabled: boolean;
  onSelect: (mode: MasterMode) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 7, marginTop: -2 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ fontSize: 12.5, color: C.t2 }}>
          <b style={{ color: C.t1 }}>Overall autonomy</b> — set every action
          type at once.
        </div>
        {current === "custom" && (
          <span
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              letterSpacing: "0.04em",
              color: C.t2,
              background: C.sunken,
              border: `1px solid ${C.line2}`,
              borderRadius: 6,
              padding: "2px 7px",
              whiteSpace: "nowrap",
            }}
          >
            CUSTOM
          </span>
        )}
      </div>
      <div
        role="radiogroup"
        aria-label="Overall autonomy"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
        }}
      >
        {MASTER_OPTIONS.map((opt) => {
          const active = opt.mode === current;
          return (
            <button
              key={opt.mode}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => {
                if (!active) onSelect(opt.mode);
              }}
              style={{
                textAlign: "left",
                display: "grid",
                gap: 3,
                padding: "10px 12px",
                borderRadius: 12,
                cursor: disabled ? "default" : "pointer",
                background: active ? C.surface : C.sunken,
                border: active
                  ? `1.5px solid ${C.blueS}`
                  : `1px solid ${C.line2}`,
                boxShadow: active ? "0 1px 3px rgba(26,34,48,0.10)" : "none",
                transition: "background 120ms, border-color 120ms",
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: active ? C.blueS : C.t1,
                }}
              >
                {opt.label}
              </span>
              <span style={{ fontSize: 11.5, color: C.t2, lineHeight: 1.3 }}>
                {opt.sub}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AutonomyRow({
  row,
  mode,
  disabled,
  onSelect,
}: {
  row: (typeof AUTONOMY_ROWS)[number];
  mode: AutonomyMode;
  disabled: boolean;
  onSelect: (mode: AutonomyMode) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        padding: "11px 13px",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: row.accent,
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: C.t1 }}>
            {row.label}
          </div>
          <div style={{ fontSize: 12, color: C.t2 }}>{row.sub}</div>
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label={`${row.label} autonomy`}
        style={{
          display: "inline-flex",
          background: C.sunken,
          border: `1px solid ${C.line2}`,
          borderRadius: 8,
          padding: 2,
          flexShrink: 0,
        }}
      >
        {AUTONOMY_MODE_OPTIONS.map((opt) => {
          const active = opt.mode === mode;
          return (
            <button
              key={opt.mode}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => {
                if (!active) onSelect(opt.mode);
              }}
              style={{
                fontFamily: mono,
                fontSize: 11,
                letterSpacing: "0.02em",
                padding: "4px 10px",
                borderRadius: 6,
                border: "none",
                cursor: disabled ? "default" : "pointer",
                background: active ? C.surface : "transparent",
                color: active ? C.blueS : C.t2,
                fontWeight: active ? 600 : 400,
                boxShadow: active ? `0 1px 2px rgba(26,34,48,0.10)` : "none",
                transition: "background 120ms, color 120ms",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PermissionRulesPanel({
  loading,
  error,
  rules,
  onSuggest,
}: {
  loading: boolean;
  error: boolean;
  rules: TrustRule[];
  onSuggest: () => void;
}) {
  const { total, custom, byRisk } = useMemo(() => {
    const groups: Record<TrustRule["risk"], TrustRule[]> = {
      high: [],
      medium: [],
      low: [],
    };
    let customCount = 0;
    for (const rule of rules) {
      groups[rule.risk].push(rule);
      if (rule.origin === "user_defined") customCount += 1;
    }
    return { total: rules.length, custom: customCount, byRisk: groups };
  }, [rules]);

  const suggestButton = (
    <button
      type="button"
      onClick={onSuggest}
      style={{
        fontFamily: mono,
        fontSize: 11,
        letterSpacing: "0.02em",
        color: C.blueS,
        background: C.blueW,
        border: "none",
        borderRadius: 6,
        padding: "4px 10px",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      Ask Cue to propose a rule
    </button>
  );

  return (
    <Panel
      title="What Cue may do · permission rules"
      action={total > 0 && !loading && !error ? suggestButton : undefined}
    >
      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: C.t2,
          }}
        >
          <Loader2 className="size-4 animate-spin" /> Loading permission rules…
        </div>
      ) : error ? (
        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderLeft: `3px solid ${C.danger}`,
            borderRadius: "0 12px 12px 0",
            padding: "11px 14px",
            fontSize: 13,
            color: C.t2,
          }}
        >
          Couldn&rsquo;t load the permission policy. Cue stays default-deny
          until this resolves.
        </div>
      ) : total === 0 ? (
        <div style={{ fontSize: 13, color: C.t2 }}>
          No permission rules yet — Cue is fully locked down until you grant
          access.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: C.t2, marginTop: -2 }}>
            <span style={{ color: C.t1, fontWeight: 500 }}>{total}</span>{" "}
            {total === 1 ? "rule governs" : "rules govern"} what Cue can do ·
            default-deny
            {custom > 0 ? (
              <>
                {" · "}
                {custom} custom, {total - custom} default
              </>
            ) : (
              <> · all defaults</>
            )}
          </div>

          {RISK_ORDER.map((risk) => {
            const group = byRisk[risk];
            if (group.length === 0) return null;
            const meta = RISK_META[risk];
            return (
              <div key={risk} style={{ display: "grid", gap: 7 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    marginTop: 2,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: meta.dot,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: C.t2,
                    }}
                  >
                    {meta.label}
                  </span>
                  <span style={{ fontSize: 11.5, color: C.t3 }}>
                    {group.length}
                  </span>
                </div>
                {group.map((rule) => (
                  <RuleRow key={rule.id} rule={rule} />
                ))}
              </div>
            );
          })}
        </>
      )}
    </Panel>
  );
}

function RuleRow({ rule }: { rule: TrustRule }) {
  const custom = rule.origin === "user_defined";
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        padding: "11px 13px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontFamily: mono, fontSize: 12.5, color: C.t1 }}>
          {rule.tool}
        </span>
        <span style={{ fontFamily: mono, fontSize: 12, color: C.t3 }}>
          {rule.pattern}
        </span>
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 5,
            background: custom ? C.blueW : C.sunken,
            color: custom ? C.blueS : C.t3,
          }}
        >
          {custom ? "custom" : "default"}
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.t2, marginTop: 3 }}>
        {rule.description}
      </div>
    </div>
  );
}

function CapturePanel() {
  const [alwaysOn, setAlwaysOn] = useState(() =>
    readPref(PREF_KEYS.alwaysOn, false),
  );
  const [indicator, setIndicator] = useState(() =>
    readPref(PREF_KEYS.indicator, true),
  );
  const [autoDelete, setAutoDelete] = useState(() =>
    readPref(PREF_KEYS.autoDelete, true),
  );

  const toggle = useCallback(
    (key: string, value: boolean, set: (v: boolean) => void) => {
      set(value);
      writePref(key, value);
    },
    [],
  );

  return (
    <Panel title="Trust & capture">
      <ToggleRow
        title="Always-on capture"
        sub="Mic listens in meetings you start"
        on={alwaysOn}
        onChange={(v) => toggle(PREF_KEYS.alwaysOn, v, setAlwaysOn)}
      />
      <ToggleRow
        title="Recording indicator"
        sub="Always show a visible light when listening"
        on={indicator}
        onChange={(v) => toggle(PREF_KEYS.indicator, v, setIndicator)}
      />
      <ToggleRow
        title="Auto-delete raw audio"
        sub="Keep insights, drop the recording after 24h"
        on={autoDelete}
        onChange={(v) => toggle(PREF_KEYS.autoDelete, v, setAutoDelete)}
      />
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderLeft: `3px solid ${C.blue}`,
          borderRadius: "0 12px 12px 0",
          padding: "11px 14px",
          fontSize: 13,
          color: C.t2,
        }}
      >
        Consent-first by design. Capture is off until you turn it on, per
        meeting — these set your defaults for when always-on capture ships.
      </div>
    </Panel>
  );
}

function AuditPanel({
  loading,
  guardianName,
  trusted,
}: {
  loading: boolean;
  guardianName: string;
  trusted: string[];
}) {
  return (
    <Panel title="Who can reach Cue · audit">
      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: C.t2,
          }}
        >
          <Loader2 className="size-4 animate-spin" /> Loading actors…
        </div>
      ) : (
        <>
          <AuditCard
            title={`${guardianName} — guardian`.replace(
              /^vellum-principal-\S+ —/,
              "You —",
            )}
            badge="full"
            badgeBg="var(--mv1-green-wash)"
            badgeColor={C.green}
            sub="Every capability, every channel"
          />
          <AuditCard
            title={
              trusted.length === 0
                ? "No trusted contacts yet"
                : `${trusted.length} trusted ${trusted.length === 1 ? "contact" : "contacts"}`
            }
            badge="scoped"
            badgeBg={C.blueW}
            badgeColor={C.blueS}
            sub={
              trusted.length === 0
                ? "People you connect can reach Cue on shared channels"
                : `${trusted.slice(0, 3).join(", ")}${trusted.length > 3 ? "…" : ""} · shared channels only`
            }
          />
          <AuditCard
            title="Unknown actors"
            badge="denied"
            badgeBg={`color-mix(in srgb, ${C.violet} 14%, transparent)`}
            badgeColor="var(--mv1-violet-strong)"
            sub="No memory read, no tools — fail closed"
          />
          <div style={{ marginTop: 4 }}>
            <div
              style={{
                fontFamily: mono,
                fontSize: 11,
                color: C.t3,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Policy
            </div>
            <div style={{ fontSize: 12.5, color: C.t2 }}>
              {trusted.length + 1}{" "}
              {trusted.length + 1 === 1 ? "actor" : "actors"} can reach Cue ·
              everyone else is denied by default.
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 500, color: C.t1 }}>
          {title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({
  title,
  sub,
  on,
  onChange,
}: {
  title: string;
  sub: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: C.t1 }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: C.t2 }}>{sub}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={title}
        onClick={() => onChange(!on)}
        style={{
          width: 38,
          height: 22,
          borderRadius: 999,
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
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            top: 2,
            left: on ? 18 : 2,
            transition: "left 120ms",
          }}
        />
      </button>
    </div>
  );
}

function AuditCard({
  title,
  badge,
  badgeBg,
  badgeColor,
  sub,
}: {
  title: string;
  badge: string;
  badgeBg: string;
  badgeColor: string;
  sub: string;
}) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        padding: "13px 15px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 500, color: C.t1 }}>
          {title}
        </span>
        <span
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            padding: "1px 6px",
            borderRadius: 5,
            background: badgeBg,
            color: badgeColor,
          }}
        >
          {badge}
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.t2, marginTop: 3 }}>{sub}</div>
    </div>
  );
}
