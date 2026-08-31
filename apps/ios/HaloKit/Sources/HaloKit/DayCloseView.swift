import SwiftUI

/// Day close — E3, the 9pm ritual.
///
/// The design calls this "the ritual that justifies the purchase", and that is
/// a precise claim: the Day cover is where you *look things up*, but this is
/// the surface somebody sees at the end of every day whether or not they went
/// looking. It has to be worth arriving at.
///
/// Its shape is three beats. The completed sun path — the whole day, drawn in
/// the light of the whole day. The serif verdict. Then **receipt rows**, each
/// of which links *into Cue* rather than back into Halo: a mission that moved,
/// a flag that became tomorrow's brief, a person whose page grew. That is the
/// structural point the competitor cannot copy — their day ends in a summary,
/// ours ends in three places where work is already happening.
///
/// ## The footer is the promise, said plainly
///
/// "Worn 11h · synced fully · audio discarded" then "Tomorrow, Cue starts
/// already knowing this." The first line is three verifiable facts; the second
/// is the only forward-looking sentence on the screen, and it earns its place
/// because the three facts above it are true.
///
/// ## And it never scolds
///
/// The verdict arrives already written and already scoped (see
/// `halo-verdict.ts`): an observation, never a grade. This view renders what
/// it is given and adds no judgement of its own — no streaks, no comparison
/// to yesterday, no "you were quieter than usual".
public struct DayCloseView: View {
    public let day: HaloDay
    public let receipts: [Receipt]
    public var onGoodNight: (() -> Void)?

    /// One thing that came of the day, and where it went.
    public struct Receipt: Identifiable, Equatable, Sendable {
        public let id: String
        public let glyph: String
        public let text: String
        /// What tapping it opens, named — "Ops picked one up ›".
        public let destination: String?

        public init(id: String, glyph: String, text: String, destination: String?) {
            self.id = id
            self.glyph = glyph
            self.text = text
            self.destination = destination
        }
    }

    public init(day: HaloDay, receipts: [Receipt], onGoodNight: (() -> Void)? = nil) {
        self.day = day
        self.receipts = receipts
        self.onGoodNight = onGoodNight
    }

    /// Evening light, because that is the hour this describes.
    private var sky: SkyClock { SkyClock.at(hour: 21) }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text(closedLine)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .tracking(1.4)
                    .foregroundStyle(.white.opacity(0.5))

                // The completed arc — the whole day, lived.
                SunPathView(
                    segments: SunPathBuilder.segments(day: day, now: endOfDay),
                    beads: SunPathBuilder.beads(day: day),
                    nowT: 1,
                    sky: sky,
                    lineWidth: 3
                )
                .frame(height: 108)

                if let verdict = day.verdict, !verdict.isEmpty {
                    Text(verdict)
                        .font(.system(size: 27, weight: .regular, design: .serif))
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 12) {
                    ForEach(receipts) { receipt in
                        receiptRow(receipt)
                    }
                }

                footer
            }
            .padding(22)
        }
        .background(sky.gradient.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    /// "SATURDAY, CLOSED"
    var closedLine: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: day.date) else {
            return "\(day.date.uppercased()), CLOSED"
        }
        formatter.dateFormat = "EEEE"
        return "\(formatter.string(from: date).uppercased()), CLOSED"
    }

    private var endOfDay: Date {
        Date(timeIntervalSince1970: Double(day.lastHeardAt ?? 0) / 1000)
            .addingTimeInterval(6 * 3600)
    }

    private func receiptRow(_ receipt: Receipt) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Text(receipt.glyph)
                .font(.system(size: 15))
                .foregroundStyle(Color(red: 1, green: 0.72, blue: 0.30))
            VStack(alignment: .leading, spacing: 2) {
                Text(receipt.text)
                    .font(.system(size: 15))
                    .foregroundStyle(.white.opacity(0.92))
                    .fixedSize(horizontal: false, vertical: true)
                // Every receipt names where it went — the row is a door into
                // Cue, not a restatement of what Halo heard.
                if let destination = receipt.destination {
                    Text(destination)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.55))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(0.06))
        )
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(DayCloseCopy.factsLine(day: day))
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.white.opacity(0.5))

            Text("Tomorrow, Cue starts already knowing this.")
                .font(.system(size: 15, design: .serif))
                .foregroundStyle(.white.opacity(0.8))

            Button {
                // The only `.success` bloom in the product.
                HaloHaptic.bloom.play()
                onGoodNight?()
            } label: {
                Text("Good night")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 48)
                    .background(Capsule().fill(.white.opacity(0.13)))
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .padding(.top, 6)
    }
}

/// The recap's words, testable apart from the view.
public enum DayCloseCopy {
    /// "Worn 11h · synced fully · audio discarded"
    ///
    /// Three verifiable facts, and the reason the forward-looking sentence
    /// underneath them is allowed to exist. Each clause is dropped rather than
    /// faked when it is not true: a day still syncing does not claim to be
    /// fully synced.
    public static func factsLine(day: HaloDay) -> String {
        var parts: [String] = []

        let hours = Int((Double(day.wornSeconds) / 3600).rounded())
        if hours > 0 { parts.append("Worn \(hours)h") }

        switch day.sync.resolved {
        case .upToDate: parts.append("synced fully")
        case .behind(let seconds): parts.append("\(HaloSync.phrase(seconds)) still to sync")
        case .unknown: break
        }

        parts.append("audio discarded")
        return parts.joined(separator: " · ")
    }
}
