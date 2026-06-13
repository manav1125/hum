import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MEMORY_TYPES, SourceTag } from "./source-tag";

describe("SourceTag", () => {
  test("colors by memory type via the --memory-* token and defaults its label", () => {
    const html = renderToStaticMarkup(<SourceTag memoryType="semantic" />);
    expect(html).toContain('data-slot="source-tag"');
    expect(html).toContain('data-memory-type="semantic"');
    expect(html).toContain("var(--memory-semantic)");
    expect(html).toContain("semantic");
    expect(html).toContain("font-mono");
  });

  test("custom children override the default label", () => {
    const html = renderToStaticMarkup(
      <SourceTag memoryType="prospective">prospective · Acme Q3</SourceTag>,
    );
    expect(html).toContain("prospective · Acme Q3");
    expect(html).toContain("var(--memory-prospective)");
  });

  test("without a memory type it renders a neutral source label", () => {
    const html = renderToStaticMarkup(<SourceTag>source: gmail</SourceTag>);
    expect(html).toContain("source: gmail");
    expect(html).toContain("var(--tag-bg-neutral)");
    expect(html).not.toContain("var(--memory-");
  });

  test("showDot=false omits the leading dot", () => {
    const withDot = renderToStaticMarkup(<SourceTag memoryType="episodic" />);
    const without = renderToStaticMarkup(
      <SourceTag memoryType="episodic" showDot={false} />,
    );
    expect(withDot.length).toBeGreaterThan(without.length);
  });

  test("covers all 8 memory types and emits no raw hex", () => {
    expect(MEMORY_TYPES).toHaveLength(8);
    const html = renderToStaticMarkup(
      <div>
        {MEMORY_TYPES.map((t) => (
          <SourceTag key={t} memoryType={t} />
        ))}
      </div>,
    );
    for (const t of MEMORY_TYPES) {
      expect(html).toContain(`var(--memory-${t})`);
    }
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});
