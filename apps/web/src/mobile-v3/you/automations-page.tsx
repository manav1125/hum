/**
 * Mv3AutomationsPage — the mobile "Automations" leaf (spec frames 69 + 70).
 *
 * A You-cluster leaf (not a tab): Watchers (teal — monitor a source) and
 * Playbooks (violet — trigger→action with an autonomy chip). The new-playbook
 * sheet (frame 70) shows the autonomy segmented control with the global-dial
 * CAP: an option above the dial's ceiling renders locked (🔒) with a line
 * pointing to You → Trust. The cap is the server's truth — the playbook list
 * carries `globalDial`/`effectiveAutonomy`/`autonomyCapped`.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { microLabel, rise } from "../mv3-kit";
import { SheetShell } from "../sheet-shell";
import { Eyebrow, YouScreen } from "./you-kit";
import {
  AUTONOMY_LABEL,
  DIAL_LABEL,
  agoLabel,
  dialBanner,
  intervalLabel,
  useCreatePlaybook,
  useCreateWatcher,
  usePlaybooks,
  useToggleWatcher,
  useWatcherProviders,
  useWatchers,
  type Autonomy,
  type GlobalDial,
  type Playbook,
  type Watcher,
} from "./use-automations-data";

const TEAL = "#4FC7C7";
const VIOLET = "#A79FF0";
const GREEN = "#6FD69A";
const AMBER = "#F4BF4F";

/** Autonomy ranking so we can tell which options the dial ceiling locks. */
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

// ── Watcher card ──────────────────────────────────────────────────────
function HealthDot({ health }: { health: Watcher["health"] }) {
  const color =
    health === "ok"
      ? GREEN
      : health === "reauth" || health === "not_connected"
        ? AMBER
        : "var(--mv3-faint)";
  return (
    <span
      aria-label={
        health === "reauth"
          ? "Reconnect needed"
          : health === "ok"
            ? "Healthy"
            : "Status unknown"
      }
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function WatcherCard({ watcher }: { watcher: Watcher }) {
  const toggle = useToggleWatcher();
  const lastHit = agoLabel(watcher.lastPollAt);
  const filter = (() => {
    try {
      const cfg = watcher.configJson ? JSON.parse(watcher.configJson) : {};
      return typeof cfg.filter === "string" ? cfg.filter : null;
    } catch {
      return null;
    }
  })();
  const meta = [
    providerLabel(watcher.providerId),
    filter,
    intervalLabel(watcher.pollIntervalMs),
    lastHit ? `hit ${lastHit}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "13px 15px",
        borderBottom: "1px solid var(--mv3-line)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          background: "rgba(79,199,199,.15)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: TEAL,
          fontSize: 15,
        }}
      >
        ◎
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>
            {watcher.name}
          </span>
          <HealthDot health={watcher.health} />
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--mv3-muted)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {watcher.health === "reauth"
            ? "Token expired — reconnect to resume"
            : watcher.health === "not_connected"
              ? `${watcher.credentialService} isn't connected — connect it to start`
              : meta}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={watcher.enabled}
        aria-label={`${watcher.name} ${watcher.enabled ? "on" : "off"}`}
        onClick={() => {
          haptic.medium();
          toggle.mutate({ id: watcher.id, enabled: !watcher.enabled });
        }}
        style={{
          width: 42,
          height: 26,
          borderRadius: 99,
          border: "none",
          background: watcher.enabled ? TEAL : "var(--mv3-track)",
          position: "relative",
          cursor: "pointer",
          flexShrink: 0,
          transition: "background .18s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: watcher.enabled ? 19 : 3,
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .18s",
          }}
        />
      </button>
    </div>
  );
}

// ── Playbook card ─────────────────────────────────────────────────────
function AutonomyChip({ playbook }: { playbook: Playbook }) {
  const capped = playbook.autonomyCapped;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontFamily: "var(--mv3-mono)",
        fontSize: 9.5,
        letterSpacing: ".08em",
        padding: "3px 7px",
        borderRadius: 6,
        color: VIOLET,
        background: "rgba(167,159,240,.14)",
      }}
    >
      {AUTONOMY_LABEL[playbook.effectiveAutonomy]}
      {capped ? <span aria-label="capped by trust dial">🔒</span> : null}
    </span>
  );
}

