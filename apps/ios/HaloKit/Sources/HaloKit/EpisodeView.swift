import SwiftUI

/// One episode, opened — E4. A page written about you, not a transcript dump.
///
/// The reading order is the design's two-block rhythm and it is deliberate:
/// **narrative first, then scannable.** Scene header, the pull-quote somebody
/// actually said, Key Takeaways, then what came out of it, and only then the
/// words. Putting the transcript first would make this a recording app; the
/// point is that it is a diary.
///
/// Three rules the page keeps:
///
///  · **"Audio discarded ✓" rides the header** — a claim the retention
///    setting makes true, printed where it is read every time.
///  · **The quote is quoted.** It arrives already verified against the
///    transcript by the daemon, and arrives absent rather than paraphrased
///    when it could not be. So the page renders without one instead of
///    putting words in somebody's mouth.
///  · **No transcript editor.** Understanding is corrected at the proposal,
///    not by rewriting what was said. Speakers can be reassigned; words cannot.
public struct EpisodeView: View {
    public let episode: HaloEpisode
    public let proposals: [HaloProposal]
    public let sky: SkyClock
    public var onAccept: ((HaloProposal) -> Void)?
    public var onDismiss: ((HaloProposal) -> Void)?
    public var onBack: (() -> Void)?

    public init(
        episode: HaloEpisode,
        proposals: [HaloProposal] = [],
        sky: SkyClock? = nil,
        onAccept: ((HaloProposal) -> Void)? = nil,
        onDismiss: ((HaloProposal) -> Void)? = nil,
        onBack: (() -> Void)? = nil
    ) {
        self.episode = episode
        self.proposals = proposals
        // The scene is lit by the hour it describes, not the hour it is read.
        self.sky = sky ?? SkyClock.at(
            date: Date(timeIntervalSince1970: Double(episode.startedAt) / 1000)
        )
        self.onAccept = onAccept
        self.onDismiss = onDismiss
        self.onBack = onBack
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                header
                if let quote = episode.pullQuote { pullQuote(quote) }
                if !episode.keyTakeaways.isEmpty { takeaways }
                if !proposals.isEmpty { outcomes }
                words
            }
            .padding(20)
        }
        .background(sky.gradient.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if onBack != nil {
                    Button { onBack?() } label: {
                        Text("‹").font(.system(size: 22)).foregroundStyle(.white.opacity(0.7))
                    }
                    .buttonStyle(.plain)
                }
                Text(sceneLine)
                    .font(.system(.caption2, design: .monospaced))
                    .tracking(0.8)
                    .foregroundStyle(.white.opacity(0.62))
                Spacer()
            }

            if let title = episode.title {
                Text(title)
                    .font(.system(size: 28, weight: .regular, design: .serif))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // The claim, where it is read every time.
            Text("audio discarded ✓")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.white.opacity(0.45))
        }
    }

    /// "10:12 · VERVE ☕ · 40 MIN · WITH DANA"
    var sceneLine: String {
        var parts = [ChapterRow.time(episode.startedAt)]
        if let place = episode.placeLabel { parts.append(place) }
        let minutes = max(1, episode.durationSeconds / 60)
        parts.append("\(minutes) MIN")
        if !episode.participants.isEmpty {
            parts.append("WITH \(episode.participants.joined(separator: ", ").uppercased())")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: - Pull quote

    private func pullQuote(_ quote: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("“\(quote)”")
                .font(.system(size: 21, design: .serif))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
            if let speaker = episode.pullQuoteSpeaker {
                Text("\(speaker) · \(ChapterRow.time(episode.pullQuoteAt ?? episode.startedAt))")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.55))
            }
        }
    }

    // MARK: - Key takeaways

    private var takeaways: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("KEY TAKEAWAYS")
            ForEach(Array(episode.keyTakeaways.enumerated()), id: \.offset) { _, takeaway in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("·").foregroundStyle(.white.opacity(0.4))
                    Text(takeaway.label + ":")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                    Text(takeaway.value)
                        .font(.system(size: 14))
                        .foregroundStyle(.white.opacity(0.75))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
    }

    // MARK: - Outcomes

    private var outcomes: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("WHAT CAME OUT OF IT")
            ForEach(proposals) { proposal in
                ProposalCard(
                    proposal: proposal,
                    onAccept: { onAccept?(proposal) },
                    onDismiss: { onDismiss?(proposal) }
                )
            }
        }
    }

    // MARK: - The words

    private var words: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("THE WORDS")
            if (episode.transcript ?? []).isEmpty {
                Text("Not read yet.")
                    .font(.system(size: 14))
                    .foregroundStyle(.white.opacity(0.45))
            } else {
                ForEach(Array((episode.transcript ?? []).enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(line.speaker)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.8))
                        Text(line.text)
                            .font(.system(size: 14))
                            .foregroundStyle(.white.opacity(0.72))
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .tracking(1.1)
            .foregroundStyle(.white.opacity(0.45))
    }
}

/// One proposal, as a card with its provenance and its named destination.
public struct ProposalCard: View {
    public let proposal: HaloProposal
    public var onAccept: (() -> Void)?
    public var onDismiss: (() -> Void)?

    public init(
        proposal: HaloProposal,
        onAccept: (() -> Void)? = nil,
        onDismiss: (() -> Void)? = nil
    ) {
        self.proposal = proposal
        self.onAccept = onAccept
        self.onDismiss = onDismiss
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Text("○")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.5))
                Text(proposal.title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }

            // The ◉ heard pill: proof-of-magic and audit trail, same object.
            VStack(alignment: .leading, spacing: 3) {
                Text(proposal.heard.pillLine)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.5))
                if let quote = proposal.heard.quote {
                    Text("“\(quote)”")
                        .font(.system(size: 13, design: .serif))
                        .foregroundStyle(.white.opacity(0.7))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack(spacing: 8) {
                // The destination is named BEFORE you accept.
                Button { onAccept?() } label: {
                    Text("✓ " + proposal.verb.chipLabel(destination: proposal.destinationLabel))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(.white.opacity(0.16)))
                }
                .buttonStyle(.plain)

                Button { onDismiss?() } label: {
                    Text("✕")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.6))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(.white.opacity(0.08)))
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(0.07))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        // Unsure draws dashed and hollow — the tier is visible
                        // without ever printing a percentage.
                        .strokeBorder(
                            .white.opacity(proposal.confidenceTier == .unsure ? 0.18 : 0),
                            style: StrokeStyle(lineWidth: 1, dash: [3, 3])
                        )
                )
        )
    }
}
