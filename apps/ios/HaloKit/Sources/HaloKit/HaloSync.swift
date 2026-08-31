import Foundation

/// The lag, and the three sentences it is allowed to become.
///
/// The product's organizing idea is that Halo is *always a little behind the
/// room, never in it*, and the design wears that number proudly on every
/// surface rather than hiding it. Which makes this small type load-bearing:
/// it is the same number on the card, in the Island, on the Day cover and on
/// the watch, and if any two of them phrase it differently the honesty stops
/// reading as honesty and starts reading as inconsistency.
///
/// So the phrasing lives here, once, and the surfaces choose a length rather
/// than a wording.
public struct HaloSync: Codable, Equatable, Sendable {
    public let state: String
    /// **Null when nothing has ever arrived.** Not zero — a fabricated zero
    /// would claim Cue is current with a room it has never heard.
    public let behindSeconds: Int?
    /// The live strip's last words.
    public let snippet: String?

    public init(state: String, behindSeconds: Int?, snippet: String? = nil) {
        self.state = state
        self.behindSeconds = behindSeconds
        self.snippet = snippet
    }

    public enum State: Equatable, Sendable {
        /// Nothing has arrived. The surface says so; it never prints a number.
        case unknown
        case upToDate
        case behind(seconds: Int)
    }

    public var resolved: State {
        guard let behindSeconds else { return .unknown }
        // The daemon decides the threshold and sends the state; the client
        // trusts it rather than re-deriving one, so the two cannot disagree.
        return state == "up_to_date" ? .upToDate : .behind(seconds: behindSeconds)
    }

    /// The card's line. One of exactly three shapes, and never a fourth.
    public var cardLine: String {
        switch resolved {
        case .unknown: return "not connected"
        case .upToDate: return "up to date"
        case .behind(let seconds): return "synced to \(Self.phrase(seconds)) ago"
        }
    }

    /// The Island's line — the same fact, shorter. The moving number is what
    /// signals liveness, so it is the part that survives the truncation.
    public var islandLine: String {
        switch resolved {
        case .unknown: return "—"
        case .upToDate: return "live"
        case .behind(let seconds): return "\(Self.compact(seconds)) behind"
        }
    }

    /// The Day cover's pill.
    public var coverPill: String {
        switch resolved {
        case .unknown: return "nothing yet"
        case .upToDate: return "up to date"
        case .behind(let seconds): return "\(Self.compact(seconds)) behind"
        }
    }

    /// Out of range is reassurance, not alarm: it is still recording, and the
    /// sync resumes. The wording says so rather than leaving the number to
    /// imply something is broken.
    public func outOfRangeLine() -> String {
        switch resolved {
        case .unknown: return "out of range — still recording"
        case .upToDate: return "up to date"
        case .behind(let seconds):
            return "\(Self.phrase(seconds)) behind · out of range — still recording"
        }
    }

    // MARK: - Phrasing

    /// "3 min", "2 hours" — rounded, never precise to the second. A number
    /// that ticks every second reads as a stopwatch; this is a diary.
    static func phrase(_ seconds: Int) -> String {
        if seconds < 90 { return "just now" }
        let minutes = Int((Double(seconds) / 60).rounded())
        if minutes < 60 { return "\(minutes) min" }
        let hours = Int((Double(minutes) / 60).rounded())
        return hours == 1 ? "1 hour" : "\(hours) hours"
    }

    /// The Island and watch variant: "3m", "2h".
    static func compact(_ seconds: Int) -> String {
        if seconds < 90 { return "0m" }
        let minutes = Int((Double(seconds) / 60).rounded())
        if minutes < 60 { return "\(minutes)m" }
        return "\(Int((Double(minutes) / 60).rounded()))h"
    }
}
