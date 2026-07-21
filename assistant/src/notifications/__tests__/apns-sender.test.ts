/**
 * Tests for the APNs sender's JWT minting and config resolution.
 *
 * Focus: the ES256 provider-token shape Apple requires (base64url
 * header.payload.signature with `kid`/`iss` claims and an IEEE P1363
 * signature) and graceful degradation to "not configured" when the env
 * vars are absent. No network involved.
 */

import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";

import {
  buildApnsPayload,
  createApnsJwt,
  isApnsConfigured,
  resolveApnsConfig,
} from "../apns-sender.js";

const APNS_ENV_VARS = [
  "CUE_APNS_KEY_P8",
  "CUE_APNS_KEY_PATH",
  "CUE_APNS_KEY_ID",
  "CUE_APNS_TEAM_ID",
  "CUE_APNS_BUNDLE_ID",
  "CUE_APNS_ENV",
] as const;

const savedEnv = new Map<string, string | undefined>(
  APNS_ENV_VARS.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function clearApnsEnv(): void {
  for (const name of APNS_ENV_VARS) delete process.env[name];
}

function makeKeyPair() {
  return generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
}

describe("createApnsJwt", () => {
  test("produces an ES256 JWT with kid header and iss/iat claims", () => {
    const { privateKey, publicKey } = makeKeyPair();
    const nowMs = 1_750_000_000_000;

    const jwt = createApnsJwt(
      { keyPem: privateKey, keyId: "ABC123DEFG", teamId: "XU8BLQACGU" },
      nowMs,
    );

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [headerB64, payloadB64, signatureB64] = parts;

    expect(decodeSegment(headerB64!)).toEqual({
      alg: "ES256",
      kid: "ABC123DEFG",
    });
    expect(decodeSegment(payloadB64!)).toEqual({
      iss: "XU8BLQACGU",
      iat: Math.floor(nowMs / 1000),
    });

    // ES256 signatures must be raw IEEE P1363 (r||s), 64 bytes for P-256.
    const signature = Buffer.from(signatureB64!, "base64url");
    expect(signature).toHaveLength(64);
    const valid = verify(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
    expect(valid).toBe(true);
  });
});

describe("buildApnsPayload", () => {
  test("spreads custom data at the payload root — the iOS router's userInfo contract", () => {
    // CueNotificationRouter.deepLinkURL reads userInfo["path"] (and the
    // other custom keys) directly off the payload root, next to `aps`.
    const payload = buildApnsPayload({
      title: "Your morning brief is ready",
      body: "3 finished overnight",
      threadId: "cue-morning-brief",
      data: {
        kind: "morning_brief",
        path: "/assistant/brief",
        dateKey: "2026-07-20",
      },
    });

    expect(payload["path"]).toBe("/assistant/brief");
    expect(payload["kind"]).toBe("morning_brief");
    expect(payload["dateKey"]).toBe("2026-07-20");
    expect(payload["aps"]).toEqual({
      alert: {
        title: "Your morning brief is ready",
        body: "3 finished overnight",
      },
      sound: "default",
      "thread-id": "cue-morning-brief",
    });
    // Custom keys are NOT nested under a container the router doesn't read.
    expect(payload["data"]).toBeUndefined();
  });

  test("no data and no threadId yields a bare aps envelope", () => {
    const payload = buildApnsPayload({ title: "T", body: "B" });
    expect(Object.keys(payload)).toEqual(["aps"]);
    expect(payload["aps"]).toEqual({
      alert: { title: "T", body: "B" },
      sound: "default",
    });
  });
});

describe("resolveApnsConfig", () => {
  test("is null (sender disabled) when no APNs env vars are set", () => {
    clearApnsEnv();
    expect(resolveApnsConfig()).toBeNull();
    expect(isApnsConfigured()).toBe(false);
  });

  test("resolves inline key material with defaults applied", () => {
    clearApnsEnv();
    const { privateKey } = makeKeyPair();
    // Simulate a single-line env UI where newlines arrive as literal "\n".
    process.env.CUE_APNS_KEY_P8 = privateKey.replaceAll("\n", "\\n");
    process.env.CUE_APNS_KEY_ID = "ABC123DEFG";
    process.env.CUE_APNS_TEAM_ID = "XU8BLQACGU";

    const config = resolveApnsConfig();
    expect(config).not.toBeNull();
    expect(config!.keyPem).toBe(privateKey);
    expect(config!.bundleId).toBe("com.ventureverse.cue");
    expect(config!.env).toBe("production");

    // The normalized key must actually be usable for signing.
    expect(() => createApnsJwt(config!)).not.toThrow();
  });

  test("is null when the key is present but kid/team are missing", () => {
    clearApnsEnv();
    const { privateKey } = makeKeyPair();
    process.env.CUE_APNS_KEY_P8 = privateKey;
    expect(resolveApnsConfig()).toBeNull();
  });

  test("honors sandbox env selection", () => {
    clearApnsEnv();
    const { privateKey } = makeKeyPair();
    process.env.CUE_APNS_KEY_P8 = privateKey;
    process.env.CUE_APNS_KEY_ID = "ABC123DEFG";
    process.env.CUE_APNS_TEAM_ID = "XU8BLQACGU";
    process.env.CUE_APNS_ENV = "sandbox";
    expect(resolveApnsConfig()!.env).toBe("sandbox");
  });
});
