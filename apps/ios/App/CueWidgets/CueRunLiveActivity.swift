import ActivityKit
import SwiftUI
import WidgetKit

/// Live Activity for a Cue run — mobile-v3 spec frame 4 ("Dynamic Island +
/// Lock Screen · Cue works while the phone is closed"). Grammar: ring glyph
/// in a rounded tile, run title, one-line status, blue equalizer while
/// running, thin determinate bar underneath. Colors follow the v3 state
/// taxonomy via `CueRunState.tint`; the Island surface is always dark glass,
/// so the dark palette applies verbatim.
struct CueRunLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CueRunActivityAttributes.self) { context in
            // Lock Screen / banner presentation.
            CueRunLockScreenView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.72))
                .activitySystemActionForegroundColor(CueColors.text)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded — mirrors the spec's expanded-Island card.
                DynamicIslandExpandedRegion(.leading) {
                    CueGlyphTile(size: 34, glyph: 20)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(context.attributes.title)
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundColor(CueColors.text)
                            .lineLimit(1)
                        Text(context.state.statusLine)
                            .font(.system(size: 11.5))
                            .foregroundColor(CueColors.muted)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    CueEqualizerBars(state: context.state.state, barWidth: 2.5, height: 14)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    CueProgressBar(progress: context.state.progress, tint: context.state.state.tint)
                }
            } compactLeading: {
                CueRingMark(size: 14)
            } compactTrailing: {
                CueEqualizerBars(state: context.state.state, barWidth: 2, height: 10)
            } minimal: {
                CueRingMark(size: 14)
            }
            .keylineTint(context.state.state.tint)
        }
    }
}

// MARK: - Lock Screen

/// Lock-screen card: glyph tile, title + status, state-tinted progress —
/// the "Bottega booked ✓" row from the spec, generalized per taxonomy.
private struct CueRunLockScreenView: View {
    let context: ActivityViewContext<CueRunActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                CueGlyphTile(size: 36, glyph: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(CueColors.text)
                        .lineLimit(1)
                    Text(context.state.statusLine)
                        .font(.system(size: 12.5))
                        .foregroundColor(CueColors.muted)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                CueEqualizerBars(state: context.state.state, barWidth: 2.5, height: 14)
            }
            CueProgressBar(progress: context.state.progress, tint: context.state.state.tint)
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 13)
    }
}

// MARK: - Shared pieces

/// Dark-palette constants from the v3 spec (the activity surfaces are dark).
private enum CueColors {
    static let text = Color(red: 0xF4 / 255, green: 0xF4 / 255, blue: 0xF6 / 255) // #F4F4F6
    static let muted = Color(red: 0x9A / 255, green: 0x9A / 255, blue: 0xA8 / 255) // #9A9AA8
    static let tileFill = Color(red: 0x16 / 255, green: 0x16 / 255, blue: 0x1D / 255) // #16161D
    static let tileBorder = Color(red: 0x2A / 255, green: 0x2A / 255, blue: 0x35 / 255) // #2A2A35
    static let track = Color.white.opacity(0.12)
}

/// The ring glyph inside its rounded dark tile (`#16161D` / border `#2A2A35`).
private struct CueGlyphTile: View {
    var size: CGFloat
    var glyph: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                .fill(CueColors.tileFill)
            RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                .strokeBorder(CueColors.tileBorder, lineWidth: 1)
            CueRingMark(size: glyph)
        }
        .frame(width: size, height: size)
    }
}

/// The three-bar equalizer. Live Activities can't run timers, so the bars
/// are staggered heights (a captured frame of the spec's `v3Bar` loop) while
/// active, and collapse to a single state-tinted dot once the run settles.
private struct CueEqualizerBars: View {
    let state: CueRunState
    var barWidth: CGFloat
    var height: CGFloat

    /// Staggered bar heights — a frozen frame of the spec's `v3Bar` loop.
    private static let fractions: [CGFloat] = [0.45, 1.0, 0.65]

    var body: some View {
        if state.isActive {
            HStack(spacing: 1.5) {
                ForEach(Self.fractions.indices, id: \.self) { index in
                    Capsule()
                        .fill(state.tint)
                        .frame(width: barWidth, height: height * Self.fractions[index])
                }
            }
            .frame(height: height, alignment: .center)
        } else {
            Circle()
                .fill(state.tint)
                .frame(width: height * 0.5, height: height * 0.5)
        }
    }
}

/// Thin determinate bar (`4px`, `99px` radius, blue gradient) per the spec;
/// hidden when the run has no measurable progress.
private struct CueProgressBar: View {
    let progress: Double?
    let tint: Color

    var body: some View {
        if let progress {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(CueColors.track)
                    Capsule()
                        .fill(LinearGradient(
                            colors: [tint, tint.opacity(0.55)],
                            startPoint: .leading,
                            endPoint: .trailing
                        ))
                        .frame(width: geo.size.width * min(max(progress, 0), 1))
                }
            }
            .frame(height: 4)
        }
    }
}
