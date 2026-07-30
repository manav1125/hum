import { useState } from "react";

import { GoogleLogo } from "@/components/icons/google-logo";
import { publicAsset } from "@/utils/public-asset";

// Local assets, preferred over the remote fallback below: they load instantly,
// work offline, and are the versions tuned for our surfaces. Every file in
// `public/images/integrations/` belongs here — several shipped in the repo for
// months while this map listed only five of them, so Gmail and Calendar fell
// through to initials despite having artwork sitting on disk.
const KNOWN_LOGO_URLS: Record<string, string> = {
  "apple-notes": publicAsset("/images/integrations/apple-notes.svg"),
  excel: publicAsset("/images/integrations/excel.svg"),
  figma: publicAsset("/images/integrations/figma.svg"),
  github: publicAsset("/images/integrations/github.svg"),
  gmail: publicAsset("/images/integrations/gmail.svg"),
  googlecalendar: publicAsset("/images/integrations/google-calendar.svg"),
  googledrive: publicAsset("/images/integrations/google-drive.svg"),
  jira: publicAsset("/images/integrations/jira.svg"),
  linear: publicAsset("/images/integrations/linear-light-logo.svg"),
  notion: publicAsset("/images/integrations/notion.svg"),
  outlook: publicAsset("/images/integrations/outlook.png"),
  slack: publicAsset("/images/integrations/slack.svg"),
};

// Aliases for provider keys that don't match the asset name above. Composio
// slugs run words together (`googlecalendar`), while other call sites use
// hyphens.
const LOGO_KEY_ALIASES: Record<string, string> = {
  "google-calendar": "googlecalendar",
  "google-drive": "googledrive",
  "google_calendar": "googlecalendar",
  "google_drive": "googledrive",
};

/**
 * Remote logo for any connector we don't ship an asset for.
 *
 * Every connector in the catalogue is a Composio toolkit, and Composio serves
 * an SVG per slug at a stable URL — so this one line covers all ~500 of them
 * rather than the handful we happen to have local files for. Without it, any
 * connector outside the map above renders as coloured initials: HubSpot showed
 * as a yellow "HU" and WhatsApp as a blue "WH" in the in-chat connector card.
 *
 * `onError` still falls back to initials, so a missing or blocked logo
 * degrades exactly as it did before rather than showing a broken image.
 */
function composioLogoUrl(providerKey: string): string {
  return `https://logos.composio.dev/api/${encodeURIComponent(providerKey)}`;
}

// Deterministic avatar palette. Each slot is a distinct hue so adjacent
// integrations read as visually different. This is a purely decorative
// avatar treatment (not success/error/warning semantics), so we use a
// consistent set of Tailwind accent colors rather than mixing semantic
// system tokens with accent classes.
const PALETTE = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-teal-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-indigo-500",
];

function colorForKey(providerKey: string): string {
  let sum = 0;
  for (let i = 0; i < providerKey.length; i += 1) {
    sum = (sum + providerKey.charCodeAt(i)) % Number.MAX_SAFE_INTEGER;
  }
  return PALETTE[sum % PALETTE.length] ?? PALETTE[0]!;
}

interface IntegrationIconProps {
  providerKey: string;
  displayName: string | null;
  logoUrl: string | null;
  size?: number;
}

export function IntegrationIcon({
  providerKey,
  displayName,
  logoUrl,
  size = 32,
}: IntegrationIconProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedProviderKey = providerKey.toLowerCase();
  const logoKey =
    LOGO_KEY_ALIASES[normalizedProviderKey] ?? normalizedProviderKey;
  const effectiveLogoUrl =
    logoUrl ??
    KNOWN_LOGO_URLS[logoKey] ??
    (logoKey ? composioLogoUrl(logoKey) : undefined);
  const name = displayName ?? providerKey;
  const initials = name.slice(0, 2).toUpperCase();
  const bgColor = colorForKey(providerKey);

  if (normalizedProviderKey === "google") {
    return (
      <GoogleLogo
        size={size}
        className="shrink-0 rounded-md object-contain"
        style={{ width: size, height: size }}
      />
    );
  }

  if (effectiveLogoUrl && !imageFailed) {
    return (
      <img
        src={effectiveLogoUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-md object-contain"
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${bgColor}`}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}
