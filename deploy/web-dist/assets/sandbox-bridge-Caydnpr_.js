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
<\/script>`}function r(e,n){let r=n?.fetch??!1,i=n?.route??null,a=r?`
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
    route: ${t(i)},
    sendAction: function(actionId, data) {
      window.parent.postMessage({
        type: 'vellum_surface_action',
        frameId: ${t(e)},
        actionId: actionId,
        data: data || {}
      }, '*');
    }
  };${a}
})();
<\/script>`}function i(e,t){let n=e.lastIndexOf(`</body>`);if(n!==-1)return e.slice(0,n)+t+e.slice(n);let r=e.lastIndexOf(`</head>`);if(r!==-1){let n=r+7;return e.slice(0,n)+t+e.slice(n)}return t+e}var a=/<head(\s[^>]*)?>/i,o=/<html(\s[^>]*)?>/i;function s(e,t){let n=a.exec(e);if(n){let r=n.index+n[0].length;return e.slice(0,r)+t+e.slice(r)}let r=o.exec(e);if(r){let n=r.index+r[0].length;return e.slice(0,n)+t+e.slice(n)}return t+e}function c(e,t,a){return s(i(e,r(t,a)),n())}function l(e){return s(e,n()+`<style>html,body{overflow:hidden!important;scrollbar-width:none!important;}::-webkit-scrollbar{display:none!important;}</style>`)}export{c as n,l as r,e as t};