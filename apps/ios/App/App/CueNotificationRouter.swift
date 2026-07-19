import Foundation
import UIKit
import UserNotifications

/// Routes notification **taps** to the connected instance's SPA.
///
/// The daemon's APNs pushes (morning brief, work-item completions, approvals —
/// see `assistant/src/notifications/{morning-brief-push,push-dispatch}.ts`)
/// carry their deep-link metadata as top-level custom payload keys next to
/// `aps`, e.g. `{ kind: "morning_brief", path: "/assistant/brief", dateKey }`.
/// When the user taps one, the app must open that path on the **connected
/// instance** — the same WebView-navigation seam `AppDelegate` already uses
/// for Universal Links.
///
/// Delegate ownership is a three-step dance:
///
/// 1. `AppDelegate.didFinishLaunchingWithOptions` installs this router as the
///    `UNUserNotificationCenter` delegate. Apple only delivers the tap that
///    *launched* the app (cold start) to a delegate that exists before launch
///    finishes, and Capacitor's own router is only created later, at bridge
///    init — so the early claim is what makes cold-start taps routable.
/// 2. Capacitor's bridge init replaces the delegate with its
///    `NotificationRouter` (`handleApplicationNotifications` defaults to on).
/// 3. `MyViewController.capacitorDidLoad` re-installs this router, keeping
///    Capacitor's as `forwardTarget` so the push plugin's JS events
///    (`pushNotificationReceived` / `pushNotificationActionPerformed`) keep
///    flowing to any web listener.
///
/// Cold-start race: the tap response can arrive before the bridge (and its
/// WKWebView) exists. The resolved URL is parked in `pendingURL` and flushed
/// the moment `MyViewController` registers the `navigator` closure.
final class CueNotificationRouter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = CueNotificationRouter()

    /// Capacitor's `NotificationRouter` — restored into the chain so plugin
    /// JS events keep working. Weak: the bridge owns it.
    weak var forwardTarget: UNUserNotificationCenterDelegate?

    /// Navigates the Capacitor WKWebView. Set (on the main thread) by
    /// `MyViewController` once the bridge exists; setting it flushes any
    /// deep link that arrived first.
    var navigator: ((URL) -> Void)? {
        didSet { flushPendingURL() }
    }

    private var pendingURL: URL?

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if let forward = forwardTarget,
           forward.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
            forward.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
            return
        }
        // Pre-bridge window (cold start only): match Capacitor's default of
        // not alerting for a foreground push.
        completionHandler([])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Only the plain tap navigates; custom action buttons (none today)
        // and the dismiss action must not hijack the WebView.
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            handleTap(userInfo: response.notification.request.content.userInfo)
        }
        if let forward = forwardTarget,
           forward.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
            forward.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
            return
        }
        completionHandler()
    }

    // MARK: - Deep-link resolution

    /// Resolve the payload's deep link against the connected instance and
    /// navigate (or park the URL until the WebView exists). Payloads without
    /// a usable `path` (e.g. work-item / approval pushes today) just open the
    /// app — no navigation.
    private func handleTap(userInfo: [AnyHashable: Any]) {
        guard let url = Self.deepLinkURL(
            userInfo: userInfo,
            instanceBase: UserDefaults.standard.string(forKey: CueNativePlugin.instanceKey)
        ) else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let navigator = self.navigator {
                navigator(url)
            } else {
                self.pendingURL = url
            }
        }
    }

    private func flushPendingURL() {
        guard let url = pendingURL, let navigator else { return }
        pendingURL = nil
        navigator(url)
    }

    /// Pure resolver: `path` from the push payload + the saved instance root
    /// (`https://<host>/assistant/`, persisted by `CueNativePlugin`) →
    /// `https://<host><path>`. Nil when there is no connected instance (the
    /// sign-on shell is showing — nowhere meaningful to deep-link) or the
    /// path is missing/absolute-URL-shaped (never navigate to a host a push
    /// payload names).
    static func deepLinkURL(userInfo: [AnyHashable: Any], instanceBase: String?) -> URL? {
        guard let path = userInfo["path"] as? String,
              path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
        guard let base = instanceBase,
              let baseURL = URL(string: base), baseURL.scheme == "https",
              let host = baseURL.host else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.port = baseURL.port
        components.path = path
        return components.url
    }
}
