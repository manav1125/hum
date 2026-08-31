import SwiftUI

/// The dock — E2, the accept moment.
///
/// This is the interaction the whole funnel rests on. "Halo flows into Cue" is
/// a claim on a marketing page; the dock is the sentence being *demonstrated*,
/// once per accepted proposal, in half a second. So it is built exactly: the
/// card lifts, flies a spring path into the mission dock, the count ticks, the
/// ring pulses once, a `.medium` haptic lands at the catch, and an undo pill
/// stays for five seconds.
///
/// ## The dock only ever animates what a ✓ actually did
///
/// The honesty spine applies to motion too. The count ticks because a work
/// item was really created; the flight plays after the accept succeeded, not
/// optimistically before it. A dock that animated on tap and then quietly
/// failed would be the most convincing lie in the product.
///
/// ## And a draft does not dock on ✓
///
/// S6 ruling 3: `draft` opens the composer with the real draft in it, and the
/// dock fires on **send or park** instead. The thing that docks has to be the
/// real artifact — a work item that will draft something later is neither
/// done for you nor shown to you.
public struct MissionDock: View {
    public let label: String
    public let openCount: Int
    /// Set true for one beat when a card lands, to tick and pulse.
    public let isCatching: Bool

    public init(label: String, openCount: Int, isCatching: Bool = false) {
        self.label = label
        self.openCount = openCount
        self.isCatching = isCatching
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The count is the receipt: it moves because a row exists.
    ///
    /// The rolling-digit transition is iOS 16; below that the number simply
    /// changes, which is less delightful and exactly as true.
    @ViewBuilder
    private var countLabel: some View {
        let label = Text("\(openCount)")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
        if #available(iOS 16.0, *) {
            label.contentTransition(.numericText())
        } else {
            label
        }
    }

    public var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle()
                    .strokeBorder(Color(red: 1, green: 0.72, blue: 0.30).opacity(0.85), lineWidth: 2)
                    .frame(width: 34, height: 34)
                    .scaleEffect(isCatching && !reduceMotion ? 1.18 : 1.0)
                    .opacity(isCatching ? 1.0 : 0.75)
                countLabel
            }
            VStack(alignment: .leading, spacing: 1) {
                Text("▤ \(label)")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white)
                Text(openCount == 1 ? "1 open" : "\(openCount) open")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.55))
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(0.08))
        )
        .animation(HaloMotion.dockSpring(reduceMotion: reduceMotion), value: openCount)
        .animation(HaloMotion.standardEase(reduceMotion: reduceMotion), value: isCatching)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label), \(openCount) open")
    }
}

/// The five-second undo. One decision, reversible, then gone.
public struct UndoPill: View {
    public let message: String
    public var onUndo: () -> Void

    public init(message: String, onUndo: @escaping () -> Void) {
        self.message = message
        self.onUndo = onUndo
    }

    public var body: some View {
        HStack(spacing: 14) {
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.85))
            Button("Undo", action: onUndo)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color(red: 1, green: 0.72, blue: 0.30))
                .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .background(Capsule().fill(.black.opacity(0.72)))
        .frame(minHeight: 44)
    }
}

/// What accepting a proposal did, and therefore what the surface should show.
///
/// Modelled as a value rather than left to the view, because the difference
/// between "this docked" and "this opened a composer" is a design ruling and
/// belongs somewhere it can be tested.
public enum HaloAcceptOutcome: Equatable, Sendable {
    /// The work exists. Fly the card, tick the count, offer undo.
    case docked(destination: String?, workItemId: String)
    /// A draft is being written; the composer opens and the dock waits.
    case opensComposer(workItemId: String)
    /// Slow path: over ~4s the chip becomes "drafting…" and the sheet arrives
    /// as a notification, rather than holding somebody on a spinner.
    case drafting
    case failed(reason: String)

    /// Whether the dock animation may play now.
    public var docksNow: Bool {
        if case .docked = self { return true }
        return false
    }

    /// The undo pill's words. Nil when there is nothing to undo yet.
    public var undoMessage: String? {
        switch self {
        case .docked(let destination, _):
            return destination.map { "Filed to \($0)" } ?? "Filed"
        // Nothing has been filed yet — the draft has not been sent or parked,
        // so offering "undo" would be undoing something that did not happen.
        case .opensComposer, .drafting, .failed:
            return nil
        }
    }

    /// The haptic to play, if any. A failure is a quiet amber card, never a
    /// buzz — `.error` is not in Halo's map at all.
    public var haptic: HaloHaptic? {
        switch self {
        case .docked: return .commit
        case .opensComposer: return .selection
        case .drafting, .failed: return nil
        }
    }

    /// Decides what a ✓ on this proposal should do, before the request is made.
    public static func planned(for proposal: HaloProposal) -> HaloAcceptOutcome {
        proposal.verb.opensComposer
            ? .opensComposer(workItemId: "")
            : .docked(destination: proposal.destinationLabel, workItemId: "")
    }
}
