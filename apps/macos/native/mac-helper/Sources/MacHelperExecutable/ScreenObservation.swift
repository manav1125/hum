import AppKit
import Foundation
import os

private let log = Logger(subsystem: "ai.cue.mac-helper", category: "Observe")

/// One read-only look at the focused window, for `observe.screen`.
///
/// ## Why this is not `computeruse.perform`
///
/// The computer-use path is the one that CLICKS AND TYPES. It runs
/// `ActionVerifier`, `ActionExecutor` and a step counter, all of which exist
/// for a loop that acts on the machine. Observation only reads, and routing it
/// through the acting executor would mean a person could not let Cue watch
/// them demonstrate a workflow without also standing up the machinery that can
/// act on it. This reaches `AccessibilityTreeEnumerator` directly — the same
/// read the CU observe phase performs, with nothing that can emit an event.
///
/// ## Accessibility text, not pixels
///
/// The daemon's capture contract prefers AX text: it is cheaper, it is
/// structured, and it never leaves an image of the person's screen anywhere.
/// This returns text only. A screenshot path stays available through
/// `cuelive.captureScreen` for callers that genuinely need pixels, and is
/// deliberately not folded in here — a read that silently also grabs a frame
/// is not the read the caller asked for.
enum ScreenObservation {
    /// Read the frontmost non-self window's accessibility tree.
    ///
    /// Returns `ok: false` with a reason rather than throwing: a failed look
    /// is an ordinary outcome (the screen is locked, the app is unresponsive,
    /// Accessibility is not granted) and the daemon treats every failure the
    /// same way — it skips the tick. Distinguishing them here would only
    /// invite the caller to act on a distinction it does not have.
    static func observe() -> [String: Any] {
        // Non-prompting: a background capture tick must never raise a system
        // dialog. The Accessibility grant is requested at Cue Live start-up,
        // where there is a person present to answer it.
        guard AXIsProcessTrusted() else {
            return ["ok": false, "reason": "accessibility-permission"]
        }

        let enumerator = AccessibilityTreeEnumerator()
        let box = ObservationBox()
        let sem = DispatchSemaphore(value: 0)
        Task {
            box.value = await enumerator.enumerateCurrentWindow()
            sem.signal()
        }
        // Bounded well under the daemon's 10s request timeout so a wedged app
        // surfaces as a clean "could not look" rather than a hung request.
        if sem.wait(timeout: .now() + 5) == .timedOut {
            log.warning("observe timed out reading the focused window")
            return ["ok": false, "reason": "observe-timeout"]
        }

        guard let result = box.value else {
            return ["ok": false, "reason": "no-focused-window"]
        }

        let description = AccessibilityTreeEnumerator.formatAXTree(
            elements: result.elements,
            windowTitle: result.windowTitle,
            appName: result.appName
        )

        return ["ok": true, "description": description, "appName": result.appName]
    }
}

/// Carries the enumerator's result across the Task boundary. The semaphore is
/// the happens-before edge, mirroring `CueLive.captureScreen`'s CaptureBox.
private final class ObservationBox: @unchecked Sendable {
    var value: (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)?
}
