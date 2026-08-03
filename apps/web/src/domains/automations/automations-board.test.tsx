/**
 * The Automations board's job here is to stop reading like the other half of
 * Schedules, and to stop calling a poll a hit.
 *
 * Both leaves sit under "What it does alone" and the owner asked, reasonably,
 * whether they were one thing. They are not — a schedule fires on a clock and
 * an automation fires when something arrives — but nothing on either page said
 * so. These tests hold the distinguishing line and the honest empty state in
 * place.
 *
 * The empty state matters on its own: prod runs three healthy watchers and zero
 * playbooks, and the old copy ("No playbooks yet — turn a watcher hit into an
 * action") reads as "nothing is happening here". Watcher hits are still judged
 * and surfaced with no playbook at all.
 *
 * The watcher card matters for the opposite reason. It rendered
 * `Last hit ${ago(lastPollAt)}` — the poll clock under a hit's label — so a
 * GitHub watcher that had polled ~320 times and recorded zero events read as
 * "Last hit 2m ago" for a day and a half. A poll is not a hit, and a watcher
 * that cannot produce must not render green.
 */
import { describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "bun:test";

import { routes } from "@/utils/routes";

const navigateCalls: string[] = [];
const reactRouter = await import("react-router");
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => (to: string) => {
    navigateCalls.push(to);
  },
}));

const automationsData = await import("@/mobile-v3/you/use-automations-data");

const noop = { mutate: () => {}, isPending: false };

const HEALTHY_GMAIL = {
  id: "w1",
  name: "Gmail — new mail",
  providerId: "gmail",
  enabled: true,
  pollIntervalMs: 300_000,
  health: "ok",
  credentialService: "gmail",
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

mock.module("@/mobile-v3/you/use-automations-data", () => ({
  ...automationsData,
  useWatchers: () => ({ data: watcherRows, isLoading: false }),
  usePlaybooks: () => ({
    data: { playbooks: [], globalDial: "assist" },
    isLoading: false,
  }),
  useWatcherProviders: () => ({ data: [] }),
  useToggleWatcher: () => noop,
  useDeleteWatcher: () => noop,
  useCreateWatcher: () => noop,
  useTogglePlaybook: () => noop,
  useDeletePlaybook: () => noop,
  useCreatePlaybook: () => noop,
}));

const { WebAutomationsBoard } =
  await import("@/domains/automations/automations-board");

afterEach(() => {
  cleanup();
  navigateCalls.length = 0;
  watcherRows = [HEALTHY_GMAIL];
});

describe("WebAutomationsBoard", () => {
  test("says it is the arrival-driven half and links to Schedules", () => {
    render(<WebAutomationsBoard />);

    expect(document.body.textContent).toContain("Nothing here runs on a clock");
    fireEvent.click(screen.getByRole("button", { name: /Schedules/ }));
    expect(navigateCalls).toEqual([routes.settings.schedules]);
  });

  test("the zero-playbook state says watchers still work", () => {
    render(<WebAutomationsBoard />);

    // "No playbooks yet" alone reads as "nothing is happening". The copy has
    // to name what happens without one, or the surface looks broken while
    // three watchers poll behind it.
    expect(document.body.textContent).toContain("watchers still work");
    expect(document.body.textContent).toContain("Came In");
    expect(document.body.textContent).not.toContain("No playbooks yet");
  });

  test("running watchers are still listed", () => {
    render(<WebAutomationsBoard />);

    expect(document.body.textContent).toContain("Gmail — new mail");
    expect(document.body.textContent).toContain("healthy");
  });

  test("a watcher that has produced reports its real hit count", () => {
    render(<WebAutomationsBoard />);

    expect(document.body.textContent).toContain("431 hits");
    // The poll clock is still shown — as a check, under its own word.
    expect(document.body.textContent).toContain("checked 1m ago");
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
    render(<WebAutomationsBoard />);

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
    render(<WebAutomationsBoard />);

    expect(document.body.textContent).toContain("Watching:");
    expect(document.body.textContent).toContain(
      "Your connected Gmail account.",
    );
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
    render(<WebAutomationsBoard />);

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
    render(<WebAutomationsBoard />);

    const text = document.body.textContent ?? "";
    for (const glyph of ["✓", "▲", "⊘"]) {
      expect(text).toContain(glyph);
    }
  });
});
