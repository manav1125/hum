import { CompanionSurface } from "./companion-surface";
import type { CompanionPhase } from "./companion-surface";

/** Scratch preview for checking the surface against C1/C2. Not routed in prod. */
export function CreaturePreview() {
  const rows: Array<{ phase: CompanionPhase; props?: Record<string, unknown> }> = [
    { phase: "resting" },
    { phase: "hover" },
    { phase: "listening", props: { line: "“remind me what Dana agreed on pricing…”" } },
    { phase: "working", props: { line: "Checking the pricing thread…" } },
    { phase: "watching" },
    { phase: "summary", props: { line: "Writing up what you showed me", detail: "this will be labelled a summary" } },
    { phase: "nudge", props: { line: "Dana replied on pricing — she’s in at $47." } },
    { phase: "recording", props: { line: "Recording · Board prep", detail: "12:41" } },
    { phase: "waiting", props: { line: "That one needs your okay — I’ve raised the window.", detail: "Nothing runs until you answer." } },
    { phase: "couldnt", props: { line: "I couldn’t read that just now — your question is kept." } },
    { phase: "offline", props: { line: "Notes still save. Questions wait for signal." } },
    {
      phase: "typing",
      props: {
        answer: "$47 a seat on 24 months — Dana’s procurement approved it if the loyalty discount holds.",
        source: "from the pricing thread · Aug 12",
      },
    },
  ];
  return (
    <div style={{ background: "#2A2140", minHeight: "100vh", padding: 40 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 26, alignItems: "flex-start" }}>
        {rows.map((r) => (
          <div key={r.phase}>
            <p style={{ color: "#9A9AA8", font: "10px/1 ui-monospace", letterSpacing: ".1em", textTransform: "uppercase", margin: "0 0 8px" }}>
              {r.phase}
            </p>
            <CompanionSurface phase={r.phase} avatarBox={66} growth="right" cardGrowth="up" {...r.props} />
          </div>
        ))}
      </div>
    </div>
  );
}
