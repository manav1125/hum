import Capacitor
import UIKit
import UserNotifications
import WebKit

/// Custom `CAPBridgeViewController` subclass that:
///
/// 1. Registers `NativeAuthPlugin` and `NativeBiometricPlugin` as local
///    plugin instances at bridge init time. These plugins live inside the
///    App target (no SPM module) so the bridge won't discover them
///    automatically.
///
/// 2. Injects `WKUserScript`s at `.atDocumentEnd` to:
///    a) Pin focusable fields to a minimum 16px font-size, preventing the
///       iOS auto-zoom behaviour that gets stuck after the input loses focus.
///    b) Append `maximum-scale=1.0, user-scalable=no` to the viewport meta
///       tag. This is injected natively (rather than baked into `index.html`)
///       so regular mobile-browser users keep their default zoom/accessibility
///       behaviour. Only the Capacitor WKWebView shell receives the lock.
///
/// 3. Resets the WKWebView scroll view zoom scale to 1.0 after device
///    rotation completes. Capacitor's built-in zoom prevention only
///    disables the pinch gesture recognizer (via `scrollViewWillBeginZooming`),
///    which doesn't prevent programmatic zoom changes triggered by rotation.
///    The viewport `maximum-scale` constraint (item 2b) is the primary guard;
///    this reset is a native safety net for any edge case it doesn't cover.
///
/// Safe-area handling lives on the web side: `apps/web/index.html` ships
/// `viewport-fit=cover` in its viewport meta tag, and `initSafeAreaBridge()`
/// in `runtime/native-safe-area.ts` reads native insets via
/// `capacitor-plugin-safe-area` and writes them to `--safe-area-inset-*`
/// CSS custom properties.
///
/// `Main.storyboard`'s single scene uses this class instead of the stock
/// `CAPBridgeViewController`.
class MyViewController: CAPBridgeViewController {
    /// Choose what the WebView loads at launch. When the owner has connected
    /// an instance (persisted by `CueNativePlugin`), load it as the server
    /// origin so the SPA runs as the real app (bridge injected, same-origin
    /// auth) — the fix for the shell's stuck loader. Otherwise Capacitor serves
    /// the bundled sign-on shell from `capacitor://localhost`.
    ///
    /// Navigating the shell onto a freshly-connected instance is permitted by
    /// `server.allowNavigation` (`*.justcue.app` / `*.justcue.io`), baked in
    /// `capacitor.config.ts`. A connected instance's own host is always allowed
    /// once it is the `serverURL`, which also covers custom domains on return.
    override open func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let saved = UserDefaults.standard.string(forKey: CueNativePlugin.instanceKey) {
            descriptor.serverURL = saved
        }
        return descriptor
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeAuthPlugin())
        bridge?.registerPluginInstance(NativeBiometricPlugin())
        bridge?.registerPluginInstance(CueNativePlugin())
        installNotificationTapRouting()
        installCueNativeAliasUserScript()
        installInputZoomPreventionUserScript()
        installViewportZoomLockUserScript()
    }

    /// Re-chain `CueNotificationRouter` in front of Capacitor's notification
    /// delegate (which replaced it during bridge init) and hand it the WebView
    /// seam. Any deep link that arrived during a cold start is flushed the
    /// moment the navigator lands. See `CueNotificationRouter` for the full
    /// delegate-ownership story.
    private func installNotificationTapRouting() {
        let router = CueNotificationRouter.shared
        let center = UNUserNotificationCenter.current()
        if center.delegate !== router {
            router.forwardTarget = center.delegate
            center.delegate = router
        }
        router.navigator = { [weak self] url in
            self?.bridge?.webView?.load(URLRequest(url: url))
        }
    }

    /// Expose `window.CueNative` (the shell's contract) as a thin wrapper over
    /// the `CueNative` Capacitor plugin, so the shell code stays plain and the
    /// alias only exists inside the native WebView.
    private func installCueNativeAliasUserScript() {
        guard let contentController = webView?.configuration.userContentController else { return }
        let source = """
        (function () {
          function plugin() {
            return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CueNative) || null;
          }
          window.CueNative = {
            connect: function (url, token) { var p = plugin(); return p ? p.connect({ url: url, token: token || "" }) : Promise.reject("no bridge"); },
            load: function (url) { var p = plugin(); return p ? p.load({ url: url }) : Promise.reject("no bridge"); },
            signOut: function () { var p = plugin(); return p ? p.signOut() : Promise.reject("no bridge"); }
          };
        })();
        """
        contentController.addUserScript(WKUserScript(
            source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    // MARK: - Rotation zoom reset

    override open func viewWillTransition(
        to size: CGSize,
        with coordinator: UIViewControllerTransitionCoordinator
    ) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            guard let scrollView = self?.webView?.scrollView,
                  scrollView.zoomScale != 1.0 else { return }
            scrollView.setZoomScale(1.0, animated: false)
        }
    }

    /// Pin focusable fields to a minimum 16px font-size so iOS WKWebView
    /// doesn't auto-zoom into inputs with small text.
    private func installInputZoomPreventionUserScript() {
        guard let contentController = webView?.configuration.userContentController else { return }
        let source = """
        (function() {
          var style = document.createElement('style');
          style.textContent = 'input, textarea, select { font-size: max(16px, 1em) !important; }';
          if (document.head) {
            document.head.appendChild(style);
          } else {
            document.addEventListener('DOMContentLoaded', function() {
              document.head.appendChild(style);
            }, { once: true });
          }
        })();
        """
        let script = WKUserScript(
            source: source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(script)
    }

    /// Append `maximum-scale=1.0, user-scalable=no` to the existing viewport
    /// meta tag so WKWebView cannot zoom beyond 1x. Injected natively rather
    /// than baked into `index.html` so regular mobile-browser users retain
    /// their default zoom/accessibility behaviour.
    private func installViewportZoomLockUserScript() {
        guard let contentController = webView?.configuration.userContentController else { return }
        let source = """
        (function() {
          var viewport = document.querySelector('meta[name="viewport"]');
          if (viewport) {
            var content = viewport.getAttribute('content') || '';
            if (content.indexOf('maximum-scale') === -1) {
              viewport.setAttribute('content', content + ', maximum-scale=1.0, user-scalable=no');
            }
          }
        })();
        """
        let script = WKUserScript(
            source: source,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        contentController.addUserScript(script)
    }
}
