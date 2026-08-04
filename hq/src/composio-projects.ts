/**
 * Cue HQ — per-customer Composio projects.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now every provisioned instance was seeded with the SAME Composio
 * credential (`HQ_COMPOSIO_API_KEY`). That key is scoped to a Composio
 * *project*, and every customer's connected accounts lived inside one
 * shared project — so the key could list and proxy ALL of them. Verified
 * against the live org on 2026-08-03: an unfiltered
 * `GET /api/v3/connected_accounts` under that key returned 176 connected
 * accounts spanning 36 distinct `user_id`s, and the same key can drive
 * `POST /tools/execute/proxy` against any of those `connected_account_id`s
 * — which is what reads real Gmail/Drive/Slack data.
 *
 * The `user_id` we write next to the key is NOT an auth boundary. In
 * Composio it is a partition *label* on a connected account; the project
 * key sees every label. So isolation rested entirely on Cue's own code
 * remembering to attach `user_ids=<own>` to every list call, on a
 * credential that sits readable inside the customer's own container.
 *
 * Composio's actual isolation boundary is the PROJECT. This module drives
 * the org-owner API so HQ can mint one project per customer and seed a key
 * that is structurally incapable of seeing another tenant's accounts —
 * a foreign `connected_account_id` is not merely filtered out, it is
 * invisible and un-proxyable.
 *
 * Endpoints (verified against the live OpenAPI spec at
 * https://backend.composio.dev/api/v3.1/openapi.json on 2026-08-04):
 *   POST   /org/owner/project/new                        → {id, name, api_key}
 *   GET    /org/owner/project/list?limit&cursor          → {data: [{id, name, ...}]}
 *   DELETE /org/owner/project/{nano_id}?revoke_on_delete=true
 *   POST   /org/owner/project/{nano_id}/regenerate_api_key  — 403 on this
 *          org ("regeneration is not enabled"); nothing here depends on it.
 *
 * All four authenticate with `x-org-api-key` (the ORG key) — NOT the
 * project `x-api-key`. That distinction is the whole point: the org key is
 * strictly more powerful than what we seed today and must never leave HQ.
 * It is read from the HQ process env only, and no function here ever
 * returns or logs it.
 *
 * Env contract:
 *   HQ_COMPOSIO_ORG_API_KEY — org-owner key used to mint/rotate/delete
 *                             per-customer projects. Unset ⇒ this module
 *                             is inert and provisioning keeps its legacy
 *                             shared-key behaviour (see provisioning.ts).
 *   HQ_COMPOSIO_API_BASE    — override the API base (tests/staging).
 */

import { randomBytes } from "node:crypto";

const DEFAULT_BASE = "https://backend.composio.dev/api/v3.1";

/**
 * Composio rejects duplicate project names within an org with a 409, so the
 * name carries a random suffix: a provision that died after creating the
 * project must not wedge every future retry for that customer on a name
 * clash it cannot clear. (Rotating the clashing project's key would be the
 * tidier recovery, but regeneration is not available on every org — see
 * regenerateProjectApiKey.) The customer id stays in the name so projects
 * remain greppable in the dashboard; the authoritative link is the
 * projectId persisted in InstanceSecrets.
 */
export function projectNameForCustomer(customerId: string): string {
  return `cue-${customerId}-${randomBytes(3).toString("hex")}`;
}

export function orgApiKey(): string | null {
  return process.env.HQ_COMPOSIO_ORG_API_KEY?.trim() || null;
}

/** True when HQ is able to mint per-customer projects. */
export function composioProjectsConfigured(): boolean {
  return orgApiKey() !== null;
}

function apiBase(): string {
  return process.env.HQ_COMPOSIO_API_BASE?.trim() || DEFAULT_BASE;
}

export interface CustomerProject {
  /** Composio project id (`pr_…`) — persisted so we can rotate/revoke later. */
  projectId: string;
  /** Project-scoped key (`ak_…`) — seeded into the instance, never logged. */
  apiKey: string;
}

export interface ComposioProjectDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Composio's error envelope is `{error: {message, code, slug, status, …}}`.
 * We surface `message` only — never the response body wholesale, since
 * request echoes can carry credential material.
 */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    const message = body?.error?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Non-JSON body (gateway HTML, empty 502) — status alone is the signal.
  }
  return `HTTP ${res.status}`;
}

async function orgApi(
  deps: ComposioProjectDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const key = orgApiKey();
  if (!key) throw new Error("HQ_COMPOSIO_ORG_API_KEY unset");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`${apiBase()}${path}`, {
    method,
    headers: {
      "x-org-api-key": key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    throw new Error(
      `composio ${method} ${path} -> ${res.status}: ${await readError(res)}`,
    );
  }
  return res.json();
}

/**
 * Mint the customer their own Composio project and return a project-scoped
 * key for it.
 *
 * Throws on failure, and the key must be captured from this one response —
 * Composio only returns it at creation time. Callers must fail CLOSED (seed
 * nothing) rather than fall back to a shared key; see seedConnectors() in
 * provisioning.ts.
 */
export async function createCustomerProject(
  customerId: string,
  deps: ComposioProjectDeps = {},
): Promise<CustomerProject> {
  const created = (await orgApi(deps, "POST", "/org/owner/project/new", {
    name: projectNameForCustomer(customerId),
    should_create_api_key: true,
  })) as { id?: string; api_key?: string | null };

  if (!created.id) throw new Error("composio: create returned no project id");
  if (!created.api_key) {
    // A project we hold no key for is useless to us and cannot be recovered
    // on orgs without regeneration. Bin it rather than leaving a stray.
    await deleteCustomerProject(created.id, deps).catch(() => {});
    throw new Error(
      `composio: project ${created.id} created without an api_key ` +
        `(should_create_api_key was ignored) — deleted it and failed closed`,
    );
  }
  return { projectId: created.id, apiKey: created.api_key };
}

/**
 * Rotate a project's key. Composio marks every existing key for the project
 * as deleted, so this is also the revocation primitive for a credential we
 * believe has leaked.
 *
 * NOT AVAILABLE ON EVERY ORG. Verified against the live org on 2026-08-04:
 * this returns `403 API key regeneration is not enabled for this
 * organization`. Nothing in the provisioning path may depend on it. Until
 * Composio enables it, the only way to invalidate a leaked project key is
 * to delete the project and re-create it — which costs that customer their
 * connections, so it is an operator decision, not an automated one.
 */
export async function regenerateProjectApiKey(
  projectId: string,
  deps: ComposioProjectDeps = {},
): Promise<string> {
  const body = (await orgApi(
    deps,
    "POST",
    `/org/owner/project/${encodeURIComponent(projectId)}/regenerate_api_key`,
  )) as { api_key?: { key?: string } };
  const key = body.api_key?.key;
  if (!key) throw new Error("composio: regenerate returned no key");
  return key;
}

/**
 * Delete the customer's project at teardown.
 *
 * `revoke_on_delete=true` additionally kicks off a background job that
 * revokes the UPSTREAM credentials of every connected account in the
 * project — i.e. Cue's Google/Slack refresh tokens for that customer stop
 * working at the provider, not merely inside Composio. That is the
 * behaviour we want when an instance is destroyed: deleting the container
 * should not leave live OAuth grants pointing at a dead tenant.
 */
export async function deleteCustomerProject(
  projectId: string,
  deps: ComposioProjectDeps = {},
): Promise<void> {
  await orgApi(
    deps,
    "DELETE",
    `/org/owner/project/${encodeURIComponent(projectId)}?revoke_on_delete=true`,
  );
}
