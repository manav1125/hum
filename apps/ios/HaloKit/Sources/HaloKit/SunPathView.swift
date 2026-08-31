import SwiftUI

/// The arc, drawn. One view, every size.
///
/// ## The dim treatments are contrast, not a fixed opacity
///
/// S6 fixes not-yet at 18% and gap at 14%. Taken literally as *white* at those
/// values, both vanish on a midday sky — the first render of this view showed
/// a solid warm arc across an unheard afternoon, which is precisely the lie
/// the three-treatment grammar exists to prevent, and it looked fine. So the
/// numbers are read as what they are: dimness relative to the ground. The
/// stroke flips to a dark tint on a light sky, which keeps "dim solid reads as
/// record" true at every hour instead of only after dusk.
///
/// The three stroke treatments are S6 ruling 4 and are not interchangeable:
/// dotted reads as promise, dim-solid reads as record. Sizes come from the
/// caller's frame — an Island stub and a Day cover are the same view in
/// different rects, which is what keeps the hero recognisable.
public struct SunPathView: View {
    public let segments: [SunPathSegment]
    public let beads: [(episode: HaloEpisode, t: Double)]
    /// Where "now" sits, 0...1. The glow head is drawn here.
    public let nowT: Double
    public let lineWidth: CGFloat
    public let showsBeads: Bool
    /// The sky this arc is drawn on. The dim treatments are derived from it —
    /// see {@link dimColor}.
    public let sky: SkyClock
    public var onSelectBead: ((HaloEpisode) -> Void)?

    public init(
        segments: [SunPathSegment],
        beads: [(episode: HaloEpisode, t: Double)] = [],
        nowT: Double,
        sky: SkyClock,
        lineWidth: CGFloat = 3,
        showsBeads: Bool = true,
        onSelectBead: ((HaloEpisode) -> Void)? = nil
    ) {
        self.sky = sky
        self.segments = segments
        self.beads = beads
        self.nowT = nowT
        self.lineWidth = lineWidth
        self.showsBeads = showsBeads
        self.onSelectBead = onSelectBead
    }

    private let geometry = SunPathGeometry()

    public var body: some View {
        GeometryReader { proxy in
            let rect = CGRect(
                x: lineWidth,
                y: lineWidth,
                width: max(proxy.size.width - lineWidth * 2, 1),
                height: max(proxy.size.height - lineWidth * 2, 1)
            )

            ZStack {
                ForEach(segments) { segment in
                    stroke(for: segment, in: rect)
                }

                if nowT > 0, nowT < 1 {
                    glowHead(at: nowT, in: rect)
                }

                if showsBeads {
                    ForEach(beads, id: \.episode.id) { bead in
                        beadView(bead, in: rect)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Your day so far")
    }

    /// A dim stroke that stays dim AND stays visible, whatever hour it is on.
    private func dim(_ opacity: Double) -> Color {
        sky.isLight
            ? Color.black.opacity(opacity * 1.6)
            : Color.white.opacity(opacity)
    }

    @ViewBuilder
    private func stroke(for segment: SunPathSegment, in rect: CGRect) -> some View {
        let path = geometry.path(from: segment.from, to: segment.to, in: rect)
        switch segment.treatment {
        case .lived:
            path.stroke(
                LinearGradient(
                    colors: [Color(red: 1, green: 0.78, blue: 0.55),
                             Color(red: 1, green: 0.60, blue: 0.42)],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
            )
        case .notYet:
            // Fine dotted at 18% — a promise. Thinner than lived on purpose:
            // the future should not weigh the same as what happened.
            path.stroke(
                dim(0.18),
                style: StrokeStyle(
                    lineWidth: max(lineWidth * 0.6, 1),
                    lineCap: .round,
                    dash: [1, max(lineWidth * 1.6, 3)]
                )
            )
        case .gap:
            // Dim solid at 14% — a record of time that passed unheard.
            path.stroke(
                dim(0.14),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
            )
        }
    }

    private func glowHead(at t: Double, in rect: CGRect) -> some View {
        let point = geometry.point(at: t, in: rect)
        return Circle()
            .fill(Color(red: 1, green: 0.85, blue: 0.65))
            .frame(width: lineWidth * 2.2, height: lineWidth * 2.2)
            .shadow(color: Color(red: 1, green: 0.7, blue: 0.45).opacity(0.75),
                    radius: lineWidth * 2.4)
            .position(point)
            .accessibilityHidden(true)
    }

    private func beadView(
        _ bead: (episode: HaloEpisode, t: Double),
        in rect: CGRect
    ) -> some View {
        let point = geometry.point(at: bead.t, in: rect)
        // S6 ruling 2: beads under five minutes render at 70%.
        let size = lineWidth * 2.6 * bead.episode.beadScale
        let marked = !bead.episode.marks.isEmpty

        return Circle()
            .fill(marked
                  ? Color(red: 1, green: 0.72, blue: 0.30)   // amber: you marked it
                  : Color.white.opacity(0.92))
            .frame(width: size, height: size)
            .overlay(
                Circle().strokeBorder(Color.black.opacity(0.25), lineWidth: 0.5)
            )
            .position(point)
            .accessibilityLabel(bead.episode.title ?? "A conversation")
            .accessibilityAddTraits(.isButton)
            .onTapGesture { onSelectBead?(bead.episode) }
    }
}
