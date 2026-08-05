/**
 * Tests for the memory ingest route handler (`memory-ingest-routes.ts`).
 *
 * The v2 ingest module is mocked so the tests assert the route layer:
 *   - request bodies that fail schema validation throw BadRequest (400)
 *   - the memory.v2.enabled gate rejects inactive installs with BadRequest
 *   - a held consolidation lock maps to Conflict (409) carrying the holder
 *   - the happy path forwards pages + flags and passes the summary through
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../config/types.js";
import { RouteError } from "../errors.js";

class FakeIngestLockedError extends Error {
  readonly holder: string;

  constructor(holder: string) {
    super(`memory ingest skipped: consolidation lock held by ${holder}`);
    this.name = "IngestLockedError";
    this.holder = holder;
  }
}

interface IngestCall {
  workspaceDir: string;
  pages: Array<{ slug: string; content: string }>;
  opts: { dryRun?: boolean; overwrite?: boolean } | undefined;
}

let ingestCalls: IngestCall[] = [];
let ingestImpl: () => Promise<Record<string, unknown>>;

const actualIngest = await import("../../../memory/v2/ingest.js");
mock.module("../../../memory/v2/ingest.js", () => ({
  ...actualIngest,
  IngestLockedError: FakeIngestLockedError,
  ingestPages: async (
    workspaceDir: string,
    pages: Array<{ slug: string; content: string }>,
    opts?: { dryRun?: boolean; overwrite?: boolean },
  ) => {
    ingestCalls.push({ workspaceDir, pages, opts });
    return ingestImpl();
  },
}));

const { handleMemoryIngest, ROUTES } =
  await import("../memory-ingest-routes.js");

const V2_CONFIG = {
  memory: { enabled: true, v2: { enabled: true } },
} as unknown as AssistantConfig;

const V2_DISABLED_CONFIG = {
  memory: { enabled: true, v2: { enabled: false } },
} as unknown as AssistantConfig;

const PAGE = { slug: "alice", content: "---\nedges: []\n---\nBody.\n" };

const EMPTY_SUMMARY = {
  results: [],
  written: 0,
  skipped: 0,
  invalid: 0,
  dryRun: false,
};

beforeEach(() => {
  ingestCalls = [];
  ingestImpl = async () => EMPTY_SUMMARY;
});

async function expectRouteError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number,
): Promise<RouteError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RouteError);
  const routeError = caught as RouteError;
  expect(routeError.code).toBe(code);
  expect(routeError.statusCode).toBe(statusCode);
  return routeError;
}

describe("handleMemoryIngest", () => {
  test("rejects a body without pages as BadRequest", async () => {
    await expectRouteError(
      handleMemoryIngest({}, V2_CONFIG),
      "BAD_REQUEST",
      400,
    );
    expect(ingestCalls).toHaveLength(0);
  });

  test("rejects an empty pages array as BadRequest", async () => {
    await expectRouteError(
      handleMemoryIngest({ pages: [] }, V2_CONFIG),
      "BAD_REQUEST",
      400,
    );
    expect(ingestCalls).toHaveLength(0);
  });

  test("rejects the request when concept-page memory is not active", async () => {
    const err = await expectRouteError(
      handleMemoryIngest({ pages: [PAGE] }, V2_DISABLED_CONFIG),
      "BAD_REQUEST",
      400,
    );
    expect(err.message).toContain("Concept-page memory is not active");
    expect(ingestCalls).toHaveLength(0);
  });

  test("maps a held consolidation lock to Conflict carrying the holder", async () => {
    ingestImpl = async () => {
      throw new FakeIngestLockedError("1234 2026-07-29 consolidation");
    };

    const err = await expectRouteError(
      handleMemoryIngest({ pages: [PAGE] }, V2_CONFIG),
      "CONFLICT",
      409,
    );
    expect(err.message).toContain("1234 2026-07-29 consolidation");
  });

  test("passes the ingest summary through and forwards dryRun/overwrite", async () => {
    const summary = {
      results: [
        { slug: "alice", action: "written" as const, warnings: [] },
        { slug: "bob", action: "skipped_exists" as const, warnings: [] },
        {
          slug: "bad",
          action: "invalid" as const,
          warnings: [],
          error: "invalid slug",
        },
      ],
      written: 1,
      skipped: 1,
      invalid: 1,
      dryRun: true,
    };
    ingestImpl = async () => summary;

    const pages = [PAGE, { slug: "bob", content: "Body.\n" }];
    const result = await handleMemoryIngest(
      { pages, dryRun: true, overwrite: true },
      V2_CONFIG,
    );

    expect(result).toEqual(summary);
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0]?.pages).toEqual(pages);
    expect(ingestCalls[0]?.opts).toEqual({ dryRun: true, overwrite: true });
  });
});

describe("ROUTES", () => {
  test("registers memory_ingest as a tagged settings.write POST", () => {
    expect(ROUTES).toHaveLength(1);
    const route = ROUTES[0];
    expect(route?.operationId).toBe("memory_ingest");
    expect(route?.method).toBe("POST");
    expect(route?.endpoint).toBe("memory/ingest");
    expect(route?.tags).toEqual(["memory"]);
    expect(route?.policy?.requiredScopes).toEqual(["settings.write"]);
  });
});
