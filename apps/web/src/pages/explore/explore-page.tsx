/**
 * "What Cue can now do" — HQ discovery (design frame D2), serif-HQ grammar.
 *
 * Same seven powers as the mobile frame, same honesty rule: the CTA verb
 * matches the state, and the amber caveat naming the cost ("Needs the Mac app",
 * "Needs the extension", "Needs setup") sits inline in the description rather
 * than hidden behind the tap.
 *
 * Every colour is a `--mv1-*` token via `@/lib/hq-theme`, so the surface reads
 * correctly in the HQ light and dark themes (parity+ W6) with no second
 * palette.
 *
 * Mobile renders the v3 frame (D1) instead — same data hook, native grammar.
 */
import { useNavigate } from "react-router";

import {
  useCapabilityPowers,
  type CapabilityPower,
  type PowerState,
} from "@/domains/discovery/use-capability-powers";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { C, mono, serif } from "@/lib/hq-theme";
import { Mv3ExplorePage } from "@/mobile-v3/you/explore-page";
import { HqStyle } from "@/pages/hq/hq-kit";

/** State → chip colours. Blue pulse = running now, green = on, amber = needs you. */
function chipStyle(state: PowerState): React.CSSProperties {
  switch (state) {
    case "running":
      return {
        color: C.blueS,
        background: C.blueW,
        border: `1px solid color-mix(in srgb, ${C.blue} 34%, transparent)`,
      };
    case "on":
      return {
        color: C.green,
        background: `color-mix(in srgb, ${C.green} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${C.green} 34%, transparent)`,
      };
    case "needs-you":
      return {
        color: C.amber,
        background: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${C.amber} 34%, transparent)`,
      };
    default:
      return {
        color: C.t1,
        background: C.sunken,
        border: `1px solid ${C.line2}`,
      };
  }
}

function PowerCard({ power }: { power: CapabilityPower }) {
  const navigate = useNavigate();
  const chip = chipStyle(power.state);
  const actionable = power.to != null;
  return (
    <div
      data-slot={`explore-power-${power.id}`}
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: "16px 17px",
        display: "flex",
        flexDirection: "column",
        gap: 9,
        minHeight: 148,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: C.sunken,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 15,
          }}
        >
          {power.glyph}
        </span>
        <button
          type="button"
          disabled={!actionable}
          aria-label={`${power.hqTitle} — ${power.cta}`}
          onClick={() => {
            if (power.to) navigate(power.to);
          }}
          style={{
            ...chip,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            borderRadius: 999,
            padding: "5px 12px",
            fontFamily: mono,
            fontSize: 11,
            cursor: actionable ? "pointer" : "default",
          }}
        >
          {power.state === "running" ? (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: C.blue,
                animation: "hqBlink 1.8s infinite",
              }}
            />
          ) : null}
          {power.cta}
        </button>
      </div>
      <div style={{ fontFamily: serif, fontSize: 20, color: C.t1 }}>
        {power.hqTitle}
      </div>
      <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.5 }}>
        {power.line}
        {power.caveat ? (
          <>
            {" "}
            <span style={{ color: C.amber }}>{power.caveat}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The grid itself, data-free — rendered by the container and the preview. */
export function ExploreHqView({ powers }: { powers: CapabilityPower[] }) {
  return (
    <div style={{ minHeight: "100%", background: C.bg }}>
      <HqStyle />
      <div
        style={{
          maxWidth: 1000,
          margin: "0 auto",
          padding: "22px 20px 60px",
          fontFamily: "'DM Sans', system-ui, sans-serif",
          color: C.t1,
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          Explore
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 32,
            color: C.t1,
            marginTop: 6,
          }}
        >
          What Cue can now do
        </div>
        <div
          style={{
            fontSize: 14,
            color: C.t2,
            marginTop: 6,
            lineHeight: 1.55,
            maxWidth: 560,
          }}
        >
          Turn on what&rsquo;s useful. Each one says what it needs before you
          commit — nothing here switches itself on.
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 14,
            marginTop: 22,
          }}
        >
          {powers.map((power) => (
            <PowerCard key={power.id} power={power} />
          ))}
        </div>
      </div>
    </div>
  );
}

function HqExplorePage() {
  const { powers } = useCapabilityPowers();
  return <ExploreHqView powers={powers} />;
}

export function ExplorePage() {
  const isMobile = useIsMobile();
  if (isMobile) return <Mv3ExplorePage />;
  return <HqExplorePage />;
}
