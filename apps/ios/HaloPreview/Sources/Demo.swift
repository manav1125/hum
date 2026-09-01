import SwiftUI
import HaloKit

/// A day worth showing — the demo data behind the walkthrough.
///
/// Written as one coherent Tuesday rather than a set of disconnected samples,
/// because the point of a walkthrough is that the pieces refer to each other:
/// the promise you make at 10:12 is the proposal in the queue, the mark you
/// press at 13:47 is the loudest thing on the Day, and the recap's receipts
/// name the same mission the dock flew a card into.
///
/// It is also what an App Store reviewer needs. Halo cannot be evaluated by
/// tapping around an empty account — the surfaces are *about* a day, and with
/// no day they render their honest-empty states, which look like a broken app
/// to somebody who has never seen a full one.
enum Demo {
    static func at(_ hour: Int, _ minute: Int = 0) -> Int {
        var parts = DateComponents()
        parts.year = 2026; parts.month = 9; parts.day = 1
        parts.hour = hour; parts.minute = minute
        return Int(Calendar.current.date(from: parts)!.timeIntervalSince1970 * 1000)
    }

    /// 4:40pm — late enough that the day has a shape, early enough that the
    /// arc still has an unwritten tail to show.
    static var now: Date { Date(timeIntervalSince1970: Double(at(16, 40)) / 1000) }

    // MARK: - Episodes

    static var standup: HaloEpisode {
        HaloEpisode(
            id: "d1", chapterIndex: 1, startedAt: at(9, 12), endedAt: at(9, 34),
            placeLabel: "HOME",
            title: "Standup, and the Vercel bill",
            summary: "Sprint scope cut to eight. The bill question went unanswered.",
            participants: ["Priya"]
        )
    }

    static var acme: HaloEpisode {
        HaloEpisode(
            id: "d2", chapterIndex: 2, startedAt: at(10, 12), endedAt: at(10, 52),
            placeLabel: "VERVE ☕",
            title: "Acme landed on 24 months",
            summary: "The floor held at $47. Dana takes it to her side this week.",
            pullQuote: "If the floor holds at 47, I can take 24 months to my side this week.",
            pullQuoteSpeaker: "Dana",
            pullQuoteAt: at(10, 31),
            keyTakeaways: [
                .init(label: "Price", value: "floor holds at $47/seat"),
                .init(label: "Term", value: "24 months, her side signs this week"),
                .init(label: "You owe", value: "the one-pager before Thursday")
            ],
            participants: ["Dana"],
            transcript: [
                .init(speaker: "Dana", text: "So where did legal land on the term?", at: at(10, 12)),
                .init(speaker: "You", text: "Rachel cleared it yesterday. It's the price that's open.", at: at(10, 14)),
                .init(speaker: "Dana", text: "If the floor holds at 47, I can take 24 months to my side this week.", at: at(10, 31)),
                .init(speaker: "You", text: "I'll get you the one-pager before Thursday.", at: at(10, 44))
            ]
        )
    }

    static var walk: HaloEpisode {
        HaloEpisode(
            id: "d3", chapterIndex: 3, startedAt: at(13, 47), endedAt: at(13, 53),
            placeLabel: "WALKING",
            marks: [
                HaloMark(id: "dm1", markedAt: at(13, 47),
                         words: "Check whether the Vercel bill doubled")
            ]
        )
    }

    static var airtel: HaloEpisode {
        HaloEpisode(
            id: "d4", chapterIndex: 4, startedAt: at(15, 20), endedAt: at(15, 58),
            placeLabel: "OFFICE",
            title: "Tom wants the Airtel deck by Friday",
            summary: "He is waiting on a read, not a rewrite.",
            pullQuote: "Just tell me if page four holds up, that's all I need.",
            pullQuoteSpeaker: "Tom",
            pullQuoteAt: at(15, 31),
            keyTakeaways: [
                .init(label: "Owed", value: "a read of the deck, by Friday"),
                .init(label: "Not owed", value: "a rewrite")
            ],
            participants: ["Tom"]
        )
    }

    // MARK: - The day

    static var day: HaloDay {
        HaloDay(
            date: "2026-09-01",
            verdict: "The morning found Acme its number.",
            heardSeconds: 6 * 3600, wornSeconds: 8 * 3600,
            firstHeardAt: at(9, 12), lastHeardAt: at(15, 58), closedAt: nil,
            sync: HaloSync(state: "behind", behindSeconds: 190,
                           snippet: "…so if the floor holds we can still make Thursday…"),
            counts: .init(conversations: 4, marks: 1, places: 4),
            episodes: [standup, acme, walk, airtel],
            // Two absences of different kinds, so the arc shows the grammar.
            gaps: [
                HaloGap(id: "dg1", startedAt: at(11, 10), endedAt: at(12, 40),
                        reason: .notWorn, caption: "not worn over lunch"),
                HaloGap(id: "dg2", startedAt: at(14, 10), endedAt: at(14, 55),
                        reason: .offTheRecord, caption: "off the record · 45 min")
            ]
        )
    }

    // MARK: - Proposals

