/**
 * Tests for the Brand Kit store (brand-profile-store.ts): CRUD, JSON
 * (de)serialization round-trips, and the single-active-per-assistant invariant
 * enforced by setActiveBrandProfile.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  createBrandProfile,
  deleteBrandProfile,
  getActiveBrandProfile,
  getBrandProfile,
  listBrandProfiles,
  setActiveBrandProfile,
  updateBrandProfile,
} from "./brand-profile-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM brand_profiles");
});

const A = "assistant-a";
const B = "assistant-b";

describe("brand profile CRUD", () => {
  test("create returns a fully-parsed profile and persists JSON columns", () => {
    const created = createBrandProfile(A, {
      name: "Acme",
      palette: { primary: "#ff0000", accent: "#00ff00" },
      fonts: { heading: "Inter", body: "Georgia" },
      logo: { light: "ref://light", mark: "ref://mark" },
      voice: {
        tone: "bold",
        doList: ["be direct"],
        dontList: ["hedge"],
        boilerplate: "We make things.",
      },
      assets: ["ref://a1", "ref://a2"],
      source: "upload",
    });

    expect(created.id).toBeTruthy();
    expect(created.assistantId).toBe(A);
    expect(created.name).toBe("Acme");
    expect(created.palette.primary).toBe("#ff0000");
    expect(created.fonts.heading).toBe("Inter");
    expect(created.logo.mark).toBe("ref://mark");
    expect(created.voice.doList).toEqual(["be direct"]);
    expect(created.assets).toEqual(["ref://a1", "ref://a2"]);
    expect(created.source).toBe("upload");

    // Round-trip through a fresh read.
    const fetched = getBrandProfile(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.palette.accent).toBe("#00ff00");
    expect(fetched!.voice.boilerplate).toBe("We make things.");
  });

  test("create defaults missing sub-objects to empty and source to guided", () => {
    const created = createBrandProfile(A, { name: "Minimal" });
    expect(created.palette).toEqual({});
    expect(created.fonts).toEqual({});
    expect(created.logo).toEqual({});
    expect(created.voice).toEqual({});
    expect(created.assets).toEqual([]);
    expect(created.source).toBe("guided");
  });

  test("list is assistant-scoped and ordered oldest-first", () => {
    const first = createBrandProfile(A, { name: "First" });
    const second = createBrandProfile(A, { name: "Second" });
    createBrandProfile(B, { name: "Other" });

    const forA = listBrandProfiles(A);
    expect(forA.map((p) => p.name)).toEqual(["First", "Second"]);
    expect(forA.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(listBrandProfiles(B).map((p) => p.name)).toEqual(["Other"]);
  });

  test("update patches only provided fields", () => {
    const created = createBrandProfile(A, {
      name: "Acme",
      palette: { primary: "#111111" },
      fonts: { heading: "Inter" },
    });
    const updated = updateBrandProfile(created.id, {
      name: "Acme Corp",
      palette: { primary: "#222222", accent: "#333333" },
    });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Acme Corp");
    expect(updated!.palette.primary).toBe("#222222");
    expect(updated!.palette.accent).toBe("#333333");
    // Untouched field survives.
    expect(updated!.fonts.heading).toBe("Inter");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.createdAt);
  });

  test("delete removes the row", () => {
    const created = createBrandProfile(A, { name: "Doomed" });
    deleteBrandProfile(created.id);
    expect(getBrandProfile(created.id)).toBeUndefined();
    expect(listBrandProfiles(A)).toHaveLength(0);
  });
});

describe("single-active invariant", () => {
  test("the first profile for an assistant is auto-activated", () => {
    const first = createBrandProfile(A, { name: "First" });
    expect(first.isActive).toBe(1);
    expect(getActiveBrandProfile(A)?.id).toBe(first.id);
  });

  test("subsequent profiles start inactive", () => {
    createBrandProfile(A, { name: "First" });
    const second = createBrandProfile(A, { name: "Second" });
    expect(second.isActive).toBe(0);
  });

  test("setActive flips exactly one row active for the assistant", () => {
    const first = createBrandProfile(A, { name: "First" });
    const second = createBrandProfile(A, { name: "Second" });
    const third = createBrandProfile(A, { name: "Third" });

    const activated = setActiveBrandProfile(second.id);
    expect(activated?.isActive).toBe(1);

    const all = listBrandProfiles(A);
    const active = all.filter((p) => p.isActive === 1);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.id);
    // The previously-auto-active first is now cleared.
    expect(getBrandProfile(first.id)!.isActive).toBe(0);
    expect(getBrandProfile(third.id)!.isActive).toBe(0);
    expect(getActiveBrandProfile(A)?.id).toBe(second.id);
  });

  test("activating in one assistant does not touch another assistant's active kit", () => {
    const aFirst = createBrandProfile(A, { name: "A1" });
    const bFirst = createBrandProfile(B, { name: "B1" });
    const aSecond = createBrandProfile(A, { name: "A2" });

    setActiveBrandProfile(aSecond.id);

    expect(getActiveBrandProfile(A)?.id).toBe(aSecond.id);
    // B's auto-active kit is untouched.
    expect(getBrandProfile(bFirst.id)!.isActive).toBe(1);
    expect(getActiveBrandProfile(B)?.id).toBe(bFirst.id);
    expect(getBrandProfile(aFirst.id)!.isActive).toBe(0);
  });

  test("setActive on a missing id is a no-op returning undefined", () => {
    createBrandProfile(A, { name: "First" });
    expect(setActiveBrandProfile("does-not-exist")).toBeUndefined();
    // Still exactly one active.
    expect(listBrandProfiles(A).filter((p) => p.isActive === 1)).toHaveLength(
      1,
    );
  });
});
