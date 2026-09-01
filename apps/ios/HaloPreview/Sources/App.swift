import SwiftUI
import HaloKit

/// Three tabs, one per surface, so every render can be compared to its frame.
@main
struct HaloPreviewApp: App {
    var body: some Scene {
        WindowGroup {
            // HALO_SURFACE=walk opens the guided click-through; anything else
            // opens the surface switcher for working on one screen at a time.
            if ProcessInfo.processInfo.environment["HALO_SURFACE"] == "walk" {
                Walkthrough()
            } else {
                Switcher()
            }
        }
    }
}

/// A switcher rather than a TabView: the surfaces paint their sky edge to
/// edge, which swallows a system tab bar, and the harness should not make the
/// views compromise to be looked at.
struct Switcher: View {
    /// Which surface to open on. Set from the launch environment so a
    /// screenshot run can target one surface without tapping:
    /// `SIMCTL_CHILD_HALO_SURFACE=1 xcrun simctl launch …`
    @State private var surface = Int(
        ProcessInfo.processInfo.environment["HALO_SURFACE"] ?? "0"
    ) ?? 0

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                switch surface {
                case 0: DayCoverView(day: .sample, now: Sample.now)
                case 1: EpisodeView(episode: Sample.episode, proposals: Sample.proposals)
                case 2: CardGallery()
                case 3: QueueView(proposals: Sample.queue, ledger: Sample.ledger)
                case 4: TileStage()
                case 5: DayCloseView(day: .sample, receipts: Sample.receipts)
                case 6: OnboardingStage()
                default: IslandStage()
                }
            }

            HStack(spacing: 0) {
                ForEach(Array(["Day", "Ep", "Card", "Queue", "Tile", "Close", "Set", "Isle"].enumerated()), id: \.offset) { index, label in
                    Button { surface = index } label: {
                        Text(label)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(surface == index ? .white : .white.opacity(0.5))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(.ultraThinMaterial)
            .clipShape(Capsule())
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .preferredColorScheme(.dark)
    }
}

/// Every card state at once — the ten H5 states are the ones most likely to
/// rot, because each is rare in real use and easy to never look at.
struct CardGallery: View {
    private let sync = HaloSync(state: "behind", behindSeconds: 190)

    private let states: [(String, HaloCardState)] = [
        ("recording", .recording),
        ("paused", .paused),
        ("out of range", .outOfRange),
        ("battery low", .batteryLow(percent: 8)),
        ("storage full", .storageFull),
        ("understanding down", .understandingUnavailable),
        ("quiet day", .quietDay),
        ("never paired", .neverPaired),
        ("bluetooth denied", .bluetoothDenied)
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                ForEach(states, id: \.0) { label, state in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(label.uppercased())
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                        HaloCardView(state: state, sync: sync, batteryPercent: 62)
                    }
                }
            }
            .padding(20)
        }
        .background(SkyClock.at(hour: 21).gradient.ignoresSafeArea())
    }
}

/// The Island's four phases, drawn at their real sizes.
///
/// The Live Activity itself only renders inside a real activity session, so
/// this stages the same strings and tints the widget uses — which is where the
/// mistakes would be anyway: a lock screen that quotes somebody's meeting, or
/// a timer that implies a live mic.
struct IslandStage: View {
    private struct Phase: Identifiable {
        let id: String
        let glyph: String
        let participle: String
        let lag: String
        let tint: Color
    }

    private let phases: [Phase] = [
        .init(id: "rec", glyph: "●", participle: "Wearing", lag: "3m behind",
              tint: Color(red: 0.898, green: 0.404, blue: 0.357)),
        .init(id: "pause", glyph: "❙❙", participle: "Paused", lag: "3m behind",
              tint: .white.opacity(0.45)),
        .init(id: "range", glyph: "◐", participle: "Out of range", lag: "22m behind",
              tint: Color(red: 1.0, green: 0.72, blue: 0.30)),
        .init(id: "otr", glyph: "◌", participle: "Off the record", lag: "off",
              tint: .white.opacity(0.30))
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                ForEach(phases) { phase in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(phase.id.uppercased())
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.35))

                        // Lock screen
                        HStack(spacing: 11) {
                            Text(phase.glyph).font(.system(size: 14))
                                .foregroundStyle(phase.tint)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(phase.participle) · \(phase.lag)")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(.white)
                                Text("3 conversations today")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.white.opacity(0.6))
                            }
                            Spacer()
                        }
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 18).fill(.white.opacity(0.08)))

                        // Compact Island
                        HStack {
                            Spacer()
                            HStack(spacing: 8) {
                                Text(phase.glyph).font(.system(size: 12))
                                    .foregroundStyle(phase.tint)
                                Text(phase.lag)
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.75))
                            }
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(Capsule().fill(.black))
                            Spacer()
                        }
                    }
                }
            }
            .padding(20)
            .padding(.bottom, 60)
        }
        .background(Color(red: 0.05, green: 0.05, blue: 0.08).ignoresSafeArea())
    }
}

/// Onboarding, steppable, so the whole shape can be walked.
struct OnboardingStage: View {
    @State private var index = HaloOnboardingStep.promise.rawValue
    @State private var transcript: String?

    var body: some View {
        let step = HaloOnboardingStep(rawValue: index) ?? .promise
        OnboardingView(
            step: step,
            firstCaptureTranscript: transcript,
            onPrimary: { advance(from: step) },
            onSecondary: { advance(from: step) }
        )
    }

    /// Advance, and simulate the first capture landing a beat later so the
    /// disabled-Continue state is actually visible in the harness.
    private func advance(from step: HaloOnboardingStep) {
        index = min(index + 1, HaloOnboardingStep.allCases.count - 1)
        guard HaloOnboardingStep(rawValue: index) == .firstCapture else { return }
        transcript = nil
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            transcript = "Right, so the one-pager for Dana before Thursday."
        }
    }
}

