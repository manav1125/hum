/**
 * Channel normalisation for playbooks.
 *
 * The runtime matches a playbook's `channel` against the event's channel by
 * exact string equality (`listMatchablePlaybooks`), and a watcher event's
 * channel is always `watcher:<providerId>` (`watcherChannel`). So a playbook
 * stored with channel "email" or "gmail" can never fire, however sensible it
 * reads. Anything that accepts a channel from outside — a tool argument, an
 * imported rule — funnels through here first so the stored value is one the
 * matcher can actually hit.
 */

/** Any channel. */
export const ANY_CHANNEL = "*";

const WATCHER_PREFIX = "watcher:";

/**
 * Friendly aliases callers reach for, mapped onto the provider ids the watcher
 * registry actually uses. Keys are lowercased and stripped of spaces.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  email: "gmail",
  mail: "gmail",
  googlemail: "gmail",
  gmail: "gmail",
  outlook: "outlook",
  outlookmail: "outlook",
  calendar: "google-calendar",
  googlecalendar: "google-calendar",
  gcal: "google-calendar",
  outlookcalendar: "outlook-calendar",
  github: "github",
  gh: "github",
  linear: "linear",
};

/**
 * Coerce a caller-supplied channel into the form the playbook matcher compares
 * against. `*`/empty means "any channel"; a `watcher:*` value is already
 * canonical; anything else is treated as a provider name and prefixed.
 */
export function normalizePlaybookChannel(value: unknown): string {
  if (typeof value !== "string") return ANY_CHANNEL;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === ANY_CHANNEL) return ANY_CHANNEL;
  if (trimmed.startsWith(WATCHER_PREFIX)) return trimmed;
  const key = trimmed.toLowerCase().replace(/[\s_]+/g, "");
  const providerId = PROVIDER_ALIASES[key] ?? trimmed.toLowerCase();
  return `${WATCHER_PREFIX}${providerId}`;
}

/** Human-readable form of a stored channel, for tool output. */
export function describePlaybookChannel(channel: string): string {
  if (channel === ANY_CHANNEL) return "all channels";
  return channel.startsWith(WATCHER_PREFIX)
    ? channel.slice(WATCHER_PREFIX.length)
    : channel;
}
