import SwiftUI
import WidgetKit

#if canImport(ActivityKit)
import ActivityKit

/// Halo's Live Activity — lock screen and Dynamic Island.
///
/// See `HaloActivityAttributes` for the three rules every string here obeys.
/// The short version: participle only, never content; the timer never claims a
/// live mic; and in the minimal presentation the moving lag number is the only
/// thing that proves the device is alive.
@available(iOS 16.2, *)
struct HaloLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: HaloActivityAttributes.self) { context in
            lockScreen(context.state)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.state.phase.glyph)
                        .font(.system(size: 15))
                        .foregroundStyle(context.state.phase.tint)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(HaloActivityCopy.lagLine(
                        behindSeconds: context.state.behindSeconds,
                        phase: context.state.phase
                    ))
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.8))
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.phase.participle)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // A count of real chapters, or nothing at all.
                    if context.state.chapters > 0 {
                        Text(context.state.chapters == 1
                             ? "1 conversation today"
                             : "\(context.state.chapters) conversations today")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.6))
                    }
                }
            } compactLeading: {
                Text(context.state.phase.glyph)
                    .font(.system(size: 12))
                    .foregroundStyle(context.state.phase.tint)
            } compactTrailing: {
                Text(HaloActivityCopy.lagLine(
                    behindSeconds: context.state.behindSeconds,
                    phase: context.state.phase
                ))
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.white.opacity(0.75))
            } minimal: {
                // Room for one glyph. The tint carries the phase; the lag
                // cannot fit, which is why the compact presentations keep it.
                Text(context.state.phase.glyph)
                    .font(.system(size: 12))
                    .foregroundStyle(context.state.phase.tint)
            }
            .keylineTint(context.state.phase.tint)
        }
    }

    @ViewBuilder
    private func lockScreen(_ state: HaloActivityAttributes.ContentState) -> some View {
        HStack(spacing: 11) {
            Text(state.phase.glyph)
                .font(.system(size: 14))
                .foregroundStyle(state.phase.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(HaloActivityCopy.lockScreenLine(
                    behindSeconds: state.behindSeconds,
                    phase: state.phase
                ))
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.white)
                if state.chapters > 0 {
                    Text(state.chapters == 1
                         ? "1 conversation today"
                         : "\(state.chapters) conversations today")
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.6))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
    }
}
#endif
