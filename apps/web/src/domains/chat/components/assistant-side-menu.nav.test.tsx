/**
 * The desktop rail's navigation, as RENDERED.
 *
 * `nav-model.test.ts` asserts the shared declaration and `rail-peek.test.ts`
 * asserts the expansion rule; this file asserts that the rail actually draws
 * them — the half a shared constant cannot guarantee on its own. v11's bug was
 * exactly that gap: the constant said "Work", the rail still said "Projects",
 * and nothing objected.
 *
 * Scope is the rail and the peek. The conversation list is covered by the
 * sidebar-state tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

interface FakeProject {
  id: string;
  title?: string;
  status: string;
  stats?: {
    counts: { queued: number; running: number; awaiting_review: number };
  };
}
interface FakeItem {
  id: string;
  status: string;
  title?: string;
  dueAt?: number | null;
}

let projects: FakeProject[] = [];
let workItems: FakeItem[] = [];
let interactions: { requestId: string; toolName?: string }[] = [];
let projectsFail = false;

/**
 * The People row's gate reads live data — contacts, and the relationship
 * memories extraction has written against them. These two refs are the whole
 * input; `shouldShowPeopleRow` is the whole rule.
 */
interface FakeContact {
  id: string;
  displayName: string;
  role: string;
  interactionCount: number;
  lastInteraction?: number | null;
  channels: unknown[];
}
let contacts: FakeContact[] = [];
let contactMemories: Record<string, { id: string }[]> = {};

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  projectsGet: mock(async () => {
    if (projectsFail) throw new Error("daemon unreachable");
    return { data: { projects }, ...okResponse };
  }),
  // Honour the status filter: the needs-you badge asks for `awaiting_review`
  // while the rail's counts read the unfiltered list, and a mock that ignored
  // the query would make those two indistinguishable.
  workitemsGet: mock(async (options?: { query?: { status?: string } }) => {
    const status = options?.query?.status;
    return {
      data: {
        items: status
          ? workItems.filter((i) => i.status === status)
          : workItems,
      },
      ...okResponse,
    };
  }),
  pendinginteractionsGet: mock(async () => ({
    data: { interactions },
    ...okResponse,
  })),
  contactsGet: mock(async () => ({ data: { contacts }, ...okResponse })),
  contactsByIdMemoryGet: mock(async (options?: { path?: { id?: string } }) => ({
    data: { memory: contactMemories[options?.path?.id ?? ""] ?? [] },
    ...okResponse,
  })),
}));

const { AssistantSideMenu } = await import("./assistant-side-menu");
const { useRailPeekStore } = await import("@/components/nav/rail-peek-store");

function renderRail(pathname = "/assistant/hq") {
  return render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        MemoryRouter,
        { initialEntries: [pathname] },
        createElement(AssistantSideMenu, {
          assistantId: ASSISTANT_ID,
          collapsed: false,
          variant: "rail" as const,
          conversations: [],
          onSelectConversation: () => undefined,
        }),
      ),
    ),
  );
}

/** Open a section by clicking its disclosure, then wait for the lane to load. */
async function expand(label: "HQ" | "Work") {
  fireEvent.click(screen.getByLabelText(`Show what's in ${label}`));
  await waitFor(() => {
    expect(screen.queryByText("Checking…")).toBeNull();
  });
}

beforeEach(() => {
  useRailPeekStore.setState({ openSection: null });
});

afterEach(() => {
  projects = [];
  workItems = [];
  interactions = [];
  projectsFail = false;
  contacts = [];
  contactMemories = {};
  globalThis.localStorage?.clear();
  cleanup();
});

/** A contact with `memories` relationship memories written against it. */
function seedContact(id: string, memories: number): void {
  contacts.push({
    id,
    displayName: id,
    role: "contact",
    interactionCount: 1,
    lastInteraction: 1,
    channels: [],
  });
  contactMemories[id] = Array.from({ length: memories }, (_, i) => ({
    id: `${id}-m${i}`,
  }));
}

