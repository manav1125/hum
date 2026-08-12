import { describe, expect, it } from "bun:test";

import {
  buildLinkInterceptorScript,
  buildStoragePolyfill,
  injectBridge,
  injectScript,
  isRelayableExternalHref,
  jsonForScript,
  preparePreviewHtml,
  prependScript,
} from "@/utils/sandbox-bridge";

const FRAME_ID = "test-frame";

describe("jsonForScript", () => {
  it("escapes </script> to prevent script-context breakout", () => {
    const out = jsonForScript("</script><script>alert(1)</script>");
    expect(out).not.toContain("</script>");
    expect(out).toContain("<\\/script>");
  });

  it("escapes <!-- to prevent HTML comment injection", () => {
    const out = jsonForScript("<!--<script>alert(1)</script>");
    expect(out).not.toContain("<!--");
    expect(out).toContain("<\\!--");
  });
});

describe("buildStoragePolyfill", () => {
  it("produces a script tag with localStorage and sessionStorage shims", () => {
    const out = buildStoragePolyfill();
    expect(out).toContain("<script>");
    expect(out).toContain("</script>");
    expect(out).toContain("localStorage");
    expect(out).toContain("sessionStorage");
    expect(out).toContain("storageShim");
  });
});

describe("injectScript", () => {
  it("injects before the last </body>", () => {
    const html = "<html><body><div>hi</div></body></html>";
    const script = "<script>x</script>";
    const out = injectScript(html, script);
    const bodyClose = out.lastIndexOf("</body>");
    const scriptIdx = out.indexOf("<script>x</script>");
    expect(scriptIdx).toBeGreaterThan(0);
    expect(scriptIdx).toBeLessThan(bodyClose);
  });

  it("uses lastIndexOf so literal </body> in a script doesn't hijack", () => {
    const html = [
      "<html><body>",
      "<script>",
      "// inject before </body>, so wait for it",
      "console.log('app');",
      "</script>",
      "</body></html>",
    ].join("\n");
    const script = "<script>bridge</script>";
    const out = injectScript(html, script);

    const realBodyClose = out.lastIndexOf("</body>");
    const bridgeIdx = out.indexOf("<script>bridge</script>");
    const hostScriptStart = out.indexOf("<script>");

    expect(bridgeIdx).toBeGreaterThan(hostScriptStart);
    expect(bridgeIdx).toBeLessThan(realBodyClose);
    expect(out.indexOf("console.log('app');")).toBeLessThan(
      out.indexOf("</script>"),
    );
  });

  it("falls back to after </head> when no </body>", () => {
    const html = "<html><head></head>no body";
    const script = "<script>x</script>";
    const out = injectScript(html, script);
    const headClose = out.indexOf("</head>");
    const scriptIdx = out.indexOf("<script>x</script>");
    expect(scriptIdx).toBeGreaterThan(headClose);
  });

  it("prepends when neither tag exists", () => {
    const html = "just a fragment";
    const script = "<script>x</script>";
    const out = injectScript(html, script);
    expect(out.startsWith("<script>x</script>")).toBe(true);
    expect(out.endsWith("just a fragment")).toBe(true);
  });
});

describe("prependScript", () => {
  it("injects right after <head>", () => {
    const html =
      '<html><head><meta charset="utf-8"></head><body></body></html>';
    const script = "<script>early</script>";
    const out = prependScript(html, script);
    const headOpen = out.indexOf("<head>");
    const scriptIdx = out.indexOf("<script>early</script>");
    expect(scriptIdx).toBe(headOpen + "<head>".length);
  });

  it("falls back to after <html> when no <head>", () => {
    const html = "<html><body></body></html>";
    const script = "<script>early</script>";
    const out = prependScript(html, script);
    const htmlOpen = out.indexOf("<html>");
    const scriptIdx = out.indexOf("<script>early</script>");
    expect(scriptIdx).toBe(htmlOpen + "<html>".length);
  });

  it("prepends when neither <head> nor <html> exists", () => {
    const html = "just a fragment";
    const script = "<script>early</script>";
    const out = prependScript(html, script);
    expect(out.startsWith("<script>early</script>")).toBe(true);
    expect(out.endsWith("just a fragment")).toBe(true);
  });

  it("handles <head> with attributes", () => {
    const html = '<html><head lang="en"><meta></head><body></body></html>';
    const script = "<script>early</script>";
    const out = prependScript(html, script);
    const headEnd = out.indexOf('lang="en">') + 'lang="en">'.length;
    const scriptIdx = out.indexOf("<script>early</script>");
    expect(scriptIdx).toBe(headEnd);
  });
});

