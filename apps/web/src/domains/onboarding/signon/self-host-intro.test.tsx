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

/**
 * The gateway's policy endpoint — both halves.
 *
 * The write is real HTTP and never what is under test, so it is always a spy.
 * The READ is under test: the consent switches are seeded from it, and the
 * whole point of `sources` is that a mode alone cannot be read back as an
 * answer. `instanceHolds` below is how a test states what the gateway returns;
 * unset, it rejects, which is the unreachable case.
 */
const setAutonomyPoliciesMock = mock((..._args: unknown[]) =>
  Promise.resolve({}),
);
let policyState: {
  policies: Record<string, string>;
  sources: Record<string, string>;
} | null = null;
const realAutonomy = await import("@/lib/autonomy-policies-api");
mock.module("@/lib/autonomy-policies-api", () => ({
  ...realAutonomy,
  setAutonomyPolicies: setAutonomyPoliciesMock,
  getAutonomyPolicyState: () =>
    policyState
      ? Promise.resolve(policyState)
      : Promise.reject(new Error("gateway unreachable")),
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
  policyState = null;
  setAutonomyPoliciesMock.mockClear();
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

/**
 * Put a policy map in front of the consent screen.
 *
 * `stored` is the list of categories the instance has an ANSWER for; every
 * other category is reported at its mode but attributed to the gateway's own
 * defaults, which is the distinction the whole feature turns on. Calling this
 * with no `stored` entries is a never-configured instance.
 */
function instanceHolds(
  policies: Partial<Record<string, string>>,
  stored: string[] = [],
) {
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  policyState = {
    // The gateway always resolves a complete map; these are its own defaults.
    policies: {
      research: "auto",
      draft: "auto",
      send: "auto",
      money: "ask",
      delete: "ask",
      other: "auto",
      ...policies,
    },
    sources: Object.fromEntries(
      ["research", "draft", "send", "money", "delete", "other"].map((c) => [
        c,
        stored.includes(c) ? "stored" : "default",
      ]),
    ),
  };
}

/**
 * Wait for the policy read to land.
 *
 * Needed wherever the seeded values are INDISTINGUISHABLE from the shipped
 * defaults — a fresh instance is exactly that case, so without an explicit
 * synchronisation point those tests would pass on the blind path and never
 * exercise the seed they exist to pin.
 */
async function policyReadLands() {
  await waitFor(() =>
    expect(
      queryClient.getQueryState(["autonomy-policies", ASSISTANT_ID])?.status,
    ).toBe("success"),
  );
}

const switchState = (name: string) =>
  screen.getByRole("switch", { name }).getAttribute("aria-checked");

/** The map actually PUT to the gateway, once the write has happened. */
async function writtenPolicies(): Promise<Record<string, string>> {
  await waitFor(() => expect(setAutonomyPoliciesMock).toHaveBeenCalled());
  return setAutonomyPoliciesMock.mock.calls.at(-1)?.[1] as Record<
    string,
    string
  >;
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

/**
 * The second-device reset.
 *
 * `cue:signon:introDone` is device-scoped by design, so this screen replays on
 * every new laptop against an instance that already holds policy — and it used
 * to start its switches at the frozen defaults and PUT all six categories on
 * Continue. An owner who had set research or draft to "never" in Guardrails got
 * both back at "auto" for clicking a button that never mentioned them: autonomy
 * widened that nobody asked for.
 *
 * The naive fix is a trap of its own, and the second block below is the one
 * that pins it: the gateway's own default is `send: "auto"`, so seeding from a
 * plain read-back would render "Send and spend" ON for every brand-new
 * instance — the exact default that had a background run email a partner with
 * no approval. Seeding is allowed only from categories the gateway reports as
 * `stored`.
 *
 * MUTATION CHECK (run by hand; each does go red):
 *   · `seedConsentScopes`: drop the `if (!view.answered[scope]) continue;`
 *     guard → "a never-configured instance does not turn the send card on"
 *     fails, and so does "…and Continue still writes send: ask".
 *   · `seedConsentScopes`: `return { ...DEFAULT_CONSENT_SCOPES }` unconditionally
 *     (i.e. never seed) → the two "reflects what the instance holds" tests fail.
 *   · `consentPolicyWrite`: return `promised` in full for the blind branch →
 *     "a gateway that never answered is not written over" fails.
 *   · `consentPolicyWrite`: drop the `strictest(...)` floor → "a stricter
 *     choice this screen never mentioned is not relaxed" fails.
 */
describe("an instance with policy is not reset by a new device", () => {
  function reachConsent() {
    renderIntro();
    advance("Continue");
  }

  test("the switches reflect what the instance holds, not the shipped defaults", async () => {
    // The reported case: both tightened to "never" in Guardrails.
    instanceHolds({ research: "never", draft: "never" }, ["research", "draft"]);
    reachConsent();
    await waitFor(() => expect(switchState("Read and organise")).toBe("false"));
    expect(switchState("Draft and prepare")).toBe("false");
  });

  test("…and Continue writes those choices back rather than widening them", async () => {
    instanceHolds({ research: "never", draft: "never" }, ["research", "draft"]);
    reachConsent();
    await waitFor(() => expect(switchState("Read and organise")).toBe("false"));
    advance("Continue");

    const written = await writtenPolicies();
    // The regression, stated the way it failed: these came back as "auto".
    expect(written.research).toBe("never");
    expect(written.draft).toBe("never");
  });

  test("a stricter choice this screen never mentioned is not relaxed", async () => {
    // Neither card says anything about money or deletion, so a "never" the
    // owner set for either must survive a Continue — the promised "ask" would
    // be a loosening the user was never shown.
    instanceHolds({ money: "never", delete: "never" }, ["money", "delete"]);
    reachConsent();
    await waitFor(() => expect(switchState("Send and spend")).toBe("false"));
    advance("Continue");

    const written = await writtenPolicies();
    expect(written.money).toBe("never");
    expect(written.delete).toBe("never");
  });

  test("an owner who genuinely turned sending on sees it on", async () => {
    instanceHolds({ send: "auto" }, ["send"]);
    reachConsent();
    await waitFor(() => expect(switchState("Send and spend")).toBe("true"));
    advance("Continue");
    expect((await writtenPolicies()).send).toBe("auto");
  });

  test("a switch the user moved wins over a seed that lands afterwards", async () => {
    // The seed and the user disagree, so this can only pass one way: the
    // instance holds send: "never" (which seeds the card OFF) and the user
    // turns it ON while the read is still in flight.
    instanceHolds({ send: "never", research: "never" }, ["send", "research"]);
    reachConsent();
    expect(switchState("Send and spend")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: "Send and spend" }));
    expect(switchState("Send and spend")).toBe("true");

    // The read lands — visible on the card nobody touched…
    await waitFor(() => expect(switchState("Read and organise")).toBe("false"));
    // …and it must not have reached under the user and flipped theirs back.
    expect(switchState("Send and spend")).toBe("true");
    advance("Continue");
    expect((await writtenPolicies()).send).toBe("auto");
  });
});

describe("…but a default is never mistaken for an answer", () => {
  function reachConsent() {
    renderIntro();
    advance("Continue");
  }

  test("a never-configured instance does not turn the send card on", async () => {
    // The gateway reports send: "auto" — its own default, for an instance
    // nobody has ever configured. Seeding from the mode alone would show this
    // card ON to every brand-new user.
    instanceHolds({}, []);
    reachConsent();
    await policyReadLands();
    expect(switchState("Send and spend")).toBe("false");
    expect(switchState("Read and organise")).toBe("true");
  });

  test("…and Continue still writes send: ask, explicitly", async () => {
    instanceHolds({}, []);
    reachConsent();
    await policyReadLands();
    advance("Continue");
    const written = await writtenPolicies();
    expect(written.send).toBe("ask");
    expect(written.money).toBe("ask");
  });

  test("a gateway that never answered is not written over", async () => {
    // policyState stays null → the read rejects. We know nothing about this
    // instance, so the categories whose "on" is only our own default must be
    // left alone; the PUT upserts just the keys it is given.
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    reachConsent();
    expect(switchState("Send and spend")).toBe("false");
    advance("Continue");

    const written = await writtenPolicies();
    expect(written.research).toBeUndefined();
    expect(written.draft).toBeUndefined();
    expect(written.other).toBeUndefined();
    // The card's promise is still kept — skipping `send` would leave the
    // gateway's "auto" in force and make the copy a lie.
    expect(written.send).toBe("ask");
  });

  test("…yet a card the user actually touched is still honoured", async () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    reachConsent();
    fireEvent.click(screen.getByRole("switch", { name: "Read and organise" }));
    advance("Continue");

    // An answer given on this screen is an answer, unreachable gateway or not.
    expect((await writtenPolicies()).research).toBe("never");
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

  test("the connectors footer is a real control, not link-coloured text", () => {
    // Shipped as an accent-coloured <span> with no handler: it invited the tap
    // and ate it. Now it must complete the arc and land on connectors.
    reachNames();
    advance("Continue");
    fireEvent.click(
      screen.getByRole("button", { name: /Nothing's connected yet/ }),
    );

    const [to, opts] = navigateMock.mock.calls.at(-1) as [string, unknown];
    expect(to).toBe("/assistant/connectors");
    expect(opts).toEqual({ replace: true });
    expect(isSelfHostIntroComplete()).toBe(true);
  });

  test("day one can be skipped, and skipping is not an answer", () => {
    reachNames();
    advance("Continue");
    advance("Skip for now");

    const [to, opts] = navigateMock.mock.calls.at(-1) as [string, unknown];
    expect(to).toBe("/assistant");
    expect(opts).toEqual({ replace: true });
    expect(isSelfHostIntroComplete()).toBe(true);
    // No thread is opened for a question the user declined to answer.
    expect(to).not.toContain("/conversations/");
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