describe("the rail's top three match the phone's three tabs", () => {
  test.each(["Talk to Cue", "HQ", "Work"])("%s is in the rail", (label) => {
    renderRail();
    expect(screen.getByText(label)).toBeDefined();
  });

  test("the words the design retired are gone from the rail", () => {
    // "A rename is only finished when nothing else answers to the old word."
    renderRail();
    expect(screen.queryByText("Missions")).toBeNull();
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.queryByText("All work")).toBeNull();
    // v14's one rename. "Intelligence" named the machinery.
    expect(screen.queryByText("Intelligence")).toBeNull();
  });

  test("'New conversation' is no longer a second row — the ✎ row IS the action", () => {
    // v13 was right that the destination and the action are one intent; v14
    // kept the collapse and kept the warmer name.
    let started = 0;
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          MemoryRouter,
          null,
          createElement(AssistantSideMenu, {
            assistantId: ASSISTANT_ID,
            collapsed: false,
            variant: "rail" as const,
            conversations: [],
            onSelectConversation: () => undefined,
            onStartNewConversation: () => {
              started += 1;
            },
          }),
        ),
      ),
    );
    expect(screen.queryByText("New conversation")).toBeNull();
    fireEvent.click(screen.getByText("Talk to Cue"));
    expect(started).toBe(1);
  });

  test("⌘N is not printed in a browser tab, where nothing is listening for it", () => {
    // The accelerator is registered by the desktop app only
    // (apps/macos/src/main/commands.ts). A hint that does nothing is a lie the
    // rail is cheap enough to avoid telling.
    renderRail();
    expect(screen.queryByText("⌘N")).toBeNull();
  });
});

describe("Work's two views belong to the Work page, not the rail", () => {
  test("they are not rail rows — three rows for one destination is duplicate nav", () => {
    renderRail("/assistant/projects");
    expect(screen.queryByText("Things")).toBeNull();
    expect(screen.queryByText("Everything")).toBeNull();
  });
});

describe("one column, five rows, a door", () => {
  // The bug this replaces: v20 rendered the Tier-2 rows as a two-column CSS
  // grid, and the live app showed "Watching" as "Wat…". Design's ruling — a
  // grid reads as a keypad, breaks vertical scanning, truncates labels — is
  // asserted structurally here, because a class name is the thing that
  // regressed.
  test("the Tier-2 rows are NOT laid out in a grid", () => {
    const { container } = renderRail();
    expect(container.querySelector(".grid-cols-2")).toBeNull();
    expect(container.querySelector('[class*="grid-cols"]')).toBeNull();
  });

  test("Library sits below the conversation list, alone with the door", () => {
    renderRail();
    expect(screen.getByText("Library")).toBeDefined();
    expect(screen.getByText("Your Cue")).toBeDefined();
  });

  test("the four rows that became Your Cue leaves are gone from the rail", () => {
    // Each is still routable and each is a leaf inside Your Cue; none of them
    // is a rail row any more. "You go there to change something" is a leaf;
    // "the data accumulates on its own" is a rail row.
    renderRail();
    for (const gone of ["Agents", "Skills", "Rhythms", "Memory", "Watching"]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  test("the rows earlier rounds displaced are still gone", () => {
    renderRail();
    for (const gone of [
      "Create",
      "Voice",
      "What Cue does",
      "Trust & guardrails",
      // Settings is not a second door beside Your Cue.
      "Settings",
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  test("Your Cue is the last row and lands on the door", () => {
    renderRail();
    const door = screen.getByText("Your Cue").closest("button");
    expect(door).toBeDefined();
    expect(door?.hasAttribute("disabled")).toBe(false);
  });
});

describe("the People row is gated on real data", () => {
  test("absent while extraction has written nothing", async () => {
    // The live instance: 2 contacts, 0 memories. Contact extraction ran 697
    // times, completed every time, and wrote nothing — this is that state.
    seedContact("ada", 0);
    seedContact("grace", 0);
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("Library")).toBeDefined();
    });
    expect(screen.queryByText("People")).toBeNull();
  });

  test("absent with no contacts at all", async () => {
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("Library")).toBeDefined();
    });
    expect(screen.queryByText("People")).toBeNull();
  });

  test("present once a real memory exists against a real contact", async () => {
    seedContact("ada", 3);
    seedContact("grace", 0);
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("People")).toBeDefined();
    });
  });

  test("the badge counts contacts, and never renders a zero", async () => {
    seedContact("ada", 1);
    seedContact("grace", 1);
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("People")).toBeDefined();
    });
    expect(screen.getByText("2")).toBeDefined();
  });

  test("the assistant and the guardian are not contacts for this purpose", async () => {
    // Otherwise a fresh install clears the gate with two rows that are both
    // you — which is precisely the "prominent destination with 2 rows" design
    // refused to ship.
    contacts.push(
      {
        id: "self",
        displayName: "Cue",
        role: "assistant",
        interactionCount: 9,
        lastInteraction: 9,
        channels: [],
      },
      {
        id: "me",
        displayName: "Manav",
        role: "guardian",
        interactionCount: 9,
        lastInteraction: 9,
        channels: [],
      },
    );
    contactMemories.self = [{ id: "x" }];
    contactMemories.me = [{ id: "y" }];
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("Library")).toBeDefined();
    });
    expect(screen.queryByText("People")).toBeNull();
  });
});

