import Foundation

/// A proposal — something Cue thinks should happen, waiting for a ✓.
///
/// Mirrors `GET /v1/halo/proposals`. Two fields carry design rules rather
/// than data:
///
/// `destinationLabel` is what the accept chip **prints before you tap it**
/// ("▤ File to Renew Acme"). A destination resolved on the way out would make
/// the dock animation a claim rather than a description of what happened.
///
/// `confidenceTier` is a tier and never a number. An unsure proposal waits
/// behind the fold instead of diluting the queue; "82% sure" is a fact about
/// the model, not about the owner's work, and the moment a percentage exists
/// somebody prints it.
public struct HaloProposal: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let owner: String?
    public let verb: Verb
    public let destinationLabel: String?
    public let confidenceTier: Tier
    public let episodeId: String?
    /// The ◉ heard pill — the same object in HQ, in missions, in chat.
    public let heard: Heard

    public enum Verb: String, Codable, Sendable {
        case file, draft, schedule, note

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Verb(rawValue: raw) ?? .file
        }

        /// The chip's glyph, from the frames.
        public var glyph: String {
            switch self {
            case .file: return "▤"
            case .draft: return "✉"
            case .schedule: return "◷"
            case .note: return "📓"
            }
        }

        /// What the chip says, with its destination named.
        public func chipLabel(destination: String?) -> String {
            switch self {
            case .file:
                return destination.map { "\(glyph) File to \($0)" } ?? "\(glyph) File it"
            case .draft:
                return destination.map { "\(glyph) Draft it for \($0)" } ?? "\(glyph) Draft it"
            case .schedule:
                return destination.map { "\(glyph) \($0)" } ?? "\(glyph) Schedule it"
            case .note:
                return "\(glyph) Just a note"
            }
        }

        /// S6 ruling 3: a draft opens the composer with the real draft in it;
        /// the dock fires on send or park, never on ✓. The thing that docks
        /// has to be the real artifact.
        public var opensComposer: Bool { self == .draft }
    }

    public enum Tier: String, Codable, Sendable {
        case confident, unsure

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Tier(rawValue: raw) ?? .unsure
        }

        /// Unsure proposals wait behind the fold rather than diluting the queue.
        public var isBehindTheFold: Bool { self == .unsure }
    }

    public struct Heard: Codable, Equatable, Sendable {
        public let quote: String?
        public let at: Int?
        public let place: String?
        public let speaker: String?

        public init(quote: String?, at: Int?, place: String?, speaker: String?) {
            self.quote = quote
            self.at = at
            self.place = place
            self.speaker = speaker
        }

        /// "◉ heard · 10:31 · Verve" — the pill, as one line.
        ///
        /// Built from whatever is actually known: a proposal whose quote could
        /// not be verified against the transcript arrives without one, and the
        /// pill shows the time and place rather than inventing words.
        public var pillLine: String {
            var parts = ["◉ heard"]
            if let at {
                let formatter = DateFormatter()
                formatter.dateFormat = "HH:mm"
                parts.append(formatter.string(from: Date(timeIntervalSince1970: Double(at) / 1000)))
            }
            if let place { parts.append(place) }
            return parts.joined(separator: " · ")
        }
    }

    public init(
        id: String,
        title: String,
        owner: String? = nil,
        verb: Verb = .file,
        destinationLabel: String? = nil,
        confidenceTier: Tier = .confident,
        episodeId: String? = nil,
        heard: Heard
    ) {
        self.id = id
        self.title = title
        self.owner = owner
        self.verb = verb
        self.destinationLabel = destinationLabel
        self.confidenceTier = confidenceTier
        self.episodeId = episodeId
        self.heard = heard
    }
}

/// The queue's footer — "34 accepted · 7 dismissed · Cue is learning your bar".
public struct HaloLedger: Codable, Equatable, Sendable {
    public let proposed: Int
    public let accepted: Int
    public let dismissed: Int

    public init(proposed: Int, accepted: Int, dismissed: Int) {
        self.proposed = proposed
        self.accepted = accepted
        self.dismissed = dismissed
    }

    /// The trust ledger line. Says nothing until there is something true to
    /// say — a fresh install must not claim a bar it has not learned.
    public var line: String? {
        guard accepted + dismissed > 0 else { return nil }
        return "\(accepted) accepted · \(dismissed) dismissed · Cue is learning your bar"
    }
}
