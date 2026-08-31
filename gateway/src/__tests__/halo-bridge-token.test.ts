/**
 * The one credential that is pasted into somebody else's application.
 *
 * The Halo bridge token trades rotation for survival, so the properties that
 * buy that safety back are the ones worth pinning: it is the owner's own
 * authority and nothing more, there is only ever one of them outstanding, and
 * revoking it must not sign the owner out of anything else.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

interface TokenRow {
  tokenHash: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  status: string;
  expiresAt: number;
}

let rows: TokenRow[] = [];
/** Captured (guardianPrincipalId, hashedDeviceId) pairs from revocations. */
let revocations: Array<{ hashedDeviceId: string }> = [];

/**
 * A gateway DB just real enough for this: inserts land in `rows`, and an
 * update flips every row matching the last-seen device to revoked. Drizzle's
 * builder is stubbed rather than run, so the assertions are about which rows
 * the code decided to touch.
 */
mock.module("../db/connection.js", () => ({
  getGatewayDb: () => ({
    insert: () => ({
      values: (v: TokenRow) => ({
        run: () => {
          rows.push(v);
        },
      }),
    }),
    update: () => ({
      set: (patch: { status?: string }) => ({
        where: () => ({
          run: () => {
            // The device being revoked is whichever one was last hashed; the
            // caller only ever revokes one binding per call.
            const target = revocations.at(-1)?.hashedDeviceId;
            for (const row of rows) {
              if (row.hashedDeviceId === target && patch.status) {
                row.status = patch.status;
              }
            }
          },
        }),
      }),
    }),
  }),
  initGatewayDb: async () => {},
}));

const {
  hashToken,
  HALO_BRIDGE_DEVICE_ID,
  HALO_BRIDGE_TTL_SECONDS,
  issueHaloBridgeToken,
  revokeHaloBridgeTokens,
} = await import("../auth/guardian-bootstrap.js");
const { initSigningKey } = await import("../auth/token-service.js");

initSigningKey(Buffer.alloc(32, 7));

const GUARDIAN = "vellum-principal-test";
const HALO_DEVICE_HASH = hashToken(HALO_BRIDGE_DEVICE_ID);

/** Record which binding each revocation targeted, for the stub above. */
function issue(ttlSeconds?: number) {
  revocations.push({ hashedDeviceId: HALO_DEVICE_HASH });
  return issueHaloBridgeToken({ guardianPrincipalId: GUARDIAN, ttlSeconds });
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
}

beforeEach(() => {
  rows = [];
  revocations = [];
});

describe("issueHaloBridgeToken", () => {
  test("carries the owner's own authority and nothing more", () => {
    const { token } = issue();
    const claims = claimsOf(token);
    // Not a new privilege class — the same profile the owner's own clients use.
    expect(claims.scope_profile).toBe("actor_client_v1");
    expect(claims.sub).toContain(`:${GUARDIAN}`);
    expect(String(claims.sub).startsWith("actor:")).toBe(true);
  });

  test("lasts a year by default, because the app cannot refresh it", () => {
    const { token, expiresAt } = issue();
    const claims = claimsOf(token) as { exp: number; iat: number };
    expect(claims.exp - claims.iat).toBe(HALO_BRIDGE_TTL_SECONDS);
    expect(expiresAt).toBeGreaterThan(Date.now() + 300 * 24 * 3600 * 1000);
  });

  test("a shorter life can be asked for", () => {
    const claims = claimsOf(issue(7 * 24 * 3600).token) as {
      exp: number;
      iat: number;
    };
    expect(claims.exp - claims.iat).toBe(604_800);
  });

  test("only its hash is recorded — the token is never stored readably", () => {
    const { token } = issue();
    const record = rows.at(-1)!;
    expect(record.tokenHash).not.toContain(token);
    expect(record.tokenHash).toBe(hashToken(token));
    expect(record.platform).toBe("halo-bridge");
  });

  test("issuing again revokes the one already pasted into the app", () => {
    // One slot, not a collection: two live year-long credentials for the same
    // purpose is exactly the state you cannot audit.
    const first = issue();
    issue();

    const firstRecord = rows.find(
      (r) => r.tokenHash === hashToken(first.token),
    )!;
    expect(firstRecord.status).toBe("revoked");
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
  });
});

describe("revokeHaloBridgeTokens", () => {
  test("kills the bridge", () => {
    issue();
    revocations.push({ hashedDeviceId: HALO_DEVICE_HASH });
    revokeHaloBridgeTokens(GUARDIAN);
    expect(rows.every((r) => r.status === "revoked")).toBe(true);
  });

  test("does not touch the owner's other devices", () => {
    // Pulling the Halo bridge must never sign somebody out of their phone.
    rows.push({
      tokenHash: "phone-hash",
      guardianPrincipalId: GUARDIAN,
      hashedDeviceId: hashToken("iphone-abc"),
      platform: "ios",
      status: "active",
      expiresAt: Date.now() + 1000,
    });
    issue();
    revocations.push({ hashedDeviceId: HALO_DEVICE_HASH });
    revokeHaloBridgeTokens(GUARDIAN);

    expect(rows.find((r) => r.tokenHash === "phone-hash")!.status).toBe(
      "active",
    );
  });
});
