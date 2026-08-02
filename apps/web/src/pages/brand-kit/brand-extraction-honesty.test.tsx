/**
 * Brand Kit extraction honesty.
 *
 * The defect these lock down: entering two different company domains produced
 * the same brand guidelines. The extract endpoint never throws — a blocked
 * host, a dead page, and a page with no brand signal all return HTTP 200 with
 * an empty draft — and the client then (a) treated 200 as success and (b)
 * spread a hardcoded `DEFAULT_PALETTE` plus literal "Tiempos"/"Söhne" type
 * names underneath the holes. The result was a complete, plausible, identical
 * profile for every failure, wired to "Save & apply everywhere".
 *
 * So: an absent value must stay absent, and a failed extraction must render as
 * a failure and never reach the review screen on its own.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

import { BrandReview } from "./brand-review";
import {
  extractionSucceeded,
  readExtraction,
  toBrandInput,
  type BrandProfileInput,
} from "./use-brand-kit";

afterEach(cleanup);

const ASSISTANT_ID = "asst-test";

/** These surfaces hold save/extract mutations, so they need a query client. */
function renderUI(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// toBrandInput — no invented values
// ---------------------------------------------------------------------------

describe("toBrandInput", () => {
  test("an empty draft yields an EMPTY palette — no fabricated colours", () => {
    const input = toBrandInput(null, "Example One");
    // The regression: this used to be five hardcoded hexes.
    expect(input.palette).toEqual({});
    expect(input.fonts).toEqual({ heading: "", body: "" });
  });

  test("two different extractions stay different all the way through", () => {
    const one = toBrandInput(
      {
        name: "Example One",
        palette: { primary: "#0b1621", accent: "#c81e28" },
        fonts: { heading: "Georgia", body: "Verdana" },
      } as Parameters<typeof toBrandInput>[0],
      "Example One",
    );
    const two = toBrandInput(
      {
        name: "Example Two",
        palette: { primary: "#f0b414", accent: "#0f785a" },
        fonts: { heading: "Palatino", body: "Tahoma" },
      } as Parameters<typeof toBrandInput>[0],
      "Example Two",
    );
    expect(one.palette).not.toEqual(two.palette);
    expect(one.fonts).not.toEqual(two.fonts);
    expect(one.name).not.toBe(two.name);
  });

  test("two FAILED extractions are both empty — not both the same template", () => {
    const one = toBrandInput(null, "Example One");
    const two = toBrandInput(null, "Example Two");
    // They are equal because they are both EMPTY. That is the honest outcome;
    // the failure shape is "nothing", never "a plausible shared kit".
    expect(Object.keys(one.palette)).toHaveLength(0);
    expect(Object.keys(two.palette)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readExtraction — the success/failure signal
// ---------------------------------------------------------------------------

describe("readExtraction", () => {
  test("passes through a daemon-supplied status", () => {
    const e = readExtraction({
      draft: {},
      extraction: { status: "blocked", detail: "Couldn't resolve that host." },
    });
    expect(e.status).toBe("blocked");
    expect(e.detail).toBe("Couldn't resolve that host.");
    expect(extractionSucceeded(e)).toBe(false);
  });

  test("only `extracted` counts as success", () => {
    for (const status of [
      "empty",
      "unreachable",
      "blocked",
      "unreadable",
      "disabled",
    ]) {
      expect(
        extractionSucceeded(
          readExtraction({ draft: {}, extraction: { status } }),
        ),
      ).toBe(false);
    }
    expect(
      extractionSucceeded(
        readExtraction({ draft: {}, extraction: { status: "extracted" } }),
      ),
    ).toBe(true);
  });

  test("an older daemon with no `extraction` field infers from the draft, and a bare draft is NOT a success", () => {
    const bare = readExtraction({
      draft: { palette: {}, fonts: {}, logo: {}, voice: {} },
    });
    expect(bare.status).toBe("empty");
    expect(extractionSucceeded(bare)).toBe(false);

    const real = readExtraction({ draft: { palette: { primary: "#0b1621" } } });
    expect(real.status).toBe("extracted");
  });

  test("a name alone is not evidence of extraction", () => {
    // Every failure path labels the draft with the host the user typed, so a
    // name must never be mistaken for a pulled-in brand value.
    const e = readExtraction({ draft: { name: "Example One" } });
    expect(e.status).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// The website flow — a 200 with nothing in it must not reach the review screen
// ---------------------------------------------------------------------------

/** Drive BrandPathFlow with a stubbed extract mutation. */
async function renderWebsiteFlow(response: unknown) {
  const actual = await import("./use-brand-kit");
  mock.module("./use-brand-kit", () => ({
    ...actual,
    useExtractBrandProfile: () => ({
      isPending: false,
      mutate: (_vars: unknown, opts?: { onSuccess?: (r: unknown) => void }) =>
        opts?.onSuccess?.(response),
    }),
  }));
  const { BrandPathFlow } = await import("./brand-paths");
  const drafts: BrandProfileInput[] = [];
  renderUI(
    <BrandPathFlow
      path="website"
      assistantId={ASSISTANT_ID}
      onDraft={(d) => drafts.push(d)}
      onBack={() => {}}
    />,
  );
  return drafts;
}

describe("WebsiteFlow", () => {
  test("a failed scan renders the failure and does NOT hand over a draft", async () => {
    const drafts = await renderWebsiteFlow({
      draft: { name: "Example", palette: {}, fonts: {}, logo: {}, voice: {} },
      extraction: {
        status: "unreachable",
        detail: "Couldn't load that page — it may be down.",
      },
    });

    fireEvent.change(screen.getByPlaceholderText("northwind.co"), {
      target: { value: "example.com" },
    });
    fireEvent.click(screen.getByText("Scan"));

    // MUTATION GUARD: if the flow ever resolves a draft on a failed
    // extraction, the review screen renders an invented profile — the exact
    // defect. `drafts` must stay empty.
    expect(drafts).toHaveLength(0);
    expect(screen.getByText("Couldn't reach it")).toBeTruthy();
    expect(screen.getByText(/no brand kit to review yet/i)).toBeTruthy();
  });

  test("a successful scan does hand over the extracted draft", async () => {
    const drafts = await renderWebsiteFlow({
      draft: {
        name: "Example One",
        palette: { primary: "#0b1621" },
        fonts: { heading: "Georgia" },
        logo: {},
        voice: {},
      },
      extraction: { status: "extracted", detail: "Read the brand signal." },
    });

    fireEvent.change(screen.getByPlaceholderText("northwind.co"), {
      target: { value: "example.com" },
    });
    fireEvent.click(screen.getByText("Scan"));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.palette.primary).toBe("#0b1621");
  });
});

// ---------------------------------------------------------------------------
// The review screen — undetected values must read as undetected
// ---------------------------------------------------------------------------

describe("BrandReview", () => {
  const emptyKit: BrandProfileInput = {
    name: "Example One",
    palette: {},
    fonts: {},
    logo: {},
    voice: {},
    assets: [],
  };

  test("undetected type is not backfilled with a real typeface name", () => {
    renderUI(<BrandReview assistantId={ASSISTANT_ID} initial={emptyKit} />);
    // The regression: these literal names rendered in the specimen slots,
    // indistinguishable from a detected face, identical for every brand.
    expect(screen.queryByText("Tiempos")).toBeNull();
    expect(screen.queryByText("Söhne")).toBeNull();
    expect(screen.getAllByText("— not detected").length).toBe(2);
  });

  test("empty palette slots are labelled `none`, so a stand-in can't read as a colour", () => {
    renderUI(<BrandReview assistantId={ASSISTANT_ID} initial={emptyKit} />);
    expect(screen.getByText("Primary · none")).toBeTruthy();
    expect(screen.getByText("Accent · none")).toBeTruthy();
  });

  test("a kit with no values says the preview is stand-in styling, not 'your brand'", () => {
    renderUI(<BrandReview assistantId={ASSISTANT_ID} initial={emptyKit} />);
    expect(screen.getByText(/isn't your brand/i)).toBeTruthy();
    expect(screen.queryByText(/not the demo/i)).toBeNull();
  });

  test("a real kit keeps the detected values and the confident copy", () => {
    renderUI(
      <BrandReview
        assistantId={ASSISTANT_ID}
        initial={{
          ...emptyKit,
          palette: { primary: "#0b1621", accent: "#c81e28" },
          fonts: { heading: "Georgia", body: "Verdana" },
        }}
      />,
    );
    expect(screen.getByText("Georgia")).toBeTruthy();
    expect(screen.getByText("Verdana")).toBeTruthy();
    expect(screen.getByText("Primary")).toBeTruthy();
    expect(screen.getByText(/not the demo/i)).toBeTruthy();
  });
});
