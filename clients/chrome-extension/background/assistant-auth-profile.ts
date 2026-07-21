/**
 * Auth profile enum for the Cue Chrome extension's transport selection.
 *
 * The shipped extension has a single connection mode:
 *
 * - `self-hosted` — pair directly with a Cue gateway's `/v1/pair` endpoint
 *   over HTTP, then open the SSE `/v1/events` relay to the same gateway.
 *   Used for a locally-running Cue assistant (the desktop app on loopback)
 *   or any gateway URL the user provides.
 * - `unsupported` — the topology is not recognised by this version of the
 *   extension.
 */
export type AssistantAuthProfile = 'self-hosted' | 'unsupported';

/**
 * The subset of topology fields needed to derive the auth profile.
 */
export interface LockfileTopology {
  cloud: string;
  runtimeUrl?: string;
}

/** Cloud values that map to self-hosted direct pairing. */
const LOCAL_CLOUD_VALUES = new Set(['local', 'apple-container']);

/**
 * Derive the auth profile for a given topology. Every recognised local
 * topology resolves to `self-hosted`; anything else is `unsupported`.
 */
export function resolveAuthProfile(topology: LockfileTopology): AssistantAuthProfile {
  if (LOCAL_CLOUD_VALUES.has(topology.cloud)) {
    return 'self-hosted';
  }
  return 'unsupported';
}
