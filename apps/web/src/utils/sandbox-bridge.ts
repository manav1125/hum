/**
 * Sandboxed iframe bridge utilities.
 *
 * Provides everything needed to safely render untrusted HTML inside
 * `<iframe sandbox="allow-scripts">` (no `allow-same-origin`):
 *
 * 1. **Storage polyfill** — in-memory shim for `localStorage` / `sessionStorage`,
 *    which throw `SecurityError` in sandboxed contexts without `allow-same-origin`.
 * 2. **Action bridge** — `window.vellum.sendAction()` forwards surface actions to
 *    the parent via `postMessage`.
 * 3. **Fetch proxy** — `window.vellum.fetch()` proxies authenticated requests
 *    through the parent, keeping auth tokens out of the sandbox.
 * 4. **Safe injection** — `injectScript()` inserts `<script>` tags using
 *    `lastIndexOf` to avoid hijacking when app JS contains literal close-tag
 *    sequences.
 *
 * All sandboxed iframes that render untrusted HTML must use these utilities.
 * The storage polyfill is required even for non-interactive preview iframes.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox
 * @see https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path pattern allowed through the fetch proxy (matches desktop ATL-83 restriction). */
export const FETCH_PROXY_PATH_RE = /^\/v1\/x\//;

/**
 * Link schemes a sandboxed frame may ask the host to open on its behalf.
 *
 * One definition for both sides of the relay: the in-frame interceptor
 * interpolates it to decide what to hand over (routing) and
 * {@link isRelayableExternalHref} applies it to what arrives (the security
 * check). Two copies would drift into links the frame relays and the host
 * refuses, or the reverse.
 */
const RELAYABLE_LINK_SCHEME_RE = /^(https?|mailto|tel):/i;

/**
 * Whether a sandboxed frame's link may be opened by the host.
 *
 * The host is the authority on this: a frame that relays `vellum_open_link`
 * controls the `href` string entirely, so the in-frame scheme check is a
 * routing decision and this one is the security check. Anything outside the
 * allowlist (`javascript:`, `data:`, `blob:`, `file:`, custom schemes) is
 * refused.
 */
export function isRelayableExternalHref(href: unknown): href is string {
  return typeof href === "string" && RELAYABLE_LINK_SCHEME_RE.test(href.trim());
}

// ---------------------------------------------------------------------------
// Script serialization
// ---------------------------------------------------------------------------

/**
 * Safely serialize a value for embedding inside an inline `<script>` block.
 *
 * `JSON.stringify` alone doesn't escape `</script>` or `<!--`, which can
 * break out of the script context in `srcdoc`. We replace the two dangerous
 * sequences after stringifying.
 *
 * @see https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\!--");
}

// ---------------------------------------------------------------------------
// Storage polyfill
// ---------------------------------------------------------------------------

/**
 * Build a `<script>` tag that replaces `localStorage` and `sessionStorage`
 * with in-memory shims.
 *
 * Required for every sandboxed iframe without `allow-same-origin`. Without
 * this, any code that accesses `window.localStorage` — including framework
 * initialization in React, Vue, i18next, etc. — throws a `SecurityError`
 * and prevents the app from mounting.
 */
