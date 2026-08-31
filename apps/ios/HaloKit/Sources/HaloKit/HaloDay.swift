import Foundation

/// The Day, as the API hands it over.
///
/// Mirrors `GET /v1/halo/days/:date` field for field. Decoding is deliberately
/// forgiving about what may be missing and strict about what may not: a day
/// always has a date and a sync state, and everything the design allows to be
/// absent — the verdict before it is written, a chapter's title before it is
/// understood — is optional here rather than defaulted, because a default
/// would be Cue inventing something it was never told.
public struct HaloDay: Codable, Equatable, Sendable {
    public let date: String
    public let verdict: String?
    /// Seconds actually heard. Qualifies every count below it.
    public let heardSeconds: Int
    public let wornSeconds: Int
    public let firstHeardAt: Int?
    public let lastHeardAt: Int?
    public let closedAt: Int?
    public let sync: HaloSync
    public let counts: Counts
    public let episodes: [HaloEpisode]
    public let gaps: [HaloGap]

    public struct Counts: Codable, Equatable, Sendable {
        public let conversations: Int
        public let marks: Int
        public let places: Int

        public init(conversations: Int, marks: Int, places: Int) {
            self.conversations = conversations
            self.marks = marks
            self.places = places
        }
    }

    public init(
        date: String,
        verdict: String?,
        heardSeconds: Int,
        wornSeconds: Int,
        firstHeardAt: Int?,
        lastHeardAt: Int?,
        closedAt: Int?,
        sync: HaloSync,
        counts: Counts,
        episodes: [HaloEpisode],
        gaps: [HaloGap]
    ) {
        self.date = date
        self.verdict = verdict
        self.heardSeconds = heardSeconds
        self.wornSeconds = wornSeconds
        self.firstHeardAt = firstHeardAt
        self.lastHeardAt = lastHeardAt
        self.closedAt = closedAt
        self.sync = sync
        self.counts = counts
        self.episodes = episodes
        self.gaps = gaps
    }
}

/// A chapter. `title` is nil until understanding has run, and the cover draws
/// the bead either way — a chapter that exists but has not been read yet is a
/// normal state, not a broken one.
public struct HaloEpisode: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let chapterIndex: Int
    public let startedAt: Int
    public let endedAt: Int
    public let placeLabel: String?
    public let title: String?
    public let summary: String?
    public let pullQuote: String?
    public let pullQuoteSpeaker: String?
    public let pullQuoteAt: Int?
    public let keyTakeaways: [Takeaway]
    public let participants: [String]
    /// The words. Absent on the Day cover — which draws episodes, not
    /// transcript — and present when one episode is fetched on its own.
    public let transcript: [Line]?
    public let marks: [HaloMark]

    public struct Line: Codable, Equatable, Sendable {
        public let speaker: String
        public let text: String
        public let at: Int

        public init(speaker: String, text: String, at: Int) {
            self.speaker = speaker
            self.text = text
            self.at = at
        }
    }

    public struct Takeaway: Codable, Equatable, Sendable {
        public let label: String
        public let value: String

        public init(label: String, value: String) {
            self.label = label
            self.value = value
        }
    }

    /// Seconds of wall-clock the chapter spans.
    public var durationSeconds: Int { max(0, (endedAt - startedAt) / 1000) }

    /// S6 ruling 2: beads under five minutes render at 70% so a dense day
    /// reads without crowding.
    public var beadScale: Double { durationSeconds < 300 ? 0.7 : 1.0 }

    public init(
        id: String,
        chapterIndex: Int,
        startedAt: Int,
        endedAt: Int,
        placeLabel: String? = nil,
        title: String? = nil,
        summary: String? = nil,
        pullQuote: String? = nil,
        pullQuoteSpeaker: String? = nil,
        pullQuoteAt: Int? = nil,
        keyTakeaways: [Takeaway] = [],
        participants: [String] = [],
        transcript: [Line]? = nil,
        marks: [HaloMark] = []
    ) {
        self.id = id
        self.chapterIndex = chapterIndex
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.placeLabel = placeLabel
        self.title = title
        self.summary = summary
        self.pullQuote = pullQuote
        self.pullQuoteSpeaker = pullQuoteSpeaker
        self.pullQuoteAt = pullQuoteAt
        self.keyTakeaways = keyTakeaways
        self.participants = participants
        self.transcript = transcript
        self.marks = marks
    }
}

/// The ⚑ and the ✦ — the only two things a person says to Halo by hand.
public struct HaloMark: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let markedAt: Int
    public let words: String?

    public var isNote: Bool { kind == "note" }

    public init(id: String, kind: String = "bookmark", markedAt: Int, words: String? = nil) {
        self.id = id
        self.kind = kind
        self.markedAt = markedAt
        self.words = words
    }
}

/// An absence, and which of the four kinds it is.
///
/// Modelled as an enum with an explicit unknown case rather than a raw string:
/// the arc draws each reason differently, and a reason the client does not
/// recognise must fall back to the most conservative treatment rather than
/// crash or render as "not worn", which would claim something untrue.
public struct HaloGap: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let startedAt: Int
    public let endedAt: Int?
    public let reason: Reason
    public let caption: String?

    public enum Reason: String, Codable, Sendable {
        case notWorn = "not_worn"
        case offTheRecord = "off_the_record"
        case battery
        case forgotten
        /// A reason from a newer daemon. Drawn as a plain gap, never guessed at.
        case unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Reason(rawValue: raw) ?? .unknown
        }
    }

    public init(id: String, startedAt: Int, endedAt: Int?, reason: Reason, caption: String? = nil) {
        self.id = id
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.reason = reason
        self.caption = caption
    }
}
