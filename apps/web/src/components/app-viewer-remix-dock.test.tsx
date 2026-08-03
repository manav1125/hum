/**
 * Opening a made thing on a phone shows the MADE THING.
 *
 * The report this covers: tapping a file in the Library handed roughly the
 * bottom half of the viewport to a "REMIX THIS DECK" panel the moment the file
 * opened — the artefact's own caption line sat behind it, there was no detent
 * low enough to get it out of the way ("window locked"), and rotating the phone
 * did not help. Three separate faults, one screen:
 *
 *   1. the panel rendered expanded, unbidden;
 *   2. nothing dismissed it — the grabber it drew was `aria-hidden` and inert,
 *      and the only escape (fullscreen) is disabled on the mobile overlay;
 *   3. landscape was worse, because a 852pt-wide stage cleared the phone width
 *      test twice over: the remix cluster fell back to the desktop row, and the
 *      deck fit-to-stage treatment (gated on width < 700) never fired, so a
 *      720pt-tall slide rendered at contract size inside a ~300pt window.
 *
 * These are the three the caller asked to be covered: the file shows, the remix
 * panel is reachable AND fully dismissable, and landscape leaves the artefact
 * readable.
 *
 * Media queries and `ResizeObserver` are stubbed — happy-dom has no layout
 * engine, and every branch under test is a decision made from those two
 * signals. Module mocks spread the real module and override only the seam
 * (the two react-query-backed hooks) so nothing else in those files is lost.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

mock.module("@/hooks/use-sandbox-fetch-proxy", () => ({
  useSandboxFetchProxy: () => {},
}));

mock.module("@/utils/sandbox-bridge", () => ({
  injectBridge: (html: string) => html,
}));

const actualBrand = await import("@/domains/create/use-active-brand");
mock.module("@/domains/create/use-active-brand", () => ({
  ...actualBrand,
  useActiveBrand: () => ({ brand: null, isLoading: false }),
  useBrandKits: () => ({ kits: [], isLoading: false }),
}));

const actualKit = await import("@/domains/create/use-kit");
mock.module("@/domains/create/use-kit", () => ({
  ...actualKit,
  useKit: () => ({ data: undefined, refetch: () => {} }),
  useKitLauncher: () => ({
    ready: true,
    launchKit: async () => null,
    regenerateAsset: async () => {},
  }),
}));

const { AppViewerContainer } =
  await import("@/components/app-viewer-container");
const { REMIX_DOCK_DRAG_PX } =
  await import("@/domains/create/create-remix-cluster");

/* -------------------------------------------------------------------------- */
/* Viewport + stage stubs                                                     */
/* -------------------------------------------------------------------------- */

const originalMatchMedia = window.matchMedia;
const originalRO = globalThis.ResizeObserver;

/** Answer the three questions the viewer asks the viewport, independently. */
function setViewport({
  narrow,
  coarse,
  short,
}: {
  narrow: boolean;
  coarse: boolean;
  short: boolean;
}) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer")
      ? coarse
      : query.includes("max-height")
        ? short
        : narrow,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Give the stage a size, since happy-dom measures everything as zero. */
