import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

/// Cue Live — Stage 1 companion (guide-only, AX-first).
///
/// A transparent, click-through overlay that the Cue assistant **daemon** drives
/// over JSON-RPC. This is a thin native client (per CUE-LIVE-SPEC + the clicky
/// integration direction): it does NOT call any model itself. It
///   - registers a summon hotkey (Control+Option+Space) and reports it,
///   - reads the accessibility element under the cursor (AX-first; no screenshots),
///   - draws a Cue-styled "next move" guide card the daemon hands it, and
///   - highlights an element's bounds with a Cue-blue ring.
///
/// The daemon does all reasoning (provider abstraction / CES) and tells the
/// helper what to show. Take-control (CGEvent / MCP action layer) is a later
/// stage and intentionally absent here.
///
/// Marked `@unchecked Sendable`: every public method is invoked on the main
/// thread (the JSON-RPC router dispatches there) and hops to `@MainActor` for
/// the AppKit work, returning only Sendable values across the boundary.
/// Sendable result of a ScreenCaptureKit capture, marshaled back to the
/// synchronous RPC handler across the Task boundary.
private struct CaptureResult: Sendable {
    var ok: Bool = false
    var data: String?
    var width: Int = 0
    var height: Int = 0
    var screenWidth: Double = 0
    var screenHeight: Double = 0
    var reason: String?
}

/// Carries a `CaptureResult` from the capture Task to the semaphore-blocked RPC
/// thread. Safe by construction: the semaphore is the happens-before edge.
private final class CaptureBox: @unchecked Sendable {
    var value: CaptureResult?
}

final class CueLiveController: @unchecked Sendable {
    /// Emits a JSON-RPC notification back to the daemon.
    private let emit: (String, [String: Any]?) -> Void

    @MainActor private var overlay: NSPanel?
    @MainActor private var cardView: CueGuideCardView?
    @MainActor private var highlightView: CueHighlightView?
    @MainActor private var hotkeyMonitor: Any?
    @MainActor private var localHotkeyMonitor: Any?
    @MainActor private var trustPollTimer: Timer?
    @MainActor private let voice = CueVoiceController()
    @MainActor private var pttMonitor: CuePushToTalkMonitor?
    @MainActor private var voiceWired = false

    init(emit: @escaping (String, [String: Any]?) -> Void) {
        self.emit = emit
    }

    // MARK: - Lifecycle (JSON-RPC entry points)

    func start() -> [String: Any] {
        // The summon hotkey is a *global* NSEvent monitor and
        // `readElementAtCursor` calls `AXUIElementCopyElementAtPosition` —
        // both silently no-op until this helper is trusted for Accessibility.
        // Nothing else surfaces that, so trigger the system prompt here: when
        // untrusted it registers the helper in System Settings → Privacy &
        // Security → Accessibility and asks the user to enable it. Once trusted
        // it's a no-op (no repeat prompt).
        let trusted = ensureAccessibilityTrust()
        MainActor.assumeIsolated {
            ensureOverlay()
            if trusted {
                installHotkeyMonitors()
            } else {
                // The global monitor only receives events once the helper is
                // trusted, and a monitor installed while untrusted stays dead
                // even after the user flips the toggle — so don't install it
                // yet. Poll instead and install the moment trust is granted,
                // so the summon hotkey works without a relaunch.
                startTrustPolling()
            }
        }
        return ["enabled": true, "accessibilityTrusted": trusted]
    }

