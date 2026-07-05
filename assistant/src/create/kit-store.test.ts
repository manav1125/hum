/**
 * Tests for the Kit store (kit-store.ts): create (kit + one pending asset per
 * format), the kit ⇄ assets join, per-asset run-state patches, the
 * assistant-scoped list, and cascade delete.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  createKit,
  deleteKit,
  getKit,
  getKitAsset,
  getKitWithAssets,
  listKitAssets,
  listKits,
  updateKitAsset,
} from "./kit-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM kit_assets");
  getDb().run("DELETE FROM kits");
});

const A = "assistant-a";
const B = "assistant-b";

const FORMATS = [
  { format: "slides", mode: "slides" },
  { format: "one_pager", mode: "docs" },
  { format: "social", mode: "image" },
];

describe("kit creation", () => {
  test("create returns the kit with one pending asset per format", () => {
    const kit = createKit(A, {
      brief: "Launch the Series A",
      brandKitId: "brand-1",
      contractPreamble: "DESIGN CONTRACT — …",
      title: "Series A launch kit",
      formats: FORMATS,
    });

    expect(kit.id).toBeTruthy();
    expect(kit.assistantId).toBe(A);
    expect(kit.brief).toBe("Launch the Series A");
    expect(kit.brandKitId).toBe("brand-1");
    expect(kit.contractPreamble).toBe("DESIGN CONTRACT — …");
    expect(kit.title).toBe("Series A launch kit");

    expect(kit.assets).toHaveLength(3);
    expect(kit.assets.map((a) => a.format)).toEqual([
      "slides",
      "one_pager",
      "social",
    ]);
    expect(kit.assets.map((a) => a.mode)).toEqual(["slides", "docs", "image"]);
    for (const asset of kit.assets) {
      expect(asset.kitId).toBe(kit.id);
      expect(asset.status).toBe("pending");
      expect(asset.conversationId).toBeNull();
      expect(asset.outputRef).toBeNull();
      expect(asset.error).toBeNull();
    }
  });

  test("optional fields default to null and persist through a fresh read", () => {
    const kit = createKit(A, {
      brief: "Minimal",
      formats: [{ format: "social", mode: "image" }],
    });
    expect(kit.brandKitId).toBeNull();
    expect(kit.contractPreamble).toBeNull();
    expect(kit.title).toBeNull();

    const fetched = getKit(kit.id);
    expect(fetched).toBeDefined();
    expect(fetched!.brief).toBe("Minimal");
    expect(fetched!.brandKitId).toBeNull();
  });
});

describe("kit ⇄ assets join + reads", () => {
  test("getKitWithAssets returns the kit and its assets in creation order", () => {
    const created = createKit(A, { brief: "b", formats: FORMATS });
    const joined = getKitWithAssets(created.id);
    expect(joined).toBeDefined();
    expect(joined!.assets.map((a) => a.format)).toEqual([
      "slides",
      "one_pager",
      "social",
    ]);
  });

  test("getKitWithAssets is undefined for a missing kit", () => {
    expect(getKitWithAssets("nope")).toBeUndefined();
  });

  test("listKitAssets returns only the kit's assets", () => {
    const k1 = createKit(A, { brief: "one", formats: FORMATS });
    const k2 = createKit(A, {
      brief: "two",
      formats: [{ format: "email", mode: "docs" }],
    });
    expect(listKitAssets(k1.id)).toHaveLength(3);
    expect(listKitAssets(k2.id)).toHaveLength(1);
    expect(listKitAssets(k2.id)[0].format).toBe("email");
  });

  test("list is assistant-scoped, newest first", () => {
    const first = createKit(A, { brief: "first", formats: FORMATS });
    const second = createKit(A, { brief: "second", formats: FORMATS });
    createKit(B, { brief: "other", formats: FORMATS });

    const forA = listKits(A);
    expect(forA.map((k) => k.id)).toEqual([second.id, first.id]);
    expect(listKits(B).map((k) => k.brief)).toEqual(["other"]);
  });
});

describe("asset run-state patches", () => {
  test("updateKitAsset patches only provided fields and bumps updatedAt", () => {
    const kit = createKit(A, { brief: "b", formats: FORMATS });
    const target = kit.assets[0];

    const running = updateKitAsset(target.id, {
      conversationId: "conv-1",
      status: "running",
    });
    expect(running!.status).toBe("running");
    expect(running!.conversationId).toBe("conv-1");
    expect(running!.outputRef).toBeNull();
    expect(running!.updatedAt).toBeGreaterThanOrEqual(target.createdAt);

    const done = updateKitAsset(target.id, {
      status: "done",
      outputRef: "att-9",
    });
    expect(done!.status).toBe("done");
    expect(done!.outputRef).toBe("att-9");
    // The earlier conversationId survives the partial patch.
    expect(done!.conversationId).toBe("conv-1");
  });

  test("updateKitAsset records a failure message", () => {
    const kit = createKit(A, { brief: "b", formats: FORMATS });
    const failed = updateKitAsset(kit.assets[1].id, {
      status: "failed",
      error: "model timed out",
    });
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toBe("model timed out");
  });

  test("getKitAsset fetches a single asset by id", () => {
    const kit = createKit(A, { brief: "b", formats: FORMATS });
    const fetched = getKitAsset(kit.assets[2].id);
    expect(fetched?.format).toBe("social");
    expect(getKitAsset("missing")).toBeUndefined();
  });

  test("an unknown status value normalizes to pending on read", () => {
    const kit = createKit(A, { brief: "b", formats: FORMATS });
    getSqliteFrom(getDb())
      .prepare("UPDATE kit_assets SET status = 'garbage' WHERE id = ?")
      .run(kit.assets[0].id);
    expect(getKitAsset(kit.assets[0].id)!.status).toBe("pending");
  });
});

describe("delete", () => {
  test("deleteKit removes the kit and cascades its assets", () => {
    const kit = createKit(A, { brief: "b", formats: FORMATS });
    deleteKit(kit.id);
    expect(getKit(kit.id)).toBeUndefined();
    expect(listKitAssets(kit.id)).toHaveLength(0);
  });
});