export function buildStoragePolyfill(): string {
  return `<script>
(function() {
  var store = {};
  var storageShim = {
    getItem: function(k) { return store.hasOwnProperty(k) ? store[k] : null; },
    setItem: function(k, v) { store[k] = String(v); },
    removeItem: function(k) { delete store[k]; },
    clear: function() { store = {}; },
    get length() { return Object.keys(store).length; },
    key: function(i) { return Object.keys(store)[i] || null; }
  };
  try {
    Object.defineProperty(window, 'localStorage', { value: storageShim, writable: true, configurable: true });
  } catch(e) { window.localStorage = storageShim; }
  try {
    Object.defineProperty(window, 'sessionStorage', { value: storageShim, writable: true, configurable: true });
  } catch(e) { window.sessionStorage = storageShim; }
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Full bridge script
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  /** Include the authenticated fetch proxy bridge. Default: false. */
  fetch?: boolean;
  /** Deep-link route exposed as `window.vellum.route`. */
  route?: string;
  /**
   * Include the deck navigation bridge (mobile slide decks). Adds:
   *  1. a `vellum_deck_nav` message listener that re-dispatches the given
   *     key (`ArrowLeft` / `ArrowRight`) as a real `keydown` inside the
   *     sandbox — decks built to the SLIDES contract navigate on arrow keys,
   *     and the sandboxed frame (no `allow-same-origin`) can't be reached
   *     any other way from the parent;
   *  2. an in-frame horizontal swipe detector that synthesizes the same
   *     arrow-key events, so swiping the slide itself paginates on touch.
   * Default: false.
   */
  deckNav?: boolean;
  /**
   * Intercept anchor clicks on external-scheme links inside the frame.
   *
   * With the embedder's `frame-src` in force (see `index.html`), a plain
   * anchor click would try to navigate the sandboxed frame itself to the
   * external URL and be refused — the click dies silently. The interceptor
   * catches it and either:
   *
   *  - `"relay"` — posts a `vellum_open_link` message to the host, which
   *    opens the URL after checking its scheme ({@link isRelayableExternalHref})
   *    and requiring a user activation. Required for frames sandboxed
   *    WITHOUT `allow-popups`, where `window.open()` is a silent no-op.
   *  - `"open"` — calls `window.open(..., 'noopener,noreferrer')` directly.
   *    Only meaningful for frames that keep `allow-popups` (the app viewer).
   *    A popup is a top-level navigation that no `frame-src` constrains, so
   *    this mode leaves the frame a direct egress channel — a deliberate
   *    trust-tier split, not an oversight: an installed app is a different
   *    tier from model-authored inline markup.
   *
   * Default: no interception.
   */
  links?: "relay" | "open";
}

/**
 * Build the in-frame link interceptor `<script>`.
 *
 * Anchors with external schemes are intercepted so the click neither
 * navigates the sandboxed frame (refused by the embedder's `frame-src`, so
 * the link would just die) nor leaves through an uncontrolled path. Fragment
 * and relative links are left to the browser: fragment navigation is in-page,
 * and everything else is already refused by the sandbox/frame-src.
 *
 * @param frameId Included in `vellum_open_link` messages so the parent knows
 *   which surface sent the request.
 * @param options.relayExternal Relay external links to the parent as
 *   `vellum_open_link` instead of calling `window.open()`. Required for
 *   frames sandboxed without `allow-popups`, where `window.open()` is a
 *   silent no-op.
 */
export function buildLinkInterceptorScript(
  frameId: string,
  options?: { relayExternal?: boolean },
): string {
  const externalHandler = options?.relayExternal
    ? `window.parent.postMessage({
              type: 'vellum_open_link',
              frameId: ${jsonForScript(frameId)},
              href: rawHref,
              linkText: (el.textContent || '').trim()
            }, '*');`
    : `window.open(rawHref, '_blank', 'noopener,noreferrer');`;

  return `<script>
(function() {
    document.addEventListener('click', function(e) {
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.defaultPrevented) return;
      var el = e.target;
      while (el && el !== document.body) {
        // Compared case-insensitively: \`tagName\` is upper-cased for HTML
        // elements but preserves case for SVG, where an anchor reports 'a'.
        // Widgets are frequently SVG diagrams, so an exact 'A' test leaves
        // every link drawn inside the artwork dead.
        if (el.tagName && String(el.tagName).toUpperCase() === 'A' && el.getAttribute('href')) {
          // Use the raw href attribute for scheme detection. In srcdoc
          // documents el.href resolves fragment/relative links against the
          // embedding page URL, producing absolute http(s) URLs that would
          // wrongly match the external-scheme test below.
          var rawHref = el.getAttribute('href');
          if (${RELAYABLE_LINK_SCHEME_RE.toString()}.test(rawHref)) {
            e.preventDefault();
            ${externalHandler}
            return;
          }
        }
        el = el.parentElement;
      }
    }, true);
})();
</script>`;
}

/**
 * Build the bridge logic script (action sender, fetch proxy, `window.vellum`
 * namespace) WITHOUT the storage polyfill.
 *
 * This is injected at the end of the document via `injectScript`. The
 * storage polyfill is prepended separately via `prependScript` so that it
 * runs before any app code that accesses `localStorage` during parsing.
 */
function buildBridgeLogicScript(
  frameId: string,
  options?: BridgeOptions,
): string {
  const enableFetch = options?.fetch ?? false;
  const enableDeckNav = options?.deckNav ?? false;
  const route = options?.route ?? null;

  const deckNavBridge = enableDeckNav
    ? `
  // Repair the common broken SLIDES pagination pattern (P2, Northwind /
  // VentureVerse decks): the generated JS drives a track with inline
  // width:C*100% + per-slide inline width:(100/C)% and translateX(-i/C*100%),
  // while the generated CSS also declares ".slide { flex: 0 0 100% }". In a
  // flex track, flex-basis beats the inline width — 100% of the 1000%-wide
  // track makes EVERY slide track-sized, so navigation advances the counter
  // but shows empty track. Keyed on the exact signature (inline width on BOTH
  // track and slide) so contract-correct decks are untouched.
  (function() {
    var st = document.createElement('style');
    st.textContent = '.slide-container[style*="width"] > .slide[style*="width"] { flex: 0 0 auto !important; }';
    (document.head || document.documentElement).appendChild(st);
  })();
  // Find the deck's own next/prev control (SLIDES-contract nav chrome or a
  // plain arrow glyph button) so pagination works for click-driven decks too.
  function vellumDeckNavEl(dir) {
    var words = dir === 'next' ? ['next', 'forward'] : ['prev', 'back'];
    var glyphs = dir === 'next' ? ['\\u2192', '\\u203A', '\\u276F', '>'] : ['\\u2190', '\\u2039', '\\u276E', '<'];
    var els = document.querySelectorAll('button, [role="button"], a, .nav *, [data-chrome] *');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var label = ((el.getAttribute('aria-label') || '') + ' ' + (el.className && el.className.baseVal !== undefined ? '' : el.className || '') + ' ' + el.id).toLowerCase();
      for (var w = 0; w < words.length; w++) {
        if (label.indexOf(words[w]) !== -1) return el;
      }
      var text = (el.textContent || '').trim();
      if (text.length <= 2 && glyphs.indexOf(text) !== -1) return el;
    }
    return null;
  }
  function vellumDeckKey(key) {
    // Prefer the deck's own control (deterministic for click-driven decks)…
    var el = vellumDeckNavEl(key === 'ArrowRight' ? 'next' : 'prev');
    if (el) { el.click(); return; }
    // …fall back to a synthetic arrow key (SLIDES-contract keyboard nav).
    // bubbles:true so listeners on document OR window both fire; keyCode
    // shimmed for decks written against the legacy property.
    var ev = new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true });
    var code = key === 'ArrowRight' ? 39 : 37;
    try {
      Object.defineProperty(ev, 'keyCode', { get: function() { return code; } });
      Object.defineProperty(ev, 'which', { get: function() { return code; } });
    } catch (e) { /* read-only in some engines — key-based listeners still fire */ }
    (document.body || document).dispatchEvent(ev);
  }
  window.addEventListener('message', function(event) {
    var d = event.data;
    if (d && d.type === 'vellum_deck_nav' && (d.key === 'ArrowLeft' || d.key === 'ArrowRight')) {
      vellumDeckKey(d.key);
    }
  });
  (function() {
    var startX = 0, startY = 0, tracking = false;
    document.addEventListener('touchstart', function(e) {
      if (e.touches.length !== 1) { tracking = false; return; }
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', function(e) {
      if (!tracking || e.changedTouches.length !== 1) return;
      tracking = false;
      var dx = e.changedTouches[0].clientX - startX;
      var dy = e.changedTouches[0].clientY - startY;
      // Deliberate horizontal swipe: dominant axis + a real distance.
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        vellumDeckKey(dx < 0 ? 'ArrowRight' : 'ArrowLeft');
      }
    }, { passive: true });
  })();`
    : "";

  const fetchBridge = enableFetch
    ? `
  window.vellum._pendingFetches = {};
  window.vellum._fetchNextId = 1;
  window.vellum._resolveFetch = function(callId, status, statusText, body, headers) {
    var p = window.vellum._pendingFetches[callId];
    if (!p) return;
    delete window.vellum._pendingFetches[callId];
    p.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      statusText: statusText,
      headers: headers || {},
      _body: body,
      json: function() { return Promise.resolve(JSON.parse(body)); },
      text: function() { return Promise.resolve(body); }
    });
  };
  window.vellum._rejectFetch = function(callId, errorMessage) {
    var p = window.vellum._pendingFetches[callId];
    if (!p) return;
    delete window.vellum._pendingFetches[callId];
    p.reject(new Error(errorMessage));
  };
  window.addEventListener('message', function(event) {
    var d = event.data;
    if (!d) return;
    if (d.type === 'vellum_fetch_response' && d.callId) {
      if (d.error) {
        window.vellum._rejectFetch(d.callId, d.error);
      } else {
        window.vellum._resolveFetch(d.callId, d.status, d.statusText, d.body, d.headers);
      }
    }
  });
  window.vellum.fetch = function(path, options) {
    options = options || {};
    return new Promise(function(resolve, reject) {
      var callId = 'f' + (window.vellum._fetchNextId++);
      window.vellum._pendingFetches[callId] = { resolve: resolve, reject: reject };
      window.parent.postMessage({
        type: 'vellum_fetch_request',
        frameId: ${jsonForScript(frameId)},
        callId: callId,
        path: path,
        method: (options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
        body: options.body || null
      }, '*');
    });
  };`
    : "";

  return `<script>
(function() {
  window.vellum = {
    route: ${jsonForScript(route)},
    sendAction: function(actionId, data) {
      window.parent.postMessage({
        type: 'vellum_surface_action',
        frameId: ${jsonForScript(frameId)},
        actionId: actionId,
        data: data || {}
      }, '*');
    }
  };${fetchBridge}${deckNavBridge}
})();
</script>`;
}

/**
 * Build the complete bridge script (polyfill + logic) as a single string.
 *
 * Useful for tests that want to inspect the full output. In production,
 * `injectBridge` is preferred because it places the polyfill and bridge
 * logic at separate positions in the HTML.
 */
export function buildBridgeScript(
  frameId: string,
  options?: BridgeOptions,
): string {
  return buildStoragePolyfill() + buildBridgeLogicScript(frameId, options);
}

// ---------------------------------------------------------------------------
// HTML injection
// ---------------------------------------------------------------------------

/**
 * Safely inject a script string into HTML at the end of the document.
 *
 * Insertion priority: before the last `</body>`, then after the last
 * `</head>`, then prepended. Uses `lastIndexOf` so that literal close-tag
 * sequences inside `<script>` blocks (comments, strings) can't hijack the
 * injection site.
 */
export function injectScript(html: string, script: string): string {
  const BODY_CLOSE = "</body>";
  const HEAD_CLOSE = "</head>";

  const bodyIdx = html.lastIndexOf(BODY_CLOSE);
  if (bodyIdx !== -1) {
    return html.slice(0, bodyIdx) + script + html.slice(bodyIdx);
  }
  const headIdx = html.lastIndexOf(HEAD_CLOSE);
  if (headIdx !== -1) {
    const after = headIdx + HEAD_CLOSE.length;
    return html.slice(0, after) + script + html.slice(after);
  }
  return script + html;
}

const HEAD_OPEN_RE = /<head(\s[^>]*)?>/i;
const HTML_OPEN_RE = /<html(\s[^>]*)?>/i;

/**
 * Prepend a script to the beginning of an HTML document so it executes
 * before any other scripts during HTML parsing.
 *
 * Insertion priority: right after `<head>`, then after `<html>`, then
 * prepended to the raw string. This ensures the script runs before any
 * inline `<script>` tags in the body.
 */
export function prependScript(html: string, script: string): string {
  const headMatch = HEAD_OPEN_RE.exec(html);
  if (headMatch) {
    const after = headMatch.index + headMatch[0].length;
    return html.slice(0, after) + script + html.slice(after);
  }
  const htmlMatch = HTML_OPEN_RE.exec(html);
  if (htmlMatch) {
    const after = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, after) + script + html.slice(after);
  }
  return script + html;
}

/**
 * Inject the full bridge into app HTML.
 *
 * The storage polyfill is prepended (runs before any app scripts) while
 * the bridge logic is appended before `</body>` (app code calls
 * `window.vellum` APIs asynchronously after mount, not during parsing).
 */
export function injectBridge(
  html: string,
  frameId: string,
  options?: BridgeOptions,
): string {
  const linkInterceptor =
    options?.links !== undefined
      ? buildLinkInterceptorScript(frameId, {
          relayExternal: options.links === "relay",
        })
      : "";
  return prependScript(
    injectScript(
      html,
      buildBridgeLogicScript(frameId, options) + linkInterceptor,
    ),
    buildStoragePolyfill(),
  );
}

/**
 * Prepare HTML for a non-interactive preview iframe.
 *
 * Prepends the storage polyfill so it executes before any inline app
 * scripts that might access `localStorage` during parsing. Also hides
 * scrollbars for the thumbnail viewport.
 */
export function preparePreviewHtml(html: string): string {
  const HIDE_SCROLLBARS =
    "<style>html,body{overflow:hidden!important;scrollbar-width:none!important;}::-webkit-scrollbar{display:none!important;}</style>";
  return prependScript(html, buildStoragePolyfill() + HIDE_SCROLLBARS);
}