    static var proposals: [HaloProposal] {
        [
            HaloProposal(
                id: "dp1", title: "Send the one-pager to Dana by Thursday",
                verb: .file, destinationLabel: "Renew Acme", confidenceTier: .confident,
                episodeId: "d2",
                heard: .init(quote: "I'll get you the one-pager before Thursday",
                             at: at(10, 44), place: "Verve", speaker: "You")
            ),
            HaloProposal(
                id: "dp2", title: "Read page four of the Airtel deck for Tom",
                verb: .draft, destinationLabel: "Tom", confidenceTier: .confident,
                episodeId: "d4",
                heard: .init(quote: "Just tell me if page four holds up, that's all I need.",
                             at: at(15, 31), place: "Office", speaker: "Tom")
            ),
            HaloProposal(
                id: "dp3", title: "Check whether the Vercel bill doubled",
                verb: .schedule, destinationLabel: "Tomorrow morning", confidenceTier: .confident,
                episodeId: "d3",
                heard: .init(quote: nil, at: at(13, 47), place: "walking", speaker: "You")
            ),
            HaloProposal(
                id: "dp4", title: "Someone mentioned reordering the coffee beans",
                verb: .note, destinationLabel: nil, confidenceTier: .unsure,
                heard: .init(quote: nil, at: at(9, 30), place: "Home", speaker: nil)
            ),
            HaloProposal(
                id: "dp5", title: "A physio appointment, possibly Thursday",
                verb: .note, destinationLabel: nil, confidenceTier: .unsure,
                heard: .init(quote: nil, at: at(12, 50), place: nil, speaker: nil)
            )
        ]
    }

    static var ledger: HaloLedger { HaloLedger(proposed: 5, accepted: 34, dismissed: 7) }

    static var receipts: [DayCloseView.Receipt] {
        [
            .init(id: "dr1", glyph: "✓",
                  text: "2 filed to missions — both already moving",
                  destination: "Ops picked one up ›"),
            .init(id: "dr2", glyph: "⚑",
                  text: "Your Vercel flag → tomorrow's brief",
                  destination: "7:30 ›"),
            .init(id: "dr3", glyph: "👤",
                  text: "Dana's page grew — pricing stance saved",
                  destination: "view ›")
        ]
    }
}

// MARK: - The home shelf and the week

extension Demo {
    /// A fortnight, including two days nobody wore — the shelf only reads as
    /// a record of a life if it can show the days you didn't.
    static var shelf: [DaysGalleryView.DayTile] {
        [
            .init(id: "s1", label: "TODAY",
                  verdict: "The morning found Acme its number",
                  conversations: 4, marks: 1, openProposals: 2, filed: 0,
                  worn: true, skyHour: 10),
            .init(id: "s2", label: "MON",
                  verdict: "Board prep, and Tom called twice",
                  conversations: 9, marks: 0, openProposals: 0, filed: 3,
                  worn: true, skyHour: 15),
            .init(id: "s3", label: "SUN", verdict: nil,
                  conversations: 0, marks: 0, openProposals: 0, filed: 0,
                  worn: false, skyHour: 12),
            .init(id: "s4", label: "SAT",
                  verdict: "A quiet Saturday — one good idea on the walk home",
                  conversations: 2, marks: 1, openProposals: 1, filed: 0,
                  worn: true, skyHour: 18),
            .init(id: "s5", label: "FRI",
                  verdict: "The sprint got its cut before lunch",
                  conversations: 7, marks: 0, openProposals: 0, filed: 2,
                  worn: true, skyHour: 9),
            .init(id: "s6", label: "THU", verdict: nil,
                  conversations: 0, marks: 0, openProposals: 0, filed: 0,
                  worn: false, skyHour: 21),
        ]
    }

    static var learned: DaysGalleryView.Learned {
        .init(days: 28, things: 214)
    }

    static var weekRhythm: [WeekView.DayBar] {
        [
            .init(id: "m", letter: "M", conversations: 6, filed: 2, worn: true),
            .init(id: "t", letter: "T", conversations: 4, filed: 1, worn: true),
            .init(id: "w", letter: "W", conversations: 11, filed: 3, worn: true),
            .init(id: "t2", letter: "T", conversations: 5, filed: 0, worn: true),
            .init(id: "f", letter: "F", conversations: 7, filed: 2, worn: true),
            .init(id: "s", letter: "S", conversations: 2, filed: 1, worn: true),
            .init(id: "s2", letter: "S", conversations: 0, filed: 0, worn: false),
        ]
    }

    static var weekInsights: [WeekView.Insight] {
        [
            .init(id: "w1", glyph: "↗",
                  headline: "You keep your promises fast",
                  evidence: "9 of 11 things you said you'd do this week were done within a day.",
                  verb: "See the 2 open"),
            .init(id: "w2", glyph: "◔",
                  headline: "Thursday afternoons vanish",
                  evidence: "Three weeks running, 2–5pm Thursday is back-to-back and nothing gets filed.",
                  verb: "Block it weekly"),
            .init(id: "w3", glyph: "👤",
                  headline: "Sarah's gone quiet on you",
                  evidence: "You mentioned the data room twice in person — still no reply sent.",
                  verb: "Draft it"),
        ]
    }
}
