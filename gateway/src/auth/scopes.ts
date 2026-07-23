/**
 * Scope profile resolver and scope-check utilities.
 *
 * Each scope profile maps to a fixed set of permission scopes. The
 * mapping is intentionally hard-coded — profile definitions are a
 * policy decision, not a runtime configuration.
 */

import type { Scope, ScopeProfile } from "./types.js";

// ---------------------------------------------------------------------------
// Profile -> scope mapping
// ---------------------------------------------------------------------------

const PROFILE_SCOPES: Record<ScopeProfile, ReadonlySet<Scope>> = {
  actor_client_v1: new Set<Scope>([
    "admin.write",
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
    "settings.read",
    "settings.write",
    "attachments.read",
    "attachments.write",
    "calls.read",
    "calls.write",
    "feature_flags.read",
    "feature_flags.write",
  ]),
  // Minimal profile for the browser extension's host_browser relay loop:
  //   - chat.read     → subscribe to the SSE stream (GET /v1/events) that
  //                     carries host_browser_request frames
  //   - approval.write → POST results back (POST /v1/host-browser-result)
  // Deliberately excludes chat.write, settings.*, attachments.*, admin.write,
  // etc. — the extension can drive the browser relay but cannot send messages,
  // change settings, or read data. Bound to the guardian principal at mint time
  // (see pair-session.ts); /v1/host-browser-result additionally requires the
  // caller to be the bound guardian, which the guardian-bound sub satisfies.
  chrome_extension_v1: new Set<Scope>(["chat.read", "approval.write"]),
  gateway_ingress_v1: new Set<Scope>(["ingress.write", "internal.write"]),
  gateway_service_v1: new Set<Scope>([
    "chat.read",
    "chat.write",
    "settings.read",
    "settings.write",
    "attachments.read",
    "attachments.write",
    "internal.write",
  ]),
  local_v1: new Set<Scope>(["local.all"]),
  ui_page_v1: new Set<Scope>(["settings.read"]),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve a scope profile name to its set of granted scopes. */
export function resolveScopeProfile(profile: ScopeProfile): ReadonlySet<Scope> {
  return PROFILE_SCOPES[profile];
}