    /// Watch for Accessibility trust being granted at runtime and install the
    /// hotkey monitors as soon as it is, then stop polling. Uses the
    /// non-prompting `AXIsProcessTrusted()` so the system dialog isn't shown
    /// again on every tick.
    @MainActor
    private func startTrustPolling() {
        guard trustPollTimer == nil else { return }
        // The block runs on the main run loop (this timer is scheduled from a
        // main-actor context), so hop back onto the main actor and drive
        // everything through `self` — never touch the passed `Timer`, which
        // Swift 6 won't let us send across the isolation boundary.
        trustPollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) {
            [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, AXIsProcessTrusted() else { return }
                self.trustPollTimer?.invalidate()
                self.trustPollTimer = nil
                self.installHotkeyMonitors()
                self.emit("cuelive.accessibilityTrusted", ["trusted": true])
            }
        }
    }

    /// Trigger / read the Accessibility trust state for this helper process.
    /// Passing the prompt option shows the system grant dialog only while
    /// untrusted; returns the current trust state either way.
    private func ensureAccessibilityTrust() -> Bool {
        // Literal value of `kAXTrustedCheckOptionPrompt`; referencing the
        // imported global directly trips Swift 6 strict-concurrency (shared
        // mutable state), same dodge as the "AXSecureTextField" literal below.
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// Trigger a summon programmatically (same effect as the global hotkey):
    /// emits `cuelive.summoned` at the current cursor so the daemon runs the
    /// full read → highlight → card → guidance flow. Backs the tray fallback
    /// and the self-test.
    func summonNow() -> [String: Any] {
        MainActor.assumeIsolated {
            ensureOverlay()
            emitSummon()
        }
        return ["ok": true]
    }

    func stop() -> [String: Any] {
        MainActor.assumeIsolated {
            trustPollTimer?.invalidate()
            trustPollTimer = nil
            removeHotkeyMonitors()
            pttMonitor?.stop()
            pttMonitor = nil
            voiceWired = false
            voice.stopListening()
            voice.stopSpeaking()
            overlay?.orderOut(nil)
            overlay = nil
            cardView = nil
            highlightView = nil
        }
        return ["enabled": false]
    }

    func hide() -> [String: Any] {
        MainActor.assumeIsolated {
            cardView?.isHidden = true
            highlightView?.clear()
        }
        return ["ok": true]
    }

    // MARK: - AX perception (AX-first; no screenshots)

    /// The accessibility element under the cursor: role, label, a redacted
    /// value, and screen bounds. Secure fields (passwords) never return a value.
    func readElementAtCursor() -> [String: Any] {
        // mouse + screen height need the main actor; AX is a nonisolated C API.
        let (mouseX, mouseY, screenHeight): (Double, Double, Double) =
            MainActor.assumeIsolated {
                // The overlay is a full-screen window at the cursor, so it would
                // shadow the system-wide AX hit-test below — making every read
                // (native or Electron) return nothing. Order it out for the
                // hit-test; the caller re-shows it via highlight/showCard when
                // there's something to draw.
                overlay?.orderOut(nil)
                let m = NSEvent.mouseLocation
                return (Double(m.x), Double(m.y), Double(NSScreen.screens.first?.frame.height ?? 0))
            }
        // AX uses a top-left origin; AppKit's mouseLocation is bottom-left.
        let axX = mouseX
        let axY = screenHeight - mouseY

        let system = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        var err = AXUIElementCopyElementAtPosition(
            system, Float(axX), Float(axY), &element
        )
        // Chromium/Electron apps (Cue, Chrome, VS Code, Slack, …) don't expose
        // their accessibility tree until an AX client asks for it, so the
        // system-wide hit-test fails over their windows. Set AXManualAccessibility
        // on the app under the cursor to coax the tree to build, then retry. The
        // tree builds asynchronously, so the first summon over a fresh Electron
        // app may still miss but primes it for the next one.
        var hitVia = "systemwide"
        var hitPid: pid_t = 0
        if err != .success || element == nil {
            if let pid = Self.appPidAtScreenPoint(x: axX, y: axY) {
                hitPid = pid
                let appEl = AXUIElementCreateApplication(pid)
                AXUIElementSetAttributeValue(
                    appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
                AXUIElementSetAttributeValue(
                    appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
                // Hit-test within the app element itself — the system-wide
                // hit-test can fail where a per-application one succeeds.
                err = AXUIElementCopyElementAtPosition(
                    appEl, Float(axX), Float(axY), &element)
                hitVia = "perapp"
            }
        }
        guard err == .success, let element else {
            var probe: AnyObject?
            let probeErr = AXUIElementCopyAttributeValue(
                system, kAXFocusedApplicationAttribute as CFString, &probe)
            let msg = "[cue-live] readElement miss: AXerr=\(err.rawValue)"
                + " via=\(hitVia) pid=\(hitPid)"
                + " grantProbe=\(probeErr.rawValue)(\(probe != nil))"
                + " trusted=\(AXIsProcessTrusted())"
                + " cursorAX=(\(Int(axX)),\(Int(axY)))\n"
            FileHandle.standardError.write(Data(msg.utf8))
            return ["found": false]
        }

        // Drill deeper: the hit-test can stop at a shallow container — an
        // AXApplication / AXWindow / AXGroup with no useful label — especially
        // over Electron/Chromium apps whose AX tree is sparse. When that
        // happens, fall back to the app's *focused* UI element (the text field,
        // button, or control the user is actually in), which is almost always
        // the meaningful target. Keep the original hit element otherwise.
        let resolved = Self.refineElement(element, appPid: hitPid)

        let role = axString(resolved, kAXRoleAttribute) ?? "AXUnknown"
        let isSecure = role == "AXSecureTextField"
        let roleDescription = axString(resolved, "AXRoleDescription")
        let label = axString(resolved, kAXTitleAttribute)
            ?? axString(resolved, kAXDescriptionAttribute)
            ?? axString(resolved, "AXPlaceholderValue")
        let value = isSecure ? nil : axString(resolved, kAXValueAttribute)
        let appName = Self.appName(forPid: hitPid)
        let actions = Self.supportedActions(resolved)

        var result: [String: Any] = ["found": true, "role": role]
        if let roleDescription { result["roleDescription"] = roleDescription }
        if let label { result["label"] = label }
        if let value { result["value"] = String(value.prefix(240)) }
        if let appName { result["appName"] = appName }
        if !actions.isEmpty { result["actions"] = actions }
        if let frame = axFrame(resolved) {
            result["x"] = frame.origin.x
            result["y"] = frame.origin.y
            result["width"] = frame.size.width
            result["height"] = frame.size.height
        }
        return result
    }

    /// Roles that carry no actionable meaning on their own — when the hit-test
    /// lands on one of these we prefer the app's focused UI element instead.
    private static let containerRoles: Set<String> = [
        "AXApplication", "AXWindow", "AXGroup", "AXScrollArea",
        "AXSplitGroup", "AXUnknown", "AXLayoutArea", "AXGenericElement",
    ]

    /// If `element` is a bare container, substitute the focused UI element of
    /// its application (the control the user is actually interacting with).
    /// Returns the better of the two; never returns nil.
    private static func refineElement(
        _ element: AXUIElement, appPid: pid_t
    ) -> AXUIElement {
        let role = {
            var v: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &v)
            return v as? String ?? "AXUnknown"
        }()
        guard containerRoles.contains(role), appPid != 0 else { return element }
        let app = AXUIElementCreateApplication(appPid)
        var focused: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            app, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
            let focused, CFGetTypeID(focused) == AXUIElementGetTypeID()
        {
            return (focused as! AXUIElement)
        }
        return element
    }

    /// The names of AX actions an element supports (e.g. `AXPress`), so the
    /// daemon can tell whether the target is clickable, editable, etc.
    private static func supportedActions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success,
            let names = names as? [String]
        else { return [] }
        return names
    }

    /// The localized name of the running app with the given pid.
    private static func appName(forPid pid: pid_t) -> String? {
        guard pid != 0 else { return nil }
        return NSRunningApplication(processIdentifier: pid)?.localizedName
    }

    /// PID of the frontmost normal (layer 0) app window containing the given
    /// screen point (AX top-left coords), skipping this helper's own overlay.
    /// Used to target AXManualAccessibility at the app the cursor is over.
    private static func appPidAtScreenPoint(x: Double, y: Double) -> pid_t? {
        guard
            let wins = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]
        else { return nil }
        let selfPid = ProcessInfo.processInfo.processIdentifier
        let point = CGPoint(x: x, y: y)
        // CGWindowList is front-to-back: the first containing window wins.
        for w in wins {
            guard let opid = w[kCGWindowOwnerPID as String] as? pid_t,
                opid != selfPid
            else { continue }
            let layer = w[kCGWindowLayer as String] as? Int ?? 0
            if layer != 0 { continue }
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat]
            else { continue }
            let rect = CGRect(
                x: b["X"] ?? 0, y: b["Y"] ?? 0,
                width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            if rect.contains(point) { return opid }
        }
        return nil
    }

    // MARK: - Overlay rendering (daemon-driven)

    /// Show the guide card near a screen point (AX top-left coords), with a
    /// title + optional subtitle. The daemon synthesizes the "next move".
    func showCard(params: [String: Any]) -> [String: Any] {
        let title = params["title"] as? String ?? "Cue"
        let subtitle = params["subtitle"] as? String
        let ax = pointFrom(params)
        MainActor.assumeIsolated {
            ensureOverlay()
            guard let card = cardView else { return }
            card.configure(title: title, subtitle: subtitle)
            let origin = anchorOrigin(axX: ax.x, axY: ax.y, cardSize: card.frame.size)
            card.setFrameOrigin(origin)
            card.isHidden = false
            overlay?.orderFrontRegardless()
        }
        return ["ok": true]
    }

    /// Draw a Cue-blue ring around an element's bounds (AX top-left coords).
    func highlight(params: [String: Any]) -> [String: Any] {
        guard
            let x = params["x"] as? Double,
            let y = params["y"] as? Double,
            let w = params["width"] as? Double,
            let h = params["height"] as? Double
        else { return ["ok": false] }
        let label = params["label"] as? String
        MainActor.assumeIsolated {
            ensureOverlay()
            let rect = appKitRect(axX: x, axY: y, width: w, height: h)
            highlightView?.show(rect: rect, label: label)
            overlay?.orderFrontRegardless()
        }
        return ["ok": true]
    }

    // MARK: - Vision capture + pointing (clicky-style)

    /// Capture the main display as a downscaled PNG, base64-encoded. Requires
    /// the Screen Recording permission; prompts and returns `ok:false` the
    /// first time so the caller can tell the user. `width`/`height` are the
    /// OUTPUT pixel size (the space the model's [POINT] coords come back in);
    /// `screenWidth`/`screenHeight` are the display's size in points, so the
    /// caller can map image pixels → on-screen cursor position.
    func captureScreen(params: [String: Any]) -> [String: Any] {
        let maxWidth = (params["maxWidth"] as? Double) ?? 1280
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
            return ["ok": false, "reason": "screen-recording-permission"]
        }
        // ScreenCaptureKit's screenshot API is async; the RPC handler is sync.
        // Bridge with a semaphore — SCK delivers on its own queue, so blocking
        // the caller (even main) can't deadlock. Carry the result across the
        // Task boundary in an @unchecked-Sendable box (the semaphore is the
        // happens-before edge).
        let box = CaptureBox()
        let sem = DispatchSemaphore(value: 0)
        Task {
            box.value = await Self.captureViaSCK(maxWidth: maxWidth)
            sem.signal()
        }
        if sem.wait(timeout: .now() + 8) == .timedOut {
            return ["ok": false, "reason": "capture-timeout"]
        }
        guard let r = box.value, r.ok, let data = r.data else {
            return ["ok": false, "reason": box.value?.reason ?? "capture-failed"]
        }
        return [
            "ok": true, "data": data, "mediaType": "image/png",
            "width": r.width, "height": r.height,
            "screenWidth": r.screenWidth, "screenHeight": r.screenHeight,
        ]
    }

    /// One-shot main-display capture via ScreenCaptureKit, downscaled so the
    /// longest edge is ~`maxWidth`px and PNG-encoded. Returns a Sendable struct.
    private static func captureViaSCK(maxWidth: Double) async -> CaptureResult {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                return CaptureResult(reason: "no-display")
            }
            let ptW = Double(display.width)
            let ptH = Double(display.height)
            let scale = ptW > maxWidth ? maxWidth / ptW : 1.0
            let outW = max(1, Int(ptW * scale))
            let outH = max(1, Int(ptH * scale))
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = outW
            config.height = outH
            config.showsCursor = false
            let cg = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: config)
            guard
                let png = NSBitmapImageRep(cgImage: cg)
                    .representation(using: .png, properties: [:])
            else { return CaptureResult(reason: "encode-failed") }
            return CaptureResult(
                ok: true, data: png.base64EncodedString(),
                width: cg.width, height: cg.height,
                screenWidth: ptW, screenHeight: ptH)
        } catch {
            return CaptureResult(reason: "sck:\(error.localizedDescription)")
        }
    }

    /// Fly the cursor to a screen point (top-left points) and pin a labeled
    /// ring there — the visible "pointing" gesture.
    func pointAt(params: [String: Any]) -> [String: Any] {
        guard let x = params["x"] as? Double, let y = params["y"] as? Double
        else { return ["ok": false] }
        let label = params["label"] as? String ?? ""
        MainActor.assumeIsolated {
            ensureOverlay()
            // CGWarp uses global top-left display points — our point space.
            CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
            let ring = 46.0
            let rect = appKitRect(
                axX: x - ring / 2, axY: y - ring / 2, width: ring, height: ring)
            highlightView?.show(rect: rect, label: label.isEmpty ? nil : label)
            if let card = cardView, !label.isEmpty {
                card.configure(title: label, subtitle: nil)
                card.setFrameOrigin(
                    anchorOrigin(axX: x, axY: y, cardSize: card.frame.size))
                card.isHidden = false
            }
            overlay?.orderFrontRegardless()
        }
        return ["ok": true]
    }

    // MARK: - Main-actor internals

    @MainActor
    private func ensureOverlay() {
        guard overlay == nil else { return }
        let frame = NSScreen.screens.first?.frame ?? .zero
        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true // click-through
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false

        let content = NSView(frame: frame)
        content.wantsLayer = true
        panel.contentView = content

        let highlight = CueHighlightView(frame: frame)
        highlight.autoresizingMask = [.width, .height]
        content.addSubview(highlight)
        highlightView = highlight

        let card = CueGuideCardView()
        card.isHidden = true
        content.addSubview(card)
        cardView = card

        panel.orderFrontRegardless()
        overlay = panel
    }

    /// Voice configuration (API keys) pushed from the app. Keys are never
    /// embedded — the user enters them in Cue's settings.
    func setVoiceConfig(params: [String: Any]) -> [String: Any] {
        let assemblyAiKey = params["assemblyAiKey"] as? String
        let elevenLabsKey = params["elevenLabsKey"] as? String
        let voiceId = params["elevenLabsVoiceId"] as? String
        MainActor.assumeIsolated {
            voice.setConfig(
                assemblyAiKey: assemblyAiKey,
                elevenLabsKey: elevenLabsKey,
                voiceId: voiceId)
        }
        return ["ok": true]
    }

    /// Speak text aloud via ElevenLabs (no-op if no key configured).
    func speak(params: [String: Any]) -> [String: Any] {
        let text = params["text"] as? String ?? ""
        MainActor.assumeIsolated {
            if !text.isEmpty { voice.speak(text) }
        }
        return ["ok": voice.canSpeak]
    }

    /// Wire push-to-talk: hold ctrl+option to talk, release to ask. Gated on
    /// Accessibility (same as the hotkey), so it's set up from
    /// `installHotkeyMonitors`. Idempotent.
    @MainActor
    private func installVoice() {
        guard !voiceWired else { return }
        voiceWired = true
        voice.onTranscript = { [weak self] question in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    // Empty transcript → fall back to the default screen look.
                    self.ensureOverlay()
                    self.emitSummon(question: question.isEmpty ? nil : question)
                }
            }
        }
        let monitor = CuePushToTalkMonitor()
        monitor.onPressed = { [weak self] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.voice.startListening() }
            }
        }
        monitor.onReleased = { [weak self] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.voice.stopListening() }
            }
        }
        monitor.start()
        pttMonitor = monitor
    }

    @MainActor
    private func installHotkeyMonitors() {
        installVoice()
        guard hotkeyMonitor == nil else { return }
        // Control+Option+Space summons Cue (mirrors clicky's Control+Option).
        func matches(_ event: NSEvent) -> Bool {
            event.keyCode == 49 // Space
                && event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                    .isSuperset(of: [.control, .option])
        }
        hotkeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, matches(event) else { return }
            self.emitSummon()
        }
        localHotkeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, matches(event) else { return event }
            self.emitSummon()
            return nil
        }
    }

    @MainActor
    private func removeHotkeyMonitors() {
        if let hotkeyMonitor { NSEvent.removeMonitor(hotkeyMonitor) }
        if let localHotkeyMonitor { NSEvent.removeMonitor(localHotkeyMonitor) }
        hotkeyMonitor = nil
        localHotkeyMonitor = nil
    }

    @MainActor
    private func emitSummon(question: String? = nil) {
        let mouse = NSEvent.mouseLocation
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        var params: [String: Any] = [
            "x": mouse.x,
            "y": screenHeight - mouse.y, // report AX top-left coords
        ]
        if let question, !question.isEmpty { params["question"] = question }
        emit("cuelive.summoned", params)
    }

    /// Convert AX (top-left) element rect to AppKit (bottom-left) screen rect.
    @MainActor
    private func appKitRect(axX: Double, axY: Double, width: Double, height: Double) -> NSRect {
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSRect(x: axX, y: screenHeight - axY - height, width: width, height: height)
    }

    /// Place the card just below-right of the AX anchor, clamped on-screen.
    @MainActor
    private func anchorOrigin(axX: Double, axY: Double, cardSize: NSSize) -> NSPoint {
        let screen = NSScreen.screens.first?.frame ?? .zero
        let appKitY = Double(screen.height) - axY
        var x = axX + 16
        var y = appKitY - Double(cardSize.height) - 16
        x = min(max(8, x), Double(screen.width) - Double(cardSize.width) - 8)
        y = min(max(8, y), Double(screen.height) - Double(cardSize.height) - 8)
        return NSPoint(x: x, y: y)
    }

    private func pointFrom(_ params: [String: Any]) -> (x: Double, y: Double) {
        (x: params["x"] as? Double ?? 200, y: params["y"] as? Double ?? 200)
    }

    private func axString(_ element: AXUIElement, _ attr: String) -> String? {
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success,
            let str = value as? String,
            !str.isEmpty
        else { return nil }
        return str
    }

    private func axFrame(_ element: AXUIElement) -> CGRect? {
        var posValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue) == .success,
            AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
            let posAX = posValue, let sizeAX = sizeValue,
            CFGetTypeID(posAX) == AXValueGetTypeID(),
            CFGetTypeID(sizeAX) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posAX as! AXValue, .cgPoint, &point)
        AXValueGetValue(sizeAX as! AXValue, .cgSize, &size)
        return CGRect(origin: point, size: size)
    }
}

