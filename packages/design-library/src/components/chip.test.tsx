import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Chip } from "./chip";

describe("Chip", () => {
  test("renders a <button type=button> by default", () => {
    const html = renderToStaticMarkup(<Chip>Draft follow-up</Chip>);
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('data-slot="chip"');
    expect(html).toContain("Draft follow-up");
  });

  test("unselected uses the hairline surface; selected lights the blue accent", () => {
    const off = renderToStaticMarkup(<Chip>x</Chip>);
    expect(off).toContain("border-[var(--border-element)]");
    expect(off).not.toContain('aria-pressed="true"');

    const on = renderToStaticMarkup(<Chip selected>x</Chip>);
    expect(on).toContain("bg-[var(--accent-cue-weak)]");
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('data-selected="true"');
  });

  test("asChild renders the slotted element instead of a button", () => {
    const html = renderToStaticMarkup(
      <Chip asChild>
        <a href="/memory">Open Memory</a>
      </Chip>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/memory"');
    expect(html).not.toContain("<button");
  });

  test("onClick wiring is preserved", () => {
    const onClick = mock(() => {});
    renderToStaticMarkup(<Chip onClick={onClick}>x</Chip>);
    onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("emits no raw hex colors", () => {
    const html = renderToStaticMarkup(
      <div>
        <Chip leftIcon={<svg />}>a</Chip>
        <Chip selected size="sm">
          b
        </Chip>
      </div>,
    );
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});
