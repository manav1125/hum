/**
 * `assistant memory ingest` subcommand.
 *
 * Batch-ingests fully-formed concept pages (frontmatter + body markdown)
 * straight into memory/concepts/ via the daemon's `memory_ingest` route,
 * bypassing the consolidation buffer. Input comes from a staging directory
 * of .md files (--dir), a JSON manifest file (--file), or piped stdin.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Command } from "commander";

import { cliIpcCall, exitCodeFromIpcResult } from "../../../ipc/cli-client.js";
import type { MemoryIngestResult } from "../../../runtime/routes/memory-ingest-routes.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";

/**
 * IPC timeout for `ingest`. A batch validates and writes up to 200 pages
 * under the consolidation lock and enqueues reindex follow-up jobs, which
 * can outlast `cliIpcCall`'s default 60s on large batches, so allow a
 * generous 5-minute ceiling per batch rather than report a spurious
 * "Request timed out" while the assistant keeps working.
 */
const INGEST_IPC_TIMEOUT_MS = 5 * 60 * 1000;

interface IngestPage {
  slug: string;
  content: string;
}

/** Recursively collect .md files under `dir`; slug = relative path minus `.md`. */
function walkMarkdownFiles(root: string, dir: string, out: IngestPage[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(root, full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const rel = relative(root, full);
      const slug = rel.slice(0, -".md".length).split(sep).join("/");
      out.push({ slug, content: readFileSync(full, "utf-8") });
    }
  }
}

/** Validate a parsed JSON manifest into pages, with per-index error messages. */
function validateManifest(raw: unknown): IngestPage[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      "Manifest must be a JSON array of { slug, content } objects.",
    );
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `Manifest item [${i}] must be an object with string 'slug' and 'content' fields.`,
      );
    }
    const { slug, content } = item as Record<string, unknown>;
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error(
        `Manifest item [${i}].slug is required and must be a non-empty string.`,
      );
    }
    if (typeof content !== "string") {
      throw new Error(
        `Manifest item [${i}].content is required and must be a string (the full page markdown).`,
      );
    }
    return { slug, content };
  });
}

