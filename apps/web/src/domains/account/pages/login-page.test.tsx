/**
 * What a signed-out user of a Cue self-hosted install sees at
 * `/account/login`.
 *
 * This is the screen the route guard sends a lapsed session to, and it is
 * where the incident surfaced: the inherited Vellum-Platform form rendered
 * here, and its buttons open `api.workos.com/user_management/authorize` with
 * upstream's client_id. A single-tenant Cue instance has no account there, so
 * the assertions below are about ABSENCE as much as presence — no platform
 * buttons, not for a frame, and no reachable code path to WorkOS from what is
 * rendered.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The sign-on arc runs a 9s splash story and an orbital canvas; neither is
// what this test is about, and `initialStep` is its own documented seam.
// Stubbing the screen keeps the assertion on the ROUTING decision — which of
// the two screens LoginPage picks — rather than on sign-on's internals, which
// `signon-flow` owns and tests itself.
mock.module("@/lib/self-hosted/cue-connect-screen", () => ({
  CueConnectScreen: () => <div data-testid="cue-signon">cue sign-on</div>,
}));

const { LoginPage } = await import("@/domains/account/pages/login-page");

const LS_SELF_HOST_FLAG = "cue:selfHost";

afterEach(() => {
  cleanup();
  localStorage.removeItem(LS_SELF_HOST_FLAG);
  (globalThis.window as { vellum?: unknown }).vellum = undefined;
});

const renderLogin = () =>
  render(
    <MemoryRouter initialEntries={["/account/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );

describe("LoginPage on a Cue self-hosted install", () => {
  test("a seeded self-host session renders Cue sign-on, not the platform form", () => {
    localStorage.setItem(LS_SELF_HOST_FLAG, "1");

    const { getByTestId, queryByText } = renderLogin();

    expect(getByTestId("cue-signon")).toBeDefined();
    expect(queryByText("Continue with Apple")).toBeNull();
    expect(queryByText("Continue with Google")).toBeNull();
    expect(queryByText("Continue with Email")).toBeNull();
  });

  test("the packaged desktop app, signed out, renders Cue sign-on", () => {
    // The incident's exact state: origin is `app://vellum.ai` so no hostname
    // test can fire, the self-host flag was cleared by the sign-out, and no
    // token remains. Only the desktop preload's bridge still says "this is
    // Cue" — and that has to be enough.
    (globalThis.window as { vellum?: unknown }).vellum = {
      selfHost: { connected: async () => null },
    };

    const { getByTestId, queryByText } = renderLogin();

    expect(getByTestId("cue-signon")).toBeDefined();
    expect(queryByText("Continue with Apple")).toBeNull();
  });

  test("no rendered markup names Vellum or reaches workos.com", () => {
    (globalThis.window as { vellum?: unknown }).vellum = {
      selfHost: { connected: async () => null },
    };

    const { container } = renderLogin();
    const html = container.innerHTML;

    expect(html.toLowerCase()).not.toContain("vellum");
    expect(html.toLowerCase()).not.toContain("workos");
  });

  test("a plain web build still gets the platform form (no collateral change)", () => {
    // The gate must be narrow enough that a non-Cue deploy is untouched;
    // otherwise this fix would have quietly removed sign-in for the upstream
    // web build too.
    const { queryByTestId, getByText } = renderLogin();

    expect(queryByTestId("cue-signon")).toBeNull();
    expect(getByText("Sign in to Cue")).toBeDefined();
  });
});
