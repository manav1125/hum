import SwiftUI

/// The Day cover — E1, lit by the hour it describes.
///
/// The reading order is the design's, and it is deliberate: the sync pill sits
/// **on the cover**, not buried in a settings screen, because the lag is worn
/// proudly rather than hidden. Then the verdict — the serif line, the one
/// sentence the day is remembered by. Then the arc. Then the counts, which
/// are only ever counts of real things.
///
/// Two invariants this view will not break:
///
///  · **It never invents a number.** No verdict yet means no verdict line, not
///    a placeholder. An unknown lag prints "nothing yet", never "0m".
///  · **The wearer's own marks are louder than anything Cue inferred.** A
///    chapter someone marked draws its bead amber, and the chapter row leads
///    with their words rather than Cue's title.
public struct DayCoverView: View {
    public let day: HaloDay
    public let now: Date
    public var onSelectEpisode: ((HaloEpisode) -> Void)?

    public init(day: HaloDay, now: Date = Date(), onSelectEpisode: ((HaloEpisode) -> Void)? = nil) {
        self.day = day
        self.now = now
        self.onSelectEpisode = onSelectEpisode
    }

    private var sky: SkyClock { SkyClock.at(date: now) }

    private var nowT: Double {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: now)
        let hour = Double(parts.hour ?? 12) + Double(parts.minute ?? 0) / 60
        return SunPathGeometry().progress(forHour: hour)
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                arc
                counts
                chapters
            }
            .padding(20)
        }
        .background(sky.gradient.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(day.date.uppercased())
                    .font(.system(.caption, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(.white.opacity(0.62))
                Spacer()
                syncPill
            }

            // No verdict yet is a state, not a blank to fill with something
            // generic. The cover simply does not carry the line.
            if let verdict = day.verdict, !verdict.isEmpty {
                Text(verdict)
                    .font(.system(size: 30, weight: .regular, design: .serif))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var syncPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(pillColor)
                .frame(width: 6, height: 6)
            Text(day.sync.coverPill)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.white.opacity(0.78))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Capsule().fill(.white.opacity(0.10)))
        .accessibilityLabel("Sync: \(day.sync.cardLine)")
    }

    private var pillColor: Color {
        switch day.sync.resolved {
        case .unknown: return .white.opacity(0.35)
        case .upToDate: return Color(red: 0.45, green: 0.85, blue: 0.55)
        case .behind: return Color(red: 1.0, green: 0.72, blue: 0.30)
        }
    }

    // MARK: - Arc

    private var arc: some View {
        SunPathView(
            segments: SunPathBuilder.segments(day: day, now: now),
            beads: SunPathBuilder.beads(day: day),
            nowT: nowT,
            sky: sky,
            lineWidth: 3,
            onSelectBead: { onSelectEpisode?($0) }
        )
        .frame(height: 118)
        .padding(.vertical, 4)
    }

    // MARK: - Counts

    private var counts: some View {
        HStack(spacing: 24) {
            countOrb(String(day.counts.conversations),
                     day.counts.conversations == 1 ? "conversation" : "conversations")
            if day.counts.places > 0 {
                countOrb(String(day.counts.places),
                         day.counts.places == 1 ? "place" : "places")
            }
            if day.counts.marks > 0 {
                countOrb("⚑ \(day.counts.marks)", "marked")
            }
            Spacer()
        }
    }

    private func countOrb(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(.white)
            Text(label)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.white.opacity(0.55))
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Chapters

    private var chapters: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(day.episodes) { episode in
                Button { onSelectEpisode?(episode) } label: {
                    ChapterRow(episode: episode)
                }
                .buttonStyle(.plain)
            }

            // An honest quiet day is success, not an error state.
            if day.episodes.isEmpty {
                Text("Nothing worth keeping yet today.")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.top, 6)
            }
        }
    }
}

/// One chapter, as it reads on the cover.
struct ChapterRow: View {
    let episode: HaloEpisode

    private var mark: HaloMark? { episode.marks.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(Self.time(episode.startedAt))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.55))
                if let place = episode.placeLabel {
                    Text(place)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.55))
                }
                Spacer()
            }

            // Nothing Cue inferred may outrank what the wearer marked, so a
            // marked chapter leads with their words.
            if let mark, let words = mark.words, !words.isEmpty {
                Text(mark.isNote ? "✦ YOU SAID THIS" : "⚑ YOU MARKED THIS")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(0.8)
                    .foregroundStyle(Color(red: 1, green: 0.72, blue: 0.30))
                Text("“\(words)”")
                    .font(.system(size: 16, design: .serif))
                    .foregroundStyle(.white)
            } else if let title = episode.title {
                Text(title)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.white)
            } else {
                // Heard but not yet read. A normal state, and it says so.
                Text("Not read yet")
                    .font(.system(size: 15))
                    .foregroundStyle(.white.opacity(0.45))
            }

            if let summary = episode.summary, !summary.isEmpty {
                Text(summary)
                    .font(.system(size: 14))
                    .foregroundStyle(.white.opacity(0.68))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(mark == nil ? 0.06 : 0.10))
        )
    }

    static func time(_ epochMs: Int) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: Double(epochMs) / 1000))
    }
}
