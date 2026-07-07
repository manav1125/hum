/**
 * Minimal GitHub API client for marketplace indexing.
 *
 * - Unauthenticated by default; `skills.marketplace.githubToken` (or
 *   `CUE_GITHUB_TOKEN` / `GITHUB_TOKEN` in the daemon env) raises rate
 *   limits when configured. The token is used ONLY for direct HTTPS calls
 *   from the daemon process — it is never added to SAFE_ENV_VARS or child
 *   process env.
 * - Tree fetches are ETag-conditional: callers persist the etag next to
 *   their cache and pass it back; a 304 costs no rate-limit budget.
 * - File contents come from raw.githubusercontent.com (not rate-limited
 *   like the REST API).
 */

import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("marketplace-github");

const API_BASE = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const FETCH_TIMEOUT_MS = 20_000;

function githubToken(): string | undefined {
  try {
    const configured = getConfig().skills.marketplace.githubToken;
    if (configured) return configured;
  } catch {
    // config not loaded (e.g. narrow unit tests) — fall through to env
  }
  return process.env.CUE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? undefined;
}

function apiHeaders(etag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cue-marketplace",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-None-Match"] = etag;
  return headers;
}

export interface RepoInfo {
  defaultBranch: string;
  htmlUrl: string;
  licenseSpdxId?: string;
  description?: string;
}

/** GET /repos/{owner}/{repo} — default branch + license. */
export async function fetchRepoInfo(address: string): Promise<RepoInfo> {
  const response = await fetch(`${API_BASE}/repos/${address}`, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub repo lookup failed for ${address}: HTTP ${response.status}`,
    );
  }
  const data = (await response.json()) as {
    default_branch?: string;
    html_url?: string;
    description?: string;
    license?: { spdx_id?: string | null } | null;
  };
  const spdx = data.license?.spdx_id;
  return {
    defaultBranch: data.default_branch ?? "main",
    htmlUrl: data.html_url ?? `https://github.com/${address}`,
    ...(spdx && spdx !== "NOASSERTION" ? { licenseSpdxId: spdx } : {}),
    ...(data.description ? { description: data.description } : {}),
  };
}

export interface TreeEntry {
  /** Repo-relative path. */
  path: string;
  /** "blob" | "tree". */
  type: string;
  /** Git blob sha (sha1). */
  sha: string;
  size?: number;
}

export type TreeFetchResult =
  | { notModified: true }
  | {
      notModified: false;
      entries: TreeEntry[];
      etag?: string;
      treeSha?: string;
      truncated: boolean;
    };

/**
 * GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1 with conditional
 * request support. Returns `{ notModified: true }` on a 304.
 */
export async function fetchRepoTree(
  address: string,
  ref: string,
  etag?: string,
): Promise<TreeFetchResult> {
  const url = `${API_BASE}/repos/${address}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const response = await fetch(url, {
    headers: apiHeaders(etag),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 304) return { notModified: true };
  if (!response.ok) {
    throw new Error(
      `GitHub tree fetch failed for ${address}@${ref}: HTTP ${response.status}`,
    );
  }

  const data = (await response.json()) as {
    sha?: string;
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
  };
  const entries: TreeEntry[] = (data.tree ?? [])
    .filter(
      (e): e is { path: string; type: string; sha: string; size?: number } =>
        typeof e.path === "string" &&
        typeof e.type === "string" &&
        typeof e.sha === "string",
    )
    .map((e) => ({
      path: e.path,
      type: e.type,
      sha: e.sha,
      ...(typeof e.size === "number" ? { size: e.size } : {}),
    }));

  const responseEtag = response.headers.get("etag") ?? undefined;
  if (data.truncated) {
    log.warn({ address, ref }, "GitHub tree response was truncated");
  }
  return {
    notModified: false,
    entries,
    ...(responseEtag ? { etag: responseEtag } : {}),
    ...(data.sha ? { treeSha: data.sha } : {}),
    truncated: data.truncated === true,
  };
}

/** Fetch a raw file's text content from raw.githubusercontent.com. */
export async function fetchRawFile(
  address: string,
  ref: string,
  path: string,
): Promise<string> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${RAW_BASE}/${address}/${encodeURIComponent(ref)}/${encodedPath}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "cue-marketplace" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Raw file fetch failed for ${address}@${ref}:${path}: HTTP ${response.status}`,
    );
  }
  return response.text();
}

/** Run `fn` over `inputs` with bounded concurrency, preserving order. */
export async function mapWithConcurrency<T, R>(
  inputs: T[],
  limit: number,
  fn: (input: T) => Promise<R>,
): Promise<Array<R | Error>> {
  const results: Array<R | Error> = new Array(inputs.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, inputs.length) },
    async () => {
      while (next < inputs.length) {
        const index = next++;
        try {
          results[index] = await fn(inputs[index]);
        } catch (err) {
          results[index] = err instanceof Error ? err : new Error(String(err));
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}
