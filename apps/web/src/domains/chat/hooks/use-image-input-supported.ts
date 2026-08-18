import { useQuery } from "@tanstack/react-query";

import {
  configGetOptions,
  conversationsByIdGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type WireLlm = NonNullable<ConfigGetResponse["llm"]>;

/**
 * Pick the daemon's answer that applies to a conversation: its own inference
 * profile if it has one, else the workspace's active profile, else the
 * workspace-wide answer. Split out from the hook so the precedence is testable
 * without a query client.
 *
 * Every fall-through lands on `true`. See the hook's note on failing open.
 */
export function selectImageInputSupported(
  llm: WireLlm | undefined,
  conversationProfile: string | null | undefined,
): boolean {
  if (!llm) return true;
  const profileName = conversationProfile ?? llm.activeProfile ?? null;
  const profileAnswer = profileName
    ? llm.profiles?.[profileName]?.imageInputSupported
    : undefined;
  return profileAnswer ?? llm.imageInputSupported ?? true;
}

/**
 * Can an image attached to this conversation be read by anything?
 *
 * This deliberately does NOT ask "does the conversation's model support
 * vision", which is the question the composer used to ask and the reason a
 * perfectly capable workspace refused images. Two things make those different:
 *
 *  - The model named in a profile is often not the model that serves the turn.
 *    A workspace whose config still says `ollama` / `llama3.2` from its first
 *    boot runs every turn on the hosted brain instead.
 *  - Even a text-only brain reads images, because the daemon reroutes an
 *    image-bearing round to a vision model (`agent/vision-tier.ts`). A
 *    text-only default is not a refusal; it is the case that routing exists
 *    for.
 *
 * Neither is knowable from the client, so the daemon answers it: `GET
 * /v1/config` resolves `imageInputSupported` through the same functions a real
 * turn uses, per profile and for the workspace. Here we only pick the entry
 * that applies — the conversation's own inference profile, else the workspace
 * active profile, else the workspace-wide answer.
 *
 * Fails open. Config not loaded yet, a daemon too old to send the field, a
 * profile that isn't in the response — none of those are evidence that an
 * image cannot be read, and a paperclip that silently drops files is a far
 * worse failure than one image the model has to decline.
 */
export function useImageInputSupported(
  assistantId: string | null,
  conversationId: string | undefined,
): boolean {
  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    // The `assistant:self:config` sync tag (SSE) invalidates the shared
    // config cache on every daemon-side change, and local mutations write
    // through `configGetSetQueryData` — refetching the ~21 KB config on
    // every focus/navigation is redundant.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: convData } = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: !!assistantId && !!conversationId,
  });

  return selectImageInputSupported(
    config?.llm,
    convData?.conversation.inferenceProfile,
  );
}
