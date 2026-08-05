var e=/^\/v1\/x\//;function t(e){return JSON.stringify(e).replace(/<\//g,`<\\/`).replace(/<!--/g,`<\\!--`)}function n(){return`<script>
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
<\/script>`}function r(e,n){let r=n?.fetch??!1,i=n?.deckNav??!1,a=n?.route??null,o=i?`
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
  })();`:``,s=r?`
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
        frameId: ${t(e)},
        callId: callId,
        path: path,
        method: (options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
        body: options.body || null
      }, '*');
    });
  };`:``;return`<script>
(function() {
  window.vellum = {
    route: ${t(a)},
    sendAction: function(actionId, data) {
      window.parent.postMessage({
        type: 'vellum_surface_action',
        frameId: ${t(e)},
        actionId: actionId,
        data: data || {}
      }, '*');
    }
  };${s}${o}
})();
<\/script>`}function i(e,t){let n=e.lastIndexOf(`</body>`);if(n!==-1)return e.slice(0,n)+t+e.slice(n);let r=e.lastIndexOf(`</head>`);if(r!==-1){let n=r+7;return e.slice(0,n)+t+e.slice(n)}return t+e}var a=/<head(\s[^>]*)?>/i,o=/<html(\s[^>]*)?>/i;function s(e,t){let n=a.exec(e);if(n){let r=n.index+n[0].length;return e.slice(0,r)+t+e.slice(r)}let r=o.exec(e);if(r){let n=r.index+r[0].length;return e.slice(0,n)+t+e.slice(n)}return t+e}function c(e,t,a){return s(i(e,r(t,a)),n())}function l(e){return s(e,n()+`<style>html,body{overflow:hidden!important;scrollbar-width:none!important;}::-webkit-scrollbar{display:none!important;}</style>`)}export{c as n,l as r,e as t};