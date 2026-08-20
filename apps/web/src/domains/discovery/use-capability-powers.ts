/**
 * "What Cue can now do" — the seven powers, with their state derived from what
 * the daemon actually reports (design frames D1 mobile / D2 HQ).
 *
 * The rule this module exists to enforce: **the CTA verb states the truth**.
 * A power is only "On ✓" when something real is running; "Set up"/"Browse" when
 * it is available and unconfigured; "Learn" when we cannot honestly claim
 * anything better. Anything that needs a grant, an install, or an account
 * carries an amber caveat naming that cost *before* the tap.
 *
 * Signals, all pre-existing:
 *  - desktop organizer  → `organizer/session`.targets (host-capable Macs)
 *  - watchers           → `/v1/watchers/list`
 *  - playbooks          → `/v1/playbooks/list`
 *  - plugins            → `plugins` (installed)
 *  - phone channel      → `channels/readiness`
 *  - Cue Live           → `isCueLiveAvailable()` + `cuelive/session`
 *  - browser extension  → `/v1/clients`, the connected-client list. A
 *    connected extension is a hub subscriber with `interfaceId:
 *    "chrome-extension"` holding the `host_browser` capability — the same
 *    signal `reach-snapshot.ts` gives the model to decide whether the user's
 *    own browser is reachable. It covers the SSE transport (cloud/platform);
 *    a self-hosted extension paired over the `/v1/browser-relay` WebSocket is
 *    not a hub subscriber and reads as not-connected, which under-claims
 *    rather than over-claims.
 */
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  channelsReadinessGetOptions,
  clientsGetOptions,
  cueliveSessionGetOptions,
  organizerSessionGetOptions,
  pluginsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  usePlaybooks,
  useWatchers,
} from "@/mobile-v3/you/use-automations-data";
import { isCueLiveAvailable } from "@/runtime/cue-live";

/**
 * Visual/verb state. Taxonomy is deliberate and shared with the rest of the
 * work-loop system: blue pulse = running right now, green = done/on, amber =
 * needs you, neutral = available to explore.
 */
export type PowerState = "running" | "on" | "needs-you" | "available";

/**
 * Whether Cue can reach the user's own browser through the extension.
 *
 * `unknown` is deliberately not a synonym for `absent`: a clients query that
 * failed, timed out, or has not answered yet says nothing about whether the
 * extension is installed, so it may neither claim "On ✓" nor assert absence.
 */
export type ExtensionReach = "connected" | "absent" | "unknown";

/** The interface id the Chrome extension registers under on the event hub. */
const EXTENSION_INTERFACE_ID = "chrome-extension";
/** The host-proxy capability a browser-driving client carries. */
const BROWSER_CAPABILITY = "host_browser";

/** `/v1/clients` returns untyped passthrough records; narrow one honestly. */
function isConnectedExtension(client: Record<string, unknown>): boolean {
  const capabilities = client.capabilities;
  return (
    client.interfaceId === EXTENSION_INTERFACE_ID &&
    Array.isArray(capabilities) &&
    capabilities.includes(BROWSER_CAPABILITY)
  );
}

/**
 * The connected-client list → reach. `failed` wins over any data still held
 * from an earlier success: a stale "connected" is not something we may claim
 * once the current read errored.
 */
export function readExtensionReach(
  clients: ReadonlyArray<Record<string, unknown>> | undefined,
  failed: boolean,
): ExtensionReach {
  if (failed || clients === undefined) return "unknown";
  return clients.some(isConnectedExtension) ? "connected" : "absent";
}

export interface CapabilityPower {
  id:
    | "organizer"
    | "watchers"
    | "playbooks"
    | "plugins"
    | "extension"
    | "phone"
    | "cue-live";
  glyph: string;
  /** Short title (mobile leads with the benefit, HQ with the feature name). */
  title: string;
  hqTitle: string;
  /** One line — what it does. */
  line: string;
  /** Amber caveat naming the cost, or null when there is none. */
  caveat: string | null;
  state: PowerState;
  /** The verb, which must match `state`. */
  cta: string;
  /** In-app destination, or null when the CTA only teaches. */
  to: string | null;
}