/** Assemble the page list from --dir, --file, or piped stdin. */
function loadPages(opts: { dir?: string; file?: string }): IngestPage[] {
  if (opts.dir !== undefined && opts.file !== undefined) {
    throw new Error(
      "Pass either --dir or --file, not both. Drop one of the two input flags.",
    );
  }
  if (opts.dir !== undefined) {
    let stats;
    try {
      stats = statSync(opts.dir);
    } catch {
      throw new Error(`Directory not found: ${opts.dir}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${opts.dir}`);
    }
    const pages: IngestPage[] = [];
    walkMarkdownFiles(opts.dir, opts.dir, pages);
    pages.sort((a, b) => a.slug.localeCompare(b.slug));
    return pages;
  }
  let raw: string;
  if (opts.file !== undefined) {
    if (!existsSync(opts.file)) {
      throw new Error(`File not found: ${opts.file}`);
    }
    raw = readFileSync(opts.file, "utf-8");
  } else {
    if (process.stdin.isTTY) {
      throw new Error(
        "No input provided. Pipe JSON into stdin or use --file <path> or --dir <path>.",
      );
    }
    raw = readFileSync("/dev/stdin", "utf-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON manifest: ${msg}`);
  }
  return validateManifest(parsed);
}

/**
 * Reject duplicate slugs across the whole input before chunking. The route's
 * duplicate check is per request, so duplicates that land in different
 * 200-page batches would bypass it: without --overwrite the later copy is
 * misreported as an existing-page skip, and with --overwrite it silently
 * replaces the earlier one.
 */
function assertUniqueSlugs(pages: IngestPage[]): IngestPage[] {
  const firstIndexBySlug = new Map<string, number>();
  const duplicates: string[] = [];
  for (const [index, page] of pages.entries()) {
    const first = firstIndexBySlug.get(page.slug);
    if (first === undefined) {
      firstIndexBySlug.set(page.slug, index);
    } else {
      duplicates.push(
        `"${page.slug}" (entries ${String(first)} and ${String(index)})`,
      );
    }
  }
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate slugs in input: ${duplicates.join(", ")}. ` +
        "Each slug may appear once per ingest.",
    );
  }
  return pages;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export function registerMemoryIngestCommand(program: Command): void {
  // Reuse an existing `memory` parent if some other registrar attached to it
  // first; otherwise create one. This keeps the registration order between
  // sibling memory registrars unconstrained.
  const memory =
    program.commands.find((c) => c.name() === "memory") ??
    program.command("memory").description("Manage the memory subsystem");

  registerCommand(memory, {
    name: "ingest",
    transport: "ipc",
    description:
      "Batch-ingest staged concept pages directly into memory (bypasses the consolidation buffer)",
    build: (ingest) => {
      ingest
        .option(
          "--dir <path>",
          "Directory of staged .md pages; slug = relative path minus .md, with forward slashes",
        )
        .option(
          "--file <path>",
          "JSON manifest file: an array of { slug, content } objects",
        )
        .option("--dry-run", "Validate and report without writing any pages")
        .option(
          "--overwrite",
          "Rewrite pages whose slug already exists (default: skip them)",
        )
        .option("--json", "Machine-readable compact JSON summary output")
        .addHelpText(
          "after",
          `
Input sources (pick exactly one):
  --dir   Walks the directory recursively for .md files. Each file's slug is
          its relative path minus the .md extension, with forward slashes
          (people/alice.md becomes people/alice).
  --file  Reads a JSON manifest: an array of { slug, content } objects where
          content is the full page markdown (frontmatter + body).
  stdin   With neither flag, the same JSON manifest is read from stdin when
          it is piped (not a TTY).

Behavior:
  Writes fully-formed concept pages straight into memory/concepts/, bypassing
  the consolidation buffer. Pages whose slug already exists are skipped unless
  --overwrite is passed. Every page is validated and reported individually;
  invalid pages set a non-zero exit code without blocking valid ones. Requests
  are sent in batches of 200 pages. When the consolidation lock is held the
  command fails and names the holder; retry after the current writer finishes.
  Requires concept-page memory (memory.v2.enabled).

Examples:
  $ assistant memory ingest --dir imports/fathom/.staging --dry-run
  $ assistant memory ingest --dir imports/fathom/.staging --overwrite
  $ cat pages.json | assistant memory ingest --json`,
        )
        .action(
          async (opts: {
            dir?: string;
            file?: string;
            dryRun?: boolean;
            overwrite?: boolean;
            json?: boolean;
          }) => {
            // Batch cap shared with the daemon route: the route rejects
            // requests above this many pages, so the CLI chunks its input to
            // match. Loaded lazily so the CLI module keeps daemon internals
            // out of its static import graph.
            const { MAX_INGEST_PAGES_PER_CALL } =
              await import("../../../runtime/routes/memory-ingest-routes.js");

            let pages: IngestPage[];
            try {
              pages = assertUniqueSlugs(loadPages(opts));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (opts.json === true) {
                log.info(JSON.stringify({ ok: false, error: msg }));
              } else {
                log.error(`Error: ${msg}`);
              }
              process.exitCode = 1;
              return;
            }

            const aggregate: MemoryIngestResult = {
              results: [],
              written: 0,
              skipped: 0,
              invalid: 0,
              dryRun: opts.dryRun === true,
            };

            if (pages.length === 0) {
              if (opts.json === true) {
                log.info(JSON.stringify(aggregate));
              } else {
                log.info("No pages to ingest.");
              }
              return;
            }
            for (const batch of chunk(pages, MAX_INGEST_PAGES_PER_CALL)) {
              const r = await cliIpcCall<MemoryIngestResult>(
                "memory_ingest",
                {
                  body: {
                    pages: batch,
                    ...(opts.dryRun === true ? { dryRun: true } : {}),
                    ...(opts.overwrite === true ? { overwrite: true } : {}),
                  },
                },
                { timeoutMs: INGEST_IPC_TIMEOUT_MS },
              );
              if (!r.ok) {
                // A batch failed mid-run (e.g. 409 lock conflict, daemon
                // down). `partial` covers fully completed batches only and is
                // therefore a lower bound: the daemon commits pages one by
                // one, so the failing batch itself may have written pages
                // this aggregate cannot see.
                const message = r.error ?? "Unknown error";
                const verb = aggregate.dryRun ? "would write" : "wrote";
                if (opts.json === true) {
                  log.info(
                    JSON.stringify({
                      ok: false,
                      error: message,
                      partial: aggregate,
                    }),
                  );
                } else {
                  log.error(`Error: ${message}`);
                  log.error(
                    `Partial results from completed batches (the failing batch is ` +
                      `indeterminate): ${verb} ${aggregate.written} page(s); ` +
                      `skipped ${aggregate.skipped} existing; ${aggregate.invalid} invalid.`,
                  );
                }
                process.exitCode = exitCodeFromIpcResult(r);
                return;
              }
              const payload = r.result!;
              aggregate.results.push(...payload.results);
              aggregate.written += payload.written;
              aggregate.skipped += payload.skipped;
              aggregate.invalid += payload.invalid;
            }

            if (opts.json === true) {
              log.info(JSON.stringify(aggregate));
            } else {
              const verb = aggregate.dryRun ? "Would write" : "Wrote";
              log.info(
                `${verb} ${aggregate.written} page(s); skipped ${aggregate.skipped} existing; ${aggregate.invalid} invalid.`,
              );
              for (const res of aggregate.results) {
                for (const warning of res.warnings) {
                  log.warn(`  ${res.slug}: ${warning}`);
                }
                if (res.action === "invalid") {
                  log.error(
                    `  invalid ${res.slug}: ${res.error ?? "unknown error"}`,
                  );
                }
              }
              if (aggregate.skipped > 0 && opts.overwrite !== true) {
                log.info(
                  "Re-run with --overwrite to rewrite pages whose slug already exists.",
                );
              }
            }
            if (aggregate.invalid > 0) {
              process.exitCode = 1;
            }
          },
        );
    },
  });
}