describe("injectBridge", () => {
  it("prepends polyfill in <head> and appends bridge logic before </body>", () => {
    const html =
      "<!doctype html><html><head></head><body><div>hi</div></body></html>";
    const out = injectBridge(html, FRAME_ID);
    expect(out).toContain("<div>hi</div>");
    expect(out).toContain("window.vellum");
    expect(out).toContain("storageShim");

    const headOpen = out.indexOf("<head>");
    const headClose = out.indexOf("</head>");
    const bodyClose = out.lastIndexOf("</body>");

    const polyfillIdx = out.indexOf("storageShim");
    const bridgeIdx = out.indexOf("window.vellum");

    expect(polyfillIdx).toBeGreaterThan(headOpen);
    expect(polyfillIdx).toBeLessThan(headClose);
    expect(bridgeIdx).toBeLessThan(bodyClose);
    expect(bridgeIdx).toBeGreaterThan(headClose);
  });

  it("falls back to prepending when no <head> or </body>", () => {
    const html = "just some fragment";
    const out = injectBridge(html, FRAME_ID);
    expect(out).toContain("storageShim");
    expect(out).toContain("window.vellum");
    expect(out.endsWith("just some fragment")).toBe(true);
  });

  it("does not hijack the inject site when a script contains a literal </body>", () => {
    const html = [
      "<!doctype html><html><head></head><body>",
      "<div id=root></div>",
      "<script>",
      "// the platform injects right before </body>, so wait for it",
      "console.log('app loaded');",
      "</script>",
      "</body></html>",
    ].join("\n");

    const out = injectBridge(html, FRAME_ID);

    const realBodyClose = out.lastIndexOf("</body>");
    const vellumIdx = out.indexOf("window.vellum");
    expect(vellumIdx).toBeLessThan(realBodyClose);

    const appCode = out.indexOf("console.log('app loaded');");
    expect(appCode).toBeGreaterThan(0);
    expect(out).toContain("console.log('app loaded');");
  });

  it("serializes the route into the bridge payload", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID, { route: "deep/link" });
    expect(out).toContain('"deep/link"');
  });

  it("escapes </script> and <!-- in route to prevent script-context escapes", () => {
    const html = "<html><body></body></html>";
    const malicious = "</script><script>alert(1)</script>";
    const out = injectBridge(html, FRAME_ID, { route: malicious });
    expect(out).not.toContain('"</script>');
    expect(out).toContain("<\\/script>");
  });

  it("embeds frameId (not appId or surfaceId) in message payloads", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, "my-frame-123", { fetch: true });
    expect(out).toContain("frameId:");
    expect(out).not.toContain("appId:");
    expect(out).not.toContain("surfaceId:");
  });

  it("includes fetch proxy when fetch option is true", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID, { fetch: true });
    expect(out).toContain("vellum_fetch_request");
    expect(out).toContain("vellum_fetch_response");
    expect(out).toContain("window.vellum.fetch");
  });

  it("omits fetch proxy by default", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID);
    expect(out).not.toContain("vellum_fetch_request");
    expect(out).not.toContain("window.vellum.fetch");
  });

  it("omits the link interceptor by default", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID);
    expect(out).not.toContain("vellum_open_link");
    expect(out).not.toContain("window.open(rawHref");
  });

  it("includes the relaying interceptor for links: 'relay'", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID, { links: "relay" });
    expect(out).toContain("vellum_open_link");
    expect(out).not.toContain("window.open(rawHref");
  });

  it("includes the direct-open interceptor for links: 'open'", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID, { links: "open" });
    expect(out).toContain("window.open(rawHref");
    expect(out).not.toContain("vellum_open_link");
  });
});

