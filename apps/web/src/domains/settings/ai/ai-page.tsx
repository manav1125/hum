import { useEffect } from "react";

import { hideVendorUi, useManagedMode } from "@/assistant/use-managed-mode";
import { Typography } from "@vellumai/design-library/components/typography";

import { LanguageModelCard } from "@/domains/settings/ai/language-model-card";
import { WebSearchCard } from "@/domains/settings/ai/web-search-card";
import { EmailServiceCard } from "@/domains/settings/ai/email-service-card";
import { ImageGenerationCard } from "@/domains/settings/ai/image-generation-card";
import { TextToSpeechCard } from "@/domains/settings/ai/text-to-speech-card";
import { SpeechToTextCard } from "@/domains/settings/ai/speech-to-text-card";

// ---------------------------------------------------------------------------
// AiPage — layout shell
// ---------------------------------------------------------------------------

export function AiPage() {
  const managed = useManagedMode();

  // Scroll to hash target on mount (e.g. deep links to #email).
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    });
  }, []);

  // Managed (Cue-hosted) instances never see the BYO provider/key cards —
  // the sidebar entry is hidden too, but gate the page itself so deep links
  // can't reach vendor machinery. Per the use-managed-mode flash policy this
  // renders nothing while the flag is still resolving.
  if (hideVendorUi(managed)) {
    return managed === true ? (
      <div className="space-y-5">
        <Typography
          as="p"
          variant="body-medium-default"
          className="text-[var(--content-tertiary)]"
        >
          AI services on this instance are managed by Cue — there's nothing to
          set up here.
        </Typography>
      </div>
    ) : null;
  }

  return (
    <div className="space-y-5">
      {/* Cue runs on your own provider keys (BYOK); a managed Cue Cloud billing
          banner belongs here once that service exists. Until then, no banner —
          the previous one advertised metered Cue Cloud billing that isn't
          available yet and linked to upstream Vellum pricing. */}
      <LanguageModelCard />
      <WebSearchCard />
      <EmailServiceCard />
      <ImageGenerationCard />
      <TextToSpeechCard />
      <SpeechToTextCard />
    </div>
  );
}
