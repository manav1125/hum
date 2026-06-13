import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FocusCard } from "./focus-card";

describe("FocusCard", () => {
  test("renders the title and an ink field", () => {
    const html = renderToStaticMarkup(<FocusCard title="Review Acme follow-up" />);
    expect(html).toContain("Review Acme follow-up");
    expect(html).toContain('data-slot="focus-card"');
    expect(html).toContain("bg-[var(--surface-ink)]");
    expect(html).toContain("text-[color:var(--content-on-ink)]");
  });

  test("eyebrow renders in the muted on-ink mono style", () => {
    const html = renderToStaticMarkup(
      <FocusCard eyebrow="Next move" title="Do the thing" />,
    );
    expect(html).toContain("Next move");
    expect(html).toContain("var(--font-mono)");
    expect(html).toContain("text-[color:var(--content-on-ink-muted)]");
  });

  test("renders supporting copy and actions only when provided", () => {
    const withExtras = renderToStaticMarkup(
      <FocusCard title="T" actions={<button type="button">Do it</button>}>
        because Dana went quiet
      </FocusCard>,
    );
    expect(withExtras).toContain("because Dana went quiet");
    expect(withExtras).toContain("Do it");

    const bare = renderToStaticMarkup(<FocusCard title="T" />);
    expect(bare).not.toContain("Do it");
  });

  test("emits no raw hex colors", () => {
    const html = renderToStaticMarkup(
      <FocusCard eyebrow="Next move" title="T" icon={<svg />}>
        body
      </FocusCard>,
    );
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});