// MARK: - Cue-styled views (BRAND.md tokens)

/// Ink "next move" card with the Cue-blue accent stripe + a small aperture mark.
private final class CueGuideCardView: NSView {
    private let titleLabel = NSTextField(labelWithString: "")
    private let subtitleLabel = NSTextField(labelWithString: "")

    // BRAND.md: slate ink #1A2230, electric blue #3D6EE8, on-ink muted #9DB4E6.
    private static let ink = NSColor(srgbRed: 0x1A / 255, green: 0x22 / 255, blue: 0x30 / 255, alpha: 1)
    private static let blue = NSColor(srgbRed: 0x3D / 255, green: 0x6E / 255, blue: 0xE8 / 255, alpha: 1)
    private static let muted = NSColor(srgbRed: 0x9D / 255, green: 0xB4 / 255, blue: 0xE6 / 255, alpha: 1)

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 84))
        wantsLayer = true
        layer?.backgroundColor = Self.ink.cgColor
        layer?.cornerRadius = 14
        layer?.masksToBounds = true

        let stripe = NSView(frame: NSRect(x: 0, y: 0, width: 3, height: bounds.height))
        stripe.autoresizingMask = [.height]
        stripe.wantsLayer = true
        stripe.layer?.backgroundColor = Self.blue.cgColor
        addSubview(stripe)

        let aperture = CueApertureLayer()
        aperture.frame = NSRect(x: 16, y: 42, width: 22, height: 22)
        layer?.addSublayer(aperture)

        titleLabel.font = .systemFont(ofSize: 13, weight: .medium)
        titleLabel.textColor = .white
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.frame = NSRect(x: 48, y: 44, width: 220, height: 18)
        addSubview(titleLabel)

        subtitleLabel.font = .systemFont(ofSize: 11, weight: .regular)
        subtitleLabel.textColor = Self.muted
        subtitleLabel.lineBreakMode = .byTruncatingTail
        subtitleLabel.frame = NSRect(x: 48, y: 16, width: 220, height: 24)
        addSubview(subtitleLabel)
    }

    required init?(coder: NSCoder) { nil }

    func configure(title: String, subtitle: String?) {
        titleLabel.stringValue = title
        subtitleLabel.stringValue = subtitle ?? ""
        subtitleLabel.isHidden = (subtitle ?? "").isEmpty
    }
}

