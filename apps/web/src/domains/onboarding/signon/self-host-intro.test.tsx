/**
 * The self-host first-run intro, clicked through end to end.
 *
 * The reason this arc exists is a gap, not a redesign: gateway (self-host)
 * sessions short-circuit the platform route guard, so until now a self-host
 * user was never asked for terms or AI-data consent and never told Cue their
 * name — they landed in a bare chat. These tests pin the two things that must
 * be true: consent is genuinely blocking, and the last screen actually leads
 * into the app.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const navigateMock = mock((..._args: unknown[]) => {});
const realRouter = await import("react-router");
mock.module("react-router", () => ({
  ...realRouter,
  useNavigate: () => navigateMock,
}));

const realAuthStore = await import("@/stores/auth-store");
let currentUser: Record<string, unknown> | null = null;
mock.module("@/stores/auth-store", () => ({
  ...realAuthStore,
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: currentUser }),
    { getState: () => ({ user: currentUser }) },
  ),
}));

const persistConsentMock = mock((..._args: unknown[]) => {});
const realCleanup = await import("@/utils/onboarding-cleanup");
mock.module("@/utils/onboarding-cleanup", () => ({
  ...realCleanup,
  persistConsentForUser: persistConsentMock,
}));

const setPendingPreChatContextMock = mock((..._args: unknown[]) => {});
const setPendingAssistantNameMock = mock((..._args: unknown[]) => {});
const realPrechat = await import("@/domains/onboarding/prechat");
mock.module("@/domains/onboarding/prechat", () => ({
  ...realPrechat,
  setPendingPreChatContext: setPendingPreChatContextMock,
  setPendingAssistantName: setPendingAssistantNameMock,
}));

const { SelfHostIntro } = await import("./self-host-intro");
const { isSelfHostIntroComplete } = await import("./intro-state");
const { readConsentScopes } = await import("./consent-scopes");
const { useOnboardingStore } =
  await import("@/domains/onboarding/onboarding-store");

beforeEach(() => {
  localStorage.clear();
  currentUser = null;
  navigateMock.mockClear();
  persistConsentMock.mockClear();
  setPendingPreChatContextMock.mockClear();
  setPendingAssistantNameMock.mockClear();
  useOnboardingStore.getState().setTosAccepted(false);
  useOnboardingStore.getState().setAiDataConsent(false);
});

afterEach(cleanup);

function advance(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("the honest landing", () => {
  test("greets by name only when the session actually carries one", () => {
    currentUser = { id: "u1", firstName: "Ada", lastName: "Lovelace" };
    render(<SelfHostIntro />);
    expect(screen.getByText("You're in, Ada.")).toBeTruthy();
  });

  test("with no name it greets without one rather than inventing one", () => {
    currentUser = { id: "u1", firstName: "", lastName: "" };
    render(<SelfHostIntro />);
    expect(screen.getByText("You're in.")).toBeTruthy();
  });

  test("an email is an identifier, not a name — it never becomes the greeting", () => {
    currentUser = { id: "u1", firstName: "ada@example.com", lastName: "" };
    render(<SelfHostIntro />);
    expect(screen.getByText("You're in.")).toBeTruthy();
    expect(screen.queryByText(/ada@example\.com/)).toBeNull();
  });

  test("it claims no activity on an instance where nothing has happened", () => {
    render(<SelfHostIntro />);
    expect(screen.getByText(/Nothing has happened here yet/)).toBeTruthy();
  });
});

describe("M8 · three cards, and send-and-spend is off", () => {
  function reachConsent() {
    render(<SelfHostIntro />);
    advance("Continue");
  }

  test("all three are on screen, as switches, with the norm stated", () => {
    reachConsent();
    expect(screen.getByRole("switch", { name: "Read and organise" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Draft and prepare" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Send and spend" })).toBeTruthy();
    expect(
      screen.getByText("Most people leave this off for the first week."),
    ).toBeTruthy();
  });

  test("the two safe ones are on and the consequential one is off", () => {
    reachConsent();
    const state = (name: string) =>
      screen.getByRole("switch", { name }).getAttribute("aria-checked");
    expect(state("Read and organise")).toBe("true");
    expect(state("Draft and prepare")).toBe("true");
    expect(state("Send and spend")).toBe("false");
  });

  test("the copy says what each card actually permits", () => {
    reachConsent();
    // Draft is only honest if it also says the output waits.
    expect(screen.getByText(/waits for your review/)).toBeTruthy();
    // Send is only honest if it says the money part out loud.
    expect(screen.getByText(/a payment — every single time/)).toBeTruthy();
  });

  test("continuing writes exactly the three scopes, send-and-spend false", () => {
    currentUser = { id: "user-1" };
    reachConsent();
    advance("Continue");

    const scopes = readConsentScopes("user-1");
    expect(scopes).toEqual({
      read_organise: true,
      draft_prepare: true,
      send_spend: false,
    });
  });

  test("…and still records the legal consent through the existing writer", () => {
    currentUser = { id: "user-1" };
    reachConsent();
    advance("Continue");

    expect(useOnboardingStore.getState().tosAccepted).toBe(true);
    expect(useOnboardingStore.getState().aiDataConsent).toBe(true);
    expect(persistConsentMock).toHaveBeenCalledWith("user-1", true, true);
  });

  test("turning send-and-spend on is possible, and only by moving that switch", () => {
    currentUser = { id: "user-1" };
    reachConsent();
    fireEvent.click(screen.getByRole("switch", { name: "Send and spend" }));
    advance("Continue");
    expect(readConsentScopes("user-1").send_spend).toBe(true);
  });
});

describe("names, then day one", () => {
  function reachNames() {
    render(<SelfHostIntro />);
    advance("Continue"); // arrived
    advance("Continue"); // consent
  }

  test("names still park through the same pre-chat writers", () => {
    reachNames();
    fireEvent.change(screen.getByLabelText("YOU ARE"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText("CUE IS"), {
      target: { value: "Cue" },
    });
    advance("Continue");

    expect(setPendingAssistantNameMock).toHaveBeenCalledWith("Cue");
    expect(setPendingPreChatContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ userName: "Ada", assistantName: "Cue" }),
    );
  });

  test("it parks no interests the user never stated", () => {
    reachNames();
    advance("Continue");
    const ctx = setPendingPreChatContextMock.mock.calls[0]?.[0] as {
      tools: string[];
      tasks: string[];
    };
    expect(ctx.tools).toEqual([]);
    expect(ctx.tasks).toEqual([]);
  });

  test("day one asks one question rather than showing an empty deck", () => {
    reachNames();
    advance("Continue");
    expect(screen.getByText(/Let's start with one thing\./)).toBeTruthy();
    expect(screen.getByText("Raise money")).toBeTruthy();
    expect(screen.getByText(/Nothing's connected yet/)).toBeTruthy();
  });

  test("answering it opens a thread carrying the answer, and the arc is done", () => {
    reachNames();
    advance("Continue");
    fireEvent.click(screen.getByText("Ship something"));

    expect(navigateMock).toHaveBeenCalled();
    const [to, opts] = navigateMock.mock.calls.at(-1) as [string, unknown];
    expect(to).toContain("/assistant/conversations/");
    expect(opts).toEqual({ replace: true });
    // …and it never runs again on this device.
    expect(isSelfHostIntroComplete()).toBe(true);
  });
});
