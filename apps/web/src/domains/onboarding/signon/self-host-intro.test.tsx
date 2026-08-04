/**
 * The self-host first-run intro, clicked through end to end.
 *
 * The reason this arc exists is a gap, not a redesign: gateway (self-host)
 * sessions short-circuit the platform route guard, so until now a self-host
 * user was never asked for terms or AI-data consent and never told Cue their
 * name — they landed in a bare chat. These tests pin the two things that must
 * be true: consent is genuinely blocking, and the last screen actually leads
 * into the app.
 *
 * They also pin the second-device case. The gate that runs this arc is
 * device-scoped on purpose, so a valid session on a new browser replays it
 * against an instance that may be years old — and the landing screen used to
 * greet that instance with "Nothing has happened here yet". Three states now
 * have to stay honest: history, genuinely fresh, and "the instance did not
 * answer".
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

/**
 * The instance, unreachable by default.
 *
 * Left un-mocked this is a real socket to a port nothing is listening on —
 * which is both noisy and, on a machine that happens to be running a daemon,
 * not actually a failure. Mocked, "the daemon did not answer" is a fact of the
 * test rather than a fact of the machine. Tests that want an answer seed one
 * through `instanceSays` below.
 */
const realDaemonSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...realDaemonSdk,
  homeStateGet: () => Promise.reject(new Error("daemon unreachable")),
}));

/** The consent step's policy write — real HTTP, and not what is under test. */
const setAutonomyPoliciesMock = mock(() => Promise.resolve({}));
const realAutonomy = await import("@/lib/autonomy-policies-api");
mock.module("@/lib/autonomy-policies-api", () => ({
  ...realAutonomy,
  setAutonomyPolicies: setAutonomyPoliciesMock,
}));

const { SelfHostIntro } = await import("./self-host-intro");
const { isSelfHostIntroComplete } = await import("./intro-state");
const { readConsentScopes } = await import("./consent-scopes");
const { arrivedBody } = await import("./instance-facts");
const { useOnboardingStore } =
  await import("@/domains/onboarding/onboarding-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { homeStateGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");

const ASSISTANT_ID = "assistant-1";

let queryClient: QueryClient;

