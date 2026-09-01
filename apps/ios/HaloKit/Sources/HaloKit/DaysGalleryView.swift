import SwiftUI

/// Your days — F1. Halo's home.
///
/// A shelf of day covers, where **each tile is that day's sky**. A month laid
/// out this way reads as weather you lived rather than as a list you filed,
/// which is the whole reason the tiles are gradients and not thumbnails: the
/// sky already encodes the hour, and a month of them encodes a season.
///
/// Two rules do real work here:
///
///  · **A day not worn is dashed, never an error.** It is an honest gap in a
///    record, and it looks like an absence rather than a failure — the same
///    grammar the arc uses, at a different scale.
///  · **The footer is the compounding story.** "28 days have taught Cue 214
///    things" is the sentence a list of entries cannot say, and it is the only
///    thing on this surface that points forward rather than back.
public struct DaysGalleryView: View {
    public let days: [DayTile]
    public let learned: Learned?
    public var onOpenDay: ((DayTile) -> Void)?

    /// One day, as the shelf needs it. Deliberately not a whole `HaloDay` —
    /// the gallery must be able to draw a month without loading a month.
    public struct DayTile: Identifiable, Equatable, Sendable {
        public let id: String
        /// "TODAY", "FRI" — the shelf's own label for the day.
        public let label: String
        /// The serif line, or nil for a day that produced none.
        public let verdict: String?
        public let conversations: Int
        public let marks: Int
        public let openProposals: Int
        public let filed: Int
        /// False when the day was not worn. Draws dashed, never as an error.
        public let worn: Bool
        /// The hour whose sky becomes the tile.
        public let skyHour: Double

        public init(
            id: String, label: String, verdict: String?, conversations: Int,
            marks: Int, openProposals: Int, filed: Int, worn: Bool, skyHour: Double
        ) {
            self.id = id
            self.label = label
            self.verdict = verdict
            self.conversations = conversations
            self.marks = marks
            self.openProposals = openProposals
            self.filed = filed
            self.worn = worn
            self.skyHour = skyHour
        }

        /// "7 conv · ⚑1 · ○2 open" — counts of real things, or nothing.
        ///
        /// Empty for an unworn day: the dashed tile and the row's own line
        /// already say it, and a third "not worn" on the same row reads as
        /// the app insisting rather than reporting.
        public var countsLine: String {
            guard worn else { return "" }
            var parts = ["\(conversations) conv"]
            if marks > 0 { parts.append("⚑\(marks)") }
            if openProposals > 0 { parts.append("○\(openProposals) open") }
            if filed > 0 { parts.append("\(filed) filed ✓") }
            return parts.joined(separator: " · ")
        }
    }

    /// The footer's fact. Absent until there is a real number to state.
    public struct Learned: Equatable, Sendable {
        public let days: Int
        public let things: Int

        public init(days: Int, things: Int) {
            self.days = days
            self.things = things
        }

        public var line: String { "\(days) days have taught Cue \(things) things" }
    }

    public init(
        days: [DayTile],
        learned: Learned? = nil,
        onOpenDay: ((DayTile) -> Void)? = nil
    ) {
        self.days = days
        self.learned = learned
        self.onOpenDay = onOpenDay
    }

    /// Worn days over total — the header's honest scope.
    var wornLine: String {
        let worn = days.filter(\.worn).count
        return "\(days.count) remembered · worn \(worn) of \(days.count)"
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your days")
                        .font(.system(size: 26, weight: .regular, design: .serif))
                        .foregroundStyle(.white)
                    Text(wornLine)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.55))
                }

                if days.isEmpty {
                    // An honest empty shelf: not an error, not a promise.
                    Text("No days yet. The first appears when Halo has heard something worth keeping.")
                        .font(.system(size: 14))
                        .foregroundStyle(.white.opacity(0.5))
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(days) { tile in
                        Button { onOpenDay?(tile) } label: { row(tile) }
                            .buttonStyle(.plain)
                    }
                }

                if let learned { footer(learned) }
            }
            .padding(20)
        }
        .background(SkyClock.at(hour: 20).gradient.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private func row(_ tile: DayTile) -> some View {
        HStack(alignment: .center, spacing: 14) {
            // The tile IS that day's sky.
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(SkyClock.at(hour: tile.skyHour).gradient)
                .frame(width: 62, height: 62)
                .opacity(tile.worn ? 1 : 0.35)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(
                            .white.opacity(tile.worn ? 0.12 : 0.30),
                            style: tile.worn
                                ? StrokeStyle(lineWidth: 1)
                                // Dashed: an honest gap, never an error.
                                : StrokeStyle(lineWidth: 1, dash: [3, 3])
                        )
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(tile.label.uppercased())
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(1.1)
                    .foregroundStyle(.white.opacity(0.5))
                Text(tile.verdict ?? "Not worn")
                    .font(.system(size: 16, design: .serif))
                    .foregroundStyle(.white.opacity(tile.verdict == nil ? 0.45 : 0.95))
                    .fixedSize(horizontal: false, vertical: true)
                if !tile.countsLine.isEmpty {
                    Text(tile.countsLine)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.white.opacity(0.05))
        )
    }

    private func footer(_ learned: Learned) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("🧠").font(.system(size: 16))
            VStack(alignment: .leading, spacing: 3) {
                Text(learned.line)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
                Text("memories, people, patterns · See what it knows ›")
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.55))
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(0.06))
        )
        .padding(.top, 4)
    }
}
