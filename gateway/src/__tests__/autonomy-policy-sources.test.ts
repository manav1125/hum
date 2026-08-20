/**
 * Provenance on the autonomy-policy endpoint.
 *
 * The resolved map alone cannot be read back as a user's answer: this file's
 * own default for `send` is `"auto"`, which is byte-identical to a deliberate
 * opt-in. The first-run consent screen seeds its switches from this endpoint
 * and replays on every new device (its gate is device-scoped by design), so
 * without the distinction it either resets an instance that already holds
 * policy or presents `send: "auto"` to a brand-new user as if they had chosen
 * it — the default that already had a background run email a partner here.
 *
 * `sources` is the distinction, and it stores nothing new: a row exists if and
 * only if somebody wrote that category.
 *
 * HOW TO RUN THIS FILE
 * --------------------
 *   cd gateway && bun test src/__tests__/autonomy-policy-sources.test.ts
 *
 * Per-file, like every other DB-backed test here. A whole-directory
 * `bun test src/__tests__/` runs them in ONE process, and `initGatewayDb`
 * crashes inside drizzle-kit's `generateSqliteSnapshot` once another file has
 * already loaded `schema.ts` — which is why `push-schema-no-prompt.test.ts`,
 * the repo's own test of that push, fails there too. Pre-existing, and the
 * reason `test-preload.ts` prints "run gateway tests from the gateway package".
 *
 * MUTATION CHECK (run by hand; each does go red):
 *   · mark every category "stored" in `resolveAutonomyPolicyState` → "a
 *     category nobody wrote is reported as a DEFAULT" fails.
 *   · drop the `sources[row.category] = "stored"` assignment → "a category
 *     somebody wrote is reported as STORED" fails.
 *   · move the assignment out of the `isValidMode` branch → "a row that does
 *     not parse is not an answer" fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { testSecurityDir } from "./test-preload.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { autonomyCategoryPolicies } from "../db/schema.js";
import {
  createAutonomyPoliciesGetHandler,
  createAutonomyPoliciesPutHandler,
  resolveAutonomyPolicyState,
  SAFE_DEFAULT_POLICIES,
} from "../http/routes/autonomy-policies.js";

const dbPath = join(testSecurityDir, "gateway.sqlite");

function cleanDb(): void {
  resetGatewayDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix);
    } catch {
      /* may not exist */
    }
  }
}

beforeEach(async () => {
  // Re-assert the isolated security dir rather than trusting the preload to
  // still be in effect. `test-preload.ts` DELETES `GATEWAY_SECURITY_DIR` in its
  // afterAll, and a whole-directory `bun test` runs these files in one process
  // — so the first DB-backed file to finish tears the variable out from under
  // every file after it, and `initGatewayDb` then refuses to open at all.
  process.env.GATEWAY_SECURITY_DIR = testSecurityDir;
  cleanDb();
  await initGatewayDb();
});

afterEach(cleanDb);

/** Write a row the way a user's Guardrails change would. */
function storedAnswer(category: string, mode: string): void {
  getGatewayDb()
    .insert(autonomyCategoryPolicies)
    .values({ category, mode })
    .run();
}

describe("a default is never reported as an answer", () => {
  test("a category nobody wrote is reported as a DEFAULT", () => {
    const { policies, sources } = resolveAutonomyPolicyState();
    // The value is still handed out — enforcement needs a complete map…
    expect(policies.send).toBe("auto");
    // …but it is this file's opinion, and says so.
    expect(sources.send).toBe("default");
    expect(Object.values(sources).every((s) => s === "default")).toBe(true);
  });

  test("a category somebody wrote is reported as STORED", () => {
    storedAnswer("research", "never");
    const { policies, sources } = resolveAutonomyPolicyState();
    expect(policies.research).toBe("never");
    expect(sources.research).toBe("stored");
    // …and only that one. Its neighbours were not answered.
    expect(sources.draft).toBe("default");
    expect(sources.send).toBe("default");
  });

  test("a stored value that EQUALS the default is still an answer", () => {
    // The case a mode-only response can never express, and the reason the
    // consent screen can show "Send and spend" on for an owner who meant it.
    storedAnswer("send", "auto");
    const { policies, sources } = resolveAutonomyPolicyState();
    expect(policies.send).toBe(SAFE_DEFAULT_POLICIES.send);
    expect(sources.send).toBe("stored");
  });

  test("a row that does not parse is not an answer", () => {
    // A row exists, but carries no usable mode. Reporting it as a choice would
    // let a corrupt write masquerade as consent.
    storedAnswer("send", "sometimes");
    const { policies, sources } = resolveAutonomyPolicyState();
    expect(policies.send).toBe("auto");
    expect(sources.send).toBe("default");
  });
});

describe("the wire", () => {
  const url = "http://gw/v1/permissions/autonomy-policies";

  test("GET carries sources alongside policies", async () => {
    storedAnswer("draft", "never");
    const res = await createAutonomyPoliciesGetHandler()(new Request(url));
    const body = (await res.json()) as {
      policies: Record<string, string>;
      sources: Record<string, string>;
    };
    expect(body.policies.draft).toBe("never");
    expect(body.sources.draft).toBe("stored");
    expect(body.sources.other).toBe("default");
  });

  test("a PUT makes the categories it wrote answered, and only those", async () => {
    const res = await createAutonomyPoliciesPutHandler()(
      new Request(url, {
        method: "PUT",
        body: JSON.stringify({ policies: { send: "ask", money: "ask" } }),
      }),
    );
    const body = (await res.json()) as {
      policies: Record<string, string>;
      sources: Record<string, string>;
    };
    expect(res.status).toBe(200);
    expect(body.sources.send).toBe("stored");
    expect(body.sources.money).toBe("stored");
    // The consent screen's blind path deliberately omits these; an omitted key
    // must stay unanswered rather than silently acquiring one.
    expect(body.sources.research).toBe("default");
    expect(body.sources.draft).toBe("default");
    expect(body.policies.research).toBe("auto");
  });
});
