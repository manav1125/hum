/**
 * The pre-chat onboarding flow — ONE funnel.
 *
 * Web (desktop, mobile web, Electron, iOS web): `name → google`, resolved by
 * `resolveWebSteps`. The old `control` A/B arm (work type → tools → prior
 * assistants → get-the-app) and the mobile-only autonomy/finish arm are gone;
 * the pared-down funnel is the only web path, so there is exactly one step list
 * to reason about. Mobile keeps a phone-styled *rendering* of the name step —
 * same state, same advance — but no extra steps.
 *
 * Native (Capacitor iOS shell) keeps its own two screens because that shell
 * collects consent AFTER pre-chat (`use-prechat-consent-gate` exempts native,
 * `runtime/native-auth.ts` returns signups straight here), so its route order
 * genuinely differs; it is a platform path, not an experiment arm.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { fetchOnboardingRecipe } from "@/domains/onboarding/recipe-client.js";
import {
  emitOnboardingFunnelStepCompleted,
  ONBOARDING_FUNNEL_STEPS,
  ONBOARDING_FUNNEL_VARIANTS,
  resolveOnboardingFunnelVariant,
} from "@/domains/onboarding/funnel-events";
import { GoogleConnectScreen } from "@/domains/onboarding/screens/google-connect-screen.js";
import { Mv3WelcomeStep } from "@/domains/onboarding/screens/mv3/mv3-welcome-step";
import { NameExchangeScreen } from "@/domains/onboarding/screens/name-exchange-screen.js";
import { NameStepScreen } from "@/domains/onboarding/screens/name-step-screen.js";
import { VibeStepScreen } from "@/domains/onboarding/screens/vibe-step-screen.js";
import { assistantsActiveRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { usePrefilledInput } from "@/hooks/use-prefilled-input.js";
import {
  setPendingAssistantName,
  setPendingPreChatContext,
} from "@/domains/onboarding/prechat";
import { buildPreChatContext } from "@/domains/onboarding/prechat-context";
import {
  isPlatformFunnelAvailable,
  nextStep,
  prevStep,
  resolveNativeSteps,
  resolveWebSteps,
  type PreChatStep,
} from "@/domains/onboarding/prechat-steps";
import {
  DEFAULT_GROUP_ID,
  sampleSuggestionNames,
} from "@/domains/onboarding/prechat-names";
import { usePreChatConsentGate } from "@/domains/onboarding/use-prechat-consent-gate";
import { usePreChatStepState } from "@/domains/onboarding/use-prechat-step-state";
import {
  getPlatformAssistants,
  getSelectedAssistant,
  isLocalMode,
} from "@/lib/local-mode";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useIsNativePlatform } from "@/runtime/native-auth.js";
import {
  useAuthStore,
  useIsAuthenticated,
  useIsSessionInitializing,
} from "@/stores/auth-store.js";
import { hasLivePlatformSession } from "@/stores/session-status";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes.js";

const IOS_TOTAL_STEPS = 3;

function readLocalPlatformAssistantId(): string | null {
  const selected = getSelectedAssistant();
  if (selected?.cloud === "vellum") {
    return selected.assistantId;
  }
  return getPlatformAssistants()[0]?.assistantId ?? null;
}

export function PreChatFlow() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get("preview") === "true";
  const user = useAuthStore.use.user();
  const isAuthenticated = useIsAuthenticated();
  const isAuthInitializing = useIsSessionInitializing();
  const userId = user?.id ?? null;
  const firstName = user?.firstName ?? "";
  const lastName = user?.lastName ?? "";
  const isNative = useIsNativePlatform();
  const isMobile = useIsMobile();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const localMode = isLocalMode();
  const activationFlowArm =
    useClientFeatureFlagStore.use.stringFlags()
      .experimentActivationFlow20260603 ?? "control";
  const activationFlowEnabled = activationFlowArm === "variant-a";
  const selfIntroGreetingEnabled =
    useClientFeatureFlagStore.use.selfIntroGreeting();
  const localPlatformAssistantId = localMode
    ? readLocalPlatformAssistantId()
    : null;

  const consentReady = usePreChatConsentGate();
  const { currentStep, setCurrentStep, clearPersistedStep } =
    usePreChatStepState(userId, isNative);

  const platformSession = useAuthStore.use.platformSession();
  const hasPlatformSession = hasLivePlatformSession(platformSession);
  const { value: userName, onChange: handleUserNameChange } = usePrefilledInput(
    localMode && !hasPlatformSession ? "" : firstName || lastName,
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [displayedAssistantNames] = useState<string[]>(() =>
    sampleSuggestionNames(),
  );
  const [assistantName, setAssistantName] = useState<string>("");

  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled:
      !isAuthInitializing &&
      isAuthenticated &&
      (!localMode || hasPlatformSession),
  });
  const { data: fetchedRecipe, isLoading: recipeLoading } = useQuery({
    queryKey: ["onboarding-recipe", userId],
    queryFn: fetchOnboardingRecipe,
    enabled: !isAuthInitializing && isAuthenticated && !isNative && !localMode,
    staleTime: Infinity,
  });
  const recipe = fetchedRecipe ?? null;
  const googleAssistantId =
    activeAssistant?.id ?? activeAssistantId ?? localPlatformAssistantId;
  const canOfferGoogleStep = isPlatformFunnelAvailable({
    localMode,
    platformSession,
    hasCachedPlatformAssistant: localPlatformAssistantId !== null,
  });

  const navigateToChatAfterLifecycleRefresh = async () => {
    await lifecycleService.checkAssistant();
    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  };

  function emitWebFunnelStep(
    step: (typeof ONBOARDING_FUNNEL_STEPS)[keyof typeof ONBOARDING_FUNNEL_STEPS],
  ): void {
    if (isPreview) {
      return;
    }
    emitOnboardingFunnelStepCompleted(step, {
      userId,
      variant: resolveOnboardingFunnelVariant(
        ONBOARDING_FUNNEL_VARIANTS.paredDown,
      ),
    });
  }

  const steps: PreChatStep[] = isNative
    ? resolveNativeSteps()
    : resolveWebSteps({
        canOfferGoogleStep: isPreview ? false : canOfferGoogleStep,
      });

  function completeFlow(args?: { connectedScopes?: string[] }): void {
    if (isPreview) {
      navigate(-1);
      return;
    }

    const context = buildPreChatContext({
      mode: isNative ? "native" : "paredDown",
      recipe: isNative ? null : recipe,
      tone: selectedGroupId ?? recipe?.tone ?? DEFAULT_GROUP_ID,
      userName,
      assistantName,
      selfIntroGreetingEnabled,
      activationFlowEnabled: isNative ? undefined : activationFlowEnabled,
      connectedScopes: args?.connectedScopes,
    });

    setPendingPreChatContext(context);
    const trimmedAssistant = assistantName.trim();
    if (trimmedAssistant) setPendingAssistantName(trimmedAssistant);

    if (isNative) {
      clearPersistedStep();
      void navigate(routes.onboarding.privacy);
    } else if (isMobile) {
      // Mobile (v3): "Continue" lands on Today. The pending pre-chat context
      // stays parked in sessionStorage and is consumed by the first chat send,
      // exactly as the desktop path's would be.
      void lifecycleService.checkAssistant().then(() => {
        void navigate(routes.hq, { replace: true });
      });
    } else {
      lifecycleService.markExpectingFirstMessage();
      void navigateToChatAfterLifecycleRefresh();
    }
  }

  const advance = (
    from: PreChatStep,
    finishArgs?: { connectedScopes?: string[] },
  ): void => {
    if (from.funnelStep) emitWebFunnelStep(from.funnelStep);
    const next = nextStep(steps, from.id);
    if (next) {
      setCurrentStep(next);
    } else {
      completeFlow(finishArgs);
    }
  };

  const goBack = (from: PreChatStep): void => {
    const previous = prevStep(steps, from.id);
    if (previous) setCurrentStep(previous);
  };

  if (!consentReady || recipeLoading) {
    return null;
  }

  const activeStep = steps.find((step) => step.id === currentStep) ?? steps[0];
  if (!activeStep) {
    return null;
  }

  if (activeStep.id === "nativeName") {
    return (
      <NameStepScreen
        userName={userName}
        assistantName={assistantName}
        displayedAssistantNames={displayedAssistantNames}
        onUserNameChange={handleUserNameChange}
        onAssistantNameChange={setAssistantName}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
        currentStep={0}
        totalSteps={IOS_TOTAL_STEPS}
      />
    );
  }

  if (activeStep.id === "nativeVibe") {
    return (
      <VibeStepScreen
        selectedGroupId={selectedGroupId}
        onGroupChange={setSelectedGroupId}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
        currentStep={1}
        totalSteps={IOS_TOTAL_STEPS}
      />
    );
  }

  if (activeStep.id === "name") {
    // Mobile restyle (v3 frame 26): same step, same `userName` state, same
    // advance; the assistant keeps its sampled default name (the step stays
    // skippable — Continue with an empty field is the old Skip). The step
    // counter is derived from the real funnel so it can never over-promise.
    if (isMobile && !isNative) {
      return (
        <Mv3WelcomeStep
          userName={userName}
          onUserNameChange={handleUserNameChange}
          onContinue={() => advance(activeStep)}
          stepLabel={`Step 1 of ${steps.length}`}
          totalSteps={steps.length}
        />
      );
    }
    return (
      <NameExchangeScreen
        userName={userName}
        assistantName={assistantName}
        selectedGroupId={selectedGroupId}
        displayedAssistantNames={displayedAssistantNames}
        onUserNameChange={handleUserNameChange}
        onAssistantNameChange={setAssistantName}
        onGroupChange={setSelectedGroupId}
        onComplete={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (activeStep.id === "google") {
    if (!googleAssistantId) {
      return null;
    }
    return (
      <GoogleConnectScreen
        assistantId={googleAssistantId}
        assistantName={assistantName}
        onConnect={(scopes) => advance(activeStep, { connectedScopes: scopes })}
        onSkip={() => advance(activeStep)}
        onBack={() => goBack(activeStep)}
      />
    );
  }

  return null;
}