/// Draws the Cue aperture mark (a light "c" arc + blue pupil) in a small box.
private final class CueApertureLayer: CALayer {
    override init() {
        super.init()
        let ring = CAShapeLayer()
        let path = CGMutablePath()
        path.addArc(center: CGPoint(x: 11, y: 11), radius: 8,
                    startAngle: .pi * 0.35, endAngle: .pi * 0.05, clockwise: true)
        ring.path = path
        ring.strokeColor = NSColor(white: 0.94, alpha: 1).cgColor
        ring.fillColor = NSColor.clear.cgColor
        ring.lineWidth = 3
        ring.lineCap = .round
        addSublayer(ring)

        let pupil = CAShapeLayer()
        pupil.path = CGPath(ellipseIn: CGRect(x: 13, y: 6, width: 5, height: 5), transform: nil)
        pupil.fillColor = NSColor(srgbRed: 0x3D / 255, green: 0x6E / 255, blue: 0xE8 / 255, alpha: 1).cgColor
        addSublayer(pupil)
    }

    override init(layer: Any) { super.init(layer: layer) }
    required init?(coder: NSCoder) { nil }
}

/// A Cue-blue ring tracing an element's bounds, with an optional mono label.
private final class CueHighlightView: NSView {
    private var rect: NSRect?
    private var label: String?

    func show(rect: NSRect, label: String?) {
        self.rect = rect.insetBy(dx: -3, dy: -3)
        self.label = label
        needsDisplay = true
    }

    func clear() {
        rect = nil
        label = nil
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let rect else { return }
        let blue = NSColor(srgbRed: 0x3D / 255, green: 0x6E / 255, blue: 0xE8 / 255, alpha: 1)
        let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
        path.lineWidth = 2
        blue.setStroke()
        path.stroke()

        if let label, !label.isEmpty {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .medium),
                .foregroundColor: NSColor.white,
            ]
            let size = (label as NSString).size(withAttributes: attrs)
            let bg = NSRect(x: rect.minX, y: rect.maxY + 2, width: size.width + 10, height: size.height + 6)
            NSColor(srgbRed: 0x1A / 255, green: 0x22 / 255, blue: 0x30 / 255, alpha: 1).setFill()
            NSBezierPath(roundedRect: bg, xRadius: 4, yRadius: 4).fill()
            (label as NSString).draw(at: NSPoint(x: bg.minX + 5, y: bg.minY + 3), withAttributes: attrs)
        }
    }
}
