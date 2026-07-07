/**
 * Capability manifest parsing — the optional `secrets:` / `connectors:` /
 * `network:` / `writes:` frontmatter keys on third-party SKILL.md files.
 *
 * Frontmatter itself is parsed by the SAME parser `loadSkillBySelector`
 * uses (`parseFrontmatterFields` in `../frontmatter.ts`) — this module only
 * interprets already-parsed fields. Do not add a second YAML parser here.
 */

import type { CapabilityManifest } from "./types.js";
import { hasDeclaredCapabilities } from "./types.js";

function toStringList(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/** Extract the declared capability manifest from parsed frontmatter fields. */
export function parseCapabilityManifest(
  fields: Record<string, unknown>,
): CapabilityManifest {
  return {
    secrets: toStringList(fields.secrets),
    connectors: toStringList(fields.connectors),
    network: toStringList(fields.network),
    writes: toStringList(fields.writes),
  };
}

/**
 * The consent copy shown on every install confirmation. Declared
 * capabilities are listed; the absence of declarations is called out
 * explicitly rather than implying "safe".
 */
export function buildConsentNotice(
  manifest: CapabilityManifest,
  source: string,
): string {
  if (source === "cue-official") {
    return hasDeclaredCapabilities(manifest)
      ? `Cue official skill. Declares: ${describeManifest(manifest)}.`
      : "Cue official skill from the first-party catalog.";
  }
  if (!hasDeclaredCapabilities(manifest)) {
    return `No declared capabilities — third-party skill from ${source}, review before use.`;
  }
  return `Third-party skill from ${source}. Declares: ${describeManifest(manifest)}.`;
}

function describeManifest(manifest: CapabilityManifest): string {
  const parts: string[] = [];
  if (manifest.secrets.length > 0)
    parts.push(`secrets (${manifest.secrets.join(", ")})`);
  if (manifest.connectors.length > 0)
    parts.push(`connectors (${manifest.connectors.join(", ")})`);
  if (manifest.network.length > 0)
    parts.push(`network (${manifest.network.join(", ")})`);
  if (manifest.writes.length > 0)
    parts.push(`writes (${manifest.writes.join(", ")})`);
  return parts.join("; ");
}
