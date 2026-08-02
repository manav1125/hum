/**
 * WebAutomationsBoard — the desktop HQ "Automations" surface (web W3).
 *
 * Serif-HQ grammar (Instrument Serif display, DM Mono microlabels, ink on
 * #F4F3EF). Two columns: Watchers (source · interval · health dot incl. a
 * reauth state · hits) and Playbooks (trigger→action · autonomy chip ·
 * priority · last-fired). A global-trust banner makes the autonomy-vs-dial
 * relationship explicit; the autonomy the server capped is shown with a 🔒.
 * Create is inline. All data + the cap come from the daemon (no fake state).
 */
import { useState } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";
import { C } from "@/lib/hq-theme";

import {
  AUTONOMY_LABEL,
  DIAL_LABEL,
  agoLabel,
  dialBanner,
  intervalLabel,
  useCreatePlaybook,
  useCreateWatcher,
  useDeletePlaybook,
  useDeleteWatcher,
  usePlaybooks,
  useTogglePlaybook,
  useToggleWatcher,
  useWatcherProviders,
  useWatchers,
  type Autonomy,
  type GlobalDial,
  type Playbook,
  type Watcher,
} from "@/mobile-v3/you/use-automations-data";

const serif = "'Instrument Serif', Georgia, serif";
const mono = "'DM Mono', ui-monospace, monospace";
const sans = "'DM Sans', -apple-system, system-ui, sans-serif";

// Theme-aware serif-HQ palette. These were hardcoded light-mode hex values, so
// the whole board rendered as a cream panel inside dark chrome; every peer
// surface reads the same `--mv1-*` vars via `lib/hq-theme`. Names kept so the
// call sites below are unchanged.
const INK = C.t1;
const BG = C.bg;
const MUTED = C.t2;
const LINE = C.line;
const BLUE = C.blue;
// No teal token in the serif-HQ palette; the strong blue is the nearest
// in-system accent and stays legible in both themes.
const TEAL = C.blueS;
const VIOLET = C.violet;
const GREEN = C.green;
const AMBER = C.amber;
const RED = C.danger;

const AUTONOMY_RANK: Record<Autonomy, number> = {
  notify: 0,
  draft: 1,
  auto: 2,
};
const DIAL_CEILING: Record<GlobalDial, Autonomy> = {
  observe: "notify",
  assist: "draft",
  autonomous: "auto",
};

function providerLabel(id: string): string {
  const map: Record<string, string> = {
    gmail: "Gmail",
    outlook: "Outlook",
    github: "GitHub",
    "google-calendar": "Google Cal",
    "outlook-calendar": "Outlook Cal",
    linear: "Linear",
  };
  return map[id] ?? id;
}

function Micro({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 11,
        letterSpacing: ".12em",
        textTransform: "uppercase",
        color: MUTED,
      }}
    >
      {children}
    </div>
  );
}

// ── Watcher card ──────────────────────────────────────────────────────
function healthMeta(w: Watcher) {
  if (w.health === "not_connected") {
    return {
      label: "not connected",
      color: AMBER,
      note: `${w.credentialService} isn't connected — connect it to start`,
    };
  }
  if (w.health === "reauth") {
    return {
      label: "reauth",
      color: AMBER,
      note: "Token expired — reconnect to resume",
    };
  }
  if (w.health === "ok") return { label: "healthy", color: GREEN, note: null };
  return { label: "checking", color: MUTED, note: null };
}

function WatcherCard({ watcher }: { watcher: Watcher }) {
  const toggle = useToggleWatcher();
  const del = useDeleteWatcher();
  const h = healthMeta(watcher);
  const lastHit = agoLabel(watcher.lastPollAt);
  return (
    <div
      style={{
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        padding: "14px 16px",
        background: C.surface,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: serif, fontSize: 20, lineHeight: 1.1 }}>
            {watcher.name}
          </div>
          <div
            style={{
              fontFamily: sans,
              fontSize: 12.5,
              color: MUTED,
              marginTop: 3,
            }}
          >
            {providerLabel(watcher.providerId)} ·{" "}
            {intervalLabel(watcher.pollIntervalMs)}
          </div>
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontFamily: mono,
            fontSize: 10.5,
            color: h.color,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: h.color,
            }}
          />
          {h.label}
        </span>
        <ToggleSwitch
          on={watcher.enabled}
          tint={TEAL}
          onChange={() =>
            toggle.mutate({ id: watcher.id, enabled: !watcher.enabled })
          }
        />
      </div>
      <div
        style={{
          fontFamily: sans,
          fontSize: 12,
          color: h.note ? RED : MUTED,
          marginTop: 9,
        }}
      >
        {h.note ?? (lastHit ? `Last hit ${lastHit}` : "No hits yet")}
      </div>
      <button
        type="button"
        onClick={() => del.mutate(watcher.id)}
        style={ghostBtn}
      >
        Remove
      </button>
    </div>
  );
}

