/**
 * The Automations board's job here is to stop reading like the other half of
 * Schedules.
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

mock.module("@/mobile-v3/you/use-automations-data", () => ({
  ...automationsData,
  useWatchers: () => ({
    data: [
      {
        id: "w1",
        name: "Gmail — new mail",
        providerId: "gmail",
        enabled: true,
        pollIntervalMs: 300_000,
        health: "ok",
        credentialService: "gmail",
        lastPollAt: Date.now() - 60_000,
      },
    ],
    isLoading: false,
  }),
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
});
