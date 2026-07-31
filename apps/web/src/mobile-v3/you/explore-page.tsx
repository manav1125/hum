/**
 * "What Cue can now do" — mobile v3 (design frame D1).
 *
 * Seven powers, each one icon + one line + one action whose verb states the
 * truth. Anything that needs a grant, an install, or an account says so in
 * amber before you tap.
 *
 * Full-screen at first run with an explicit exit (Skip / Done, which set the
 * `cue:explore:firstrun:v1` flag — see domains/discovery/explore-seen); after
 * that it is the persistent You → Explore surface and never nags.
 */
import { useState } from "react";
import { useNavigate } from "react-router";

import {
  useCapabilityPowers,
  type CapabilityPower,
  type PowerState,
} from "@/domains/discovery/use-capability-powers";
import {
  readExploreSeen,
  writeExploreSeen,
} from "@/domains/discovery/explore-seen";
import { haptic } from "@/utils/haptics";

import { GlassCard } from "../glass-card";
import { primaryBtn, rise } from "../mv3-kit";
import { TrustFootnote, YouScreen } from "./you-kit";

/** State → the chip's color + whether it pulses. Blue pulse = running now. */
function stateStyle(state: PowerState): {
  color: string;
  background: string;
  border: string;
  pulse: boolean;
} {
  switch (state) {
    case "running":
      return {
        color: "#7FA3F2",
        background: "rgba(61,110,232,.16)",
        border: "1px solid rgba(61,110,232,.34)",
        pulse: true,
      };
    case "on":
      return {
        color: "var(--mv3-green)",
        background: "color-mix(in srgb, var(--mv3-green) 15%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--mv3-green) 34%, transparent)",
        pulse: false,
      };
    case "needs-you":
      return {
        color: "var(--mv3-amber-text)",
        background: "color-mix(in srgb, var(--mv3-amber) 15%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--mv3-amber) 34%, transparent)",
        pulse: false,
      };
    default:
      return {
        color: "var(--mv3-text)",
        background: "var(--mv3-btn2-bg)",
        border: "1px solid var(--mv3-btn2-border)",
        pulse: false,
      };
  }
}

function PowerRow({ power }: { power: CapabilityPower }) {
  const navigate = useNavigate();
  const chip = stateStyle(power.state);
  const actionable = power.to != null;
  return (
    <button
      type="button"
      className="cue-pressable"
      data-slot={`explore-power-${power.id}`}
      aria-label={`${power.title} — ${power.cta}`}
      disabled={!actionable}
      onClick={() => {
        if (!power.to) return;
        haptic.light();
        navigate(power.to);
      }}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "13px 15px",
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: "1px solid var(--mv3-line)",
        cursor: actionable ? "pointer" : "default",
        fontFamily: "inherit",
        color: "var(--mv3-text)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          background: "var(--mv3-chip-bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          flexShrink: 0,
        }}
      >
        {power.glyph}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 14.5,
            fontWeight: 600,
            letterSpacing: "-.2px",
          }}
        >
          {power.title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            color: "var(--mv3-muted)",
            marginTop: 2,
            lineHeight: 1.4,
          }}
        >
          {power.line}
        </span>
        {power.caveat ? (
          <span
            style={{
              display: "block",
              fontSize: 12,
              color: "var(--mv3-amber-text)",
              marginTop: 3,
            }}
          >
            {power.caveat}
          </span>
        ) : null}
      </span>
      <span
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 12,
          fontWeight: 600,
          borderRadius: 99,
          padding: "5px 11px",
          marginTop: 2,
          color: chip.color,
          background: chip.background,
          border: chip.border,
        }}
      >
        {chip.pulse ? (
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#7FA3F2",
              animation: "mv3Breathe 1.8s ease-in-out infinite",
            }}
          />
        ) : null}
        {power.cta}
      </span>
    </button>
  );
}

/** The screen itself, data-free — rendered by the container and the preview. */
export function Mv3ExploreView({
  powers,
  firstRun,
  onFinish,
}: {
  powers: CapabilityPower[];
  firstRun: boolean;
  onFinish: (destination?: string) => void;
}) {
  const finish = onFinish;
  return (
    <YouScreen
      tint="violet"
      testId="mv3-explore"
      // First run is a full screen with its own exit; afterwards it is a
      // You-cluster leaf with the usual back chevron.
      back={firstRun ? undefined : "/assistant/channels"}
      backLabel="You"
      title="What Cue can now do for you"
      sub={`${powers.length} powers · turn on what's useful, skip the rest`}
    >
      <GlassCard padding={0} style={{ overflow: "hidden", ...rise(0.1) }}>
        {powers.map((power) => (
          <PowerRow key={power.id} power={power} />
        ))}
      </GlassCard>

      {firstRun ? (
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginTop: 4,
            ...rise(0.25),
          }}
        >
          <button
            type="button"
            onClick={() => finish()}
            style={{
              flex: 1,
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              color: "var(--mv3-muted)",
              borderRadius: 13,
              padding: "12px 0",
              fontSize: 14,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Skip for now
          </button>
          <button
            type="button"
            data-slot="explore-first-run-done"
            onClick={() => finish("/assistant/hq")}
            style={{ ...primaryBtn, flex: 1, padding: "12px 0", fontSize: 14 }}
          >
            Done
          </button>
        </div>
      ) : null}

      <TrustFootnote>
        {firstRun
          ? "Always here afterwards under You → Explore."
          : "Nothing here turns on by itself — each one says what it needs first."}
      </TrustFootnote>
    </YouScreen>
  );
}

export function Mv3ExplorePage() {
  const navigate = useNavigate();
  const { powers } = useCapabilityPowers();
  // Read once on mount: the flag flipping mid-session should not swap the
  // chrome under the user's finger.
  const [firstRun, setFirstRun] = useState(() => !readExploreSeen());

  return (
    <Mv3ExploreView
      powers={powers}
      firstRun={firstRun}
      onFinish={(destination) => {
        haptic.light();
        writeExploreSeen();
        setFirstRun(false);
        if (destination) navigate(destination);
      }}
    />
  );
}
