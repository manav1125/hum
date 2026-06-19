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
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { contactsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
  surface: "#FFFFFF",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

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
  const contactsQuery = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.contacts,
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
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
          background: "#fff",
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
            badgeBg="#E2F0E7"
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
            badgeBg="#EEEDFB"
            badgeColor="#534AB7"
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

function Panel({ title, children }: { title: string; children: ReactNode }) {
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
      <div style={{ fontSize: 13.5, fontWeight: 500, color: C.t1 }}>{title}</div>
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
        <div style={{ fontSize: 14, fontWeight: 500, color: C.t1 }}>{title}</div>
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
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
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
