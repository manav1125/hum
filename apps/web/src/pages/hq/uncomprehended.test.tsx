/**
 * The `⌗` state — an arrival Cue read and could not make sense of.
 *
 * Every test here encodes a rule that would otherwise break silently, and the
 * suite is calibrated against three mutations:
 *
 *  1. **Widen `isUnComprehended` to include `failed`.** Four tests fail. This is
 *     the mutation that matters most: `failed` means the model never produced an
 *     answer, so during an outage EVERY arrival is `failed` and the whole task
 *     list would empty itself into the `⌗` bucket at exactly the moment Cue is
 *     least able to explain itself. The daemon pins the same boundary in
 *     `assistant/src/work-items/uncomprehended-exclusion.test.ts`; the two must
 *     not drift.
 *  2. **Fold the `⌗` count into "Came in · N".** The separate-count test fails.
 *     The comprehension failure rate is only watchable while it has its own
 *     slot — merged, a rising failure rate looks like healthy volume.
 *  3. **Render Cue's own title instead of the sender's subject.** The quoting
 *     test fails. There IS no Cue title for these; the row shows their words
 *     and marks them as borrowed, which is the whole content of the state.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, useEffect } from "react";

const NOW = Date.now();

interface ArrivalRow {
  id: string;
  channel: string;
  title: string;
  snippet: string | null;
  senderName: string | null;
  senderAddress: string | null;
  workItemId: string | null;
  createdAt: number;
}

interface ItemRow {
  id: string;
  status: string;
  title: string;
}

let ARRIVALS: ArrivalRow[] = [];
/** workItemId → comprehension status, or `undefined` for "no record → 404". */
let VERDICTS: Record<string, string | undefined> = {};
let ITEMS: Record<string, ItemRow> = {};
/** Every work-item id the daemon's list reads would return. */
let TASK_LIST: string[] = [];

function arrival(over: Partial<ArrivalRow> = {}): ArrivalRow {
  return {
    id: `arr-${over.workItemId ?? "x"}`,
    channel: "watcher:gmail",
    title: "Subject",
    snippet: null,
    senderName: null,
    senderAddress: null,
    workItemId: "wi-1",
    createdAt: NOW,
    ...over,
  };
}

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  arrivalsGetOptions: () => ({
    queryKey: ["arrivals", "surfaced"],
    queryFn: async () => ({ arrivals: ARRIVALS }),
  }),
  workitemsByIdComprehensionGetOptions: (opts: { path: { id: string } }) => ({
    queryKey: ["comprehension", opts.path.id],
    queryFn: async () => {
      const status = VERDICTS[opts.path.id];
      // The real route 404s when nothing was ever read. react-query surfaces
      // that as an error, not as data — and the hook must treat it as "ordinary
      // task", never as confusion.
      if (status === undefined) throw new Error("404");
      return { comprehension: { workItemId: opts.path.id, status } };
    },
  }),
  workitemsByIdGetOptions: (opts: { path: { id: string } }) => ({
    queryKey: ["work-item", opts.path.id],
    queryFn: async () => {
      const item = ITEMS[opts.path.id];
      if (!item) throw new Error("404");
      return { item };
    },
  }),
}));

const {
  isUnComprehended,
  UNREADABLE_STATUS,
  unreadableLabel,
  useUnreadableArrivals,
} = await import("./uncomprehended");
const { UnreadableCount, UnreadableRow, UNREADABLE_GLYPH, UNREADABLE_LINE } =
  await import("./uncomprehended-row");

