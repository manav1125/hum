/**
 * Tests for the desktop Plugins marketplace (spec W1): the installed section
 * and its Enabled ⟷ Disabled lifecycle state, the registry Explore section,
 * registry-driven curation badges, catalog suppression of already-installed
 * entries, and the update-available flag on an installed card behind the
 * marketplace pin.
 *
 * Strategy: pre-populate the React Query cache with the data we want the tab
 * to render — `renderToStaticMarkup` is single-pass, so a useQuery whose
 * queryFn hasn't resolved yet always reports `isLoading=true`. Pre-populating
 * skips the pending state on first render. happy-dom's `matchMedia` reports
 * `matches: false` for the mobile query, so `useIsMobile()` renders the
 * desktop branch under test.
 */

import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

// `useIsMobile` reads `window.matchMedia` via `useSyncExternalStore` with no
// server snapshot, which throws under `renderToStaticMarkup`. Pin it to the
// desktop branch (the surface under test here).
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
  useMobileLayout: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

import {
  pluginsByNameInspectGetQueryKey,
  pluginsGetQueryKey,
  pluginsSearchGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  PluginsByNameInspectGetData,
  PluginsByNameInspectGetResponse,
  PluginsGetData,
  PluginsGetResponse,
  PluginsSearchGetData,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

import { PluginsTab } from "./plugins-tab";

const ASSISTANT_ID = "asst-1";

interface CachedState {
  installed?: PluginsGetResponse;
  catalog?: PluginsSearchGetResponse;
  drift?: Record<string, PluginsByNameInspectGetResponse>;
}

function renderTab(state: CachedState): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (state.installed) {
    client.setQueryData(
      pluginsGetQueryKey({
        path: { assistant_id: ASSISTANT_ID },
        query: {},
      } as Options<PluginsGetData>),
      state.installed,
    );
  }
  if (state.catalog) {
    client.setQueryData(
      pluginsSearchGetQueryKey({
        path: { assistant_id: ASSISTANT_ID },
        query: {},
      } as Options<PluginsSearchGetData>),
      state.catalog,
    );
  }
  for (const [name, inspect] of Object.entries(state.drift ?? {})) {
    client.setQueryData(
      pluginsByNameInspectGetQueryKey({
        path: { assistant_id: ASSISTANT_ID, name },
      } as Options<PluginsByNameInspectGetData>),
      inspect,
    );
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Wrapper>
        <PluginsTab assistantId={ASSISTANT_ID} />
      </Wrapper>
    </QueryClientProvider>,
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <div>{children}</div>
    </MemoryRouter>
  );
}

function driftResponse(
  name: string,
  status: PluginsByNameInspectGetResponse["status"],
): PluginsByNameInspectGetResponse {
  return {
    name,
    installed: true,
    status,
    local: {
      target: `/ws/plugins/${name}`,
      commit: "60a392b0000000000000000000000000000000aa",
      committedAt: null,
      version: "0.1.0",
      description: "Level Up plugin",
      installedAt: "2026-06-01T00:00:00.000Z",
      source: { kind: "github", owner: "vellum-ai", repo: name, ref: "main" },
      localChanges: { modified: [], added: [], removed: [], clean: true },
      issues: [],
    },
    remote: {
      repo: `vellum-ai/${name}`,
      path: "",
      commit:
        status === "update-available"
          ? "3eae1820000000000000000000000000000000bb"
          : "60a392b0000000000000000000000000000000aa",
      committedAt: null,
      description: "Level Up plugin",
      homepage: null,
      license: "MIT",
      category: null,
      marketplaceRef: "main",
    },
    remoteError: null,
  };
}

