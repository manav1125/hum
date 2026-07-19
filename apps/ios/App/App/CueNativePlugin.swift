#if canImport(ActivityKit)
import ActivityKit
#endif
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
        CAPPluginMethod(name: "startRunActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateRunActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endRunActivity", returnType: CAPPluginReturnPromise),
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

    // MARK: - Live Activities (mobile-v3 frame 4)

    /// Start a Live Activity for a Cue run. JS contract (drivable by the web
    /// app later — no web callers are wired yet):
    /// `startRunActivity({ runId?, title, status, progress?, state? })`.
    /// `state` is a v3 taxonomy key (`picked_up`/`running`/`needs_you`/
    /// `review`/`done`/`failed`), defaulting to `running`. Replaces any
    /// previous run activity — one Island slot, latest run wins.
    @objc func startRunActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities require iOS 16.2+")
            return
        }
        guard let title = call.getString("title"), !title.isEmpty else {
            call.reject("A run title is required")
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Live Activities are disabled for this app")
            return
        }
        let attributes = CueRunActivityAttributes(
            runId: call.getString("runId") ?? UUID().uuidString,
            title: title
        )
        let state = Self.runContentState(from: call, defaultState: .running)
        Task {
            // One run activity at a time: retire the previous one first.
            if let previous = CueRunActivityHolder.current {
                await previous.end(nil, dismissalPolicy: .immediate)
            }
            do {
                let activity = try Activity.request(
                    attributes: attributes,
                    content: ActivityContent(state: state, staleDate: nil)
                )
                CueRunActivityHolder.current = activity
                call.resolve(["activityId": activity.id])
            } catch {
                call.reject("Failed to start Live Activity: \(error.localizedDescription)")
            }
        }
    }

    /// Update the current run activity:
    /// `updateRunActivity({ status?, progress?, state? })`.
    @objc func updateRunActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities require iOS 16.2+")
            return
        }
        guard let activity = CueRunActivityHolder.current else {
            call.reject("No run activity is active")
            return
        }
        let state = Self.runContentState(
            from: call,
            defaultState: activity.content.state.state,
            fallback: activity.content.state
        )
        Task {
            await activity.update(ActivityContent(state: state, staleDate: nil))
            call.resolve()
        }
    }

    /// End the current run activity with a final frame:
    /// `endRunActivity({ status?, state? })` — state defaults to `done`.
    @objc func endRunActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities require iOS 16.2+")
            return
        }
        guard let activity = CueRunActivityHolder.current else {
            call.resolve() // nothing to end — idempotent from JS's view
            return
        }
        CueRunActivityHolder.current = nil
        let final = Self.runContentState(
            from: call,
            defaultState: .done,
            fallback: activity.content.state
        )
        Task {
            await activity.end(
                ActivityContent(state: final, staleDate: nil),
                dismissalPolicy: .default
            )
            call.resolve()
        }
    }

    /// Build a content state from call args, falling back to the previous
    /// frame's values (or blanks on start).
    @available(iOS 16.2, *)
    private static func runContentState(
        from call: CAPPluginCall,
        defaultState: CueRunState,
        fallback: CueRunActivityAttributes.ContentState? = nil
    ) -> CueRunActivityAttributes.ContentState {
        let state = call.getString("state").flatMap(CueRunState.init(rawValue:)) ?? defaultState
        return CueRunActivityAttributes.ContentState(
            statusLine: call.getString("status") ?? fallback?.statusLine ?? "",
            progress: call.getDouble("progress") ?? fallback?.progress,
            state: state
        )
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

#if canImport(ActivityKit)
/// Holds the single in-flight run Live Activity. A separate container
/// because stored properties on the plugin class can't carry an iOS 16.2
/// availability constraint.
@available(iOS 16.2, *)
private enum CueRunActivityHolder {
    static var current: Activity<CueRunActivityAttributes>?
}
#endif