beforeEach(() => {
  localStorage.clear();
  currentUser = null;
  navigateMock.mockClear();
  persistConsentMock.mockClear();
  setPendingPreChatContextMock.mockClear();
  setPendingAssistantNameMock.mockClear();
  useOnboardingStore.getState().setTosAccepted(false);
  useOnboardingStore.getState().setAiDataConsent(false);
  // No assistant resolved by default: the instance is not reachable, which is
  // the state every one of these tests inherits unless it says otherwise.
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

function renderIntro() {
  return render(
    <QueryClientProvider client={queryClient}>
      <SelfHostIntro />
    </QueryClientProvider>,
  );
}

/**
 * Put a real answer from the instance in front of the screen.
 *
 * Seeded into the query cache rather than stubbed at the network, so the
 * component runs the same `useInstanceFacts` → `homeStateGet` query key it runs
 * in the app; only the answer is supplied.
 */
function instanceSays(state: {
  conversationCount: number;
  userName?: string;
  assistantName?: string;
}) {
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  queryClient.setQueryData(
    homeStateGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    {
      version: 1,
      assistantId: ASSISTANT_ID,
      tier: 1,
      progressPercent: 0,
      facts: [],
      capabilities: [],
      hatchedDate: "2026-01-01T00:00:00.000Z",
      assistantName: "Cue",
      updatedAt: "2026-08-04T00:00:00.000Z",
      ...state,
    },
  );
}

function advance(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("the honest landing", () => {
  test("greets by name only when the session actually carries one", () => {
    currentUser = { id: "u1", firstName: "Ada", lastName: "Lovelace" };
    renderIntro();
    expect(screen.getByText("You're in, Ada.")).toBeTruthy();
  });

  test("with no name it greets without one rather than inventing one", () => {
    currentUser = { id: "u1", firstName: "", lastName: "" };
    renderIntro();
    expect(screen.getByText("You're in.")).toBeTruthy();
  });

  test("an email is an identifier, not a name — it never becomes the greeting", () => {
    currentUser = { id: "u1", firstName: "ada@example.com", lastName: "" };
    renderIntro();
    expect(screen.getByText("You're in.")).toBeTruthy();
    expect(screen.queryByText(/ada@example\.com/)).toBeNull();
  });
});

/**
 * The bug this arc shipped with: the flag that runs it is device-scoped, so a
 * second browser replays the intro against an instance that already has a life
 * — and the screen asserted the opposite without ever asking.
 */
describe("what it says about the instance", () => {
  test("an instance with history is described as having it, with the real count", () => {
    instanceSays({ conversationCount: 420 });
    renderIntro();
    expect(screen.getByText(/420 conversations here already/)).toBeTruthy();
    expect(screen.queryByText(/no conversations here yet/)).toBeNull();
  });

  test("one conversation is one conversation, not '1 conversations'", () => {
    instanceSays({ conversationCount: 1 });
    renderIntro();
    expect(screen.getByText(/1 conversation here already/)).toBeTruthy();
  });

  test("a genuinely fresh instance is still told it is fresh", () => {
    instanceSays({ conversationCount: 0 });
    renderIntro();
    expect(screen.getByText(/no conversations here yet/)).toBeTruthy();
    expect(screen.queryByText(/conversations here already/)).toBeNull();
  });

  test("the claim is only ever the one that was measured", () => {
    // "Nothing has happened here yet" is a claim about the whole instance —
    // apps, documents, work items — made off a conversation count. Zero
    // conversations is all we asked, so it is all we may say.
    expect(arrivedBody(0)).not.toContain("Nothing has happened");
    expect(arrivedBody(0)).toContain("no conversations here yet");
  });

  test("no assistant to ask: it claims nothing, and the arc still runs", () => {
    // activeAssistantId is null, so the query never fires — the shape of a
    // cold start, and of a daemon that is not up yet.
    renderIntro();
    expect(screen.queryByText(/conversations here/)).toBeNull();
    expect(screen.getByText(/runs on your own instance/)).toBeTruthy();
    advance("Continue");
    expect(screen.getByRole("switch", { name: "Send and spend" })).toBeTruthy();
  });

  test("a failed read claims nothing in EITHER direction, and never blocks", async () => {
    // An assistant to ask, and a daemon that refuses — the fail-open case that
    // matters, because here the screen genuinely tried and got nothing.
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    renderIntro();
    // Rendered immediately — nothing waits on the count.
    expect(screen.getByText("You're in.")).toBeTruthy();
    await waitFor(() =>
      expect(
        queryClient.getQueryState(
          homeStateGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
        )?.status,
      ).toBe("error"),
    );
    expect(screen.queryByText(/conversations here already/)).toBeNull();
    expect(screen.queryByText(/no conversations here yet/)).toBeNull();
    expect(screen.getByText(/runs on your own instance/)).toBeTruthy();
    // …and the arc is still walkable end to end.
    advance("Continue");
    expect(screen.getByRole("switch", { name: "Send and spend" })).toBeTruthy();
  });

  test("the instance's own name for the user is a real name, and is used", () => {
    currentUser = { id: "u1", firstName: "", lastName: "" };
    instanceSays({ conversationCount: 12, userName: "Manav" });
    renderIntro();
    expect(screen.getByText("You're in, Manav.")).toBeTruthy();
  });
});

describe("M8 · three cards, and send-and-spend is off", () => {
  function reachConsent() {
    renderIntro();
    advance("Continue");
  }

  test("all three are on screen, as switches, with the norm stated", () => {
    reachConsent();
    expect(
      screen.getByRole("switch", { name: "Read and organise" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Draft and prepare" }),
    ).toBeTruthy();
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
    renderIntro();
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

  test("the instance's own name for Cue is the placeholder, not a written answer", () => {
    instanceSays({ conversationCount: 3, assistantName: "Hermes" });
    reachNames();
    expect(screen.getByLabelText("CUE IS").getAttribute("placeholder")).toBe(
      "Hermes",
    );
    // Leaving it alone must not park "Hermes" as if the user had just said it.
    advance("Continue");
    expect(setPendingAssistantNameMock).not.toHaveBeenCalled();
  });

  test("an instance that already knows this person is not asked again", () => {
    instanceSays({ conversationCount: 420, userName: "Manav" });
    renderIntro();
    advance("Continue"); // arrived
    advance("Continue"); // consent

    // Straight to day one — no second interrogation on the new device.
    expect(screen.queryByLabelText("YOU ARE")).toBeNull();
    expect(screen.getByText(/Let's start with one thing\./)).toBeTruthy();
    // …and nothing is parked, so the first message on this device cannot
    // overwrite the instance's onboarding context with empty tools/tasks.
    expect(setPendingPreChatContextMock).not.toHaveBeenCalled();
    expect(setPendingAssistantNameMock).not.toHaveBeenCalled();
  });

  test("an instance that does NOT know the person still asks", () => {
    instanceSays({ conversationCount: 420 });
    renderIntro();
    advance("Continue");
    advance("Continue");
    expect(screen.getByLabelText("YOU ARE")).toBeTruthy();
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
