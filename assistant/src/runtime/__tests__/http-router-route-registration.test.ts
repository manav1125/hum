/**
 * Daemon-side counterpart to the gateway's
 * `assistant-scoped-routing.test.ts`.
 *
 * The gateway test mocks the daemon upstream as an always-200 stub, so it
 * proves the gateway *forwards* `/v1/assistants/{id}/<route>` flat — but it
 * would still pass even if the real daemon `HttpRouter` 404'd the flat path.
 *
 * This test closes that gap: it instantiates the real `HttpRouter` (compiled
 * from the real `ROUTES` array) and asserts that the flat daemon paths the
 * gateway forwards — `next-move`, `activity`, `work-items` — actually
 * *dispatch to a handler* rather than returning `null` (which the HTTP server
 * turns into a 404 `httpError("NOT_FOUND", ...)`).
 *
 * The bug this guards against is route-agnostic by construction: a new
 * assistant-scoped GET route can silently 404 at the daemon if
 *   - it is never spread into `ROUTES` (registration regression), or
 *   - a parameterized sibling route (e.g. a top-level `:id`) is declared
 *     earlier and shadows the literal endpoint in the compiled regex table.
 * Both failure modes leave the gateway test green while production 404s, so
 * the assertion lives here against the real router.
 *
 * Auth is bypassed via DISABLE_HTTP_AUTH so `enforcePolicy` short-circuits and
 * we test pure dispatch (route matching), not authorization.
 */

process.env.DISABLE_HTTP_AUTH = "true";

import { beforeAll, describe, expect, test } from "bun:test";

import type { AuthContext } from "../auth/types.js";
import { HttpRouter } from "../http-router.js";
import { routeDefinitionsToHTTPRoutes } from "../routes/http-adapter.js";
import { ROUTES } from "../routes/index.js";

function fakeAuth(): AuthContext {
  return {
    subject: "local:owner",
    principalType: "local",
    assistantId: "test-assistant",
    scopeProfile: "local_v1",
    scopes: new Set() as AuthContext["scopes"],
    policyEpoch: 0,
  };
}

/**
 * Dispatch a GET to the daemon's flat endpoint via the real router.
 * Returns the matched route's status, or `null` when no route matched
 * (the case the HTTP server converts into a 404).
 */
async function dispatchGet(
  router: HttpRouter,
  endpoint: string,
): Promise<number | null> {
  const url = new URL(`http://127.0.0.1/v1/${endpoint}`);
  const req = new Request(url, { method: "GET" });
  const res = await router.dispatch(
    endpoint,
    req,
    url,
    {} as ReturnType<typeof Bun.serve>,
    fakeAuth(),
  );
  return res === null ? null : res.status;
}

describe("daemon HttpRouter dispatches assistant-scoped read routes", () => {
  let router: HttpRouter;

  beforeAll(() => {
    router = new HttpRouter();
  });

  // The flat endpoints the gateway forwards `/v1/assistants/{id}/<route>` to.
  // `work-items` is the known-good control; `next-move` and `activity` are the
  // routes that surfaced the original 404.
  test.each(["next-move", "activity", "work-items"])(
    "GET /v1/%s reaches a handler (not a 404 / null dispatch)",
    async (endpoint) => {
      const status = await dispatchGet(router, endpoint);
      // A matched route returns a real status (200, or 500 when the handler
      // needs DB state this harness lacks). The bug manifests as `null` —
      // no route matched — which the HTTP server renders as a 404. So the
      // invariant is simply: dispatch must not return null.
      expect(status).not.toBeNull();
    },
  );
});

describe("compiled route table — no parameterized route shadows literals", () => {
  const httpRoutes = routeDefinitionsToHTTPRoutes(ROUTES);

  /** Re-implements `compileRoute`'s regex build (kept private in
   *  http-router.ts) so we can assert match-order independence. */
  function compile(endpoint: string): RegExp {
    const src = endpoint
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          const isCatchAll = seg.endsWith("*");
          return isCatchAll ? "(.+)" : "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("\\/");
    return new RegExp(`^${src}$`);
  }

  test.each([
    ["get_next_move", "next-move"],
    ["activity_list", "activity"],
  ])(
    "the first GET route matching %s is the literal %s route",
    (operationId, endpoint) => {
      const firstMatch = httpRoutes.find(
        (r) => r.method === "GET" && compile(r.endpoint).test(endpoint),
      );
      expect(firstMatch).toBeDefined();
      // If a parameterized sibling (e.g. a top-level `:id`) were declared
      // earlier in ROUTES, it would win the match and `operationId` would
      // differ — exactly the silent-shadowing regression we guard against.
      expect(firstMatch?.operationId).toBe(operationId);
    },
  );
});
