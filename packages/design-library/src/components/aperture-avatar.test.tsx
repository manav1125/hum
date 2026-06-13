import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ApertureAvatar } from "./aperture-avatar";

describe("ApertureAvatar", () => {
  test("is a labelled image with the ink field and blue pupil by default", () => {
    const html = renderToStaticMarkup(<ApertureAvatar />);
    expect(html).toContain('data-slot="aperture-avatar"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Cue"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("var(--surface-ink)");
    expect(html).toContain("var(--accent-cue)");
  });

  test("listening adds a ping ring", () => {
    const html = renderToStaticMarkup(<ApertureAvatar state="listening" />);
    expect(html).toContain('data-state="listening"');
    expect(html).toContain("animate-cue-ping");
  });

  test("thinking rocks the aperture and orbits the pupil faster", () => {
    const html = renderToStaticMarkup(<ApertureAvatar state="thinking" />);
    expect(html).toContain("animate-cue-rock");
    expect(html).toContain("animate-cue-look-fast");
  });

  test("acting turns the field violet", () => {
    const html = renderToStaticMarkup(<ApertureAvatar state="acting" />);
    expect(html).toContain("var(--accent-cue-violet-strong)");
  });

  test("every animation pairs with motion-reduce:animate-none", () => {
    const html = renderToStaticMarkup(<ApertureAvatar state="listening" />);
    const anims = html.match(/animate-cue-[a-z]+/g) ?? [];
    expect(anims.length).toBeGreaterThan(0);
    expect(html).toContain("motion-reduce:animate-none");
  });

  test("size sets explicit dimensions and a custom label is honored", () => {
    const html = renderToStaticMarkup(
      <ApertureAvatar size={64} label="Cue is listening" />,
    );
    expect(html).toContain("width:64px");
    expect(html).toContain('aria-label="Cue is listening"');
  });

  test("emits no raw hex colors", () => {
    const html = renderToStaticMarkup(
      <div>
        {(["idle", "listening", "thinking", "speaking", "acting"] as const).map(
          (s) => (
            <ApertureAvatar key={s} state={s} />
          ),
        )}
      </div>,
    );
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});
