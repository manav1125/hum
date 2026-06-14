import AppKit
import ApplicationServices
import Foundation

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
final class CueLiveController: @unchecked Sendable {
    /// Emits a JSON-RPC notification back to the daemon.
    private let emit: (String, [String: Any]?) -> Void

    @MainActor private var overlay: NSPanel?
    @MainActor private var cardView: CueGuideCardView?
    @MainActor private var highlightView: CueHighlightView?
    @MainActor private var hotkeyMonitor: Any?
    @MainActor private var localHotkeyMonitor: Any?

    init(emit: @escaping (String, [String: Any]?) -> Void) {
        self.emit = emit
    }

    // MARK: - Lifecycle (JSON-RPC entry points)

    func start() -> [String: Any] {
        MainActor.assumeIsolated {
            ensureOverlay()
            installHotkeyMonitors()
        }
        return ["enabled": true]
    }

    func stop() -> [String: Any] {
        MainActor.assumeIsolated {
            removeHotkeyMonitors()
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
                let m = NSEvent.mouseLocation
                return (Double(m.x), Double(m.y), Double(NSScreen.screens.first?.frame.height ?? 0))
            }
        // AX uses a top-left origin; AppKit's mouseLocation is bottom-left.
        let axX = mouseX
        let axY = screenHeight - mouseY

        let system = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        let err = AXUIElementCopyElementAtPosition(
            system, Float(axX), Float(axY), &element
        )
        guard err == .success, let element else {
            return ["found": false]
        }

        let role = axString(element, kAXRoleAttribute) ?? "AXUnknown"
        let isSecure = role == "AXSecureTextField"
        let label = axString(element, kAXTitleAttribute)
            ?? axString(element, kAXDescriptionAttribute)
        let value = isSecure ? nil : axString(element, kAXValueAttribute)

        var result: [String: Any] = ["found": true, "role": role]
        if let label { result["label"] = label }
        if let value { result["value"] = String(value.prefix(240)) }
        if let frame = axFrame(element) {
            result["x"] = frame.origin.x
            result["y"] = frame.origin.y
            result["width"] = frame.size.width
            result["height"] = frame.size.height
        }
        return result
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

    @MainActor
    private func installHotkeyMonitors() {
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
    private func emitSummon() {
        let mouse = NSEvent.mouseLocation
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        emit("cuelive.summoned", [
            "x": mouse.x,
            "y": screenHeight - mouse.y, // report AX top-left coords
        ])
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
