/**
 * Settings → Voice: which spoken language the assistant listens for.
 *
 * Sits with Microphone because it belongs to the same half of the
 * conversation — that card says which device carries your voice, this one
 * says what the far end expects to hear. Ported from upstream
 * vellum-assistant's listening-language card (a386cf7dcf, settings half)
 * onto this fork's config plumbing.
 *
 * Source of truth is `services.stt.language` in daemon config, never a
 * client store: the card reads it through the shared config query and
 * persists picks through the same config PATCH the other daemon-config
 * cards use. Both voice engines re-read the value per spoken exchange, so a
 * pick hot-applies from the next spoken turn — there is no Save.
 *
 * Only Deepgram accepts a language on this fork (the daemon's
 * `effectiveSttLanguage` threads it into the Deepgram adapters alone), so
 * when config names another provider the card keeps the row visible but
 * swaps the picker for an honest note instead of pretending a pick would
 * change anything.
 */

import { useCallback, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

import { DetailCard } from "@/components/detail-card";
import { SttLanguagePickerModal } from "@/domains/settings/components/stt-language-picker-modal";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { captureError } from "@/lib/sentry/capture-error";
import {
  STT_MULTI_CODE,
  sttLanguageLabelForCode,
} from "@/lib/stt/language-catalog";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * The daemon id whose adapters accept `services.stt.language`. Mirrors the
 * multilingual-default set in
 * `assistant/src/providers/speech-to-text/resolve.ts` — on this fork that
 * set is just Deepgram (no managed relay).
 */
const LANGUAGE_SELECTABLE_STT_PROVIDER = "deepgram";

/** Honest display names for the daemon's other STT provider ids. */
const STT_PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "google-gemini": "Google Gemini",
  "openai-whisper": "OpenAI Whisper",
  xai: "xAI",
};

export function ListeningLanguageCard() {
  // Settings routes are NOT mounted under `<ActiveAssistantGate>`, so read
  // the raw store (nullable) rather than `useActiveAssistantId()`, which
  // throws.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  // `services.stt` falls under the ConfigGetResponse index signature
  // (`unknown`), so narrow it explicitly. Absent fields read as the daemon
  // schema defaults (provider "deepgram", language "multi").
  const daemonStt = daemonConfig?.services?.stt as
    | { provider?: string; language?: string }
    | undefined;
  const configuredProvider =
    daemonStt?.provider ?? LANGUAGE_SELECTABLE_STT_PROVIDER;
  const providerAcceptsLanguage =
    configuredProvider === LANGUAGE_SELECTABLE_STT_PROVIDER;
  const configuredCode = daemonStt?.language ?? STT_MULTI_CODE;

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId ?? "" } },
        data,
      );
    },
  });
  const { mutateAsync: patchConfig, isPending: selecting } = configMutation;

  // Optimistic display while the PATCH is in flight; config (refreshed from
  // the PATCH response) takes back over once it settles.
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const currentCode = pendingCode ?? configuredCode;

  const selectLanguage = useCallback(
    (code: string) => {
      if (!assistantId) {
        return;
      }
      setPendingCode(code);
      patchConfig({
        path: { assistant_id: assistantId },
        body: { services: { stt: { language: code } } },
      })
        .catch((error) => {
          toast.error("Couldn't change the listening language. Try again.");
          captureError(error, { context: "settings-stt-language" });
        })
        .finally(() => {
          setPendingCode(null);
        });
    },
    [assistantId, patchConfig],
  );

  return (
    <DetailCard
      title="Listening language"
      // Named for what it governs rather than the setting's key: people
      // arrive here having noticed the assistant mishearing them, not
      // looking for a speech-recognition parameter.
      subtitle="The language you speak to your assistant. Applies from your next spoken turn."
    >
      {providerAcceptsLanguage ? (
        <>
          <div className="flex items-center gap-3">
            <span className="min-w-0 text-body-medium-lighter text-[var(--content-default)]">
              {sttLanguageLabelForCode(currentCode)}
            </span>
            <Button
              variant="outlined"
              onClick={() => setPickerOpen(true)}
              // Before config arrives the current value is a guess; opening
              // the picker then could persist over a value we haven't seen.
              disabled={!assistantId || !daemonConfig}
              className="shrink-0"
            >
              Change
            </Button>
          </div>
          <SttLanguagePickerModal
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            currentCode={currentCode}
            onSelect={selectLanguage}
            selecting={selecting}
          />
        </>
      ) : (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          Your speech-to-text provider (
          {STT_PROVIDER_DISPLAY_NAMES[configuredProvider] ?? configuredProvider}
          ) detects the spoken language on its own, so there is nothing to
          choose here. Language selection applies when the provider is
          Deepgram, on Models &amp; Services.
        </p>
      )}
    </DetailCard>
  );
}
