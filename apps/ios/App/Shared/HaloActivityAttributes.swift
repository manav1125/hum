// Shared between the App target and the CueWidgets extension — each compiles
// its own copy, the standard ActivityKit pattern.
//
// The Halo Live Activity: what the lock screen and the Dynamic Island say
// while Halo is on. Design: E5's Island states + R6.

#if canImport(ActivityKit)
import ActivityKit
#endif
import SwiftUI

#if canImport(ActivityKit)

/// Halo, on the lock screen and in the Island.
///
/// Three rules govern every string in here, and all three come from the same
/// place — this surface is visible to anyone who glances at the phone:
///
///  1. **Participle only, never content.** "Wearing" and a lag number. Never
///     a snippet, never a name, never what was said. A lock screen that
///     quotes somebody's meeting is a privacy incident on a table.
///  2. **The timer never claims a live mic.** It counts recorded segments and
///     phrases itself as "3m behind", because Halo is always a little behind
///     the room and the Island is the smallest place that could accidentally
///     imply otherwise.
///  3. **The moving number is the liveness signal.** In the minimal Island
///     presentation there is room for a dot and almost nothing else, so the
///     lag is what survives — a static label would look identical whether the
///     device was working or dead.
@available(iOS 16.2, *)
struct HaloActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Seconds behind the room. Nil when nothing has arrived — rendered
        /// as "—", never as zero.
        var behindSeconds: Int?
        var phase: HaloActivityPhase
        /// Chapters heard so far today. A count of real things or nothing.
        var chapters: Int
    }

    /// Fixed for the activity's lifetime.
    var startedAt: Date
}

/// What Halo is doing, in the only four states worth showing this small.
@available(iOS 16.2, *)
enum HaloActivityPhase: String, Codable, Hashable {
    case recording
    case paused
    /// Out of range: still recording, catching up later. Amber, not red.
    case outOfRange
    /// Off the record — chosen. The Island shows ◌ and the tint goes dark.
    case offTheRecord

    /// Reserved red is recording and only recording, on every surface.
    var tint: Color {
        switch self {
        case .recording: return Color(red: 0.898, green: 0.404, blue: 0.357)
        case .paused: return Color.white.opacity(0.45)
        case .outOfRange: return Color(red: 1.0, green: 0.72, blue: 0.30)
        case .offTheRecord: return Color.white.opacity(0.30)
        }
    }

    /// The glyph the minimal Island presentation carries.
    var glyph: String {
        switch self {
        case .recording: return "●"
        case .paused: return "❙❙"
        case .outOfRange: return "◐"
        case .offTheRecord: return "◌"
        }
    }

    /// Participle only. Never says what was heard.
    var participle: String {
        switch self {
        case .recording: return "Wearing"
        case .paused: return "Paused"
        case .outOfRange: return "Out of range"
        case .offTheRecord: return "Off the record"
        }
    }
}

/// The lag phrase, duplicated from HaloKit's `HaloSync` on purpose: the widget
/// extension is a separate binary and this is the one string both must agree
/// on. Kept to a single expression so the two cannot drift far, and covered by
/// a test in HaloKit that pins the same outputs.
@available(iOS 16.2, *)
enum HaloActivityCopy {
    /// "3m behind" · "live" · "—". The Island's whole vocabulary.
    static func lagLine(behindSeconds: Int?, phase: HaloActivityPhase) -> String {
        guard phase != .offTheRecord else { return "off" }
        guard let behindSeconds else { return "—" }
        if behindSeconds < 90 { return "live" }
        let minutes = Int((Double(behindSeconds) / 60).rounded())
        if minutes < 60 { return "\(minutes)m behind" }
        return "\(Int((Double(minutes) / 60).rounded()))h behind"
    }

    /// The lock screen's line. Participle plus lag, and nothing else.
    static func lockScreenLine(behindSeconds: Int?, phase: HaloActivityPhase) -> String {
        "\(phase.participle) · \(lagLine(behindSeconds: behindSeconds, phase: phase))"
    }
}

#endif
