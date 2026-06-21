// Boot splash — paints the Cue aperture on the brand ink immediately, so the
// native launch screen hands off to a branded screen (not a white WKWebView)
// while the SPA JS loads from a possibly-cold backend. Removes itself the moment
// React renders into #root. Loaded via <script src> (CSP script-src 'self');
// styles are set through the CSSOM (.style), which CSP does not govern, so no
// inline <style>/style-attr is needed. Best-effort: any failure is swallowed and
// a 12s safety timer guarantees it never traps the user on the splash.
(function () {
  try {
    var splash = document.createElement("div");
    splash.id = "cue-boot-splash";
    var s = splash.style;
    s.position = "fixed";
    s.top = "0";
    s.right = "0";
    s.bottom = "0";
    s.left = "0";
    s.zIndex = "99999";
    s.display = "flex";
    s.alignItems = "center";
    s.justifyContent = "center";
    s.background =
      "radial-gradient(120% 100% at 50% 34%, #1E2738 0%, #1A2230 56%, #0C1018 100%)";
    s.opacity = "1";
    s.transition = "opacity .45s ease";
    // Aperture mark (ring + blue dot), no rounded-square so it floats on the ink.
    splash.innerHTML =
      '<svg width="112" height="112" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<circle cx="232" cy="256" r="150" fill="none" stroke="#EEF2F7" stroke-width="40" stroke-linecap="round" stroke-dasharray="707 236" transform="rotate(42 232 256)"/>' +
      '<circle cx="392" cy="372" r="30" fill="#3D6EE8"/>' +
      "</svg>";

    var removed = false;
    function remove() {
      if (removed) return;
      removed = true;
      splash.style.opacity = "0";
      setTimeout(function () {
        if (splash.parentNode) splash.parentNode.removeChild(splash);
      }, 450);
    }

    function mount() {
      if (!document.body) return;
      document.body.appendChild(splash);
      var root = document.getElementById("root");
      if (!root) {
        remove();
        return;
      }
      // React already painted (cache/HMR) — drop immediately.
      if (root.childNodes.length > 0) {
        remove();
        return;
      }
      var obs = new MutationObserver(function () {
        if (root.childNodes.length > 0) {
          obs.disconnect();
          remove();
        }
      });
      obs.observe(root, { childList: true });
      // Safety: never trap the user behind the splash.
      setTimeout(function () {
        obs.disconnect();
        remove();
      }, 12000);
    }

    if (document.body) {
      mount();
    } else {
      document.addEventListener("DOMContentLoaded", mount);
    }
  } catch {
    // Best-effort only.
  }
})();