function PlaybookCard({ playbook }: { playbook: Playbook }) {
  return (
    <div
      style={{
        padding: "13px 15px",
        borderBottom: "1px solid var(--mv3-line)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: "rgba(167,159,240,.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: VIOLET,
            fontSize: 15,
          }}
        >
          ⚡
        </span>
        <span style={{ fontSize: 14.5, fontWeight: 600, flex: 1, minWidth: 0 }}>
          {playbook.name}
        </span>
        <AutonomyChip playbook={playbook} />
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--mv3-muted)",
          marginTop: 7,
          lineHeight: 1.5,
          paddingLeft: 42,
        }}
      >
        When {playbook.triggerText} → {playbook.action}
      </div>
      {playbook.autonomyCapped ? (
        <div
          style={{
            fontSize: 11,
            color: AMBER,
            marginTop: 6,
            paddingLeft: 42,
            lineHeight: 1.45,
          }}
        >
          🔒 Wants {AUTONOMY_LABEL[playbook.autonomyLevel]} — held at{" "}
          {AUTONOMY_LABEL[playbook.effectiveAutonomy]} by your{" "}
          {DIAL_LABEL[playbook.globalDial]} trust.
        </div>
      ) : null}
    </div>
  );
}

// ── New-watcher sheet ─────────────────────────────────────────────────
function NewWatcherSheet({ onClose }: { onClose: () => void }) {
  const { data: providers } = useWatcherProviders();
  const create = useCreateWatcher();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");

  const canSubmit = name.trim().length > 0 && provider.length > 0;

  return (
    <SheetShell open onClose={onClose} label="New watcher">
      <div style={{ padding: "4px 2px 12px" }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
          New watcher
        </div>
        <div
          style={{ fontSize: 13, color: "var(--mv3-muted)", marginBottom: 18 }}
        >
          Watch a source for events — hits land in Came-in.
        </div>

        <FieldLabel>Name</FieldLabel>
        <TextInput
          value={name}
          onChange={setName}
          placeholder="Investor emails"
        />

        <FieldLabel>Source</FieldLabel>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 8 }}
        >
          {(providers ?? []).map((p) => {
            const active = provider === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setProvider(p.id)}
                style={{
                  fontSize: 12.5,
                  padding: "8px 13px",
                  borderRadius: 99,
                  border: active
                    ? `1px solid ${TEAL}`
                    : "1px solid var(--mv3-btn2-border)",
                  background: active
                    ? "rgba(79,199,199,.14)"
                    : "var(--mv3-btn2-bg)",
                  color: active ? TEAL : "var(--mv3-muted)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {p.displayName}
              </button>
            );
          })}
          {providers && providers.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--mv3-faint)" }}>
              No providers registered.
            </div>
          ) : null}
        </div>

        <PrimaryButton
          disabled={!canSubmit || create.isPending}
          tint={TEAL}
          onPress={() => {
            create.mutate(
              { name: name.trim(), provider },
              { onSuccess: onClose },
            );
          }}
        >
          {create.isPending ? "Creating…" : "Create watcher"}
        </PrimaryButton>
      </div>
    </SheetShell>
  );
}

