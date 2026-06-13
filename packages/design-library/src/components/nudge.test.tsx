import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Nudge } from "./nudge";

describe("Nudge", () => {
  test("info tone uses the blue accent stripe", () => {
    const html = renderToStaticMarkup(
      <Nudge tone="info" title="Dana has not replied" />,
    );
    expect(html).toContain('data-slot="nudge"');
    expect(html).toContain('data-tone="info"');
    expect(html).toContain("var(--accent-cue)");
    expect(html).toContain("Dana has not replied");
  });

  test("commitment tone uses the violet accent", () => {
    const html = renderToStaticMarkup(
      <Nudge tone="commitment" title="You promised the forecast" />,
    );
    expect(html).toContain('data-tone="commitment"');
    expect(html).toContain("var(--accent-cue-violet)");
  });

  test("defaults to info and role=status", () => {
    const html = renderToStaticMarkup(<Nudge title="x" />);
    expect(html).toContain('data-tone="info"');
    expect(html).toContain('role="status"');
  });

  test("onDismiss renders a labelled dismiss button", () => {
    const onDismiss = mock(() => {});
    const html = renderToStaticMarkup(
      <Nudge title="x" onDismiss={onDismiss} />,
    );
    expect(html).toContain('aria-label="Dismiss"');
    onDismiss();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("emits no raw hex colors", () => {
    const html = renderToStaticMarkup(
      <Nudge tone="commitment" title="t" icon={<svg />} onDismiss={() => {}}>
        body
      </Nudge>,
    );
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});