function setStageSize(w: number, h: number) {
  globalThis.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe() {
      this.cb(
        [{ contentRect: { width: w, height: h } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const PHONE_PORTRAIT = { narrow: true, coarse: true, short: false };
const PHONE_LANDSCAPE = { narrow: false, coarse: true, short: true };
const DESKTOP = { narrow: false, coarse: false, short: false };

const remix = {
  asset: {
    name: "Asteroids",
    mode: "slides",
    brandKitId: null,
    noun: "deck",
  },
  brand: null,
  onReseed: () => {},
  onRestyle: () => {},
  onNewBrandKit: () => {},
  enableFanout: true,
};

function renderViewer(appName = "Asteroids Deck") {
  return render(
    <AppViewerContainer
      appId="app-1"
      appName={appName}
      html="<html><body>hi</body></html>"
      assistantId="assistant-1"
      onClose={() => {}}
      remix={remix}
    />,
  );
}

function dockToggle(): HTMLButtonElement | null {
  return document.querySelector("[data-testid='remix-dock-toggle']");
}
function dockActions(): HTMLElement | null {
  return document.getElementById("remix-dock-actions");
}
function stageIframe(): HTMLIFrameElement | null {
  return document.querySelector("iframe");
}

beforeEach(() => {
  setViewport(PHONE_PORTRAIT);
  setStageSize(393, 600);
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  globalThis.ResizeObserver = originalRO;
});

/* -------------------------------------------------------------------------- */

describe("opening a file on a phone shows the file", () => {
  test("the remix panel is closed on arrival — no action list, just a handle", () => {
    renderViewer();

    // The artefact itself is mounted and is the only thing on the stage.
    expect(stageIframe()).not.toBeNull();

    const toggle = dockToggle();
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(dockActions()).toBeNull();
    // The actions are not merely hidden — they are not rendered.
    expect(screen.queryByText("Restyle")).toBeNull();
    expect(screen.queryByText("Make variations")).toBeNull();
  });

  test("a NEW artefact opens closed too, even after the last one was opened", () => {
    const { rerender } = renderViewer();

    fireEvent.click(dockToggle() as HTMLButtonElement);
    expect(dockActions()).not.toBeNull();

    rerender(
      <AppViewerContainer
        appId="app-2"
        appName="Breakout Deck"
        html="<html><body>hi</body></html>"
        assistantId="assistant-1"
        onClose={() => {}}
        remix={{ ...remix, asset: { ...remix.asset, name: "Breakout" } }}
      />,
    );

    expect(dockToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(dockActions()).toBeNull();
  });
});

describe("the remix panel is reachable and fully dismissable", () => {
  test("tapping the handle opens it, tapping again puts it away", () => {
    renderViewer();

    fireEvent.click(dockToggle() as HTMLButtonElement);
    expect(dockToggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(dockActions()).not.toBeNull();
    expect(screen.queryByText("Restyle")).not.toBeNull();

    fireEvent.click(dockToggle() as HTMLButtonElement);
    expect(dockToggle()?.getAttribute("aria-expanded")).toBe("false");
    // Dismissal returns the full view: the panel is gone and the artefact,
    // which never unmounted, still has the stage.
    expect(dockActions()).toBeNull();
    expect(screen.queryByText("Restyle")).toBeNull();
    expect(stageIframe()).not.toBeNull();
  });

  test("the opened list is capped against the viewport and scrolls inside the cap", () => {
    renderViewer();
    fireEvent.click(dockToggle() as HTMLButtonElement);

    const actions = dockActions() as HTMLElement;
    // Percentage-of-viewport sizing is only safe because the panel is opened
    // deliberately — and it must never be taller than the window it is in.
    expect(actions.style.maxHeight).toContain("dvh");
    expect(actions.style.overflowY).toBe("auto");
  });

  test("dragging the handle down puts it away; the synthesised click cannot reopen it", () => {
    renderViewer();
    fireEvent.click(dockToggle() as HTMLButtonElement);
    expect(dockActions()).not.toBeNull();

    const toggle = dockToggle() as HTMLButtonElement;
    fireEvent.touchStart(toggle, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(toggle, {
      changedTouches: [{ clientY: 100 + REMIX_DOCK_DRAG_PX + 10 }],
    });
    expect(dockActions()).toBeNull();

    // A touchend is followed by a click on real hardware. If that click also
    // toggled, the drag would be a no-op the user could not tell from a bug.
    fireEvent.click(toggle);
    expect(dockActions()).toBeNull();
  });

  test("dragging the handle up opens it", () => {
    renderViewer();
    const toggle = dockToggle() as HTMLButtonElement;

    fireEvent.touchStart(toggle, { touches: [{ clientY: 300 }] });
    fireEvent.touchEnd(toggle, {
      changedTouches: [{ clientY: 300 - REMIX_DOCK_DRAG_PX - 10 }],
    });

    expect(dockActions()).not.toBeNull();
  });

  test("a short drag is not a gesture — the tap still decides", () => {
    renderViewer();
    const toggle = dockToggle() as HTMLButtonElement;

    fireEvent.touchStart(toggle, { touches: [{ clientY: 300 }] });
    fireEvent.touchEnd(toggle, { changedTouches: [{ clientY: 295 }] });
    fireEvent.click(toggle);

    expect(dockActions()).not.toBeNull();
  });
});

describe("landscape leaves the artefact readable", () => {
  test("a sideways phone gets the collapsed dock, not the desktop row", () => {
    setViewport(PHONE_LANDSCAPE);
    renderViewer();

    expect(dockToggle()).not.toBeNull();
    expect(dockToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/keep chatting to refine/)).toBeNull();
  });

  test("a deck on a short touch stage is scaled to fit instead of clipped", () => {
    setViewport(PHONE_LANDSCAPE);
    // The landscape stage: wide enough to clear the old width gate, far too
    // short to hold a 720pt slide.
    setStageSize(852, 300);
    renderViewer("Asteroids Deck");

    const frame = stageIframe() as HTMLIFrameElement;
    expect(frame.style.width).toBe("1280px");
    expect(frame.style.height).toBe("720px");
    // min(852/1280, 300/720) → the height is what binds.
    expect(frame.style.transform).toContain(`scale(${300 / 720})`);
  });

  test("the same stage on a desktop pointer is left unscaled", () => {
    setViewport(DESKTOP);
    setStageSize(852, 300);
    renderViewer("Asteroids Deck");

    const frame = stageIframe() as HTMLIFrameElement;
    expect(frame.style.width).toBe("");
    expect(frame.className).toContain("h-full");
  });

  test("a wide desktop still renders the inline remix row", () => {
    setViewport(DESKTOP);
    setStageSize(1400, 900);
    renderViewer("Asteroids Deck");

    expect(dockToggle()).toBeNull();
    expect(screen.queryByText(/keep chatting to refine/)).not.toBeNull();
  });
});
