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
const { useOnboardingStore } =
  await import("@/domains/onboarding/onboarding-store");
const { routes } = await import("@/utils/routes");

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

describe("consent is blocking, and it is recorded where the rest of the app reads it", () => {
  test("the continue button stays disabled until BOTH boxes are ticked", () => {
    render(<SelfHostIntro />);
    advance("Continue");

    const submit = () =>
      screen.getByRole("button", {
        name: "Agree and continue",
      }) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/terms of use/));
    expect(submit().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/third-party AI providers/));
    expect(submit().disabled).toBe(false);
  });

  test("accepting writes both the in-memory flags and the per-user device keys", () => {
    currentUser = { id: "user-1" };
    render(<SelfHostIntro />);
    advance("Continue");
    fireEvent.click(screen.getByLabelText(/terms of use/));
    fireEvent.click(screen.getByLabelText(/third-party AI providers/));
    advance("Agree and continue");

    expect(useOnboardingStore.getState().tosAccepted).toBe(true);
    expect(useOnboardingStore.getState().aiDataConsent).toBe(true);
    expect(persistConsentMock).toHaveBeenCalledWith("user-1", true, true);
  });
});

describe("names, then into the app", () => {
  function reachNames() {
    render(<SelfHostIntro />);
    advance("Continue");
    fireEvent.click(screen.getByLabelText(/terms of use/));
    fireEvent.click(screen.getByLabelText(/third-party AI providers/));
    advance("Agree and continue");
  }

  test("the whole arc ends by navigating into the app and marking itself done", () => {
    reachNames();
    fireEvent.change(screen.getByLabelText("YOU ARE"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText("CUE IS"), {
      target: { value: "Cue" },
    });
    advance("Start using Cue");

    expect(setPendingAssistantNameMock).toHaveBeenCalledWith("Cue");
    expect(setPendingPreChatContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ userName: "Ada", assistantName: "Cue" }),
    );
    expect(navigateMock).toHaveBeenCalledWith(routes.assistant, {
      replace: true,
    });
    // And it never runs again on this device.
    expect(isSelfHostIntroComplete()).toBe(true);
  });

  test("names are optional — skipping them still gets you in", () => {
    reachNames();
    advance("Start using Cue");

    expect(setPendingAssistantNameMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith(routes.assistant, {
      replace: true,
    });
    expect(isSelfHostIntroComplete()).toBe(true);
  });

  test("it parks no interests the user never stated", () => {
    reachNames();
    advance("Start using Cue");
    const ctx = setPendingPreChatContextMock.mock.calls[0]?.[0] as {
      tools: string[];
      tasks: string[];
    };
    expect(ctx.tools).toEqual([]);
    expect(ctx.tasks).toEqual([]);
  });
});
