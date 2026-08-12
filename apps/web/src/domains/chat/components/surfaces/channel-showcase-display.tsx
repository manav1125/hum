/**
 * `channel_showcase` card template — the visual answer to "how can I reach
 * you / interact with you?".
 *
 * The model emits only the channel rows (id + live/available status), built
 * from its `# Your Channels` prompt section; this renderer enriches them
 * with icons, labels, a LIVE pill for connected channels, and a "Set up"
 * button for available ones. "Set up" submits the channel's guardian setup
 * seed prompt through the composer as a real user message (same path as the
 * conversation-starter chips — see `surface-prompt-submit.ts`), which opens
 * the conversation that drives that channel's verification flow.
 *
 * Below the channels, the card appends static informational rows for the
 * non-channel interfaces (Desktop app, Web, iOS, CLI). No metadata catalog
 * exists for interfaces, so these are hardcoded here.
 */
import type { ReactNode } from "react";
import {
  Bot,
  Globe,
  Hash,
  Mail,
  MessageCircle,
  MessageSquare,
  Monitor,
  Phone,
  Send,
  Smartphone,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@vellumai/design-library";
import { submitPromptFromSurface } from "@/domains/chat/components/surfaces/surface-prompt-submit";

// ---------------------------------------------------------------------------
// Channel metadata (mirrors the daemon catalog)
// ---------------------------------------------------------------------------

export interface ChannelShowcaseMeta {
  label: string;
  subtitle: string;
  icon: LucideIcon;
  /**
   * First-turn user message that opens the setup conversation for this
   * channel. Submitted verbatim when "Set up" is pressed.
   */
  setupPrompt: string;
}

/**
 * SOURCE OF TRUTH: `assistant/src/channels/types.ts` `CHANNEL_METADATA`
 * (labels, subtitles, lucide icon names, and `setupMessages.guardian` seed
 * prompts). Mirrored here rather than fetched from `GET /v1/channels/available`
 * so the card renders synchronously with zero extra requests; if a channel is
 * added or reworded in the daemon, update this map to match.
 *
 * Icons mirror the icon-name → component resolution in
 * `apps/web/src/domains/intelligence/channels-page.tsx` (`CHANNEL_GLYPH`).
 * TODO(refactor): lift a shared channel-glyph module out of the intelligence
 * domain so this map and CHANNEL_GLYPH cannot drift (blocked on the
 * cross-domain import convention — see apps/web/docs/CONVENTIONS.md).
 */
export const CHANNEL_SHOWCASE_METADATA: Record<string, ChannelShowcaseMeta> = {
  slack: {
    label: "Slack",
    subtitle: "Message your assistant from Slack",
    icon: Hash,
    setupPrompt:
      "I'd like to verify my identity as your guardian on Slack. Can you help me set that up?",
  },
  telegram: {
    label: "Telegram",
    subtitle: "Message your assistant from Telegram",
    icon: Send,
    setupPrompt:
      "I'd like to verify my identity as your guardian on Telegram. Can you help me set that up?",
  },
  phone: {
    label: "Phone Calling",
    subtitle: "Call or text your assistant via phone",
    icon: Phone,
    setupPrompt:
      "I'd like to verify my identity as your guardian for phone calls. Can you help me set that up?",
  },
  sms: {
    label: "SMS",
    subtitle: "Text your assistant from any phone",
    icon: MessageCircle,
    setupPrompt:
      "I'd like to verify my identity as your guardian over SMS. Can you help me set that up?",
  },
  email: {
    label: "Email",
    subtitle: "Reach your assistant by email",
    icon: Mail,
    setupPrompt:
      "I'd like to set up email as a way for me to reach you. Can you walk me through it?",
  },
  whatsapp: {
    label: "WhatsApp",
    subtitle: "Message your assistant on WhatsApp",
    icon: MessageSquare,
    setupPrompt:
      "I'd like to verify my identity as your guardian on WhatsApp. Can you help me set that up?",
  },
  a2a: {
    label: "A2A",
    subtitle: "Agent-to-Agent protocol",
    icon: Bot,
    setupPrompt:
      "I'd like to connect with another assistant via A2A. Can you help me set that up?",
  },
};

/**
 * Non-channel interfaces — ways to use Cue that aren't messaging channels.
 * Informational only (no status, no setup flow).
 * TODO(design/daemon): there is no daemon-side metadata catalog for
 * interfaces (`INTERFACE_IDS` in assistant/src/channels/types.ts carries ids
 * only), so label + icon + copy are hardcoded here until one exists.
 */
const INTERFACE_ROWS: {
  id: string;
  label: string;
  subtitle: string;
  icon: LucideIcon;
}[] = [
  {
    id: "macos",
    label: "Desktop app",
    subtitle: "The full Cue experience on your Mac",
    icon: Monitor,
  },
  {
    id: "web",
    label: "Web",
    subtitle: "Use Cue from any browser",
    icon: Globe,
  },
  {
    id: "ios",
    label: "iOS",
    subtitle: "Cue in your pocket, on iPhone",
    icon: Smartphone,
  },
  {
    id: "cli",
    label: "CLI",
    subtitle: "Drive your assistant from the terminal",
    icon: SquareTerminal,
  },
];

// ---------------------------------------------------------------------------
// Data shape + parsing
// ---------------------------------------------------------------------------

export interface ChannelShowcaseRow {
  id: string;
  label?: string;
  status: "live" | "available";
}

export interface ChannelShowcaseData {
  intro?: string;
  channels: ChannelShowcaseRow[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRow(value: unknown): ChannelShowcaseRow | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const id = asString(rec.id);
  if (!id) return null;
  // Unknown channel ids (a model hallucination, or a daemon channel this
  // build predates) are dropped rather than rendered as a labelless row
  // with a dead Set up button.
  if (!CHANNEL_SHOWCASE_METADATA[id]) return null;
  return {
    id,
    label: asString(rec.label),
    status: rec.status === "live" ? "live" : "available",
  };
}

/**
 * Never-throw parse: malformed template data returns `null` and the card
 * degrades to its plain prose body (same contract as the weather template).
 */
export function parseChannelShowcase(
  templateData: Record<string, unknown>,
): ChannelShowcaseData | null {
  const rawChannels = templateData.channels;
  if (!Array.isArray(rawChannels)) return null;
  const seen = new Set<string>();
  const channels: ChannelShowcaseRow[] = [];
  for (const raw of rawChannels) {
    const row = parseRow(raw);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    channels.push(row);
  }
  if (channels.length === 0) return null;
  return { intro: asString(templateData.intro), channels };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LivePill() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-body-small-default text-[var(--system-positive-strong)]"
      style={{
        backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)",
      }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-[var(--system-positive-strong)]"
      />
      LIVE
    </span>
  );
}

function ShowcaseRow({
  icon: Icon,
  label,
  subtitle,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  subtitle: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
      {/* TODO(design): placeholder neutral icon chip — channels-page gives
          each channel a brand-colored tile (Slack aubergine, WhatsApp green,
          …); port that treatment here. */}
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--tag-bg-neutral)] text-[var(--content-strong)]">
        <Icon size={18} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-medium-default text-[var(--content-strong)]">
          {label}
        </div>
        <div className="truncate text-body-small-default text-[var(--content-quiet)]">
          {subtitle}
        </div>
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChannelShowcaseDisplay({
  templateData,
  fallback,
}: {
  templateData: Record<string, unknown>;
  fallback: ReactNode;
}) {
  const data = parseChannelShowcase(templateData);
  if (!data) return <>{fallback}</>;

  return (
    <div className="mt-2">
      {data.intro && (
        <p className="mb-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          {data.intro}
        </p>
      )}

      <div className="divide-y divide-[var(--border-base)]">
        {data.channels.map((row) => {
          const meta = CHANNEL_SHOWCASE_METADATA[row.id];
          return (
            <ShowcaseRow
              key={row.id}
              icon={meta.icon}
              label={row.label ?? meta.label}
              subtitle={meta.subtitle}
              trailing={
                row.status === "live" ? (
                  <LivePill />
                ) : (
                  <Button
                    variant="outlined"
                    onClick={() => submitPromptFromSurface(meta.setupPrompt)}
                  >
                    Set up
                  </Button>
                )
              }
            />
          );
        })}
      </div>

      <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
        <div className="mb-1.5 text-body-small-default text-[var(--content-quiet)]">
          Also available on
        </div>
        <div className="divide-y divide-[var(--border-base)]">
          {INTERFACE_ROWS.map((row) => (
            <ShowcaseRow
              key={row.id}
              icon={row.icon}
              label={row.label}
              subtitle={row.subtitle}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
