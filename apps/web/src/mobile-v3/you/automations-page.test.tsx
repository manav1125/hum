/**
 * The mobile Automations leaf must not call a poll a hit.
 *
 * It rendered `hit ${agoLabel(lastPollAt)}` — the poll clock under a hit's
 * label. In production that made a GitHub watcher which had polled ~320 times
 * over 27 hours with zero `watcher_events` rows read as "hit 2m ago"; the owner
 * reported it as "it doesn't seem to point anywhere but yet it's on". Both
 * halves of that sentence are held here: the card says what the watcher is
 * pointed at, and it says what has actually arrived.
 *
 * The desktop board (`domains/automations/automations-board.test.tsx`) holds the
 * same line. Both now read the shared helpers, so a fix on one surface cannot
 * silently regress on the other.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

const reactRouter = await import("react-router");
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => () => {},
}));

const automationsData = await import("./use-automations-data");

const noop = { mutate: () => {}, isPending: false };

const HEALTHY_GMAIL = {
  id: "w1",
  name: "Gmail — new mail",
  providerId: "gmail",
  enabled: true,
  pollIntervalMs: 300_000,
  health: "ok",
  credentialService: "gmail",
  configJson: null,
  lastPollAt: Date.now() - 60_000,
  createdAt: Date.now() - 3 * 24 * 3_600_000,
  scope: { watching: true, summary: "Your connected Gmail account." },
  hitCount: 431,
  lastHitAt: Date.now() - 9 * 60_000,
};

/**
 * Swapped per test rather than fixed at module scope, because the states worth
 * holding in place are the ones a single fixture cannot show at once: producing,
 * quiet, and unable to produce.
 */
let watcherRows: Array<Record<string, unknown>> = [HEALTHY_GMAIL];

mock.module("./use-automations-data", () => ({
  ...automationsData,
  useWatchers: () => ({ data: watcherRows, isLoading: false }),
  usePlaybooks: () => ({
    data: { playbooks: [], globalDial: "assist" },
    isLoading: false,
  }),
  useWatcherProviders: () => ({ data: [] }),
  useToggleWatcher: () => noop,
  useCreateWatcher: () => noop,
  useCreatePlaybook: () => noop,
}));

const { Mv3AutomationsPage } = await import("./automations-page");

afterEach(() => {
  cleanup();
  watcherRows = [HEALTHY_GMAIL];
});

describe("Mv3AutomationsPage watcher card", () => {
  test("a watcher that has produced reports its real hit count", () => {
    render(<Mv3AutomationsPage />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Gmail — new mail");
    expect(text).toContain("431 hits");
    // The poll clock is still shown — as a check, under its own word.
    expect(text).toContain("checked 1m ago");
  });

  test("a watcher with zero events never reports a hit", () => {
    // The production GitHub row exactly: polling cleanly, watermark advancing,
    // no error, and not one event in a day and a half.
    watcherRows = [
      {
        ...HEALTHY_GMAIL,
        id: "w2",
        name: "GitHub",
        providerId: "github",
        credentialService: "github",
        scope: {
          watching: true,
          summary: "Your GitHub account's unread notifications.",
        },
        hitCount: 0,
        lastHitAt: null,
        lastPollAt: Date.now() - 2 * 60_000,
        createdAt: Date.now() - 27 * 3_600_000,
      },
    ];
    render(<Mv3AutomationsPage />);

    const text = document.body.textContent ?? "";
    // The whole complaint in one assertion: 0 events must never render as a hit.
    expect(text).not.toContain("hit 2m ago");
    expect(text).not.toContain("Last hit");
    expect(text).toContain("Nothing has arrived");
    // …and it says how long it has been quiet, so a quiet source is
    // distinguishable from one that stopped working.
    expect(text).toContain("27 hours of watching");
    expect(text).toContain("last checked 2m ago");
  });

  test("the card says what the watcher is pointed at", () => {
    render(<Mv3AutomationsPage />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Watching:");
    expect(text).toContain("Your connected Gmail account.");
  });

  test("a watcher that cannot produce does not render as healthy", () => {
    // The mutation check: take a real watcher and remove its scope. Nothing
    // else changes — same enabled flag, same fresh poll clock — so if the card
    // still reads "healthy", the health chip is measuring the wrong thing.
    watcherRows = [
      {
        ...HEALTHY_GMAIL,
        id: "w3",
        name: "GitHub",
        providerId: "github",
        credentialService: "github",
        health: "not_watching",
        scope: {
          watching: false,
          summary: "No repository or org is set, so there is nothing to poll.",
          fix: "Remove it and re-create it with a source to watch.",
        },
        hitCount: 0,
        lastHitAt: null,
      },
    ];
    render(<Mv3AutomationsPage />);

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("healthy");
    expect(text).toContain("not watching");
    // An empty state has to say WHY, and what would fix it.
    expect(text).toContain("nothing to poll");
    expect(text).toContain("re-create it with a source");
  });

  test("every health state carries a glyph, not just a colour", () => {
    watcherRows = [
      HEALTHY_GMAIL,
      { ...HEALTHY_GMAIL, id: "w4", health: "not_connected" },
      { ...HEALTHY_GMAIL, id: "w5", health: "reauth" },
      {
        ...HEALTHY_GMAIL,
        id: "w6",
        health: "not_watching",
        scope: { watching: false, summary: "Nothing to poll." },
      },
    ];
    render(<Mv3AutomationsPage />);

    const text = document.body.textContent ?? "";
    for (const glyph of ["✓", "▲", "⊘"]) {
      expect(text).toContain(glyph);
    }
  });

  test("a daemon too old to send hit counts says only that it checked", () => {
    // Forward compatibility runs both ways: this client can be newer than the
    // daemon. Absent counts must degrade to the poll fact under the poll's own
    // word — never be back-filled into a hit.
    watcherRows = [
      {
        ...HEALTHY_GMAIL,
        id: "w7",
        scope: undefined,
        hitCount: undefined,
        lastHitAt: undefined,
      },
    ];
    render(<Mv3AutomationsPage />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Last checked 1m ago");
    expect(text).not.toContain("Last hit");
    expect(text).not.toContain("hits");
  });
});