/// The tile on a ground, so its own sky can be seen against Today's.
struct TileStage: View {
    var body: some View {
        VStack {
            Spacer()
            TodayTileView(
                day: .sample, now: Sample.now, isRecording: true,
                topProposal: Sample.queue.first
            )
            .padding(.horizontal, 16)
            Spacer()
        }
        .background(Color(red: 0.06, green: 0.06, blue: 0.09).ignoresSafeArea())
    }
}

enum Sample {
    static var receipts: [DayCloseView.Receipt] {
        [
            .init(id: "r1", glyph: "✓",
                  text: "2 filed to missions — both already moving",
                  destination: "Ops picked one up ›"),
            .init(id: "r2", glyph: "⚑",
                  text: "Your Vercel flag → tomorrow's brief",
                  destination: "7:30 ›"),
            .init(id: "r3", glyph: "👤",
                  text: "Dana's page grew — pricing stance saved",
                  destination: "view ›")
        ]
    }

    static var ledger: HaloLedger { HaloLedger(proposed: 5, accepted: 34, dismissed: 7) }

    static var queue: [HaloProposal] {
        [
            HaloProposal(
                id: "q1", title: "Send the one-pager to Dana by Thursday",
                verb: .file, destinationLabel: "Renew Acme", confidenceTier: .confident,
                heard: .init(quote: "I'll get you the one-pager before Thursday",
                             at: at(10, 44), place: "Verve", speaker: "You")
            ),
            HaloProposal(
                id: "q2", title: "Have Ops draft the Airtel reply for Tom",
                verb: .draft, destinationLabel: "Tom", confidenceTier: .confident,
                heard: .init(quote: "Tell him we will look at the deck this weekend",
                             at: at(16, 20), place: "phone call", speaker: "You")
            ),
            HaloProposal(
                id: "q3", title: "Check whether the Vercel bill doubled",
                verb: .schedule, destinationLabel: "Tomorrow morning", confidenceTier: .confident,
                heard: .init(quote: nil, at: at(13, 47), place: "walking", speaker: "You")
            ),
            HaloProposal(
                id: "q4", title: "Maybe reorder the coffee beans",
                verb: .note, destinationLabel: nil, confidenceTier: .unsure,
                heard: .init(quote: nil, at: at(9, 5), place: "Home", speaker: "You")
            ),
            HaloProposal(
                id: "q5", title: "Someone mentioned a physio appointment",
                verb: .note, destinationLabel: nil, confidenceTier: .unsure,
                heard: .init(quote: nil, at: at(12, 2), place: nil, speaker: nil)
            )
        ]
    }

    static func at(_ hour: Int, _ minute: Int = 0) -> Int {
        var parts = DateComponents()
        parts.year = 2026; parts.month = 8; parts.day = 30
        parts.hour = hour; parts.minute = minute
        return Int(Calendar.current.date(from: parts)!.timeIntervalSince1970 * 1000)
    }

    /// 2:12pm — the hour E1 draws, so sky and arc match the frame.
    static var now: Date { Date(timeIntervalSince1970: Double(at(14, 12)) / 1000) }

    static var episode: HaloEpisode {
        HaloEpisode(
            id: "e2", chapterIndex: 2, startedAt: at(10, 12), endedAt: at(10, 52),
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
                .init(speaker: "Dana", text: "If the floor holds at 47, I can take 24 months to my side this week.", at: at(10, 31))
            ]
        )
    }

    static var proposals: [HaloProposal] {
        [
            HaloProposal(
                id: "p1", title: "Send the one-pager to Dana by Thursday",
                verb: .file, destinationLabel: "Renew Acme", confidenceTier: .confident,
                episodeId: "e2",
                heard: .init(quote: "I'll get you the one-pager before Thursday",
                             at: at(10, 44), place: "Verve", speaker: "You")
            ),
            HaloProposal(
                id: "p2", title: "Memory: Dana — pricing via email only",
                verb: .note, destinationLabel: nil, confidenceTier: .unsure,
                episodeId: "e2",
                heard: .init(quote: nil, at: at(10, 48), place: "Verve", speaker: "Dana")
            )
        ]
    }
}

extension HaloDay {
    static var sample: HaloDay {
        HaloDay(
            date: "2026-08-30",
            verdict: "The morning found Acme its number.",
            heardSeconds: 5 * 3600, wornSeconds: 8 * 3600,
            firstHeardAt: Sample.at(8), lastHeardAt: Sample.at(14), closedAt: nil,
            sync: HaloSync(state: "behind", behindSeconds: 190,
                           snippet: "…so if the floor holds we can still make Thursday…"),
            counts: .init(conversations: 3, marks: 1, places: 3),
            episodes: [
                HaloEpisode(
                    id: "e1", chapterIndex: 1, startedAt: Sample.at(8, 40), endedAt: Sample.at(9, 5),
                    placeLabel: "HOME", title: "Standup, and the Vercel bill",
                    summary: "Sprint scope cut to eight — Builder's call stood."
                ),
                Sample.episode,
                HaloEpisode(
                    id: "e3", chapterIndex: 3, startedAt: Sample.at(13, 47), endedAt: Sample.at(13, 52),
                    placeLabel: "WALKING",
                    marks: [HaloMark(id: "m1", markedAt: Sample.at(13, 47),
                                     words: "Check whether the Vercel bill doubled")]
                )
            ],
            gaps: [
                HaloGap(id: "g1", startedAt: Sample.at(11), endedAt: Sample.at(13),
                        reason: .notWorn, caption: "at home until one")
            ]
        )
    }
}
