import Capacitor
import Foundation
import UIKit
import WebKit

/// VentureVerse inline app embedding on iOS — the mobile twin of the desktop
/// `WebContentsView` path (see `apps/macos/src/main/ventureverse-view.ts`).
///
/// ## Why a native overlay `WKWebView` and not an iframe
///
/// VentureVerse mini apps authenticate via a postMessage SSO handshake between
/// the VentureVerse shell and the app, and that only completes when VentureVerse
/// is the **top-level** browsing context. An `<iframe>` inside Cue's SPA puts
/// VentureVerse under a foreign top origin (`manav.justcue.app`) and the
/// handshake never completes — plus WKWebView storage partitioning hides the
/// user's VentureVerse session from the frame.
///
/// This plugin composites a *separate* `WKWebView` over Cue's WebView at a
/// rectangle the SPA controls (the app-area div). From VentureVerse's point of
/// view it IS the top-level page, so the shell↔app handshake runs exactly as it
/// does in a normal browser — while visually it sits embedded inside Cue. No
/// VentureVerse-side change.
///
/// ## Session
///
/// The overlay uses the default (persistent) `WKWebsiteDataStore`, so a sign-in
/// inside it survives app restarts. Cue never sees a VentureVerse password —
/// sign-in happens in VentureVerse's own page. Note: Google blocks OAuth inside
/// embedded mobile web views (`disallowed_useragent`); an external sign-in
/// (accounts.google.com) is handed to the system browser, so **inside the embed
/// users sign into VentureVerse with email & password**.
///
/// ## Isolation
///
/// The overlay has no Cue bridge and its own data store, so VentureVerse cannot
/// reach Cue's plugins. Top-level navigation is pinned to VentureVerse origins;
/// any other http(s) destination (and every `window.open`) is handed to the
/// system browser.
///
/// JS contract mirrors the Electron `vvView` bridge (see
/// `apps/web/src/runtime/vv-view.ts`): `open({url,x,y,width,height})`,
/// `setBounds({x,y,width,height})`, `close()`. Bounds are CSS pixels from
/// `getBoundingClientRect()`; on the Capacitor WebView (viewport `initial-scale=1`)
/// one CSS pixel maps to one point, and the overlay is a subview of the host
/// WebView so those bounds are already in its coordinate space.
@objc(VentureverseViewPlugin)
public class VentureverseViewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VentureverseViewPlugin"
    public let jsName = "VentureverseView"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    /// The single embedded overlay. One VentureVerse app shows at a time.
    private var overlay: WKWebView?
    /// The URL last requested, so a repeat `open()` (fired on every resize) does
    /// not reload the page needlessly.
    private var currentUrl: String?

    /// Origins allowed to load as the overlay's TOP-LEVEL document. The per-app
    /// deployments load as sub-frames of the shell (not top-level navigations)
    /// so they don't need listing here.
    private static func isVentureverseTopOrigin(_ raw: String) -> Bool {
        guard let u = URL(string: raw), u.scheme == "https", let host = u.host else {
            return false
        }
        return host == "ventureverse.com" || host.hasSuffix(".ventureverse.com")
    }

    private func rect(from call: CAPPluginCall) -> CGRect {
        let x = call.getDouble("x") ?? 0
        let y = call.getDouble("y") ?? 0
        let width = max(0, call.getDouble("width") ?? 0)
        let height = max(0, call.getDouble("height") ?? 0)
        return CGRect(x: x, y: y, width: width, height: height)
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              Self.isVentureverseTopOrigin(urlString),
              let url = URL(string: urlString)
        else {
            call.reject("A valid VentureVerse URL is required")
            return
        }
        let frame = rect(from: call)
        DispatchQueue.main.async { [weak self] in
            guard let self, let host = self.bridge?.webView else {
                call.reject("No host web view")
                return
            }
            if self.overlay == nil {
                let config = WKWebViewConfiguration()
                // Persistent + shared across launches: sign in once, stay signed in.
                config.websiteDataStore = .default()
                config.allowsInlineMediaPlayback = true
                let webView = WKWebView(frame: frame, configuration: config)
                webView.navigationDelegate = self
                webView.uiDelegate = self
                webView.allowsBackForwardNavigationGestures = true
                webView.scrollView.contentInsetAdjustmentBehavior = .never
                host.addSubview(webView)
                self.overlay = webView
            }
            self.overlay?.frame = frame
            if self.currentUrl != urlString {
                self.currentUrl = urlString
                self.overlay?.load(URLRequest(url: url))
            }
            call.resolve()
        }
    }

    @objc func setBounds(_ call: CAPPluginCall) {
        let frame = rect(from: call)
        DispatchQueue.main.async { [weak self] in
            self?.overlay?.frame = frame
            call.resolve()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.overlay?.stopLoading()
            self?.overlay?.removeFromSuperview()
            self?.overlay = nil
            self?.currentUrl = nil
            call.resolve()
        }
    }

    private func openExternally(_ url: URL) {
        guard url.scheme == "https" || url.scheme == "http" else { return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }
}

extension VentureverseViewPlugin: WKNavigationDelegate {
    /// Pin top-level navigation to VentureVerse; hand anything else to the system
    /// browser. Sub-frame loads (the app deployments the shell iframes) are
    /// allowed unconditionally.
    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // Only gate MAIN-frame navigations; let the shell's app iframe load.
        if navigationAction.targetFrame?.isMainFrame != true {
            decisionHandler(.allow)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if Self.isVentureverseTopOrigin(url.absoluteString) {
            decisionHandler(.allow)
            return
        }
        // External top-level destination (e.g. an OAuth provider) → system
        // browser. Google blocks embedded-webview OAuth, so this is the only
        // place such a flow can complete.
        openExternally(url)
        decisionHandler(.cancel)
    }
}

extension VentureverseViewPlugin: WKUIDelegate {
    /// `window.open` from VentureVerse (popups, OAuth) → system browser. The
    /// overlay never spawns child web views of its own.
    public func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            openExternally(url)
        }
        return nil
    }
}
