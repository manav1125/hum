import Capacitor
import Foundation
import UIKit

/// Bridges the sign-on shell to the native layer so the owner's instance is
/// loaded as the WebView's **server origin** rather than navigated to.
///
/// This is the fix for the stuck loader in the first shell attempt: a JS
/// `location.replace` to the instance is treated as a navigation to an
/// "external" host, which Capacitor's navigation policy cancels (nothing is in
/// `allowNavigation` for it) — leaving a blank, half-loaded WebView. Loading
/// the instance from native (with the host allowed via `instanceDescriptor`,
/// see `MyViewController`) keeps the Capacitor runtime injected and the SPA
/// authenticates same-origin, exactly like the current baked-`server.url`
/// build already does — only chosen at runtime.
///
/// The shell calls `window.CueNative.*` (aliased to this plugin in
/// `MyViewController.capacitorDidLoad`).
@objc(CueNativePlugin)
public class CueNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CueNativePlugin"
    public let jsName = "CueNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
    ]

    /// UserDefaults key holding the token-stripped instance SPA root. Read at
    /// launch by `MyViewController.instanceDescriptor()` so a returning owner
    /// loads their instance directly, skipping the shell.
    static let instanceKey = "cue.instanceUrl"

    /// First connect: remember the instance and load it WITH the one-time
    /// token so the SPA seeds its same-origin session.
    @objc func connect(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let base = Self.normalizedInstance(raw) else {
            call.reject("A valid instance URL is required")
            return
        }
        let token = call.getString("token") ?? ""
        UserDefaults.standard.set(base, forKey: Self.instanceKey)
        var full = base
        if !token.isEmpty {
            let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
            full = base + "?cueToken=" + encoded
        }
        loadInWebView(full)
        call.resolve()
    }

    /// Returning path: load a saved instance directly (its own-origin session
    /// persists, so no token needed).
    @objc func load(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let base = Self.normalizedInstance(raw) else {
            call.reject("A valid instance URL is required")
            return
        }
        UserDefaults.standard.set(base, forKey: Self.instanceKey)
        loadInWebView(base)
        call.resolve()
    }

    /// Forget the instance and return to the bundled sign-on shell.
    @objc func signOut(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: Self.instanceKey)
        call.resolve()
        // Reload immediately so the user isn't stranded on the (now signed-out)
        // instance; the bundled shell is the fallback base path.
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.reload()
        }
    }

    private func loadInWebView(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.load(URLRequest(url: url))
        }
    }

    /// Coerce whatever the shell passes ("cue-you.justcue.app", a full URL, a
    /// bare host) into `https://<host>/assistant/`. https only; nil if unusable.
    static func normalizedInstance(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.hasPrefix("http") { s = "https://" + s }
        guard let u = URL(string: s), u.scheme == "https",
              let host = u.host, host.contains(".") else { return nil }
        return "https://\(host)/assistant/"
    }
}
