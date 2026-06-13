import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { VoiceOrb } from "./voice-orb";

describe("VoiceOrb", () => {
  test("idle renders the core with no rings or equalizer", () => {
    const html = renderToStaticMarkup(<VoiceOrb />);
    expect(html).toContain('data-slot="voice-orb"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Voice idle"');
    expect(html).not.toContain("animate-cue-ping");
    expect(html).not.toContain("animate-cue-eq");
  });

  test("listening adds expanding rings and the violet equalizer", () => {
    const html = renderToStaticMarkup(<VoiceOrb state="listening" />);
    expect(html).toContain("animate-cue-ping");
    expect(html).toContain("animate-cue-eq");
    expect(html).toContain("var(--accent-cue-violet)");
    expect(html).toContain('aria-label="Listening"');
  });

  test("speaking shows rings but no equalizer", () => {
    const html = renderToStaticMarkup(<VoiceOrb state="speaking" />);
    expect(html).toContain("animate-cue-ping");
    expect(html).not.toContain("animate-cue-eq");
  });

  test("thinking pulses the core", () => {
    const html = renderToStaticMarkup(<VoiceOrb state="thinking" />);
    expect(html).toContain("animate-cue-pulse");
    expect(html).not.toContain("animate-cue-ping");
  });

  test("animations pair with motion-reduce:animate-none", () => {
    const html = renderToStaticMarkup(<VoiceOrb state="listening" />);
    expect(html).toContain("motion-reduce:animate-none");
  });

  test("the core uses the Cue accent and emits no raw hex", () => {
    const html = renderToStaticMarkup(
      <div>
        {(["idle", "listening", "thinking", "speaking"] as const).map((s) => (
          <VoiceOrb key={s} state={s} />
        ))}
      </div>,
    );
    expect(html).toContain("var(--accent-cue)");
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});
