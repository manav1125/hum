/**
 * Every filesystem path Qdrant is given must be absolute.
 *
 * Qdrant resolves an unset path against its own cwd. Left to itself the
 * snapshots directory defaults to the RELATIVE `./snapshots` — which worked
 * only because the daemon happened to run as root in a root-owned directory.
 * Rehearsing the privilege drop as uid 1001 turned that into
 *
 *     Failed to remove snapshots temp directory at ./snapshots/tmp:
 *     Os { code: 13, kind: PermissionDenied }
 *
 * Qdrant then exited, and because the daemon must never block startup on a
 * subsystem failure it carried on serving 200s with memory silently dead.
 * `/healthz` never noticed.
 *
 * These assertions are about that being unrepeatable: a relative path reaching
 * Qdrant is the defect, whatever new path option gets added later.
 */

import { isAbsolute, join } from "node:path";
import { describe, expect, test } from "bun:test";

import { buildQdrantSpawnOptions } from "../qdrant-manager.js";

const STORAGE = "/var/lib/cue/data/qdrant";

function options() {
  return buildQdrantSpawnOptions({
    host: "127.0.0.1",
    port: 6333,
    storagePath: STORAGE,
  });
}

describe("qdrant spawn paths", () => {
  test("the snapshots path is set, and set absolutely", () => {
    const { env } = options();

    // Unset is the actual defect: Qdrant then uses relative "./snapshots".
    expect(env.QDRANT__STORAGE__SNAPSHOTS_PATH).toBeDefined();
    expect(
      `absolute:${isAbsolute(env.QDRANT__STORAGE__SNAPSHOTS_PATH ?? "")}`,
    ).toBe("absolute:true");
  });

  test("snapshots live under the storage directory the entrypoint chowns", () => {
    // Absolute but elsewhere would reintroduce the same permission failure at
    // a different path.
    const { env } = options();

    expect(env.QDRANT__STORAGE__SNAPSHOTS_PATH).toBe(
      join(STORAGE, "snapshots"),
    );
  });

  test("no QDRANT path option is left relative", () => {
    // Deliberately not a fixed list — a future QDRANT__…__PATH added without an
    // absolute value fails here rather than in production as a silent outage.
    const { env } = options();

    const relative = Object.entries(env)
      .filter(([key]) => key.startsWith("QDRANT__") && key.endsWith("_PATH"))
      .filter(([, value]) => !isAbsolute(value))
      .map(([key]) => key);

    expect(relative).toEqual([]);
  });

  test("every path option carries a value at all", () => {
    const { env } = options();
    const pathKeys = Object.keys(env).filter(
      (key) => key.startsWith("QDRANT__") && key.endsWith("_PATH"),
    );

    // Two today (storage, snapshots). The count is not asserted — the point is
    // that none is blank, which reads as "unset" to Qdrant.
    expect(pathKeys.length).toBeGreaterThan(1);
    expect(pathKeys.filter((key) => env[key]?.trim() === "")).toEqual([]);
  });

  test("the child's cwd is a directory it will be able to write to", () => {
    // The belt to the braces: any cwd-relative path not enumerated above lands
    // under storage rather than in the root-owned /app/assistant.
    expect(options().cwd).toBe(STORAGE);
  });

  test("storage and snapshots are not the same directory", () => {
    // Qdrant manages collections under storage; pointing snapshots at the same
    // path invites it to walk its own snapshot output.
    const { env } = options();

    expect(env.QDRANT__STORAGE__SNAPSHOTS_PATH).not.toBe(
      env.QDRANT__STORAGE__STORAGE_PATH,
    );
  });
});