/** The CTA verb for a state — never diverges from what we can claim. */
function ctaFor(state: PowerState, whenAvailable: string): string {
  if (state === "running") return "Running";
  if (state === "on") return "On ✓";
  if (state === "needs-you") return "Learn";
  return whenAvailable;
}

export interface CapabilityPowersResult {
  powers: CapabilityPower[];
  isLoading: boolean;
}

/** The raw truths the seven powers are derived from. */
export interface CapabilitySignals {
  /** A host-capable Mac is connected to the event hub right now. */
  macOnline: boolean;
  /** An organizer run is executing on that Mac. */
  organizerRunning: boolean;
  enabledWatchers: number;
  enabledPlaybooks: number;
  installedPlugins: number;
  /** A phone/voice channel reports ready. */
  phoneReady: boolean;
  /** A Cue Live session is running. */
  cueLiveActive: boolean;
  /** Cue Live can be reached at all (desktop bridge, or a connected Mac). */
  cueLiveReachable: boolean;
  /** Whether the browser extension is connected — or not knowable right now. */
  extensionReach: ExtensionReach;
}

/**
 * Signals → powers. Pure, so the honesty rules (verb matches state, caveat
 * names the cost) are unit-testable without a daemon.
 */
export function buildCapabilityPowers({
  macOnline,
  organizerRunning,
  enabledWatchers,
  enabledPlaybooks,
  installedPlugins,
  phoneReady,
  cueLiveActive,
  cueLiveReachable,
  extensionReach,
}: CapabilitySignals): CapabilityPower[] {
  const organizerState: PowerState = organizerRunning
    ? "running"
    : macOnline
      ? "on"
      : "needs-you";

  const cueLiveState: PowerState = cueLiveActive
    ? "running"
    : cueLiveReachable
      ? "available"
      : "needs-you";

  const extensionConnected = extensionReach === "connected";

  return [
    {
      id: "organizer",
      glyph: "🖥",
      title: "Tidy up your Mac",
      hqTitle: "Desktop organizer",
      line: "Sorts your desktop & downloads on command.",
      caveat: macOnline ? null : "Needs the Mac app.",
      state: organizerState,
      cta: ctaFor(organizerState, "Set up"),
      to: "/assistant/desktop-control",
    },
    {
      id: "watchers",
      glyph: "👁",
      title: "Watch your inbox & GitHub",
      hqTitle: "Watchers",
      line:
        enabledWatchers > 0
          ? `Flags what matters, files the rest · ${enabledWatchers} watching.`
          : "Flags what matters, files the rest.",
      caveat: null,
      state: enabledWatchers > 0 ? "on" : "available",
      cta: ctaFor(enabledWatchers > 0 ? "on" : "available", "Set up"),
      to: "/assistant/automations",
    },
    {
      id: "playbooks",
      glyph: "⚡",
      title: "Trigger → action rules",
      hqTitle: "Playbooks",
      line: '"When X happens, do Y" — Playbooks.',
      caveat: null,
      state: enabledPlaybooks > 0 ? "on" : "available",
      cta: ctaFor(enabledPlaybooks > 0 ? "on" : "available", "Set up"),
      to: "/assistant/automations",
    },
    {
      id: "plugins",
      glyph: "🧩",
      title: "Extend Cue with Plugins",
      hqTitle: "Plugins",
      line:
        installedPlugins > 0
          ? `Add tools & apps from the marketplace · ${installedPlugins} installed.`
          : "Add tools & apps from the marketplace.",
      caveat: null,
      state: installedPlugins > 0 ? "on" : "available",
      cta: installedPlugins > 0 ? "On ✓" : "Browse",
      to: "/assistant/plugins",
    },
    {
      id: "extension",
      glyph: "🌐",
      title: "Drive your browser",
      hqTitle: "Browser extension",
      line: extensionConnected
        ? "The Cue extension fills forms & navigates for you · connected."
        : "The Cue extension fills forms & navigates for you.",
      // "On ✓" only on a connected extension the daemon reports. A clients
      // query we could not read is `unknown`, and says so — it must not be
      // dressed up as either an install prompt or a working extension.
      caveat: extensionConnected
        ? null
        : extensionReach === "absent"
          ? "Needs the extension — not connected right now."
          : "Needs the extension — Cue can't confirm it right now.",
      state: extensionConnected ? "on" : "needs-you",
      cta: extensionConnected ? "On ✓" : "Learn",
      to: null,
    },
    {
      id: "phone",
      glyph: "📞",
      title: "Answer your phone",
      hqTitle: "Phone channel",
      line: "A Cue number screens & takes calls.",
      caveat: phoneReady ? null : "Needs setup.",
      state: phoneReady ? "on" : "available",
      cta: phoneReady ? "On ✓" : "Set up",
      to: "/assistant/channels",
    },
    {
      id: "cue-live",
      glyph: "✦",
      title: "Act on your Mac screen",
      hqTitle: "Cue Live",
      line: "Sees & acts on your Mac screen — Look, Guide, or take control.",
      caveat: cueLiveReachable ? null : "Needs the Mac app.",
      state: cueLiveState,
      cta: cueLiveState === "available" ? "Open" : ctaFor(cueLiveState, "Open"),
      to: "/assistant/cue-live",
    },
  ];
}