// ── New-playbook sheet (frame 70) ─────────────────────────────────────
function NewPlaybookSheet({
  dial,
  watchers,
  onClose,
}: {
  dial: GlobalDial;
  watchers: Watcher[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const create = useCreatePlaybook();
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [action, setAction] = useState("");
  const [watcherId, setWatcherId] = useState<string | "">("");
  const [autonomy, setAutonomy] = useState<Autonomy>("draft");
  const [priority, setPriority] = useState(0);

  const ceilingRank = AUTONOMY_RANK[DIAL_CEILING[dial]];
  const canSubmit =
    name.trim().length > 0 &&
    trigger.trim().length > 0 &&
    action.trim().length > 0;

  const autonomyItems: Autonomy[] = ["notify", "draft", "auto"];

  return (
    <SheetShell open onClose={onClose} label="New playbook">
      <div style={{ padding: "4px 2px 12px" }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>
          New playbook
        </div>

        <FieldLabel>Name</FieldLabel>
        <TextInput
          value={name}
          onChange={setName}
          placeholder="Investor reply → draft"
        />

        <FieldLabel>When this happens</FieldLabel>
        <TextInput
          value={trigger}
          onChange={setTrigger}
          placeholder="Investor emails, from:@vc"
        />
        {watchers.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 10,
            }}
          >
            <ScopePill
              active={watcherId === ""}
              label="Any channel"
              onPress={() => setWatcherId("")}
            />
            {watchers.map((w) => (
              <ScopePill
                key={w.id}
                active={watcherId === w.id}
                label={w.name}
                onPress={() => setWatcherId(w.id)}
              />
            ))}
          </div>
        ) : null}

        <FieldLabel>Cue does this</FieldLabel>
        <TextInput
          value={action}
          onChange={setAction}
          placeholder="Draft a reply + file to a project"
        />

        <FieldLabel>How much on its own</FieldLabel>
        <div
          role="radiogroup"
          aria-label="Autonomy"
          style={{
            display: "flex",
            gap: 4,
            background: "var(--mv3-track)",
            borderRadius: 14,
            padding: 4,
            marginBottom: 8,
          }}
        >
          {autonomyItems.map((a) => {
            const locked = AUTONOMY_RANK[a] > ceilingRank;
            const active = autonomy === a;
            return (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={locked}
                onClick={() => {
                  if (locked) return;
                  haptic.light();
                  setAutonomy(a);
                }}
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 400,
                  fontFamily: "inherit",
                  color: locked
                    ? "var(--mv3-faint)"
                    : active
                      ? "#fff"
                      : "var(--mv3-muted)",
                  background: active
                    ? "linear-gradient(160deg,#B0A8F5,#8B80E8)"
                    : "transparent",
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 0",
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
              display: "block",
              textAlign: "left",
              width: "100%",
              fontSize: 11.5,
              color: AMBER,
              background: "none",
              border: "none",
              padding: "2px 0 12px",
              cursor: "pointer",
              lineHeight: 1.5,
              fontFamily: "inherit",
            }}
          >
            🔒 {AUTONOMY_LABEL.auto} is capped — your global trust is{" "}
            {DIAL_LABEL[dial]}. Raise it in You → Trust to let playbooks act
            alone.
          </button>
        ) : null}

        <FieldLabel>Priority</FieldLabel>
        <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
          {[
            { label: "High", value: 10 },
            { label: "Normal", value: 0 },
            { label: "Low", value: -10 },
          ].map((p) => (
            <ScopePill
              key={p.label}
              active={priority === p.value}
              label={p.label}
              onPress={() => setPriority(p.value)}
            />
          ))}
        </div>

        <PrimaryButton
          disabled={!canSubmit || create.isPending}
          tint={VIOLET}
          onPress={() => {
            create.mutate(
              {
                name: name.trim(),
                trigger_text: trigger.trim(),
                action: action.trim(),
                watcher_id: watcherId || null,
                autonomy_level: autonomy,
                priority,
              },
              { onSuccess: onClose },
            );
          }}
        >
          {create.isPending ? "Creating…" : "Create playbook"}
        </PrimaryButton>
      </div>
    </SheetShell>
  );
}

// ── Small shared inputs ───────────────────────────────────────────────
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...microLabel, color: "var(--mv3-muted)", marginBottom: 7 }}>
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%",
        fontSize: 14,
        fontFamily: "inherit",
        color: "var(--mv3-text)",
        background: "var(--mv3-btn2-bg)",
        border: "1px solid var(--mv3-btn2-border)",
        borderRadius: 11,
        padding: "11px 13px",
        marginBottom: 16,
        boxSizing: "border-box",
      }}
    />
  );
}

