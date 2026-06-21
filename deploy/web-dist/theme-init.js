// Synchronous theme init — prevents flash-of-wrong-theme before React mounts.
// Loaded via <script src> (not inline) so CSP script-src 'self' allows it.
(function () {
  try {
    var stored =
      window.localStorage.getItem("device:theme") ||
      window.localStorage.getItem("vellum_theme");
    // Native (Capacitor iOS/Android) ships the dark "v1" mobile design by
    // default; an explicit stored choice still wins. window.Capacitor is
    // injected at document start in the native shell, so it is readable here.
    var isNative = !!(
      window.Capacitor &&
      window.Capacitor.isNativePlatform &&
      window.Capacitor.isNativePlatform()
    );
    var theme = stored || (isNative ? "dark" : "system");
    var prefersDark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    var shouldBeDark =
      theme === "velvet" ||
      theme === "dark" ||
      (theme === "system" && prefersDark);
    var root = document.documentElement;
    root.setAttribute("data-theme", shouldBeDark ? "dark" : "light");
    root.classList.toggle("dark", shouldBeDark);
    root.classList.remove("velvet");
  } catch {
    // Theme startup is best-effort. React will apply the default later.
  }
})();
