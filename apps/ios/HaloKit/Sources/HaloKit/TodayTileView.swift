import SwiftUI

/// The Today tile — V4. Halo's live form, replacing the compact card while
/// recording.
///
/// Same hero, smaller rect: the sun path runs across the tile's top edge, from
/// the same drawing that fills the Day cover. E5's rule is that this is what
/// makes the product recognisable at a glance, so the tile does not get its
/// own summary graphic.
///
/// Two things earn their place on a tile this small:
///
///  · **The lag, again.** It is the one number the wearer checks without
///    opening anything, and it is the same phrasing as everywhere else.
///  · **Thumb-reach ✓/✕ on Today itself.** A proposal that needs a
///    navigation to accept is a proposal that waits until evening, and the
///    queue's whole value is that it stays short.
///
/// The breathing ring is the only ambient motion, it is under three seconds,
/// and it freezes entirely under Reduced Motion — E5 caps a screen at three
/// live elements and this tile deliberately spends its budget on one.
public struct TodayTileView: View {
    public let day: HaloDay
    public let now: Date
    public let isRecording: Bool
    public let topProposal: HaloProposal?
    public var onOpenDay: (() -> Void)?
    public var onAccept: ((HaloProposal) -> Void)?
    public var onDismiss: ((HaloProposal) -> Void)?

    @State private var breathing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        day: HaloDay,
        now: Date = Date(),
        isRecording: Bool = true,
        topProposal: HaloProposal? = nil,
        onOpenDay: (() -> Void)? = nil,
        onAccept: ((HaloProposal) -> Void)? = nil,
        onDismiss: ((HaloProposal) -> Void)? = nil
    ) {
        self.day = day
        self.now = now
        self.isRecording = isRecording
        self.topProposal = topProposal
        self.onOpenDay = onOpenDay
        self.onAccept = onAccept
        self.onDismiss = onDismiss
    }

    private var sky: SkyClock { SkyClock.at(date: now) }

    private var nowT: Double {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: now)
        let hour = Double(parts.hour ?? 12) + Double(parts.minute ?? 0) / 60
        return SunPathGeometry().progress(forHour: hour)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // The same arc, across the tile's top edge.
            SunPathView(
                segments: SunPathBuilder.segments(day: day, now: now),
                beads: SunPathBuilder.beads(day: day),
                nowT: nowT,
                sky: sky,
                lineWidth: 2,
                showsBeads: true
            )
            .frame(height: 54)

            HStack(spacing: 9) {
                if isRecording { breathingRing }
                Text(day.verdict ?? "Today so far")
                    .font(.system(size: 15, weight: .medium, design: day.verdict == nil ? .default : .serif))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }

            HStack(spacing: 14) {
                Text("\(day.counts.conversations) conv")
                if day.counts.marks > 0 { Text("⚑ \(day.counts.marks)") }
                Text(day.sync.coverPill)
                Spacer()
            }
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(.white.opacity(0.55))

            if let topProposal { thumbReach(topProposal) }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(sky.gradient)
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1)
                )
        )
        .onTapGesture { onOpenDay?() }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) {
                breathing = true
            }
        }
    }

    private var breathingRing: some View {
        Circle()
            // Reserved red, and only while recording.
            .fill(Color(red: 0.898, green: 0.404, blue: 0.357))
            .frame(width: 9, height: 9)
            .scaleEffect(breathing && !reduceMotion ? 1.25 : 1.0)
            .opacity(breathing && !reduceMotion ? 1.0 : 0.72)
            .accessibilityLabel("Recording")
    }

    /// One proposal, acceptable without leaving Today.
    private func thumbReach(_ proposal: HaloProposal) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(proposal.title)
                .font(.system(size: 14))
                .foregroundStyle(.white.opacity(0.92))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button { onAccept?(proposal) } label: {
                    Text("✓ " + proposal.verb.chipLabel(destination: proposal.destinationLabel))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(.white.opacity(0.18)))
                }
                .buttonStyle(.plain)
                Button { onDismiss?(proposal) } label: {
                    Text("✕")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.6))
                        .padding(.horizontal, 11)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(.white.opacity(0.08)))
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
        }
        .padding(.top, 2)
    }
}
