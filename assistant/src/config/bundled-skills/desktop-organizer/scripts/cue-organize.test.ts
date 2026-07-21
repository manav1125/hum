/**
 * Regression tests for the desktop-organizer MOVE-NEVER-DELETE engine.
 *
 * Exercises the real `cue-organize.sh` against a scratch tree: plan is
 * read-only, apply moves + records a manifest, the protected-path denylist is
 * honored, and cue-undo.sh is an exact round-trip.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

const SCRIPT = path.join(import.meta.dir, "cue-organize.sh");

let base: string;
let root: string;

function run(args: string[]): string {
  return execFileSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "org-test-"));
  root = path.join(base, "root");
  mkdirSync(root, { recursive: true });
  // Movable
  writeFileSync(path.join(root, "report.pdf"), "x");
  writeFileSync(path.join(root, "photo.JPG"), "x");
  writeFileSync(path.join(root, "Screenshot 2026-07-21.png"), "x");
  writeFileSync(path.join(root, "notes with spaces.md"), "x");
  writeFileSync(path.join(root, "archive.zip"), "x");
  writeFileSync(path.join(root, "mystery.xyz"), "x");
  mkdirSync(path.join(root, "My Folder"));
  writeFileSync(path.join(root, "My Folder", "inner.txt"), "deep");
  // Protected
  writeFileSync(path.join(root, ".hidden"), "x");
  mkdirSync(path.join(root, "Some.app"));
  writeFileSync(path.join(root, "Some.app", "exe"), "x");
  symlinkSync(path.join(root, "report.pdf"), path.join(root, "link.pdf"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test("plan is read-only and lists only movable items in categories", () => {
  const out = run(["plan", "--root", root]);
  const rows = out.split("\n").filter((l) => l && !l.startsWith("#"));
  const cats = new Map(rows.map((r) => r.split("\t")).map(([c, n]) => [n, c]));
  expect(cats.get("report.pdf")).toBe("Documents");
  expect(cats.get("photo.JPG")).toBe("Images");
  expect(cats.get("Screenshot 2026-07-21.png")).toBe("Screenshots");
  expect(cats.get("My Folder")).toBe("Folders");
  expect(cats.get("archive.zip")).toBe("Archives");
  expect(cats.get("mystery.xyz")).toBe("Other");
  // Protected items never appear
  expect(cats.has(".hidden")).toBe(false);
  expect(cats.has("Some.app")).toBe(false);
  expect(cats.has("link.pdf")).toBe(false);
  // Nothing moved
  expect(existsSync(path.join(root, "report.pdf"))).toBe(true);
  expect(existsSync(path.join(root, "Cue Archive"))).toBe(false);
});

test("apply moves movable items, leaves protected items, and never deletes", () => {
  run(["apply", "--root", root]);
  const archive = path.join(root, "Cue Archive");
  // Movable moved
  expect(existsSync(path.join(root, "report.pdf"))).toBe(false);
  expect(readdirSync(archive).length).toBeGreaterThan(0);
  const dated = path.join(archive, readdirSync(archive)[0]);
  expect(existsSync(path.join(dated, "Documents", "report.pdf"))).toBe(true);
  expect(
    existsSync(path.join(dated, "Folders", "My Folder", "inner.txt")),
  ).toBe(true);
  // Protected untouched
  expect(existsSync(path.join(root, ".hidden"))).toBe(true);
  expect(existsSync(path.join(root, "Some.app", "exe"))).toBe(true);
  // The symlink file itself is left in place (dangling now that its target
  // moved — proof it was skipped, not followed-and-moved).
  expect(lstatSync(path.join(root, "link.pdf")).isSymbolicLink()).toBe(true);
  // Manifest records every move
  const manifest = readFileSync(path.join(dated, "moves.tsv"), "utf8");
  const moves = manifest.split("\n").filter((l) => l && !l.startsWith("#"));
  expect(moves.length).toBe(7);
});

test("SKILL.md embeds the exact canonical script (no drift)", () => {
  const scriptBody = readFileSync(SCRIPT, "utf8").replace(/\n$/, "");
  const skillMd = readFileSync(
    path.join(import.meta.dir, "..", "SKILL.md"),
    "utf8",
  );
  // The whole script must appear verbatim inside SKILL.md's staging heredoc so
  // the agent reproduces the tested engine exactly, byte-for-byte.
  expect(skillMd).toContain(scriptBody);
});

test("cue-undo.sh is an exact round-trip", () => {
  run(["apply", "--root", root]);
  const dated = path.join(
    root,
    "Cue Archive",
    readdirSync(path.join(root, "Cue Archive"))[0],
  );
  execFileSync("bash", [path.join(dated, "cue-undo.sh")], { encoding: "utf8" });
  // Originals restored to exact locations
  expect(existsSync(path.join(root, "report.pdf"))).toBe(true);
  expect(existsSync(path.join(root, "photo.JPG"))).toBe(true);
  expect(readFileSync(path.join(root, "My Folder", "inner.txt"), "utf8")).toBe(
    "deep",
  );
  // Archive category dirs emptied of moved content
  expect(existsSync(path.join(dated, "Documents", "report.pdf"))).toBe(false);
});
