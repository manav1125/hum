import { CompanionCreature, CompanionCreatureKeyframes } from "./companion-creature";

/** Scratch preview for checking the creature against C1. Not routed. */
export function CreaturePreview() {
  const states = [
    { label: "resting · dot at 4 o'clock", props: {} },
    { label: "gaze · rolls toward your pointer", props: { gazing: true } },
    { label: "working · the dot travels", props: { working: true } },
    { label: "listening · the creature breathes", props: { listening: true } },
    { label: "watching · amber ring", props: { tone: "watching" as const } },
    { label: "recording · red, reserved", props: { tone: "recording" as const } },
    { label: "offline · dimmed to slate", props: { tone: "offline" as const, still: true } },
  ];
  return (
    <div style={{ background: "#2A2140", minHeight: "100vh", padding: 40 }}>
      <CompanionCreatureKeyframes />
      <div style={{ display: "flex", gap: 30, flexWrap: "wrap" }}>
        {states.map((s) => (
          <div key={s.label} style={{ textAlign: "center", width: 240 }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
              <CompanionCreature box={176} {...s.props} />
            </div>
            <p style={{ color: "#9A9AA8", font: "11px/1.4 ui-sans-serif", margin: 0 }}>
              {s.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
