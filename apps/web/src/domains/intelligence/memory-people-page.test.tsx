/**
 * People — the interim tab under `Your Cue → Memory`.
 *
 * What is worth testing here is not the layout, it is the **honesty**. The
 * owner's instance has 76 contacts and zero learned memories, because contact
 * extraction ran 697 times, completed every time, and wrote nothing. A surface
 * that renders that as three blank columns is the exact failure design called
 * out: *"a no-op is not a success"*. So these tests are mostly about what the
 * page says when it has nothing, and about the two things design asked for that
 * the API cannot support.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";

const okResponse = { response: new Response(), error: undefined };

interface FakeContact {
  id: string;
  displayName: string;
  role: string;
  interactionCount: number;
  lastInteraction?: number | null;
  channels: { address: string; isPrimary: boolean }[];
}

let contacts: FakeContact[] = [];
let contactMemories: Record<string, { id: string; statement: string }[]> = {};
let workItems: { id: string; status: string; waitingOn?: string | null }[] = [];
let health: Record<string, unknown> = { degraded: false, degradedReason: null };

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  contactsGet: mock(async () => ({ data: { contacts }, ...okResponse })),
  contactsByIdMemoryGet: mock(async (options?: { path?: { id?: string } }) => ({
    data: { memory: contactMemories[options?.path?.id ?? ""] ?? [] },
    ...okResponse,
  })),
  workitemsGet: mock(async () => ({
    data: { items: workItems },
    ...okResponse,
  })),
  peopleMemoryHealthGet: mock(async () => ({ data: health, ...okResponse })),
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: { activeAssistantId: () => "asst-1" },
  },
}));

const { MemoryPeoplePage } = await import("./memory-people-page");

const DAY = 86_400_000;

function person(id: string, overrides: Partial<FakeContact> = {}): FakeContact {
  return {
    id,
    displayName: id,
    role: "contact",
    interactionCount: 4,
    lastInteraction: Date.now() - DAY,
    channels: [{ address: `${id}@example.com`, isPrimary: true }],
    ...overrides,
  };
}

function renderPage() {
  return render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(MemoryPeoplePage),
    ),
  );
}

beforeEach(() => {
  contacts = [];
  contactMemories = {};
  workItems = [];
  health = { degraded: false, degradedReason: null };
});

afterEach(cleanup);

describe("the empty middle column says why, rather than being blank", () => {
  test("a person Cue has learned nothing about says so", async () => {
    contacts.push(person("rachel"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("rachel")).toBeDefined();
    });
    await waitFor(() => {
      expect(screen.getByText(/Nothing learned yet/)).toBeDefined();
    });
  });

  test("a degraded extraction pipeline is reported in the daemon's own words", async () => {
    // The instrumentation that would have caught 697 completed runs writing
    // nothing. "Completed" and "learned something" are different outcomes.
    contacts.push(person("rachel"));
    health = {
      degraded: true,
      degradedReason:
        "No mail account is connected, so there is nothing to read.",
    };
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No mail account is connected/)).toBeDefined();
    });
  });

  test("no degraded banner when extraction is healthy", async () => {
    contacts.push(person("rachel"));
    contactMemories.rachel = [
      { id: "m1", statement: "Replies before 10am, never after 6." },
    ];
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText("Replies before 10am, never after 6."),
      ).toBeDefined();
    });
    expect(screen.queryByText(/learning nothing about the people/)).toBeNull();
  });
});

describe("relationship state carries a glyph, never colour alone", () => {
  test("waiting on them, sourced from a work item's waitingOn", async () => {
    contacts.push(person("dana"));
    workItems.push({ id: "w1", status: "running", waitingOn: "dana" });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTitle(/blocked on this person/).textContent).toContain(
        "‖ Waiting on them",
      );
    });
  });

  test("going quiet, derived from silence", async () => {
    contacts.push(person("sarah", { lastInteraction: Date.now() - 40 * DAY }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTitle(/No exchange in over/).textContent).toContain(
        "○ Going quiet",
      );
    });
  });

  test("never contacted is its own state, not 'going quiet'", async () => {
    contacts.push(person("tom", { lastInteraction: null }));
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByTitle(/never seen a message either way/).textContent,
      ).toContain("⊘ No exchange yet");
    });
  });
});

describe("what the data cannot support is stated, not faked", () => {
  test("'Owe them a reply' renders disabled with the reason", async () => {
    // Nothing on any per-contact interaction records a direction, so "whose
    // turn is it" is unknowable. Dropping the filter silently would leave no
    // record that a capability design asked for is missing.
    contacts.push(person("rachel"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("rachel")).toBeDefined();
    });
    const chip = screen
      .getByText("Owe them a reply")
      .closest("[aria-disabled]");
    expect(chip?.getAttribute("aria-disabled")).toBe("true");
    expect(chip?.textContent).toContain("⊘");
    expect(chip?.getAttribute("title")).toContain("who spoke last");
  });

  test("'By company' too — a contact has no company field", async () => {
    contacts.push(person("rachel"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("rachel")).toBeDefined();
    });
    const chip = screen.getByText("By company").closest("[aria-disabled]");
    expect(chip?.getAttribute("aria-disabled")).toBe("true");
  });

  test("the footer states the provenance design asked for", async () => {
    contacts.push(person("rachel"));
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText(/nothing here was typed in by hand/),
      ).toBeDefined();
    });
  });
});

describe("the guardian and the assistant are not people Cue knows about", () => {
  test("both are excluded, matching the sidebar gate", async () => {
    contacts.push(
      person("cue", { role: "assistant" }),
      person("manav", { role: "guardian" }),
      person("rachel"),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("rachel")).toBeDefined();
    });
    expect(screen.queryByText("cue")).toBeNull();
    expect(screen.queryByText("manav")).toBeNull();
  });
});
