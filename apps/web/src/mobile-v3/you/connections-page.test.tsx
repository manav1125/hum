/**
 * Mv3ConnectionsPage state rendering — the connector health states against a
 * mocked daemon response:
 *  · attention → "Needs attention" tile + amber detail sheet with lastError
 *    and Reconnect;
 *  · ok → "Linked · working ✓ Nh ago" (real success signal only);
 *  · unknown → the honest plain "Linked" + the setup-not-health footnote;
 *  · header meta → "3 linked · 1 needs attention".
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router";

const HOUR = 3_600_000;

const APPS_RESPONSE = {
  configured: true,
  source: "composio",
  apps: [
    {
      slug: "gmail",
      name: "Gmail",
      category: "email",
      connected: true,
      health: {
        status: "attention",
        lastErrorAt: new Date(Date.now() - 1 * HOUR).toISOString(),
        lastError:
          "Provider rejected the connection (HTTP 401) — reconnect to fix",
        lastSuccessAt: new Date(Date.now() - 21 * 24 * HOUR).toISOString(),
        checkedAt: new Date().toISOString(),
      },
    },
    {
      slug: "googlecalendar",
      name: "Google Calendar",
      category: "calendar",
      connected: true,
      health: {
        status: "ok",
        lastSuccessAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        checkedAt: new Date().toISOString(),
      },
    },
    {
      slug: "googledocs",
      name: "Google Docs",
      category: "docs",
      connected: true,
      // No health (old daemon) → unknown fallback.
    },
    {
      slug: "notion",
      name: "Notion",
      category: "docs",
      connected: false,
    },
  ],
};

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  connectorappsGetOptions: () => ({
    queryKey: ["connector-apps-test"],
    queryFn: async () => APPS_RESPONSE,
  }),
  connectorappsGetQueryKey: () => ["connector-apps-test"],
  connectorappsConnectPostMutation: () => ({
    mutationFn: async () => ({ redirectUrl: "https://example.com/oauth" }),
  }),
  // The Phone-line row reads the Twilio config; stub it as not-configured so
  // the row renders in its "set up" state.
  integrationsTwilioConfigGetOptions: () => ({
    queryKey: ["twilio-config-test"],
    queryFn: async () => ({ success: true, hasCredentials: false }),
  }),
}));

import { Mv3ConnectionsPage } from "./connections-page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client: queryClient } as { client: QueryClient; children?: ReactNode },
        createElement(Mv3ConnectionsPage),
      ),
    ),
  );
}

afterEach(cleanup);

describe("Mv3ConnectionsPage health states", () => {
  test("renders attention, working, and honest-linked states + meta", async () => {
    renderPage();

    // Attention tile.
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    // Verified-ok tile with the real success age.
    expect(screen.getByText(/working ✓ 2h ago/)).toBeTruthy();
    // Old-daemon shape stays plainly "Linked".
    expect(screen.getAllByText("Linked").length).toBeGreaterThanOrEqual(1);
    // Header meta counts attention.
    expect(screen.getByText("3 linked · 1 needs attention")).toBeTruthy();
    // The honesty footnote renders while an unknown connection exists.
    expect(
      screen.getByText(/reflects setup, not verified health/),
    ).toBeTruthy();
  });

  test("attention detail sheet leads with the error and Reconnect", async () => {
    renderPage();
    const tile = await screen.findByRole("button", {
      name: /Gmail — needs attention/,
    });
    fireEvent.click(tile);

    expect(
      await screen.findByText(/This connection is failing — last error 1h ago/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Provider rejected the connection \(HTTP 401\) — reconnect to fix/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Last worked 3w ago/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Reconnect" }),
    ).toBeTruthy();
  });
});