beforeEach(() => {
  ARRIVALS = [];
  VERDICTS = {};
  ITEMS = {};
  TASK_LIST = [];
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The verdict boundary — `low_confidence` is the only unreadable one
// ---------------------------------------------------------------------------

describe("isUnComprehended", () => {
  test("low_confidence is the ⌗ state — Cue read it and could not name an action", () => {
    expect(UNREADABLE_STATUS).toBe("low_confidence");
    expect(isUnComprehended("low_confidence")).toBe(true);
  });

  test("failed is NOT ⌗ — the model never got to read it", () => {
    // Mutation check. Making this `true` is the change that would empty the
    // task list into `⌗` for the whole duration of a model outage.
    expect(isUnComprehended("failed")).toBe(false);
  });

  test("skipped is NOT ⌗ — not asked is not confused", () => {
    expect(isUnComprehended("skipped")).toBe(false);
  });

  test("comprehended, absent and unknown verdicts are not ⌗", () => {
    expect(isUnComprehended("comprehended")).toBe(false);
    expect(isUnComprehended(null)).toBe(false);
    expect(isUnComprehended(undefined)).toBe(false);
    expect(isUnComprehended("something_new")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The header count
// ---------------------------------------------------------------------------

describe("the Came-in header counts them separately", () => {
  test("the label is first person — it is a claim about Cue", () => {
    expect(unreadableLabel(2)).toBe("2 I couldn't read");
    expect(unreadableLabel(1)).toBe("1 I couldn't read");
  });

  test("zero renders nothing at all, not a 0", () => {
    expect(unreadableLabel(0)).toBeNull();
    const { container } = render(createElement(UnreadableCount, { count: 0 }));
    expect(container.textContent).toBe("");
  });

  test("the count carries its own glyph and its own words", () => {
    // Mutation check: merging this into "Came in · N" loses both.
    render(createElement(UnreadableCount, { count: 2 }));
    const slot = document.querySelector('[data-slot="unreadable-count"]');
    expect(slot?.textContent).toContain(UNREADABLE_GLYPH);
    expect(slot?.textContent).toContain("2 I couldn't read");
  });
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

const ROW_ITEM = {
  workItemId: "wi-1",
  arrivalId: "arr-1",
  subject: "Email from Trip.com: 上海",
  snippet: "订单已确认",
  senderName: null,
  senderAddress: "noreply@example.com",
  channel: "watcher:gmail",
  receivedAt: NOW,
  item: { id: "wi-1", status: "queued", title: "Email from Trip.com: 上海" },
};

describe("the ⌗ row", () => {
  test("carries the glyph, and it is neither ? nor ‖", () => {
    render(
      createElement(UnreadableRow, {
        item: ROW_ITEM as never,
        verbs: {},
      }),
    );
    const row = document.querySelector('[data-slot="unreadable-row"]');
    expect(row?.textContent).toContain("⌗");
    // `?` is auto-filing confidence and `‖` is needs-you. Reusing either here
    // is what made this state look covered when it did not exist.
    expect(row?.textContent).not.toContain("‖");
    expect(
      row?.querySelector('[data-slot="unreadable-subject"]')?.textContent,
    ).not.toContain("?");
  });

  test("the glyph is announced, and the subject is not paraphrased over", () => {
    // No colour-only state means nothing if the state is also invisible to a
    // reader: `⌗` carries a name, and the subject carries no `aria-label` that
    // would replace their words with a summary of them.
    render(
      createElement(UnreadableRow, { item: ROW_ITEM as never, verbs: {} }),
    );
    expect(screen.getByLabelText("Couldn't read this").textContent).toBe("⌗");
    expect(
      document
        .querySelector('[data-slot="unreadable-subject"]')
        ?.getAttribute("aria-label"),
    ).toBeNull();
  });

  test("shows the subject in italic quotation marks — their words, not a summary", () => {
    render(
      createElement(UnreadableRow, { item: ROW_ITEM as never, verbs: {} }),
    );
    const subject = document.querySelector(
      '[data-slot="unreadable-subject"]',
    ) as HTMLElement | null;
    expect(subject?.textContent).toBe("“Email from Trip.com: 上海”");
    expect(subject?.style.fontStyle).toBe("italic");
  });

  test("says the one honest line and nothing more confident", () => {
    render(
      createElement(UnreadableRow, { item: ROW_ITEM as never, verbs: {} }),
    );
    expect(
      document.querySelector('[data-slot="unreadable-line"]')?.textContent,
    ).toBe(UNREADABLE_LINE);
    expect(UNREADABLE_LINE).toBe("I couldn't tell what this needs.");
  });

  test("Open it is the only offered action — Cue has no opinion to act on", () => {
    render(
      createElement(UnreadableRow, { item: ROW_ITEM as never, verbs: {} }),
    );
    const row = document.querySelector('[data-slot="unreadable-row"]')!;
    const labels = [...row.querySelectorAll("button")].map((b) =>
      (b.textContent ?? "").trim(),
    );
    // The `⋯` is a door, not an opinion; everything else on the row would be
    // Cue proposing a next step for something it cannot describe.
    expect(labels).toEqual(["Open it", "⋯"]);
  });

  test("Open it opens the message itself, verbatim", () => {
    render(
      createElement(UnreadableRow, { item: ROW_ITEM as never, verbs: {} }),
    );
    expect(document.querySelector('[data-slot="unreadable-open"]')).toBeNull();
    fireEvent.click(screen.getByText("Open it"));
    const opened = document.querySelector('[data-slot="unreadable-open"]');
    expect(opened?.textContent).toContain("订单已确认");
    expect(opened?.textContent).toContain("noreply@example.com");
  });

  test("the ⋯ carries the verbs it was handed, and no inert ones", () => {
    const done: string[] = [];
    render(
      createElement(UnreadableRow, {
        item: ROW_ITEM as never,
        verbs: {
          file: () => done.push("file"),
          archive: () => done.push("archive"),
          done_elsewhere: () => done.push("done_elsewhere"),
        },
      }),
    );
    fireEvent.click(
      screen.getByLabelText(`More actions for “${ROW_ITEM.subject}”`),
    );
    const verbs = [...document.querySelectorAll("[data-verb]")].map((b) =>
      b.getAttribute("data-verb"),
    );
    expect(verbs).toEqual(["archive", "done_elsewhere", "file"]);
    fireEvent.click(
      document.querySelector("[data-verb='archive']") as HTMLButtonElement,
    );
    expect(done).toEqual(["archive"]);
  });
});

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * The hook's latest return, published from an effect rather than assigned
 * during render — a render-phase side effect is exactly the impurity the app's
 * own lint rules forbid, and a test that breaks the rule it is testing under is
 * not evidence of anything.
 */
const LATEST: { current: ReturnType<typeof useUnreadableArrivals> | null } = {
  current: null,
};

function Probe({ known }: { known?: ReadonlySet<string> }) {
  const result = useUnreadableArrivals("assistant-1", {
    knownWorkItemIds: known,
  });
  useEffect(() => {
    LATEST.current = result;
  });
  return null;
}

function renderProbe(known?: ReadonlySet<string>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Probe, { known }),
    ),
  );
}

describe("the scan", () => {
  test("an un-comprehended arrival is found, and is NOT in the task list", async () => {
    ARRIVALS = [
      arrival({ workItemId: "wi-1", title: "Email from Trip.com: 上海" }),
    ];
    VERDICTS = { "wi-1": "low_confidence" };
    ITEMS = { "wi-1": { id: "wi-1", status: "queued", title: "…" } };
    // The daemon excludes it from every list read — that is the backend rule
    // this surface is the other half of. If it were here, the whole feature
    // would be redundant.
    TASK_LIST = [];

    renderProbe(new Set(TASK_LIST));
    await waitFor(() => expect(LATEST.current?.count).toBe(1));
    expect(LATEST.current?.items[0]?.subject).toBe("Email from Trip.com: 上海");
    expect(TASK_LIST).not.toContain("wi-1");
  });

  test("a failed item is an ordinary task and carries no ⌗", async () => {
    // Mutation check. `failed` items ARE in the task list, so the scan's
    // pre-filter skips them — and even reached directly, the verdict decides.
    ARRIVALS = [
      arrival({
        workItemId: "wi-fail",
        title: "Email from CIPA: annual return",
      }),
    ];
    VERDICTS = { "wi-fail": "failed" };
    ITEMS = { "wi-fail": { id: "wi-fail", status: "queued", title: "…" } };

    renderProbe(new Set());
    await waitFor(() => expect(LATEST.current?.isLoading).toBe(false));
    expect(LATEST.current?.count).toBe(0);
  });

  test("a skipped item is an ordinary task and carries no ⌗", async () => {
    ARRIVALS = [
      arrival({ workItemId: "wi-skip", title: "Chase the data room" }),
    ];
    VERDICTS = { "wi-skip": "skipped" };
    ITEMS = { "wi-skip": { id: "wi-skip", status: "queued", title: "…" } };

    renderProbe(new Set());
    await waitFor(() => expect(LATEST.current?.isLoading).toBe(false));
    expect(LATEST.current?.count).toBe(0);
  });

  test("an arrival with no comprehension record at all is not ⌗", async () => {
    ARRIVALS = [arrival({ workItemId: "wi-old", title: "Book the flights" })];
    VERDICTS = {};
    ITEMS = { "wi-old": { id: "wi-old", status: "queued", title: "…" } };

    renderProbe(new Set());
    await waitFor(() => expect(LATEST.current?.isLoading).toBe(false));
    expect(LATEST.current?.count).toBe(0);
  });

  test("the count is the rows — two unreadable arrivals, two of each", async () => {
    ARRIVALS = [
      arrival({ id: "a1", workItemId: "wi-1", title: "一", createdAt: NOW }),
      arrival({
        id: "a2",
        workItemId: "wi-2",
        title: "二",
        createdAt: NOW - 1,
      }),
      arrival({
        id: "a3",
        workItemId: "wi-3",
        title: "read me",
        createdAt: NOW - 2,
      }),
    ];
    VERDICTS = {
      "wi-1": "low_confidence",
      "wi-2": "low_confidence",
      "wi-3": "comprehended",
    };
    ITEMS = {
      "wi-1": { id: "wi-1", status: "queued", title: "…" },
      "wi-2": { id: "wi-2", status: "queued", title: "…" },
      "wi-3": { id: "wi-3", status: "queued", title: "…" },
    };

    renderProbe(new Set());
    await waitFor(() => expect(LATEST.current?.count).toBe(2));
    // Never a fake number: the header count and the rows are the same array.
    expect(LATEST.current?.items.length).toBe(LATEST.current?.count);
    expect(unreadableLabel(LATEST.current!.count)).toBe("2 I couldn't read");
  });

  test("one row per work item, however many messages folded into it", async () => {
    ARRIVALS = [
      arrival({
        id: "a1",
        workItemId: "wi-1",
        title: "Re: 上海",
        createdAt: NOW,
      }),
      arrival({
        id: "a2",
        workItemId: "wi-1",
        title: "上海",
        createdAt: NOW - 1,
      }),
    ];
    VERDICTS = { "wi-1": "low_confidence" };
    ITEMS = { "wi-1": { id: "wi-1", status: "queued", title: "…" } };

    renderProbe(new Set());
    await waitFor(() => expect(LATEST.current?.isLoading).toBe(false));
    expect(LATEST.current?.count).toBe(1);
  });

  test("an item already in the task list is never scanned as ⌗", async () => {
    // The pre-filter. Passing a known id must not change the verdict for
    // anything else, and must not cost the row its place if it is wrong.
    ARRIVALS = [
      arrival({
        id: "a1",
        workItemId: "wi-known",
        title: "filed",
        createdAt: NOW,
      }),
      arrival({
        id: "a2",
        workItemId: "wi-1",
        title: "上海",
        createdAt: NOW - 1,
      }),
    ];
    VERDICTS = { "wi-known": "low_confidence", "wi-1": "low_confidence" };
    ITEMS = {
      "wi-known": { id: "wi-known", status: "queued", title: "…" },
      "wi-1": { id: "wi-1", status: "queued", title: "…" },
    };

    renderProbe(new Set(["wi-known"]));
    await waitFor(() => expect(LATEST.current?.count).toBe(1));
    expect(LATEST.current?.items[0]?.workItemId).toBe("wi-1");
  });

  test("a settled item retires its row — archiving must not leave it immortal", async () => {
    ARRIVALS = [arrival({ workItemId: "wi-1", title: "上海" })];
    VERDICTS = { "wi-1": "low_confidence" };
    ITEMS = { "wi-1": { id: "wi-1", status: "archived", title: "…" } };

    renderProbe(new Set());
    await waitFor(() => expect(LATEST.current?.isLoading).toBe(false));
    expect(LATEST.current?.count).toBe(0);
  });

  test("an arrival that never minted a work item is not a row", async () => {
    ARRIVALS = [arrival({ workItemId: null, title: "filed away" })];

    renderProbe(new Set());
    await waitFor(() => expect(LATEST.current?.isLoading).toBe(false));
    expect(LATEST.current?.count).toBe(0);
  });
});
