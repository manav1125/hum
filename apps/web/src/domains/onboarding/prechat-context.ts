/**
 * Assemble the pre-chat onboarding handoff context from the answers collected
 * during the flow. Pure input→output: no React, no storage, no navigation —
 * the component owns those side effects and calls this to produce the payload.
 *
 * Two modes share one builder so the context shape can't drift between the
 * (single) web funnel and the native iOS flow.
 */
import type { OnboardingRecipe } from "@/domains/onboarding/recipe-client.js";
import {
  buildPreChatInitialMessage,
  DEFAULT_PRECHAT_INITIAL_MESSAGE,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";

/**
 * Tools implied by connecting Google in the pared-down funnel, which has no
 * tool-selection screen. Kept in sync with the daemon's onboarding contract.
 */
export const PARED_DOWN_GOOGLE_TOOL_IDS = [
  "gmail",
  "google-calendar",
  "google-drive",
];

export const ACTIVATION_FLOW_COHORT = "experiment-activation-flow-2026-06-03";
export const ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE =
  "BOOTSTRAP-ACTIVATION-RAIL.md";

export type PreChatMode = "paredDown" | "native";

export interface BuildPreChatContextInput {
  mode: PreChatMode;
  recipe: OnboardingRecipe | null;
  /** Already resolved: `selectedGroupId ?? recipe?.tone ?? DEFAULT_GROUP_ID`. */
  tone: string;
  userName: string;
  assistantName: string;
  selfIntroGreetingEnabled: boolean;
  /** Selects the activation rail bootstrap template for experiment users. */
  activationFlowEnabled?: boolean;
  /**
   * Scopes granted by the connect action that triggered this finish. Present
   * only when the user connected Google on the way out; `undefined` otherwise.
   */
  connectedScopes?: string[];
}

/**
 * The auto-sent first message. A campaign recipe wins; otherwise we greet by
 * name when the self-intro greeting flag is on, falling back to the default.
 */
function resolveInitialMessage(
  context: PreChatOnboardingContext,
  recipe: OnboardingRecipe | null,
  selfIntroGreetingEnabled: boolean,
): string {
  if (recipe?.initialMessage) {
    return recipe.initialMessage;
  }
  return selfIntroGreetingEnabled
    ? buildPreChatInitialMessage(context)
    : DEFAULT_PRECHAT_INITIAL_MESSAGE;
}

export function buildPreChatContext(
  input: BuildPreChatContextInput,
): PreChatOnboardingContext {
  const { mode, recipe } = input;
  const connectedWithCurrentAction = input.connectedScopes !== undefined;

  let context: PreChatOnboardingContext;
  if (mode === "native") {
    context = {
      tools: [],
      tasks: [],
      tone: input.tone,
      googleConnected: false,
    };
  } else {
    context = {
      tools: connectedWithCurrentAction ? [...PARED_DOWN_GOOGLE_TOOL_IDS] : [],
      tasks: recipe?.tasks ?? [],
      tone: input.tone,
      googleConnected: connectedWithCurrentAction,
    };
  }

  if (recipe) {
    context.cohort = recipe.cohort;
    context.bootstrapTemplate = recipe.bootstrapTemplate;
    context.skills = recipe.skills;
  }

  if (input.activationFlowEnabled) {
    context.cohort = ACTIVATION_FLOW_COHORT;
    context.bootstrapTemplate = ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE;
  }

  const trimmedUser = input.userName.trim();
  if (trimmedUser) context.userName = trimmedUser;
  const trimmedAssistant = input.assistantName.trim();
  if (trimmedAssistant) context.assistantName = trimmedAssistant;

  if (mode === "paredDown" && connectedWithCurrentAction) {
    context.googleScopes = input.connectedScopes;
  }

  context.initialMessage = resolveInitialMessage(
    context,
    input.activationFlowEnabled ? null : recipe,
    input.selfIntroGreetingEnabled,
  );
  return context;
}