describe("isRelayableExternalHref", () => {
  it("accepts the schemes a link can legitimately carry", () => {
    expect(isRelayableExternalHref("https://example.com/docs")).toBe(true);
    expect(isRelayableExternalHref("http://example.com")).toBe(true);
    expect(isRelayableExternalHref("mailto:user@example.com")).toBe(true);
    expect(isRelayableExternalHref("tel:+15550100")).toBe(true);
    expect(isRelayableExternalHref("  https://example.com  ")).toBe(true);
    expect(isRelayableExternalHref("HTTPS://example.com")).toBe(true);
  });

  it("refuses schemes that execute or smuggle content", () => {
    // The relaying frame controls this string outright, so the host cannot
    // trust the in-frame scheme check that routed the message here.
    expect(isRelayableExternalHref("javascript:alert(1)")).toBe(false);
    expect(isRelayableExternalHref("data:text/html,<script>x</script>")).toBe(
      false,
    );
    expect(isRelayableExternalHref("blob:https://example.com/abc")).toBe(false);
    expect(isRelayableExternalHref("file:///etc/passwd")).toBe(false);
    expect(isRelayableExternalHref("vellum://host/app")).toBe(false);
    expect(isRelayableExternalHref("/relative/path")).toBe(false);
    expect(isRelayableExternalHref("")).toBe(false);
    expect(isRelayableExternalHref(undefined)).toBe(false);
    expect(isRelayableExternalHref(42)).toBe(false);
  });
});

describe("buildLinkInterceptorScript", () => {
  it("produces a script tag with a click interceptor", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out.startsWith("<script>")).toBe(true);
    expect(out.trimEnd().endsWith("</script>")).toBe(true);
    expect(out).toContain("addEventListener('click'");
    expect(out).toContain("preventDefault");
  });

  it("opens directly with noopener,noreferrer when not relaying", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("window.open(rawHref");
    expect(out).toContain("noopener,noreferrer");
  });

  it("relays external links to the parent when asked", () => {
    const out = buildLinkInterceptorScript(FRAME_ID, { relayExternal: true });
    expect(out).not.toContain("window.open(rawHref");
    expect(out).toContain("vellum_open_link");
    expect(out).toContain(JSON.stringify(FRAME_ID));
  });

  it("only intercepts external URL schemes", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("https?");
    expect(out).toContain("mailto");
    expect(out).toContain("tel");
  });

  it("matches anchors in both the HTML and SVG namespaces", () => {
    // `tagName` is upper-cased for HTML but case-preserving for SVG, where an
    // anchor reports 'a'. Widgets are frequently SVG diagrams, so an exact
    // 'A' comparison leaves every link drawn inside the artwork dead.
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("toUpperCase() === 'A'");
    expect(out).not.toContain("el.tagName === 'A'");
  });

  it("detects the scheme on the raw href attribute, not the resolved URL", () => {
    // In srcdoc documents `el.href` resolves fragment/relative links against
    // the embedding page URL, producing absolute http(s) URLs that would
    // wrongly match the external-scheme test.
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("getAttribute('href')");
  });
});

describe("preparePreviewHtml", () => {
  it("prepends polyfill and styles right after <head>", () => {
    const html =
      "<html><head><meta></head><body><div>hello</div></body></html>";
    const out = preparePreviewHtml(html);
    expect(out).toContain("storageShim");
    expect(out).toContain("overflow:hidden");
    expect(out).toContain("scrollbar-width:none");
    expect(out).toContain("<div>hello</div>");

    const headOpen = out.indexOf("<head>");
    const polyfillIdx = out.indexOf("storageShim");
    const metaIdx = out.indexOf("<meta>");
    expect(polyfillIdx).toBeGreaterThan(headOpen);
    expect(polyfillIdx).toBeLessThan(metaIdx);
  });

  it("handles fragments without head/body tags", () => {
    const html = "<div>content</div>";
    const out = preparePreviewHtml(html);
    expect(out).toContain("storageShim");
    expect(out).toContain("overflow:hidden");
    expect(out).toContain("<div>content</div>");
    expect(out.indexOf("storageShim")).toBeLessThan(
      out.indexOf("<div>content</div>"),
    );
  });
});
