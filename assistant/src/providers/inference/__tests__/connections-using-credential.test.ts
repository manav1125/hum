/**
 * Which connections would break if a credential were deleted.
 *
 * The answer has to be exact in both directions. Missing a dependent lets the
 * delete through and inference stops with no error anyone sees —
 * `resolveAuth` returns `credential_not_found`, the connection resolves to
 * null, and routing moves on. Naming a connection that does not depend on it
 * blocks a legitimate delete instead.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../memory/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../memory/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../../memory/migrations/250-provider-connection-base-url-and-models.js";
import { migrateDropProviderConnectionStatus } from "../../../memory/migrations/265-drop-provider-connection-status.js";
import * as schema from "../../../memory/schema.js";
import {
  connectionsUsingCredential,
  createConnection,
} from "../connections.js";

function bootDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(sqlite, { schema });
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateDropProviderConnectionStatus(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

const KEY = "credential/openrouter/api_key";

describe("connectionsUsingCredential", () => {
  test("names an api_key connection that authenticates with it", () => {
    const db = bootDb();
    createConnection(db, {
      name: "openrouter-main",
      provider: "openrouter",
      auth: { type: "api_key", credential: KEY },
    });

    expect(connectionsUsingCredential(db, KEY)).toEqual(["openrouter-main"]);
  });

  test("names every dependent, not just the first", () => {
    const db = bootDb();
    for (const name of ["a", "b"]) {
      createConnection(db, {
        name,
        provider: "openrouter",
        auth: { type: "api_key", credential: KEY },
      });
    }

    expect(connectionsUsingCredential(db, KEY).sort()).toEqual(["a", "b"]);
  });

  test("ignores a connection pointing at a different credential", () => {
    const db = bootDb();
    createConnection(db, {
      name: "other",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });

    expect(connectionsUsingCredential(db, KEY)).toEqual([]);
  });

  // Only api_key auth names a credential. Blocking a delete for a connection
  // that resolves its auth elsewhere would refuse a legitimate one.
  test("ignores auth types that name no credential", () => {
    const db = bootDb();
    createConnection(db, {
      name: "managed",
      provider: "anthropic",
      auth: { type: "platform" },
    });

    expect(connectionsUsingCredential(db, KEY)).toEqual([]);
  });

  test("no connections means nothing blocks the delete", () => {
    expect(connectionsUsingCredential(bootDb(), KEY)).toEqual([]);
  });
});
