/**
 * `plugins publish` — prepare a plugin repo for submission to the curated
 * registry (`plugins/registry.json`).
 *
 * Publishing to Cue's registry is a PR-based, index-not-host flow (the same
 * curation model as the skills marketplace): we never host plugin code, we
 * curate an allowlist of commit-pinned source repos. This helper does the
 * mechanical, verifiable part of a submission:
 *
 *   1. Fetch the repo's `package.json` and confirm it is a plugin manifest
 *      (declares an `@vellumai/plugin-api` dependency).
 *   2. Resolve the ref to an immutable commit SHA (the pin).
 *   3. Emit a ready-to-paste `plugins/registry.json` entry + the exact PR steps.
 *
 * It does NOT open a PR or mutate the committed registry — that is a human
 * review gate. Direct-GitHub-URL installs (`plugins install <url>`) remain
 * available and are marked untrusted; publishing is how a repo graduates to a
 * reviewed, pinned entry.
 */

import { parsePluginManifest } from "../../plugins/registry/indexer.js";
import { normalizeGithubAddress } from "../../plugins/registry/registry-file.js";
import {
  fetchRawFile,
  fetchRepoTree,
} from "../../skills/marketplace/github.js";

export class PluginPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginPublishError";
  }
}

export interface PublishPreparation {
  address: string;
  ref: string;
  commit: string;
  pluginName: string;
  description: string;
  apiRange?: string;
  /** The JSON entry to add under `plugins/registry.json` → `plugins[]`. */
  registryEntry: Record<string, unknown>;
  /** Human-facing PR steps. */
  instructions: string[];
}

/** Resolve a ref (branch/tag/sha) to an immutable commit SHA via the GitHub API. */
async function resolveCommitSha(address: string, ref: string): Promise<string> {
  const token = process.env.CUE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cue-plugin-registry",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `https://api.github.com/repos/${address}/commits/${encodeURIComponent(ref)}`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) {
    throw new PluginPublishError(
      `Could not resolve ${address}@${ref} to a commit (HTTP ${res.status}).`,
    );
  }
  const data = (await res.json()) as { sha?: string };
  if (!data.sha) {
    throw new PluginPublishError(
      `GitHub returned no commit sha for ${address}@${ref}.`,
    );
  }
  return data.sha;
}

/**
 * Validate a repo (optionally a subpath) and produce a registry submission.
 * `input` is `owner/repo`, a github URL, or `owner/repo@ref`.
 */
export async function preparePluginPublish(
  input: string,
  options?: { path?: string },
): Promise<PublishPreparation> {
  let refFromInput: string | undefined;
  let addressInput = input.trim();
  const atIdx = addressInput.lastIndexOf("@");
  if (atIdx > 0 && !addressInput.slice(atIdx).includes("/")) {
    refFromInput = addressInput.slice(atIdx + 1);
    addressInput = addressInput.slice(0, atIdx);
  }
  const address = normalizeGithubAddress(addressInput);
  if (!address) {
    throw new PluginPublishError(
      `"${input}" is not a valid owner/repo or GitHub URL.`,
    );
  }

  const ref = refFromInput ?? "HEAD";
  const subPath = (options?.path ?? "").replace(/^\/+|\/+$/g, "");
  const manifestPath = subPath ? `${subPath}/package.json` : "package.json";

  // Confirm the manifest exists and is a plugin manifest.
  let content: string;
  try {
    content = await fetchRawFile(address, ref, manifestPath);
  } catch {
    throw new PluginPublishError(
      `No ${manifestPath} found in ${address}@${ref}. ` +
        (subPath
          ? ""
          : "Pass --path <dir> if the plugin lives in a subdirectory."),
    );
  }
  const parsed = parsePluginManifest(content, subPath);
  if (!parsed) {
    throw new PluginPublishError(
      `${manifestPath} in ${address} is not a plugin manifest — it must declare ` +
        `"@vellumai/plugin-api" in dependencies, devDependencies, or peerDependencies.`,
    );
  }

  // Best-effort sanity: warn (not fail) if we cannot see the tree.
  try {
    await fetchRepoTree(address, ref);
  } catch {
    /* non-fatal — the raw manifest fetch already succeeded */
  }

  const commit = await resolveCommitSha(address, ref);
  const registryEntry: Record<string, unknown> = {
    name: parsed.name,
    source: {
      source: "github",
      repo: address,
      ref: commit,
      ...(subPath ? { path: subPath } : {}),
    },
    description: parsed.description || `${parsed.name} plugin.`,
    reviewStatus: "community",
    ...(parsed.license ? { license: parsed.license } : {}),
    ...(parsed.surfaces.length > 0 ? { surfaces: parsed.surfaces } : {}),
  };

  return {
    address,
    ref,
    commit,
    pluginName: parsed.name,
    description: parsed.description,
    ...(parsed.apiRange ? { apiRange: parsed.apiRange } : {}),
    registryEntry,
    instructions: [
      "Submit this plugin to the Cue registry via PR:",
      "  1. Fork vellum-ai/vellum-assistant.",
      '  2. Add the entry below under `plugins/registry.json` → "plugins".',
      '  3. If the plugin lives in its own repo, also add its repo to "sources".',
      "  4. Open a PR. A Cue maintainer reviews the manifest + license and merges,",
      "     which pins the plugin to the reviewed commit for everyone.",
    ],
  };
}