// ── Playbook card ─────────────────────────────────────────────────────
function priorityLabel(p: number): string {
  if (p >= 5) return "High";
  if (p <= -5) return "Low";
  return "Normal";
}

function PlaybookCard({ playbook }: { playbook: Playbook }) {
  const navigate = useNavigate();
  const toggle = useTogglePlaybook();
  const del = useDeletePlaybook();
  const lastFired = agoLabel(playbook.lastFiredAt);
  return (
    <div
      style={{
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        padding: "14px 16px",
        background: C.surface,
        opacity: playbook.enabled ? 1 : 0.6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{ fontFamily: serif, fontSize: 20, lineHeight: 1.1, flex: 1 }}
        >
          {playbook.name}
        </div>
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: ".06em",
            padding: "3px 7px",
            borderRadius: 5,
            color: VIOLET,
            background: "rgba(83,74,183,.1)",
          }}
        >
          {AUTONOMY_LABEL[playbook.effectiveAutonomy]}
          {playbook.autonomyCapped ? " 🔒" : ""}
        </span>
        <span style={{ fontFamily: mono, fontSize: 10, color: MUTED }}>
          {priorityLabel(playbook.priority)}
        </span>
        <ToggleSwitch
          on={playbook.enabled}
          tint={VIOLET}
          onChange={() =>
            toggle.mutate({ id: playbook.id, enabled: !playbook.enabled })
          }
        />
      </div>
      <div
        style={{
          fontFamily: sans,
          fontSize: 13,
          color: INK,
          marginTop: 8,
          lineHeight: 1.5,
        }}
      >
        When {playbook.triggerText} → {playbook.action}
      </div>
      {playbook.autonomyCapped ? (
        <button
          type="button"
          onClick={() => navigate(routes.guardrails)}
          style={{
            display: "block",
            textAlign: "left",
            width: "100%",
            fontFamily: sans,
            fontSize: 12,
            color: AMBER,
            background: "none",
            border: "none",
            padding: "8px 0 2px",
            cursor: "pointer",
            lineHeight: 1.45,
          }}
        >
          🔒 Wants {AUTONOMY_LABEL[playbook.autonomyLevel]} — capped to{" "}
          {AUTONOMY_LABEL[playbook.effectiveAutonomy]} by your{" "}
          {DIAL_LABEL[playbook.globalDial]} trust. Raise in You → Trust to let
          it run alone.
        </button>
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 10,
        }}
      >
        <span style={{ fontFamily: mono, fontSize: 10.5, color: MUTED }}>
          {lastFired ? `Last fired ${lastFired}` : "Never fired"}
        </span>
        <button
          type="button"
          onClick={() => del.mutate(playbook.id)}
          style={ghostBtn}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

// ── Inline create forms ───────────────────────────────────────────────
function NewWatcherForm({ onDone }: { onDone: () => void }) {
  const { data: providers } = useWatcherProviders();
  const create = useCreateWatcher();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  return (
    <div style={formBox}>
      <input
        style={input}
        placeholder="Watcher name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        style={input}
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
      >
        <option value="">Choose a source…</option>
        {(providers ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          disabled={!name.trim() || !provider || create.isPending}
          style={{
            ...primaryBtn(TEAL),
            opacity: !name.trim() || !provider ? 0.5 : 1,
          }}
          onClick={() =>
            create.mutate(
              { name: name.trim(), provider },
              { onSuccess: onDone },
            )
          }
        >
          Create watcher
        </button>
        <button type="button" style={ghostBtn} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function NewPlaybookForm({
  dial,
  watchers,
  onDone,
}: {
  dial: GlobalDial;
  watchers: Watcher[];
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const create = useCreatePlaybook();
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [action, setAction] = useState("");
  const [watcherId, setWatcherId] = useState("");
  const [autonomy, setAutonomy] = useState<Autonomy>("draft");
  const [priority, setPriority] = useState(0);
  const ceilingRank = AUTONOMY_RANK[DIAL_CEILING[dial]];
  const ready = name.trim() && trigger.trim() && action.trim();
  return (
    <div style={formBox}>
      <input
        style={input}
        placeholder="Playbook name (e.g. Investor reply → draft)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        style={input}
        placeholder="When this happens (trigger text)"
        value={trigger}
        onChange={(e) => setTrigger(e.target.value)}
      />
      <select
        style={input}
        value={watcherId}
        onChange={(e) => setWatcherId(e.target.value)}
      >
        <option value="">Any channel</option>
        {watchers.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <input
        style={input}
        placeholder="Cue does this (action)"
        value={action}
        onChange={(e) => setAction(e.target.value)}
      />
      <Micro>How much on its own</Micro>
      <div style={{ display: "flex", gap: 6, margin: "6px 0" }}>
        {(["notify", "draft", "auto"] as Autonomy[]).map((a) => {
          const locked = AUTONOMY_RANK[a] > ceilingRank;
          const active = autonomy === a;
          return (
            <button
              key={a}
              type="button"
              disabled={locked}
              onClick={() => !locked && setAutonomy(a)}
              style={{
                flex: 1,
                fontFamily: mono,
                fontSize: 11,
                padding: "8px 0",
                borderRadius: 8,
                border: `1px solid ${active ? VIOLET : LINE}`,
                background: active
                  ? "var(--mv1-violet-wash, rgba(83,74,183,.1))"
                  : C.surface,
                color: locked ? C.t3 : active ? VIOLET : INK,
                cursor: locked ? "not-allowed" : "pointer",
              }}
            >
              {AUTONOMY_LABEL[a]}
              {locked ? " 🔒" : ""}
            </button>
          );
        })}
      </div>
      {ceilingRank < AUTONOMY_RANK.auto ? (
        <button
          type="button"
          onClick={() => navigate(routes.guardrails)}
          style={{
            textAlign: "left",
            fontFamily: sans,
            fontSize: 11.5,
            color: AMBER,
            background: "none",
            border: "none",
            padding: "2px 0 6px",
            cursor: "pointer",
            lineHeight: 1.4,
          }}
        >
          🔒 Auto is capped — your global trust is {DIAL_LABEL[dial]}. Raise it
          in You → Trust.
        </button>
      ) : null}
      <Micro>Priority</Micro>
      <div style={{ display: "flex", gap: 6, margin: "6px 0 10px" }}>
        {[
          { label: "High", value: 10 },
          { label: "Normal", value: 0 },
          { label: "Low", value: -10 },
        ].map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setPriority(p.value)}
            style={{
              flex: 1,
              fontFamily: mono,
              fontSize: 11,
              padding: "7px 0",
              borderRadius: 8,
              border: `1px solid ${priority === p.value ? BLUE : LINE}`,
              background: priority === p.value ? C.blueW : C.surface,
              color: priority === p.value ? BLUE : INK,
              cursor: "pointer",
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          disabled={!ready || create.isPending}
          style={{ ...primaryBtn(VIOLET), opacity: ready ? 1 : 0.5 }}
          onClick={() =>
            create.mutate(
              {
                name: name.trim(),
                trigger_text: trigger.trim(),
                action: action.trim(),
                watcher_id: watcherId || null,
                autonomy_level: autonomy,
                priority,
              },
              { onSuccess: onDone },
            )
          }
        >
          Create playbook
        </button>
        <button type="button" style={ghostBtn} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Small primitives ──────────────────────────────────────────────────
function ToggleSwitch({
  on,
  tint,
  onChange,
}: {
  on: boolean;
  tint: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      style={{
        width: 40,
        height: 24,
        borderRadius: 99,
        border: "none",
        background: on ? tint : LINE,
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 19 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: C.surface,
          transition: "left .16s",
        }}
      />
    </button>
  );
}

const ghostBtn: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: ".05em",
  color: MUTED,
  background: "none",
  border: "none",
  padding: "6px 0 0",
  cursor: "pointer",
};

const formBox: React.CSSProperties = {
  border: `1px dashed ${LINE}`,
  borderRadius: 12,
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 9,
  background: C.surface,
};

const input: React.CSSProperties = {
  fontFamily: sans,
  fontSize: 13,
  color: INK,
  padding: "9px 11px",
  borderRadius: 9,
  border: `1px solid ${LINE}`,
  background: C.surface,
  outline: "none",
};

function primaryBtn(bg: string): React.CSSProperties {
  return {
    fontFamily: sans,
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    background: bg,
    border: "none",
    borderRadius: 9,
    padding: "9px 16px",
    cursor: "pointer",
  };
}

function Column({
  title,
  count,
  tint,
  onNew,
  children,
}: {
  title: string;
  count: number;
  tint: string;
  onNew: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
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
        }}
      >
        <Micro>
          {title} · {count}
        </Micro>
        <button
          type="button"
          onClick={onNew}
          style={{
            fontFamily: mono,
            fontSize: 11,
            color: tint,
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
        >
          ＋ New
        </button>
      </div>
      {children}
    </div>
  );
}

export function WebAutomationsBoard() {
  const navigate = useNavigate();
  const watchersQ = useWatchers();
  const playbooksQ = usePlaybooks();
  const [newWatcher, setNewWatcher] = useState(false);
  const [newPlaybook, setNewPlaybook] = useState(false);

  const watchers = watchersQ.data ?? [];
  const playbooks = playbooksQ.data?.playbooks ?? [];
  const dial: GlobalDial = playbooksQ.data?.globalDial ?? "assist";

  return (
    <div
      data-slot="automations-board"
      style={{
        minHeight: "100%",
        background: BG,
        color: INK,
        fontFamily: sans,
        padding: "34px clamp(20px,4vw,56px) 60px",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ fontFamily: serif, fontSize: 40, lineHeight: 1.04 }}>
          Automations
        </div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 12,
            color: MUTED,
            marginTop: 6,
            letterSpacing: ".08em",
          }}
        >
          WHAT CUE DOES WHEN SOMETHING ARRIVES
        </div>
        <button
          type="button"
          onClick={() => navigate(routes.settings.schedules)}
          style={{
            display: "block",
            textAlign: "left",
            width: "100%",
            maxWidth: 640,
            fontFamily: sans,
            fontSize: 13,
            lineHeight: 1.5,
            color: MUTED,
            background: "none",
            border: "none",
            padding: "10px 0 0",
            cursor: "pointer",
          }}
        >
          Nothing here runs on a clock. Watchers poll a source and hand what
          they find to intake; playbooks are optional rules that claim a hit
          before Cue judges it. For work that fires on a schedule, see{" "}
          <span style={{ color: BLUE, textDecoration: "underline" }}>
            Schedules
          </span>
          .
        </button>

        <div
          style={{
            marginTop: 18,
            padding: "12px 16px",
            border: `1px solid ${LINE}`,
            borderLeft: `3px solid ${BLUE}`,
            borderRadius: 10,
            background: C.surface,
            fontSize: 13.5,
          }}
        >
          <span
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: MUTED,
              letterSpacing: ".08em",
            }}
          >
            GLOBAL TRUST:{" "}
          </span>
          {dialBanner(dial)}
        </div>

        <div
          style={{
            display: "flex",
            gap: 28,
            marginTop: 26,
            alignItems: "flex-start",
            flexWrap: "wrap",
          }}
        >
          <Column
            title="Watchers"
            count={watchers.length}
            tint={TEAL}
            onNew={() => setNewWatcher((v) => !v)}
          >
            {newWatcher ? (
              <NewWatcherForm onDone={() => setNewWatcher(false)} />
            ) : null}
            {watchers.map((w) => (
              <WatcherCard key={w.id} watcher={w} />
            ))}
            {watchers.length === 0 && !watchersQ.isLoading && !newWatcher ? (
              <div style={{ fontSize: 13, color: MUTED }}>
                No watchers yet — add one to monitor a source.
              </div>
            ) : null}
          </Column>

          <Column
            title="Playbooks"
            count={playbooks.length}
            tint={VIOLET}
            onNew={() => setNewPlaybook((v) => !v)}
          >
            {newPlaybook ? (
              <NewPlaybookForm
                dial={dial}
                watchers={watchers}
                onDone={() => setNewPlaybook(false)}
              />
            ) : null}
            {playbooks.map((p) => (
              <PlaybookCard key={p.id} playbook={p} />
            ))}
            {playbooks.length === 0 && !playbooksQ.isLoading && !newPlaybook ? (
              // Zero playbooks is the normal, working state — nothing seeds
              // defaults and nothing needs to. Saying only "no playbooks yet"
              // reads as "nothing is happening", which is false: every hit is
              // still judged and surfaced. Say what the empty column means.
              <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.55 }}>
                None — and watchers still work. Every hit goes through
                Cue&rsquo;s relevance check into Came In. A playbook is an
                override for things you&rsquo;ve already decided matter: it
                claims the hit first and attaches an action.
              </div>
            ) : null}
          </Column>
        </div>
      </div>
    </div>
  );
}
