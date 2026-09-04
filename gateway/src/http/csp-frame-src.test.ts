import { describe, expect, it } from "bun:test";

import { injectDesignFrameSrc } from "./csp-frame-src.js";

/** The shell's real meta CSP (apps/web/index.html), kept in step here. */
const SHELL = `<!DOCTYPE html>
<html><head>
  <meta http-equiv="Content-Security-Policy"
        content="frame-src 'self' https://www.ventureverse.com https://*.ventureverse.com https://*.justcue.app" />
</head><body></body></html>`;

function frameSrc(html: string): string {
  const content = /content="([^"]*)"/.exec(html)?.[1] ?? "";
  return /frame-src([^;"]*)/.exec(content)?.[1].trim() ?? "";
}

describe("injectDesignFrameSrc", () => {
  it("is a no-op when DESIGN_HOST is unset", () => {
    expect(injectDesignFrameSrc(SHELL, undefined)).toBe(SHELL);
    expect(injectDesignFrameSrc(SHELL, "")).toBe(SHELL);
    expect(injectDesignFrameSrc(SHELL, "   ")).toBe(SHELL);
  });

  it("is a no-op when the host is already covered by the *.justcue.app wildcard", () => {
    // Manav's own instance — must not change the served HTML.
    expect(injectDesignFrameSrc(SHELL, "design.manav.justcue.app")).toBe(SHELL);
    expect(injectDesignFrameSrc(SHELL, "design.justcue.app")).toBe(SHELL);
  });

  it("injects a custom-domain design host not covered by the wildcard", () => {
    const out = injectDesignFrameSrc(SHELL, "design.customer.com");
    expect(out).not.toBe(SHELL);
    expect(frameSrc(out)).toBe(
      "'self' https://www.ventureverse.com https://*.ventureverse.com https://*.justcue.app https://design.customer.com",
    );
  });

  it("normalizes host casing and surrounding whitespace", () => {
    const out = injectDesignFrameSrc(SHELL, "  Design.Customer.COM  ");
    expect(frameSrc(out)).toContain("https://design.customer.com");
    expect(frameSrc(out)).not.toContain("Design.Customer.COM");
  });

  it("only touches frame-src, leaving other directives in the content intact", () => {
    const extra = "; default-src 'self'";
    const withMore = SHELL.replace(
      'https://*.justcue.app"',
      `https://*.justcue.app${extra}"`,
    );
    const out = injectDesignFrameSrc(withMore, "design.customer.com");
    // The added frame-src host lands before the `;` boundary; default-src is untouched.
    expect(out).toContain("https://design.customer.com; default-src 'self'");
  });

  it("is idempotent — a second pass adds nothing (host now covered exactly)", () => {
    const once = injectDesignFrameSrc(SHELL, "design.customer.com");
    const twice = injectDesignFrameSrc(once, "design.customer.com");
    expect(twice).toBe(once);
  });

  it("bare apex justcue.app is not covered by *.justcue.app and gets injected", () => {
    const out = injectDesignFrameSrc(SHELL, "justcue.app");
    expect(frameSrc(out)).toContain("https://justcue.app");
  });

  it("returns the HTML unchanged when there is no meta CSP", () => {
    const noCsp = "<!DOCTYPE html><html><head></head><body></body></html>";
    expect(injectDesignFrameSrc(noCsp, "design.customer.com")).toBe(noCsp);
  });
});
