import type { WatcherProvider } from "./provider-types.js";
import { slackProvider } from "./providers/slack.js";

const providers = new Map<string, WatcherProvider>();

export function registerWatcherProvider(provider: WatcherProvider): void {
  providers.set(provider.id, provider);
}

// The Slack provider registers with the registry itself rather than in
// `daemon/providers-setup.ts` with the other six. Auto-provisioning
// (`auto-provision.ts`) already maps the Composio "slack" toolkit to this
// provider id and self-provisions the moment the provider is registered, so
// registration here guarantees every registry consumer — the engine, the
// auto-provisioner, the Automations routes — sees the same answer regardless
// of daemon startup order. Registration is idempotent (a Map.set), so the
// daemon's own registration pass is unaffected.
registerWatcherProvider(slackProvider);

export function getWatcherProvider(id: string): WatcherProvider | undefined {
  return providers.get(id);
}

export function listWatcherProviders(): WatcherProvider[] {
  return Array.from(providers.values());
}