function ScopePill({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      style={{
        fontSize: 12.5,
        padding: "7px 13px",
        borderRadius: 99,
        border: active
          ? "1px solid transparent"
          : "1px solid var(--mv3-btn2-border)",
        background: active ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
        color: active ? "var(--mv3-bg)" : "var(--mv3-muted)",
        cursor: "pointer",
        fontFamily: "inherit",
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}

function PrimaryButton({
  children,
  onPress,
  disabled,
  tint,
}: {
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  tint: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        haptic.medium();
        onPress();
      }}
      style={{
        width: "100%",
        fontSize: 15,
        fontWeight: 600,
        fontFamily: "inherit",
        color: "#fff",
        background: tint,
        border: "none",
        borderRadius: 13,
        padding: "14px 0",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}

function AddRow({
  label,
  tint,
  onPress,
}: {
  label: string;
  tint: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic.light();
        onPress();
      }}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "13px 15px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: tint,
        fontSize: 13.5,
        fontWeight: 600,
        fontFamily: "inherit",
      }}
    >
      <span style={{ fontSize: 16 }} aria-hidden>
        +
      </span>
      {label}
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────
export function Mv3AutomationsPage() {
  const watchersQ = useWatchers();
  const playbooksQ = usePlaybooks();
  const [sheet, setSheet] = useState<"watcher" | "playbook" | null>(null);

  const watchers = watchersQ.data ?? [];
  const playbooks = playbooksQ.data?.playbooks ?? [];
  const dial: GlobalDial = playbooksQ.data?.globalDial ?? "assist";

  const watcherCount = watchers.length;
  const playbookCount = playbooks.length;

  const bannerText = useMemo(() => dialBanner(dial), [dial]);

  return (
    <YouScreen
      tint="blue"
      back={routes.channels}
      title="Automations"
      sub="Watch for events · act on them"
      testId="automations"
    >
      <div
        style={{
          ...microLabel,
          color: "var(--mv3-muted)",
          background: "var(--mv3-btn2-bg)",
          border: "1px solid var(--mv3-btn2-border)",
          borderRadius: 10,
          padding: "9px 12px",
          marginBottom: 4,
          textTransform: "none",
          letterSpacing: 0,
          lineHeight: 1.4,
          ...rise(0.05),
        }}
      >
        Global trust: {bannerText}
      </div>

      {/* Watchers */}
      <GlassCard padding={0} style={{ overflow: "hidden", ...rise(0.12) }}>
        <div style={{ padding: "13px 15px 4px" }}>
          <Eyebrow>Watchers · {watcherCount}</Eyebrow>
        </div>
        {watchers.map((w) => (
          <WatcherCard key={w.id} watcher={w} />
        ))}
        {watcherCount === 0 && !watchersQ.isLoading ? (
          <div
            style={{
              padding: "6px 15px 12px",
              fontSize: 12.5,
              color: "var(--mv3-faint)",
            }}
          >
            No watchers yet — add one to monitor a source.
          </div>
        ) : null}
        <AddRow
          label="New watcher"
          tint={TEAL}
          onPress={() => setSheet("watcher")}
        />
      </GlassCard>

      {/* Playbooks */}
      <GlassCard padding={0} style={{ overflow: "hidden", ...rise(0.2) }}>
        <div style={{ padding: "13px 15px 4px" }}>
          <Eyebrow>Playbooks · {playbookCount}</Eyebrow>
        </div>
        {playbooks.map((p) => (
          <PlaybookCard key={p.id} playbook={p} />
        ))}
        {playbookCount === 0 && !playbooksQ.isLoading ? (
          <div
            style={{
              padding: "6px 15px 12px",
              fontSize: 12.5,
              color: "var(--mv3-faint)",
            }}
          >
            No playbooks yet — turn a watcher hit into an action.
          </div>
        ) : null}
        <AddRow
          label="New playbook"
          tint={VIOLET}
          onPress={() => setSheet("playbook")}
        />
      </GlassCard>

      {sheet === "watcher" ? (
        <NewWatcherSheet onClose={() => setSheet(null)} />
      ) : null}
      {sheet === "playbook" ? (
        <NewPlaybookSheet
          dial={dial}
          watchers={watchers}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </YouScreen>
  );
}
