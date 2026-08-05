import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

/**
 * Workspace paths whose contents govern the assistant itself rather than the
 * user's data: writing one changes the system prompt, the assistant's
 * identity/persona, or the code the daemon loads. A write here must never be
 * auto-approved as an ordinary low-risk workspace write — the system prompt's
 * security sections (credential custody, external-content handling) are
 * themselves override targets, so an injected write can silently rewrite the
 * assistant's own security policy and every later turn renders it.
 *
 * Consumed by the risk-classification context forwarded to the gateway's file
 * risk classifier; keep in sync with the surfaces the prompt renderer and
 * daemon loaders actually read:
 * - `prompts/` — per-section system-prompt overrides (`prompts/system/<id>.md`
 *   replaces or silences the bundled section, including the security ones).
 * - `users/`, `channels/` — persona sections injected per turn.
 * - `tools/`, `routes/` — daemon-loaded executable sinks.
 * - Root prompt files — identity/soul/voice/bootstrap plus the NOW scratchpad
 *   and the heartbeat agent's own checklist.
 */
export interface ControlPlanePaths {
  /** Directories whose entire subtree is control-plane (absolute paths). */
  dirs: string[];
  /** Individual control-plane files (absolute paths). */
  files: string[];
}

/** Root prompt files the system prompt or background agents render directly. */
const CONTROL_PLANE_ROOT_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "VOICE.md",
  "BOOTSTRAP.md",
  "NOW.md",
  "HEARTBEAT.md",
] as const;

/** Workspace subtrees that feed the system prompt or are daemon-loaded code. */
const CONTROL_PLANE_DIRS = [
  "prompts",
  "users",
  "channels",
  "tools",
  "routes",
] as const;

export function getControlPlanePaths(): ControlPlanePaths {
  const workspaceDir = getWorkspaceDir();
  return {
    dirs: CONTROL_PLANE_DIRS.map((dir) => join(workspaceDir, dir)),
    files: CONTROL_PLANE_ROOT_FILES.map((file) => join(workspaceDir, file)),
  };
}
