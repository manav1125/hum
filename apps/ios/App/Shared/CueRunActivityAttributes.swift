// Shared between the App targets and the CueWidgets extension (each target
// compiles its own copy — the standard ActivityKit pattern, both sides must
// agree on the encoded shape).
//
// Models one Cue run ("Booking Bottega / Confirming Thu 7:00pm…") for the
// Live Activity / Dynamic Island surface — mobile-v3 spec frame 4
// (docs/design/mobile-v3/cue-mobile-v3.html).

#if canImport(ActivityKit)
import ActivityKit
#endif
import SwiftUI

#if canImport(ActivityKit)

@available(iOS 16.2, *)
struct CueRunActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// One-line progress narration, e.g. "Confirming Thu 7:00pm…".
        var statusLine: String
        /// 0…1 for the determinate bar; nil hides it.
        var progress: Double?
        /// v3 state-taxonomy key; drives the tint.
        var state: CueRunState
    }

    /// Stable id linking the activity back to the run/work item.
    var runId: String
    /// Run title, e.g. "Booking Bottega". Fixed for the activity's lifetime.
    var title: String
}

/// The v3 state taxonomy (README "Design DNA"): picked up / running are blue,
/// needs-you amber, review violet, done green — red strictly for failure.
@available(iOS 16.2, *)
enum CueRunState: String, Codable, Hashable {
    case pickedUp = "picked_up"
    case running
    case needsYou = "needs_you"
    case review
    case done
    case failed

    /// Dark-palette tints from the spec (the Island is always-dark glass).
    var tint: Color {
        switch self {
        case .pickedUp, .running:
            return Color(red: 0x3D / 255, green: 0x6E / 255, blue: 0xE8 / 255) // #3D6EE8
        case .needsYou:
            return Color(red: 0xE0 / 255, green: 0xA6 / 255, blue: 0x4B / 255) // #E0A64B
        case .review:
            return Color(red: 0xA7 / 255, green: 0x9F / 255, blue: 0xF0 / 255) // #A79FF0
        case .done:
            return Color(red: 0x6F / 255, green: 0xD6 / 255, blue: 0x9A / 255) // #6FD69A
        case .failed:
            return Color(red: 0xE5 / 255, green: 0x67 / 255, blue: 0x5B / 255) // #E5675B
        }
    }

    /// Whether the run is still moving (animated equalizer + live progress).
    var isActive: Bool {
        switch self {
        case .pickedUp, .running: return true
        case .needsYou, .review, .done, .failed: return false
        }
    }
}

/// The Cue mark: an open ring (75% arc, rotated 42° — dasharray 707/236 on
/// r150 in the spec's 512-viewbox SVG) with the blue dot sitting in the gap.
/// NEVER a closed circle. Stroke defaults to the dark-palette text color.
@available(iOS 16.2, *)
struct CueRingMark: View {
    var size: CGFloat = 20
    var stroke: Color = Color(red: 0xF4 / 255, green: 0xF4 / 255, blue: 0xF6 / 255) // #F4F4F6

    private static let dot = Color(red: 0x3D / 255, green: 0x6E / 255, blue: 0xE8 / 255) // #3D6EE8

    var body: some View {
        // Spec geometry (512 viewbox): ring center (232,256) r150 w42,
        // dot center (392,372) r32 — scaled to `size` over the ring's span.
        let scale = size / 300 // ring diameter dominates the mark's bounds
        ZStack {
            Circle()
                .trim(from: 0, to: 707 / (707 + 236)) // open ring, ~75%
                .stroke(stroke, style: StrokeStyle(lineWidth: 42 * scale, lineCap: .round))
                .rotationEffect(.degrees(42))
            Circle()
                .fill(Self.dot)
                .frame(width: 64 * scale, height: 64 * scale)
                .offset(x: (392 - 232) * scale, y: (372 - 256) * scale)
        }
        .frame(width: size, height: size)
    }
}

#endif
