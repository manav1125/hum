import SwiftUI

/// The week's shape — V3. Patterns with receipts, never vibes.
///
/// The competitor shows sentiment; this shows **behaviour with receipts**.
/// Every insight here is countable ("9 of 11"), sourced to filed days, and
/// ends in a verb. That is not a stylistic preference: a mood inference is
/// unfalsifiable, so it cannot be argued with, acted on, or corrected — and a
/// diary that tells you how you *felt* without evidence is a diary you stop
/// believing the first time it is wrong about you.
///
/// So this type cannot express a mood. An insight is a count, a subject, and
/// a verb; there is nowhere to put "you seemed stressed".
public struct WeekView: View {
    public let range: String
    public let wornDays: Int
    public let totalDays: Int
    public let rhythm: [DayBar]
    public let rhythmNote: String?
    public let insights: [Insight]
    public var onAct: ((Insight) -> Void)?

    public struct DayBar: Identifiable, Equatable, Sendable {
        public let id: String
        /// "M", "T", "W" — a single letter, because seven of them share a row.
        public let letter: String
        public let conversations: Int
        public let filed: Int
        /// False when the day was not worn — drawn hollow, never as zero.
        public let worn: Bool

        public init(id: String, letter: String, conversations: Int, filed: Int, worn: Bool) {
            self.id = id
            self.letter = letter
            self.conversations = conversations
            self.filed = filed
            self.worn = worn
        }
    }

    /// One finding. The shape enforces the rule: a count, and a verb.
    public struct Insight: Identifiable, Equatable, Sendable {
        public let id: String
        public let glyph: String
        public let headline: String
        /// The receipt — a countable statement, never an inference.
        public let evidence: String
        /// What you can do about it. An insight with no verb is trivia.
        public let verb: String

        public init(id: String, glyph: String, headline: String, evidence: String, verb: String) {
            self.id = id
            self.glyph = glyph
            self.headline = headline
            self.evidence = evidence
            self.verb = verb
        }
    }

    public init(
        range: String,
        wornDays: Int,
        totalDays: Int,
        rhythm: [DayBar],
        rhythmNote: String? = nil,
        insights: [Insight],
        onAct: ((Insight) -> Void)? = nil
    ) {
        self.range = range
        self.wornDays = wornDays
        self.totalDays = totalDays
        self.rhythm = rhythm
        self.rhythmNote = rhythmNote
        self.insights = insights
        self.onAct = onAct
    }

    /// The scope every count below inherits. Printed, not implied.
    var scopeLine: String { "\(range) · worn \(wornDays) of \(totalDays) days" }

    private var peak: Int { max(1, rhythm.map(\.conversations).max() ?? 1) }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("This week")
                        .font(.system(size: 26, weight: .regular, design: .serif))
                        .foregroundStyle(.white)
                    Text(scopeLine)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.55))
                }

                rhythmSection

                ForEach(insights) { insight in
                    insightCard(insight)
                }

                // The provenance of every number above it.
                Text("Patterns come from your filed days only. Nothing here is a mood guess.")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.4))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(20)
        }
        .background(SkyClock.at(hour: 19).gradient.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private var rhythmSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CONVERSATION RHYTHM")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .tracking(1.1)
                .foregroundStyle(.white.opacity(0.45))

            HStack(alignment: .bottom, spacing: 10) {
                ForEach(rhythm) { bar in
                    VStack(spacing: 6) {
                        // An unworn day is hollow, not a zero-height bar —
                        // "nothing heard" and "nothing happened" are different.
                        RoundedRectangle(cornerRadius: 3)
                            .fill(bar.worn
                                  ? Color(red: 1, green: 0.72, blue: 0.30).opacity(0.85)
                                  : .clear)
                            .overlay(
                                RoundedRectangle(cornerRadius: 3)
                                    .strokeBorder(
                                        .white.opacity(bar.worn ? 0 : 0.25),
                                        style: StrokeStyle(lineWidth: 1, dash: [2, 2])
                                    )
                            )
                            .frame(
                                height: bar.worn
                                    ? max(6, 62 * CGFloat(bar.conversations) / CGFloat(peak))
                                    : 62
                            )
                        Text(bar.letter)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.5))
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 84, alignment: .bottom)

            if let rhythmNote {
                Text(rhythmNote)
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.7))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func insightCard(_ insight: Insight) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Text(insight.glyph).font(.system(size: 14))
                Text(insight.headline)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            Text(insight.evidence)
                .font(.system(size: 14))
                .foregroundStyle(.white.opacity(0.7))
                .fixedSize(horizontal: false, vertical: true)
            Button { onAct?(insight) } label: {
                Text("\(insight.verb) ›")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(.white.opacity(0.14)))
            }
            .buttonStyle(.plain)
            .frame(minHeight: 44)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(0.06))
        )
    }
}
