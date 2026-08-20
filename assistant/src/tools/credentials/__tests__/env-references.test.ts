/**
 * Credential references in an unattended child's environment.
 *
 * The properties under test are the security ones: a secret reaches the
 * child's env and nothing else, the credential's own tool policy still
 * decides, and an unresolvable reference fails the spawn rather than
 * silently becoming an empty string.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const CONSUMER = "mcp:atlas";
const SECRET = "s3cr3t-value-do-not-log";

// --- seams -----------------------------------------------------------------
// Spread the real modules and override only what we drive (never an
// exhaustive factory — it would delete the other exports process-wide).

interface FakeCredential {
  service: string;
  field: string;
  allowedTools: string[];
}

let credentials: Record<string, FakeCredential> = {};
let secrets: Record<string, string> = {};

const actualResolve = await import("../resolve.js");
mock.module("../resolve.js", () => ({
  ...actualResolve,
  resolveCredentialRef: (ref: string) => {
    const c = credentials[ref];
    if (!c) return undefined;
    return {
      credentialId: `id-${ref}`,
      service: c.service,
      field: c.field,
      storageKey: `${c.service}:${c.field}`,
      injectionTemplates: [],
      metadata: {
        credentialId: `id-${ref}`,
        service: c.service,
        field: c.field,
        allowedTools: c.allowedTools,
        allowedDomains: [],
        createdAt: 0,
        updatedAt: 0,
      },
    };
  },
}));

const actualSecureKeys = await import("../../../security/secure-keys.js");
mock.module("../../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async (key: string) => secrets[key] ?? null,
}));

const actualCredentialKey = await import("../../../security/credential-key.js");
mock.module("../../../security/credential-key.js", () => ({
  ...actualCredentialKey,
  credentialKey: (service: string, field: string) => `${service}:${field}`,
}));

const {
  CredentialReferenceError,
  extractCredentialReferences,
  hasCredentialReference,
  resolveCredentialReferencesInEnv,
} = await import("../env-references.js");

// --- fixtures --------------------------------------------------------------

beforeEach(() => {
  credentials = {
    "atlas_bridge/secret": {
      service: "atlas_bridge",
      field: "secret",
      allowedTools: [CONSUMER],
    },
  };
  secrets = { "atlas_bridge:secret": SECRET };
});

afterEach(() => {
  credentials = {};
  secrets = {};
});

// --- tests -----------------------------------------------------------------

describe("reference detection", () => {
  test("finds a reference and ignores plain values", () => {
    expect(hasCredentialReference("${credential:a/b}")).toBe(true);
    expect(hasCredentialReference("https://example.com")).toBe(false);
  });

  test("is not confused by a shell-style variable", () => {
    expect(hasCredentialReference("$HOME/bin")).toBe(false);
    expect(hasCredentialReference("${PATH}")).toBe(false);
  });

  test("extracts each distinct reference once, in order", () => {
    expect(
      extractCredentialReferences(
        "${credential:a/b} ${credential:c/d} ${credential:a/b}",
      ),
    ).toEqual(["a/b", "c/d"]);
  });
});

describe("resolution", () => {
  test("substitutes the secret into the child env", async () => {
    const env = await resolveCredentialReferencesInEnv(
      { ATLAS_BRIDGE_SECRET: "${credential:atlas_bridge/secret}" },
      CONSUMER,
    );
    expect(env.ATLAS_BRIDGE_SECRET).toBe(SECRET);
  });

  test("substitutes inside a larger string", async () => {
    const env = await resolveCredentialReferencesInEnv(
      { AUTH: "Bearer ${credential:atlas_bridge/secret}" },
      CONSUMER,
    );
    expect(env.AUTH).toBe(`Bearer ${SECRET}`);
  });

  test("passes non-reference values through untouched", async () => {
    const env = await resolveCredentialReferencesInEnv(
      { ATLAS_BASE_URL: "https://atlas.example.com", EMPTY: "" },
      CONSUMER,
    );
    expect(env.ATLAS_BASE_URL).toBe("https://atlas.example.com");
    expect(env.EMPTY).toBe("");
  });

  test("resolves a repeated reference without re-reading the store", async () => {
    let reads = 0;
    secrets = new Proxy(
      { "atlas_bridge:secret": SECRET },
      {
        get(t, k: string) {
          reads += 1;
          return (t as Record<string, string>)[k];
        },
      },
    ) as Record<string, string>;

    const env = await resolveCredentialReferencesInEnv(
      {
        A: "${credential:atlas_bridge/secret}",
        B: "${credential:atlas_bridge/secret}",
      },
      CONSUMER,
    );
    expect(env.A).toBe(SECRET);
    expect(env.B).toBe(SECRET);
    expect(reads).toBe(1);
  });

  test("an undefined env is an empty env, not a crash", async () => {
    expect(await resolveCredentialReferencesInEnv(undefined, CONSUMER)).toEqual(
      {},
    );
  });
});

describe("tool policy still decides", () => {
  test("denies a credential that does not name this consumer", async () => {
    credentials["atlas_bridge/secret"]!.allowedTools = ["bash"];
    const promise = resolveCredentialReferencesInEnv(
      { ATLAS_BRIDGE_SECRET: "${credential:atlas_bridge/secret}" },
      CONSUMER,
    );
    await expect(promise).rejects.toThrow(/allows \[bash\] but not mcp:atlas/);
  });

  test("denies a credential with no allowed tools (fail-closed)", async () => {
    // Naming a credential in config must not grant access to it.
    credentials["atlas_bridge/secret"]!.allowedTools = [];
    const promise = resolveCredentialReferencesInEnv(
      { ATLAS_BRIDGE_SECRET: "${credential:atlas_bridge/secret}" },
      CONSUMER,
    );
    await expect(promise).rejects.toThrow(/has no allowed tools/);
  });
});

describe("unresolvable references fail the spawn", () => {
  test("a credential that does not exist", async () => {
    const promise = resolveCredentialReferencesInEnv(
      { X: "${credential:nope/missing}" },
      CONSUMER,
    );
    await expect(promise).rejects.toThrow(
      /no credential matches "nope\/missing"/,
    );
  });

  test("metadata present but no stored value", async () => {
    // Exactly the state Levi's vault was left in: the record lists the
    // credential by name with nothing behind it.
    secrets = {};
    const promise = resolveCredentialReferencesInEnv(
      { X: "${credential:atlas_bridge/secret}" },
      CONSUMER,
    );
    await expect(promise).rejects.toThrow(/exists but has no stored value/);
  });

  test("an empty stored value counts as absent", async () => {
    secrets = { "atlas_bridge:secret": "" };
    const promise = resolveCredentialReferencesInEnv(
      { X: "${credential:atlas_bridge/secret}" },
      CONSUMER,
    );
    await expect(promise).rejects.toThrow(/no stored value/);
  });

  test("an empty reference is rejected", async () => {
    const promise = resolveCredentialReferencesInEnv(
      { X: "${credential:}" },
      CONSUMER,
    );
    await expect(promise).rejects.toThrow(/empty credential reference/);
  });

  test("never substitutes an empty string for a failed lookup", async () => {
    secrets = {};
    let result: Record<string, string> | null = null;
    try {
      result = await resolveCredentialReferencesInEnv(
        { X: "${credential:atlas_bridge/secret}" },
        CONSUMER,
      );
    } catch {
      /* expected */
    }
    // The child must not start with the variable silently unset.
    expect(result).toBeNull();
  });
});

describe("the secret does not leak", () => {
  test("the error names the reference, never the value", async () => {
    credentials["atlas_bridge/secret"]!.allowedTools = ["bash"];
    let err: unknown;
    try {
      await resolveCredentialReferencesInEnv(
        { ATLAS_BRIDGE_SECRET: "${credential:atlas_bridge/secret}" },
        CONSUMER,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialReferenceError);
    const serialized = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
    expect(serialized).not.toContain(SECRET);
    expect(
      (err as InstanceType<typeof CredentialReferenceError>).reference,
    ).toBe("atlas_bridge/secret");
  });
});
