/**
 * Credential references in the environment of an unattended child process.
 *
 * A scheduled job or a stdio MCP server runs with no human present, so the
 * interactive paths for reaching a secret are unavailable to it: the request
 * proxy is bound to a tool call, and `assistant credentials reveal` blocks on
 * an approval that nobody is there to give — it does not fail, it hangs. The
 * only remaining option was to paste the secret into config as plaintext.
 *
 * So a config value may instead name a credential:
 *
 *   ATLAS_BRIDGE_SECRET = ${credential:atlas_bridge/secret}
 *
 * and the daemon substitutes the value at spawn time, straight into the
 * child's environment. The reference — not the secret — is what lives in
 * config, in the schedule row, and in every log line.
 *
 * Three properties this must hold, in order of how badly each fails:
 *
 * 1. **The secret never appears anywhere but the child's env.** No error
 *    message, log line, or thrown value carries it. Errors name the
 *    *reference*.
 * 2. **The credential's own tool policy still decides.** Injection reuses
 *    `isToolAllowed`, the same fail-closed check the bash and browser paths
 *    use, against a consumer identity like `mcp:atlas`. Naming a credential
 *    in config does not grant access to it; the credential must name the
 *    consumer back.
 * 3. **A reference that cannot be resolved is an error, not an empty
 *    string.** Substituting "" would start the child with an unset secret and
 *    surface as a puzzling 401 from whatever it talks to, hours later and far
 *    from the cause.
 */

import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { resolveCredentialRef } from "./resolve.js";
import { isToolAllowed } from "./tool-policy.js";

const log = getLogger("credential-env-references");

/**
 * `${credential:<ref>}` where `<ref>` is anything `resolveCredentialRef`
 * accepts — a `service/field` pair or an opaque credential id.
 *
 * Built fresh per call rather than shared. A `/g` regex carries `lastIndex`
 * between uses, and `String.prototype.matchAll` *copies* it — so one
 * `.test()` leaves a shared pattern pointing past the end of the next
 * string, and extraction quietly returns nothing. That failure looks exactly
 * like "this value has no references": the reference would be passed through
 * to the child verbatim, as literal `${credential:...}` text.
 */
function credentialRefPattern(): RegExp {
  return /\$\{credential:([^}]*)\}/g;
}

/** Thrown when a reference cannot be resolved into a usable value. */
export class CredentialReferenceError extends Error {
  readonly reference: string;
  constructor(reference: string, message: string) {
    super(message);
    this.name = "CredentialReferenceError";
    this.reference = reference;
  }
}

/** True when `value` contains at least one credential reference. */
export function hasCredentialReference(value: string): boolean {
  return credentialRefPattern().test(value);
}

/** Every distinct reference in `value`, in order of first appearance. */
export function extractCredentialReferences(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(credentialRefPattern())) {
    const ref = (match[1] ?? "").trim();
    if (!found.includes(ref)) found.push(ref);
  }
  return found;
}

/**
 * Resolve one reference to its secret.
 *
 * @param consumer Identity of the process the value is being injected into,
 *   e.g. `mcp:atlas` or `schedule:<id>`. Checked against the credential's
 *   `allowedTools`, which is fail-closed when empty.
 * @throws CredentialReferenceError naming the reference, never the value.
 */
async function resolveOne(ref: string, consumer: string): Promise<string> {
  if (ref === "") {
    throw new CredentialReferenceError(
      ref,
      "empty credential reference — expected ${credential:service/field}",
    );
  }

  const resolved = resolveCredentialRef(ref);
  if (!resolved) {
    throw new CredentialReferenceError(
      ref,
      `no credential matches "${ref}" — store it first, then reference it`,
    );
  }

  const allowed = resolved.metadata.allowedTools ?? [];
  if (!isToolAllowed(consumer, allowed)) {
    throw new CredentialReferenceError(
      ref,
      allowed.length === 0
        ? `credential ${resolved.service}/${resolved.field} has no allowed tools, so it cannot be injected into ${consumer}`
        : `credential ${resolved.service}/${resolved.field} allows [${allowed.join(", ")}] but not ${consumer}`,
    );
  }

  const value = await getSecureKeyAsync(
    credentialKey(resolved.service, resolved.field),
  );
  // An empty stored value is treated as absent on purpose: it is far more
  // likely to be a credential whose value was never written than a secret
  // that is genuinely the empty string.
  if (value == null || value === "") {
    throw new CredentialReferenceError(
      ref,
      `credential ${resolved.service}/${resolved.field} exists but has no stored value`,
    );
  }

  return value;
}

/**
 * Substitute every credential reference in an env map.
 *
 * Values without a reference are passed through untouched, so an env block
 * that names no credential costs nothing and cannot fail.
 *
 * @throws CredentialReferenceError on the first reference that cannot be
 *   resolved. Failing the spawn is deliberate — see the file header.
 */
export async function resolveCredentialReferencesInEnv(
  env: Record<string, string> | undefined,
  consumer: string,
): Promise<Record<string, string>> {
  if (!env) return {};

  const out: Record<string, string> = {};
  const cache = new Map<string, string>();
  let injected = 0;

  for (const [key, raw] of Object.entries(env)) {
    const refs = extractCredentialReferences(raw);
    if (refs.length === 0) {
      out[key] = raw;
      continue;
    }

    let value = raw;
    for (const ref of refs) {
      let secret = cache.get(ref);
      if (secret === undefined) {
        secret = await resolveOne(ref, consumer);
        cache.set(ref, secret);
      }
      value = value.split(`\${credential:${ref}}`).join(secret);
    }
    out[key] = value;
    injected += 1;
  }

  if (injected > 0) {
    // Names only. The count and the variable names are the useful part of
    // this line; the values are the thing that must never reach a log.
    log.info(
      {
        consumer,
        variables: Object.keys(env).filter(
          (k) => k in out && hasCredentialReference(env[k]!),
        ),
      },
      "Injected credential references into child environment",
    );
  }

  return out;
}