export function useCapabilityPowers(): CapabilityPowersResult {
  const assistantId = useActiveAssistantId();
  const enabled = !!assistantId;
  const path = { assistant_id: assistantId ?? "" };

  const organizer = useQuery({
    ...organizerSessionGetOptions({ path }),
    enabled,
  });
  const cueLive = useQuery({ ...cueliveSessionGetOptions({ path }), enabled });
  const plugins = useQuery({
    ...pluginsGetOptions({ path, query: {} }),
    enabled,
  });
  const channels = useQuery({
    ...channelsReadinessGetOptions({ path, query: {} }),
    enabled,
  });
  const clients = useQuery({
    ...clientsGetOptions({ path, query: {} }),
    enabled,
  });
  const watchers = useWatchers();
  const playbooks = usePlaybooks();

  const macOnline = (organizer.data?.targets ?? []).some(
    (t) => t.online !== false,
  );

  return {
    powers: buildCapabilityPowers({
      macOnline,
      organizerRunning: organizer.data?.session?.active === true,
      enabledWatchers: (watchers.data ?? []).filter((w) => w.enabled).length,
      enabledPlaybooks: (playbooks.data?.playbooks ?? []).filter(
        (p) => p.enabled,
      ).length,
      installedPlugins: plugins.data?.plugins?.length ?? 0,
      // The phone power is "a Cue number screens & takes calls" — any
      // voice/phone-shaped channel reporting ready satisfies it.
      phoneReady: (channels.data?.snapshots ?? []).some(
        (s) =>
          s.ready === true &&
          /phone|voice|call|sms|whatsapp|telegram/i.test(s.channel ?? ""),
      ),
      cueLiveActive: cueLive.data?.active === true,
      cueLiveReachable: isCueLiveAvailable() || macOnline,
      // No assistant yet means the query never ran — that is "can't confirm",
      // not "absent", which `readExtensionReach` gives us for undefined data.
      extensionReach: readExtensionReach(
        clients.data?.clients,
        clients.isError,
      ),
    }),
    isLoading:
      organizer.isLoading ||
      cueLive.isLoading ||
      plugins.isLoading ||
      channels.isLoading ||
      clients.isLoading ||
      watchers.isLoading ||
      playbooks.isLoading,
  };
}
