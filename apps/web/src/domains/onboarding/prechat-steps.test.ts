import { describe, expect, test } from "bun:test";

import { ONBOARDING_FUNNEL_STEPS } from "@/domains/onboarding/funnel-events";
import {
  isPlatformFunnelAvailable,
  nextStep,
  prevStep,
  resolveNativeSteps,
  resolveWebSteps,
  restoreNativeStep,
  type PreChatStepId,
  type WebStepCapabilities,
} from "@/domains/onboarding/prechat-steps";

function ids(caps: WebStepCapabilities): PreChatStepId[] {
  return resolveWebSteps(caps).map((step) => step.id);
}

describe("resolveWebSteps", () => {
  test("one funnel: name then google", () => {
    expect(ids({ canOfferGoogleStep: true })).toEqual(["name", "google"]);
  });

  test("collapses to name when the platform-backed google step is unavailable", () => {
    // Local mode with no live platform session: nothing can attach OAuth to an
    // assistant, so the funnel is a single step rather than a dead screen.
    expect(ids({ canOfferGoogleStep: false })).toEqual(["name"]);
  });

  test("google emits the pared-down funnel event", () => {
    const google = resolveWebSteps({ canOfferGoogleStep: true }).find(
      (step) => step.id === "google",
    );
    expect(google?.funnelStep).toBe(ONBOARDING_FUNNEL_STEPS.gmailConnect);
  });

  test("name emits the name/vibe funnel event", () => {
    const name = resolveWebSteps({ canOfferGoogleStep: false }).find(
      (step) => step.id === "name",
    );
    expect(name?.funnelStep).toBe(ONBOARDING_FUNNEL_STEPS.nameVibe);
  });
});

describe("resolveNativeSteps", () => {
  test("name then vibe, not funnel-instrumented", () => {
    const steps = resolveNativeSteps();
    expect(steps.map((s) => s.id)).toEqual(["nativeName", "nativeVibe"]);
    expect(steps.every((s) => s.funnelStep === null)).toBe(true);
  });
});

describe("restoreNativeStep", () => {
  test("restores the vibe step from the current persisted value", () => {
    expect(restoreNativeStep("nativeVibe")).toBe("nativeVibe");
  });

  test("restores the vibe step from the legacy numeric value", () => {
    // An older build persisted the raw screen index; a user who updated the
    // app mid-onboarding must still land on the vibe step, not the start.
    expect(restoreNativeStep("1")).toBe("nativeVibe");
  });

  test("starts from the top when nothing is persisted or the value is unknown", () => {
    expect(restoreNativeStep(null)).toBeNull();
    expect(restoreNativeStep("nativeName")).toBeNull();
    expect(restoreNativeStep("0")).toBeNull();
    expect(restoreNativeStep("garbage")).toBeNull();
  });
});

describe("nextStep / prevStep", () => {
  test("walk forward through the funnel", () => {
    const steps = resolveWebSteps({ canOfferGoogleStep: true });
    expect(nextStep(steps, "name")).toBe("google");
    expect(nextStep(steps, "google")).toBeNull();
  });

  test("back from google lands on name", () => {
    const steps = resolveWebSteps({ canOfferGoogleStep: true });
    expect(prevStep(steps, "google")).toBe("name");
  });

  test("prev from the first step is null", () => {
    const steps = resolveWebSteps({ canOfferGoogleStep: true });
    expect(prevStep(steps, "name")).toBeNull();
  });

  test("a step that is not in the resolved list resolves to null", () => {
    // The gated-off google step is never a forward or back target, so the
    // finish path is reached from `name` instead of a dead screen.
    const steps = resolveWebSteps({ canOfferGoogleStep: false });
    expect(nextStep(steps, "name")).toBeNull();
    expect(nextStep(steps, "google")).toBeNull();
    expect(prevStep(steps, "google")).toBeNull();
  });
});

describe("isPlatformFunnelAvailable", () => {
  test("platform mode is always available, regardless of session state", () => {
    for (const platformSession of ["unknown", "absent", "present"] as const) {
      for (const hasCachedPlatformAssistant of [false, true]) {
        expect(
          isPlatformFunnelAvailable({
            localMode: false,
            platformSession,
            hasCachedPlatformAssistant,
          }),
        ).toBe(true);
      }
    }
  });

  test("local mode with a live platform session is available", () => {
    expect(
      isPlatformFunnelAvailable({
        localMode: true,
        platformSession: "present",
        hasCachedPlatformAssistant: false,
      }),
    ).toBe(true);
  });

  test("local mode, probe resolved to no session: a cached id is not enough", () => {
    // Once the probe has settled, a stale `cloud === "vellum"` lockfile entry
    // can outlive the session, so the funnel must not light up on cached state
    // alone — that is the LUM-2180 bug. Only a live session reaches the steps.
    expect(
      isPlatformFunnelAvailable({
        localMode: true,
        platformSession: "absent",
        hasCachedPlatformAssistant: true,
      }),
    ).toBe(false);
  });

  test("local mode, probe in flight with a cached id: funnel stays available", () => {
    // The local gateway path sets `isLoading: false` before the session probe
    // settles. While it is unresolved, a cached platform assistant is a strong
    // signal a session exists, so a returning user keeps their platform steps
    // instead of being raced past them on a slow probe.
    expect(
      isPlatformFunnelAvailable({
        localMode: true,
        platformSession: "unknown",
        hasCachedPlatformAssistant: true,
      }),
    ).toBe(true);
  });

  test("local mode, probe in flight with no cached id: funnel unavailable", () => {
    // No cached platform assistant means there is no reason to expect a
    // session, so a fresh local user is never optimistically shown the funnel
    // while the probe is pending.
    expect(
      isPlatformFunnelAvailable({
        localMode: true,
        platformSession: "unknown",
        hasCachedPlatformAssistant: false,
      }),
    ).toBe(false);
  });
});