/** Occurrences of `needle` in `haystack` — the rail label repeats the badge
 * vocabulary, so badge assertions have to count rather than just contain. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("PluginsTab (desktop W1)", () => {
  test("renders the registry hero + Explore section", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: { query: "", ref: "main", matches: [] },
    });
    expect(html).toContain("The plugin registry");
    expect(html).toContain("Explore the registry");
    expect(html).toContain("Submit a plugin");
  });

  test("lists installed plugins under the Installed header", () => {
    const html = renderTab({
      installed: {
        plugins: [
          {
            id: "simple-memory",
            name: "simple-memory",
            description: "Memory plugin",
            version: "0.1.0",
            disabled: false,
          },
        ],
      },
      catalog: { query: "", ref: "main", matches: [] },
    });
    expect(html).toContain("Installed");
    expect(html).toContain("simple-memory");
    expect(html).toContain("v0.1.0");
  });

  test("renders the Enabled/Disabled lifecycle state and the matching action", () => {
    // Install → Enabled ⟷ Disabled → Remove: the list response's `disabled`
    // is what drives the middle of that, so both states must be legible and
    // the toggle must offer the opposite action.
    const html = renderTab({
      installed: {
        plugins: [
          {
            id: "on-plugin",
            name: "on-plugin",
            description: "Running",
            version: "0.1.0",
            disabled: false,
          },
          {
            id: "off-plugin",
            name: "off-plugin",
            description: "Parked",
            version: "0.1.0",
            disabled: true,
          },
        ],
      },
      catalog: { query: "", ref: "main", matches: [] },
    });

    expect(html).toContain("Enabled");
    expect(html).toContain("Disabled");
    // The action offered is the opposite of the current state, per row.
    expect(html).toContain('aria-label="Disable on-plugin"');
    expect(html).toContain('aria-label="Enable off-plugin"');
    // And the restart caveat is stated rather than implied.
    expect(html).toContain("takes effect the next time the assistant restarts");
  });

  test("flags an installed plugin behind the marketplace pin", () => {
    const html = renderTab({
      installed: {
        plugins: [
          {
            id: "level-up",
            name: "level-up",
            description: "Level Up plugin",
            version: "0.1.0",
            disabled: false,
          },
        ],
      },
      catalog: { query: "", ref: "main", matches: [] },
      drift: { "level-up": driftResponse("level-up", "update-available") },
    });
    expect(html).toContain("Update available");
  });

  test("does not flag an installed plugin that is up to date", () => {
    const html = renderTab({
      installed: {
        plugins: [
          {
            id: "level-up",
            name: "level-up",
            description: "Level Up plugin",
            version: "0.1.0",
            disabled: false,
          },
        ],
      },
      catalog: { query: "", ref: "main", matches: [] },
      drift: { "level-up": driftResponse("level-up", "up-to-date") },
    });
    expect(html).not.toContain("Update available");
  });

  test("renders catalog matches with source repo, badge, and detail link", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: {
        query: "",
        ref: "main",
        matches: [
          {
            name: "apollo-bot-brain",
            description: "test plugin",
            reviewStatus: "community" as const,
            surfaces: [],
            category: null,
            license: null,
            homepage: null,
            icon: null,
            path: "github:acme/apollo-bot-brain@1111111111111111111111111111111111111111",
            source: {
              kind: "github",
              repo: "acme/apollo-bot-brain",
              ref: "1111111111111111111111111111111111111111",
            },
          },
        ],
      },
    });
    expect(html).toContain("apollo-bot-brain");
    // The source repo is shown on the card (W1 revision requirement).
    expect(html).toContain("acme/apollo-bot-brain");
    // The badge comes from the registry's `reviewStatus`, not the repo owner.
    // "Cue reviewed" appears once as the rail filter label; a second
    // occurrence would mean the card was badged curated.
    expect(html).toContain("Community");
    expect(countOf(html, "Cue reviewed")).toBe(1);
    expect(html).toContain('href="/assistant/plugins/apollo-bot-brain"');
  });

  test("badges a curated entry from reviewStatus, NOT from the repo owner", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: {
        query: "",
        ref: "main",
        matches: [
          {
            name: "caveman",
            description: "test plugin",
            reviewStatus: "curated" as const,
            surfaces: [],
            category: null,
            license: null,
            homepage: null,
            icon: null,
            path: "github:JuliusBrussee/caveman@63a91ecadbf4c4719a4602a5abb00883f9966034",
            source: {
              kind: "github",
              repo: "JuliusBrussee/caveman",
              ref: "63a91ecadbf4c4719a4602a5abb00883f9966034",
            },
          },
        ],
      },
    });
    // A third-party repo can still be curated — Cue maintains the adapter for
    // this one. The old `repo.startsWith("vellum-ai/")` heuristic got this
    // exactly backwards, and it never claims "official" (an ownership claim).
    expect(countOf(html, "Cue reviewed")).toBe(2); // rail label + card badge
    expect(html).not.toContain("Official");
  });

  test("a vellum-ai repo marked community does NOT read as Cue-curated", () => {
    // The other direction of the old heuristic's error: upstream authorship is
    // not a Cue endorsement.
    const html = renderTab({
      installed: { plugins: [] },
      catalog: {
        query: "",
        ref: "main",
        matches: [
          {
            name: "admin-copilot",
            description: "test plugin",
            reviewStatus: "community" as const,
            surfaces: [],
            category: null,
            license: null,
            homepage: null,
            icon: null,
            path: "github:vellum-ai/admin-copilot@d30596aa50a1c702f5d74e05c45bd965d14e2107",
            source: {
              kind: "github",
              repo: "vellum-ai/admin-copilot",
              ref: "d30596aa50a1c702f5d74e05c45bd965d14e2107",
            },
          },
        ],
      },
    });
    expect(html).toContain("Community");
    expect(countOf(html, "Cue reviewed")).toBe(1); // rail label only
  });

  test("suppresses catalog entries that are already installed", () => {
    const html = renderTab({
      installed: {
        plugins: [
          {
            id: "simple-memory",
            name: "simple-memory",
            description: null,
            version: null,
            disabled: false,
          },
        ],
      },
      catalog: {
        query: "",
        ref: "main",
        matches: [
          {
            name: "simple-memory",
            description: "test plugin",
            reviewStatus: "curated" as const,
            surfaces: [],
            category: null,
            license: null,
            homepage: null,
            icon: null,
            path: "github:vellum-ai/simple-memory@ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
            source: {
              kind: "github",
              repo: "vellum-ai/simple-memory",
              ref: "ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
            },
          },
          {
            name: "apollo-bot-brain",
            description: "test plugin",
            reviewStatus: "community" as const,
            surfaces: [],
            category: null,
            license: null,
            homepage: null,
            icon: null,
            path: "github:acme/apollo-bot-brain@1111111111111111111111111111111111111111",
            source: {
              kind: "github",
              repo: "acme/apollo-bot-brain",
              ref: "1111111111111111111111111111111111111111",
            },
          },
        ],
      },
    });
    // The catalog card renders the origin locator in a `title` attribute,
    // unique to the Explore card. The already-installed entry is suppressed
    // from Explore, so its locator title is absent; the other remains.
    expect(html).not.toContain(
      'title="github:vellum-ai/simple-memory@ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3"',
    );
    expect(html).toContain(
      'title="github:acme/apollo-bot-brain@1111111111111111111111111111111111111111"',
    );
  });

  test("shows the empty explore state when the registry is empty", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: { query: "", ref: "main", matches: [] },
    });
    expect(html).toContain("Nothing to explore");
  });
});