describe("the counts", () => {
  test("HQ shows what needs you; Work shows how many things there are", async () => {
    projects = [
      { id: "p1", status: "active" },
      { id: "p2", status: "active" },
      { id: "p3", status: "active" },
    ];
    workItems = [
      { id: "w1", status: "awaiting_review" },
      { id: "w2", status: "running" },
    ];
    renderRail();
    await waitFor(() => {
      // 1 awaiting review → HQ's badge.
      expect(screen.getByText("1")).toBeDefined();
    });
    // 3 live things → Work's count.
    expect(screen.getByText("3")).toBeDefined();
  });

  test("nothing renders a zero — a badge that nags at zero is noise", async () => {
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("Work")).toBeDefined();
    });
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("the peek", () => {
  test("collapsed on first run — the titles are not there until asked for", async () => {
    workItems = [{ id: "w1", status: "awaiting_review", title: "Approve AR" }];
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("1")).toBeDefined();
    });
    expect(screen.queryByText("Approve AR")).toBeNull();
  });

  test("never renders more than three, whatever the lane holds", async () => {
    workItems = Array.from({ length: 9 }, (_, i) => ({
      id: `w${i}`,
      status: "awaiting_review",
      title: `Review ${i}`,
    }));
    renderRail();
    await expand("HQ");
    const shown = Array.from({ length: 9 }, (_, i) => `Review ${i}`).filter(
      (t) => screen.queryByText(t) !== null,
    );
    expect(shown.length).toBe(3);
    // 9 total − 3 shown.
    expect(screen.getByText("6 more in HQ")).toBeDefined();
  });

  test("opening Work closes HQ", async () => {
    workItems = [
      { id: "w1", status: "awaiting_review", title: "Approve AR" },
      { id: "w2", status: "running" },
    ];
    projects = [
      {
        id: "p1",
        title: "Amex",
        status: "active",
        stats: { counts: { queued: 0, running: 1, awaiting_review: 0 } },
      },
    ];
    renderRail();
    await expand("HQ");
    expect(screen.getByText("Approve AR")).toBeDefined();

    await expand("Work");
    expect(screen.getByText("Amex")).toBeDefined();
    expect(screen.queryByText("Approve AR")).toBeNull();
  });

  test("a lane that cannot read says so rather than showing zero", async () => {
    projectsFail = true;
    renderRail();
    await expand("Work");
    await waitFor(() => {
      expect(screen.getByText("⚠ Couldn't read Work")).toBeDefined();
    });
    expect(screen.queryByText("Nothing live right now")).toBeNull();
  });

  test("an empty lane says nothing is there — and means it", async () => {
    renderRail();
    await expand("HQ");
    await waitFor(() => {
      expect(screen.getByText("Nothing needs you")).toBeDefined();
    });
  });

  test("Work lists only things with something live, and counts the rest", async () => {
    projects = [
      {
        id: "p1",
        title: "Live thing",
        status: "active",
        stats: { counts: { queued: 0, running: 2, awaiting_review: 0 } },
      },
      {
        id: "p2",
        title: "Idle thing",
        status: "active",
        stats: { counts: { queued: 0, running: 0, awaiting_review: 0 } },
      },
      {
        id: "p3",
        title: "Also idle",
        status: "active",
        stats: { counts: { queued: 0, running: 0, awaiting_review: 0 } },
      },
    ];
    renderRail();
    await expand("Work");
    expect(screen.getByText("Live thing")).toBeDefined();
    expect(screen.queryByText("Idle thing")).toBeNull();
    // 3 things in the badge, 1 shown.
    expect(screen.getByText("2 more in Work")).toBeDefined();
    // Every live state carries a glyph, never colour alone.
    expect(screen.getByText("◉ 2 running")).toBeDefined();
  });
});

describe("the collapsed 52px rail", () => {
  test("carries no disclosures — there is nothing to disclose into", () => {
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          MemoryRouter,
          null,
          createElement(AssistantSideMenu, {
            assistantId: ASSISTANT_ID,
            collapsed: true,
            variant: "rail" as const,
            conversations: [],
            onSelectConversation: () => undefined,
          }),
        ),
      ),
    );
    expect(screen.queryByLabelText("Show what's in HQ")).toBeNull();
  });
});
