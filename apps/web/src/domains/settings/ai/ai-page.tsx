import { useEffect } from "react";

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
  // Scroll to hash target on mount (e.g. deep links to #email).
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    });
  }, []);

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
