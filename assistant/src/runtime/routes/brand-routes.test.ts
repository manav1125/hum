/**
 * The brand extract route's response contract.
 *
 * The load-bearing assertion is the one the defect demands: a failed
 * extraction and a successful one must NOT produce the same payload. Both
 * return HTTP 200 with a draft-shaped object — the endpoint deliberately never
 * throws — so `extraction.status` is the only thing distinguishing "we read
 * your site" from "we never reached it". A client that gets an empty draft
 * with no verdict attached will render it as a brand profile.
 *
 * Also pinned: `extraction` is a SIBLING of `draft`, never a field inside it.
 * The draft is POSTed back verbatim to create the profile, so a run-scoped
 * verdict must not ride along into the stored kit.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

/** Swapped per-test to steer what the extractor returns. */
let websiteResult: Record<string, unknown> = {};
let documentResult: Record<string, unknown> = {};

mock.module("../../brand/brand-extract-job.js", () => ({
  extractFromWebsite: async () => websiteResult,
  extractFromDocument: async () => documentResult,
}));

const { ROUTES } = await import("./brand-routes.js");
const { BadRequestError } = await import("./errors.js");

const extractRoute = ROUTES.find(
  (r) => r.operationId === "extractBrandProfile",
)!;

type ExtractResponse = {
  draft: Record<string, unknown>;
  extraction: { status: string; detail: string };
};

async function extract(body: unknown): Promise<ExtractResponse> {
  return (await extractRoute.handler({ body } as never)) as ExtractResponse;
}

const EXTRACTED = {
  name: "Example One",
  palette: { primary: "#0b1621" },
  fonts: { heading: "Georgia" },
  logo: {},
  voice: {},
  assets: [],
  source: "website",
  extraction: { status: "extracted", detail: "Read the brand signal." },
};

const FAILED = {
  name: "https://example.com",
  palette: {},
  fonts: {},
  logo: {},
  voice: {},
  assets: [],
  source: "website",
  extraction: { status: "unreachable", detail: "Couldn't load that page." },
};

describe("extractBrandProfile", () => {
  test("a success and a failure are distinguishable in the payload", async () => {
    websiteResult = EXTRACTED;
    const ok = await extract({ source: "website", ref: "https://example.com" });

    websiteResult = FAILED;
    const bad = await extract({
      source: "website",
      ref: "https://example.net",
    });

    expect(ok.extraction.status).toBe("extracted");
    expect(bad.extraction.status).toBe("unreachable");
    expect(bad.extraction.detail.length).toBeGreaterThan(0);
    // MUTATION GUARD: drop `extraction` from the response and these two become
    // the same shape with different amounts of nothing in them — which is
    // precisely how every failure came to render as a brand profile.
    expect(ok.extraction).not.toEqual(bad.extraction);
  });

  test("`extraction` is a sibling of the draft, never inside it", async () => {
    websiteResult = EXTRACTED;
    const res = await extract({
      source: "website",
      ref: "https://example.com",
    });
    expect(res.draft.extraction).toBeUndefined();
    expect(res.draft.palette).toEqual({ primary: "#0b1621" });
    expect(res.extraction.status).toBe("extracted");
  });

  test("the upload path carries a verdict too", async () => {
    documentResult = {
      ...FAILED,
      source: "upload",
      extraction: { status: "unreadable", detail: "Couldn't read that file." },
    };
    const res = await extract({ source: "upload", ref: "attach-1" });
    expect(res.extraction.status).toBe("unreadable");
    expect(res.draft.extraction).toBeUndefined();
  });

  test("the response schema declares extraction, so generated clients get it", () => {
    const shape = (
      extractRoute.responseBody as { shape?: Record<string, unknown> }
    ).shape;
    expect(shape).toBeDefined();
    expect(Object.keys(shape!)).toContain("extraction");
    expect(Object.keys(shape!)).toContain("draft");
  });

  test("a missing ref is still rejected", async () => {
    await expect(
      extract({ source: "website", ref: "  " }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
