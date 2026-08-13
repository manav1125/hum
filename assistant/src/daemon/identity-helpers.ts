import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveGuardianPersonaStrict } from "../prompts/persona-resolver.js";
import { DECLINED_BY_USER_SENTINEL } from "../prompts/user-reference.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import { isTemplatePlaceholder } from "./handlers/identity.js";

/** Read the assistant's name from IDENTITY.md for personalized responses. */
export function getAssistantName(): string | null {
  try {
    const path = getWorkspacePromptPath("IDENTITY.md");
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8");
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    const value = match?.[1]?.trim();
    // Template scaffolding like `_(not yet chosen)_` is "no name yet", not a
    // name — callers substitute their own default instead of leaking markdown.
    if (!value || isTemplatePlaceholder(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Extract a display name from persona-file content. Tries the markdown-bold
 * "Name" label (the IDENTITY.md convention), then the onboarding-written
 * "Preferred name" bullet, then the scaffold's "Preferred name/reference"
 * line. Matches only horizontal whitespace after the label so an unfilled
 * scaffold line does not swallow the next line.
 *
 * All three are shapes this codebase itself writes — `persona-resolver.ts`
 * emits the bullet on onboarding and the bare label in the scaffold — so
 * matching only `**Name:**` missed the name our own writers had just stored.
 */
function extractPersonaName(content: string): string | null {
  const match =
    content.match(/\*\*Name:\*\*[ \t]*(.+)/) ??
    content.match(/\*\*Preferred name:\*\*[ \t]*(.+)/) ??
    content.match(/Preferred name\/reference:[ \t]*(.+)/);
  return match?.[1]?.trim() || null;
}

function readPersonaName(filePath: string): string | null {
  try {
    return extractPersonaName(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Read the user's display name from the guardian's own persona file
 * (`users/<slug>.md`), falling back to `users/default.md`. Returns `null` on
 * any miss; callers substitute a generic label.
 *
 * Reading only `default.md` was the bug: a guardian with their own persona
 * file — which `ensureGuardianPersonaFile` creates — has their name in
 * `users/<slug>.md`, so scheduled tasks and memory consolidation addressed
 * them by a generic label instead of their name.
 *
 * `DECLINED_BY_USER_SENTINEL` is a recorded refusal to be named, not a name;
 * it falls through to the default file rather than being rendered.
 */
export function resolveUserName(workspaceDir: string): string | null {
  const guardianContent = resolveGuardianPersonaStrict();
  if (guardianContent) {
    const name = extractPersonaName(guardianContent);
    if (name && name !== DECLINED_BY_USER_SENTINEL) {
      return name;
    }
  }
  return readPersonaName(join(workspaceDir, "users", "default.md"));
}
