/**
 * People (frame M3) against a mocked daemon — the honesty paths, not the pixels.
 *
 * The pipeline behind this screen reported success 697 times while writing
 * nothing, so the thing worth testing is that the screen tells four different
 * stories about "no learnings" and never a placeholder. The last test in the
 * file is a **mutation check**: it makes the memory query return nothing and
 * asserts that the learned prose actually disappears, so a future refactor
 * that renders content regardless of the query cannot pass this suite.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

const DAY = 86_400_000;

/** Mutable fixtures the mocked option factories read on every render. */
const state = {
  contacts: [] as unknown[],
  contactsFails: false,
  memory: {} as Record<string, unknown[]>,
  memoryFails: new Set<string>(),
  health: { degraded: false, degradedReason: null as string | null },
  healthFails: false,
};

function contact(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    displayName: "Dana Whitman",
    role: "contact",
    contactType: "human",
    notes: null,
    interactionCount: 31,
    lastInteraction: Date.now() - 2 * DAY,
    channels: [],
    ...over,
  };
}

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

// Spread the REAL module and override only the three seams this screen uses.
// A hand-written factory here would delete every other export for every file
// that runs after this one.
const realGen = await import("@/generated/daemon/@tanstack/react-query.gen");
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...realGen,
  contactsGetOptions: () => ({
    queryKey: ["t-contacts"],
    queryFn: () => {
      if (state.contactsFails) throw new Error("contacts 500");
      return { ok: true, contacts: state.contacts };
    },
    retry: false,
  }),
  contactsByIdMemoryGetOptions: (opts: { path: { id: string } }) => ({
    queryKey: ["t-memory", opts.path.id],
    queryFn: () => {
      if (state.memoryFails.has(opts.path.id)) throw new Error("memory 500");
      return { ok: true, memory: state.memory[opts.path.id] ?? [] };
    },
    retry: false,
  }),
  peopleMemoryHealthGetOptions: () => ({
    queryKey: ["t-health"],
    queryFn: () => {
      if (state.healthFails) throw new Error("health 500");
      return state.health;
    },
    retry: false,
  }),
}));

const { Mv3PeoplePage } = await import("./mv3-people-page");

function Wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function reset() {
  state.contacts = [contact()];
  state.contactsFails = false;
  state.memory = {};
  state.memoryFails = new Set();
  state.health = { degraded: false, degradedReason: null };
  state.healthFails = false;
}

afterEach(cleanup);

describe("Mv3PeoplePage — what it says when it knows nothing", () => {
  test("a person with zero learned memories gets the honest sentence, never a placeholder", async () => {
    reset();
    render(
      <Wrap>
        <Mv3PeoplePage />
      </Wrap>,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/hasn.t learned anything durable about Dana/i),
      ).toBeDefined();
    });
    // No lorem, no em-dash filler, no invented sentence about the person.
    expect(screen.queryByText(/Handles the redlines/i)).toBeNull();
    expect(screen.queryByText(/^—$/)).toBeNull();
  });

  test("a failed memory fetch reads DIFFERENTLY from an empty result", async () => {
    reset();
    state.memoryFails = new Set(["c1"]);
    render(
      <Wrap>
        <Mv3PeoplePage />
      </Wrap>,
    );
    await waitFor(() => {
      expect(screen.getByText(/failed request, not an empty one/i)).toBeDefined();
    });
    expect(screen.queryByText(/hasn.t learned anything durable/i)).toBeNull();
  });

  test("a degraded pipeline blames the pipeline, not the person", async () => {
    reset();
    state.health = {
      degraded: true,
      degradedReason: "the extraction budget expired before the model replied",
    };
    render(
      <Wrap>
        <Mv3PeoplePage />
      </Wrap>,
    );
    await waitFor(() => {
      expect(screen.getByText(/learning nothing about the people/i)).toBeDefined();
    });
    expect(screen.queryByText(/hasn.t learned anything durable/i)).toBeNull();
  });

  test("a failed health read is not treated as healthy — it falls back to neutral", async () => {
    reset();
    state.healthFails = true;
    render(
      <Wrap>
        <Mv3PeoplePage />
      </Wrap>,
    );
    await waitFor(() => {
      expect(screen.getByText(/hasn.t learned anything durable/i)).toBeDefined();
    });
    // An unread check must never produce the accusation.
    expect(screen.queryByText(/learning nothing about the people/i)).toBeNull();
  });

  test("a failed roster read is an error state, not an empty address book", async () => {
    reset();
    state.contactsFails = true;
    render(
      <Wrap>
        <Mv3PeoplePage />
      </Wrap>,
    );
    await waitFor(() => {
      expect(screen.getByText(/COULDN.T LOAD PEOPLE/i)).toBeDefined();
    });
    expect(screen.getByText(/nobody has been removed/i)).toBeDefined();
    expect(screen.queryByText(/Cue hasn.t met anyone yet/i)).toBeNull();
  });
});

describe("Mv3PeoplePage — relationship state", () => {
  test("a long gap surfaces the going-quiet chip with the day count on it", async () => {
    reset();
    state.contacts = [
      contact({
        id: "c2",
        displayName: "Sarah Chen",
        interactionCount: 9,
        lastInteraction: Date.now() - 11 * DAY,
      }),
    ];
    render(
      <Wrap>
        <Mv3PeoplePage />
      </Wrap>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Going quiet · 11 days/).length).toBeGreaterThan(0);
    });
  });

  test("no card ever claims a reply is owed — that field does not exist", async () => {
    reset();
    state.contacts = [
      contact({ id: "a", displayName: "A One", lastInteraction: Date.now() }),
      contact({ id: "b", displayName: "B Two", lastInteraction: Date.now() - 30 * DAY }),
    ];
    render(
      <Wrap>
        <Mv3PeoplePage />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByText("A One")).toBeDefined());
    expect(screen.queryByText(/owe a reply/i)).toBeNull();
    expect(screen.queryByText(/waiting on/i)).toBeNull();
  });
});

describe("Mv3PeoplePage — the mutation check", () => {
  /**
   * The point of this pair: if someone renders the learned prose from
   * anything other than the memory query — a cached value, a default, a
   * fallback string — the first assertion still passes and the second fails.
   */
  test("prose renders from real rows…", async () => {
    reset();
    state.memory = {
      c1: [
        {
          id: "m1",
          contactId: "c1",
          statement: "Decides the renewal",
          kind: "fact",
          source: "from_conversation",
          sourceRef: null,
          confidence: 0.9,
          createdAt: Date.now() - 20 * DAY,
          lastSeenAt: Date.now(),
        },
      ],
    };
    render(
      <Wrap>
        <Mv3PeoplePage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Decides the renewal\./)).toBeDefined(),
    );
  });

  test("…and vanishes the moment the query returns nothing", async () => {
    reset();
    state.memory = { c1: [] };
    render(
      <Wrap>
        <Mv3PeoplePage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/hasn.t learned anything durable about Dana/i),
      ).toBeDefined(),
    );
    expect(screen.queryByText(/Decides the renewal/)).toBeNull();
  });
});
