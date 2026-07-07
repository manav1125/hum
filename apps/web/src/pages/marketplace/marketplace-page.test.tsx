/**
 * MarketplacePage render verification (WS1).
 *
 * - Route registration: /assistant/marketplace resolves through the
 *   IntelligenceLayout chrome (near Skills) in the real route tree.
 * - Flag ON: the page renders the Explore surface — serif hero, tab chips,
 *   source-attributed skill cards — from a pre-populated query cache.
 * - Flag OFF: renders NO marketplace UI (redirects to Skills); pre-hydration
 *   renders nothing (no flash for users who have the flag on).
 *
 * Strategy: pre-populate the React Query cache so useQuery resolves
 * synchronously, and CLIENT-render via testing-library (zustand v5 serves
 * the initial state to SSR snapshots, so renderToStaticMarkup would not see
 * seeded stores).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { matchRoutes, MemoryRouter } from "react-router";

import {
  marketplaceInstalledGetQueryKey,
  marketplaceItemsGetQueryKey,
  marketplaceSourcesGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { routeTree } from "@/routes";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

import { MarketplacePage } from "./marketplace-page";

const ASSISTANT_ID = "asst-test";

const SOURCES = [
  {
    address: "anthropics/skills",
    kind: "github" as const,
    label: "Anthropic skills",
    enabled: true,
    builtIn: true,
  },
  {
    address: "cue-official",
    kind: "catalog" as const,
    label: "Cue official",
    enabled: true,
    builtIn: true,
  },
];

const ITEM = {
  id: "anthropics--skills--docx",
  name: "docx",
  displayName: "docx",
  description: "Create and edit Word documents",
  source: "anthropics/skills",
  sourceLabel: "Anthropic skills",
  skillPath: "skills/docx",
  ref: "main",
  capabilities: { secrets: [], connectors: [], network: [], writes: [] },
  installed: false,
};

function seededClient(): QueryClient {
  const client = new QueryClient();
  const path = { assistant_id: ASSISTANT_ID };
  client.setQueryData(marketplaceSourcesGetQueryKey({ path }), {
    sources: SOURCES,
  });
  for (const source of SOURCES) {
    client.setQueryData(
      marketplaceItemsGetQueryKey({ path, query: { source: source.address } }),
      { items: source.kind === "github" ? [ITEM] : [] },
    );
  }
  client.setQueryData(marketplaceInstalledGetQueryKey({ path }), {
    installed: [],
  });
  return client;
}

function renderPage(): string {
  const { container } = render(
    <MemoryRouter initialEntries={[routes.marketplace]}>
      <QueryClientProvider client={seededClient()}>
        <MarketplacePage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return container.innerHTML;
}

afterEach(cleanup);

function seedStores({ marketplace }: { marketplace: boolean }) {
  useResolvedAssistantsStore.getState().setActiveAssistantId(ASSISTANT_ID);
  const flags = useAssistantFeatureFlagStore.getState();
  flags.setFlags({ marketplace });
  flags.markHydrated();
}

describe("marketplace route registration", () => {
  test("/assistant/marketplace resolves in the real route tree next to Skills", () => {
    const matches = matchRoutes(routeTree as never, routes.marketplace) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(
      (matches[matches.length - 1].route as { path?: string }).path,
    ).toBe("marketplace");
    // Skills resolves through the same layout chain (same parent).
    const skillsMatches = matchRoutes(routeTree as never, routes.skills) ?? [];
    expect(skillsMatches.length).toBe(matches.length);
  });
});

describe("MarketplacePage", () => {
  test("renders Explore with hero, tabs, and source-attributed cards when the flag is ON", () => {
    seedStores({ marketplace: true });
    const html = renderPage();

    expect(html).toContain("Marketplace");
    expect(html).toContain("Skill marketplace · 2 sources");
    expect(html).toContain("Explore");
    expect(html).toContain("Sources");
    expect(html).toContain("Installed");
    // The card + its owner/repo attribution.
    expect(html).toContain("docx");
    expect(html).toContain("anthropics/skills");
    expect(html).toContain("Create and edit Word documents");
    expect(html).toContain("NO DECLARED CAPABILITIES");
  });

  test("renders NO marketplace UI when the flag is OFF", () => {
    seedStores({ marketplace: false });
    const html = renderPage();
    expect(html).not.toContain("Skill marketplace");
    expect(html).not.toContain("Explore");
  });

  test("renders nothing before flag hydration", () => {
    useResolvedAssistantsStore.getState().setActiveAssistantId(ASSISTANT_ID);
    useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
    const html = renderPage();
    expect(html).toBe("");
  });
});
