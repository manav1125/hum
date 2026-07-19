import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useIsIOSWeb } from "@/runtime/platform-detection";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { readIOSAppDownloaded } from "@/hooks/use-ios-app-nudge";
import { companyprofilePut } from "@/generated/daemon/sdk.gen";
import type { PendingWorkspaceMode } from "@/domains/onboarding/mv3-onboarding-prefs";
import { clearPendingWorkspaceMode } from "@/domains/onboarding/mv3-onboarding-prefs";
import { fetchOnboardingRecipe } from "@/domains/onboarding/recipe-client.js";
import {
  emitOnboardingFunnelStepCompleted,
  onboardingFunnelVariantFromExperiment,
  ONBOARDING_FUNNEL_STEPS,
  ONBOARDING_FUNNEL_VARIANTS,
  readOnboardingFunnelVariant,
  resolveOnboardingFunnelVariant,
} from "@/domains/onboarding/funnel-events";
import { GetIOSAppScreen } from "@/domains/onboarding/screens/get-ios-app-screen.js";
import { GoogleConnectScreen } from "@/domains/onboarding/screens/google-connect-screen.js";
import { Mv3AutonomyStep } from "@/domains/onboarding/screens/mv3/mv3-autonomy-step";
import { Mv3FinishStep } from "@/domains/onboarding/screens/mv3/mv3-finish-step";
import { Mv3WelcomeStep } from "@/domains/onboarding/screens/mv3/mv3-welcome-step";
import { NameExchangeScreen } from "@/domains/onboarding/screens/name-exchange-screen.js";
import { NameStepScreen } from "@/domains/onboarding/screens/name-step-screen.js";
import { PriorAssistantSelectionScreen } from "@/domains/onboarding/screens/prior-assistant-selection-screen.js";
import { TaskToneSelectionScreen } from "@/domains/onboarding/screens/task-tone-selection-screen.js";
import { ToolSelectionScreen } from "@/domains/onboarding/screens/tool-selection-screen.js";
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
import { GOOGLE_TOOL_IDS } from "@/domains/onboarding/prechat-tools";
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
  const isIOSWeb = useIsIOSWeb();
  const showIOSAppStep = isIOSWeb && !readIOSAppDownloaded();
  const preChatExperimentArm =
    useClientFeatureFlagStore.use.stringFlags()
      .preChatOnboardingExperiment20260606 ?? "control";
  const activationFlowArm =
    useClientFeatureFlagStore.use.stringFlags()
      .experimentActivationFlow20260603 ?? "control";
  const activationFlowEnabled = activationFlowArm === "variant-a";
  const selfIntroGreetingEnabled =
    useClientFeatureFlagStore.use.selfIntroGreeting();
  const preferredFunnelVariant =
    onboardingFunnelVariantFromExperiment(preChatExperimentArm);
  const webFunnelVariant =
    readOnboardingFunnelVariant() ?? preferredFunnelVariant;
  const paredDownPrechat =
    webFunnelVariant === ONBOARDING_FUNNEL_VARIANTS.paredDown;
  const localPlatformAssistantId = localMode
    ? readLocalPlatformAssistantId()
    : null;

  const consentReady = usePreChatConsentGate();
  const { currentStep, setCurrentStep, clearPersistedStep } =
    usePreChatStepState(userId, isNative);

  const platformSession = useAuthStore.use.platformSession();
  const hasPlatformSession = hasLivePlatformSession(platformSession);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedPriorAssistants, setSelectedPriorAssistants] = useState<
    Set<string>
  >(() => new Set());
  const { value: userName, onChange: handleUserNameChange } = usePrefilledInput(
    localMode && !hasPlatformSession ? "" : firstName || lastName,
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [displayedAssistantNames] = useState<string[]>(() =>
    sampleSuggestionNames(),
  );
  const [assistantName, setAssistantName] = useState<string>("");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleScopes, setGoogleScopes] = useState<string[]>([]);
  // Mobile-v3 Step 3 pick (frame 27) — shown on the finish receipts and
  // applied to the workspace-mode setting (see Mv3AutonomyStep).
  const [pickedMode, setPickedMode] = useState<PendingWorkspaceMode | null>(
    null,
  );

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
  const platformFunnelAvailable = isPlatformFunnelAvailable({
    localMode,
    platformSession,
    hasCachedPlatformAssistant: localPlatformAssistantId !== null,
  });
  const canOfferGoogleStep = platformFunnelAvailable;
  const canOfferPriorAssistants = platformFunnelAvailable;

  const navigateToChatAfterLifecycleRefresh = async () => {
    await lifecycleService.checkAssistant();
    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  };

  function emitWebFunnelStep(
    step: (typeof ONBOARDING_FUNNEL_STEPS)[keyof typeof ONBOARDING_FUNNEL_STEPS],
    variant = webFunnelVariant,
  ): void {
    if (isPreview) {
      return;
    }
    emitOnboardingFunnelStepCompleted(step, {
      userId,
      variant: resolveOnboardingFunnelVariant(variant),
    });
  }

  const hasGoogleTool = [...selectedTools].some((id) =>
    GOOGLE_TOOL_IDS.has(id),
  );

  const steps: PreChatStep[] = isNative
    ? resolveNativeSteps()
    : resolveWebSteps({
        paredDown: paredDownPrechat,
        canOfferPriorAssistants,
        canOfferGoogleStep: isPreview ? false : canOfferGoogleStep,
        hasGoogleTool,
        showIOSAppStep,
        // The v3 mobile funnel (frames 26–28) adds the autonomy + finish
        // steps on mobile web viewports only; desktop is unchanged.
        mobileV3: isMobile,
      });

  function completeFlow(args?: {
    connectedScopes?: string[];
    selectedPriorAssistants?: Set<string>;
  }): void {
    if (isPreview) {
      navigate(-1);
      return;
    }

    const context = buildPreChatContext({
      mode: isNative ? "native" : paredDownPrechat ? "paredDown" : "control",
      recipe: isNative ? null : recipe,
      selectedTools,
      selectedTasks,
      selectedPriorAssistants:
        args?.selectedPriorAssistants ?? selectedPriorAssistants,
      tone: selectedGroupId ?? recipe?.tone ?? DEFAULT_GROUP_ID,
      userName,
      assistantName,
      selfIntroGreetingEnabled,
      activationFlowEnabled: isNative ? undefined : activationFlowEnabled,
      googleConnected,
      googleScopes,
      connectedScopes: args?.connectedScopes,
    });

    setPendingPreChatContext(context);
    const trimmedAssistant = assistantName.trim();
    if (trimmedAssistant) setPendingAssistantName(trimmedAssistant);

    if (isNative) {
      clearPersistedStep();
      void navigate(routes.onboarding.privacy);
    } else if (isMobile) {
      // Mobile v3 (frame 28): "See today →" lands on Today. The pending
      // pre-chat context stays parked in sessionStorage and is consumed by
      // the first chat send, exactly as the desktop path's would be.
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
    finishArgs?: {
      connectedScopes?: string[];
      selectedPriorAssistants?: Set<string>;
    },
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
    // Mobile v3 restyle (frame 26): same step, same `userName` state, same
    // advance; the assistant keeps its sampled default name (the step stays
    // skippable — Continue with an empty field is the old Skip).
    if (isMobile && !isNative) {
      return (
        <Mv3WelcomeStep
          userName={userName}
          onUserNameChange={handleUserNameChange}
          onContinue={() => advance(activeStep)}
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

  if (activeStep.id === "taskTone") {
    return (
      <TaskToneSelectionScreen
        selectedTasks={selectedTasks}
        onChange={setSelectedTasks}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (activeStep.id === "tools") {
    return (
      <ToolSelectionScreen
        selectedTools={selectedTools}
        onChange={setSelectedTools}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (activeStep.id === "priorAssistants") {
    return (
      <PriorAssistantSelectionScreen
        selectedAssistants={selectedPriorAssistants}
        onChange={setSelectedPriorAssistants}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => {
          const emptyPriorAssistants = new Set<string>();
          setSelectedPriorAssistants(emptyPriorAssistants);
          advance(activeStep, {
            selectedPriorAssistants: emptyPriorAssistants,
          });
        }}
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
        onConnect={(scopes) => {
          setGoogleConnected(true);
          setGoogleScopes(scopes);
          advance(activeStep, { connectedScopes: scopes });
        }}
        onSkip={() => advance(activeStep)}
        onBack={() => goBack(activeStep)}
      />
    );
  }

  if (activeStep.id === "iosApp") {
    return <GetIOSAppScreen onComplete={() => advance(activeStep)} />;
  }

  // Mobile v3 Step 3 (frame 27) — the autonomy pick. The pick is parked as a
  // pending workspace-mode (applied by root-layout once an assistant is
  // active); when an assistant is ALREADY active, apply it live right away.
  if (activeStep.id === "autonomy") {
    return (
      <Mv3AutonomyStep
        onContinue={(mode) => {
          setPickedMode(mode);
          if (activeAssistantId) {
            void companyprofilePut({
              path: { assistant_id: activeAssistantId },
              body: { workspaceMode: mode },
            })
              .then(({ response }) => {
                if (response?.ok) clearPendingWorkspaceMode();
              })
              .catch(() => {
                /* daemon not reachable yet — the pending value covers it */
              });
          }
          advance(activeStep);
        }}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  // Mobile v3 Step 4 (frame 28) — the finish with real receipts.
  if (activeStep.id === "finish") {
    return (
      <Mv3FinishStep
        googleConnected={googleConnected}
        mode={pickedMode}
        onFinish={() => advance(activeStep)}
      />
    );
  }

  return null;
}
