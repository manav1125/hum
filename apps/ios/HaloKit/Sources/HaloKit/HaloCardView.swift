import SwiftUI

/// The Halo card — H2, one component with two homes (Today and You).
///
/// Its whole job is to answer, at a glance and without being asked: **is it
/// on, and does Cue have what it heard?** Everything else on it is
/// subordinate to that.
///
/// ## Ten states, none of them a toast
///
/// H5 draws every state as a card shape rather than a transient message,
/// because a device UI that reports its problems in toasts is a device UI
/// that looks broken the moment you miss one. Out of range is *reassurance* —
/// it is still recording, and sync resumes. A quiet day is success, in green.
/// Storage full states the deletion rule rather than just alarming.
///
/// ## Pause is one tap, from the first screen
///
/// A pause that takes three taps is a pause nobody uses, and an always-on
/// recorder whose stop control is buried is a product people are right not to
/// trust. So it is the card's primary action in every state where it applies,
/// and the card goes slate while paused so the state is unmistakable.
public enum HaloCardState: Equatable, Sendable {
    case neverPaired
    case recording
    case paused
    case outOfRange
    case syncing
    case batteryLow(percent: Int)
    case storageFull
    case charging(percent: Int)
    case bluetoothDenied
    /// Transcription is unavailable. Audio is safe; understanding is delayed.
    case understandingUnavailable
    case quietDay
}

public struct HaloCardView: View {
    public let state: HaloCardState
    public let sync: HaloSync
    public let batteryPercent: Int?
    public var onPause: (() -> Void)?
    public var onResume: (() -> Void)?
    public var onOpenDay: (() -> Void)?
    public var onSetUp: (() -> Void)?

    public init(
        state: HaloCardState,
        sync: HaloSync,
        batteryPercent: Int? = nil,
        onPause: (() -> Void)? = nil,
        onResume: (() -> Void)? = nil,
        onOpenDay: (() -> Void)? = nil,
        onSetUp: (() -> Void)? = nil
    ) {
        self.state = state
        self.sync = sync
        self.batteryPercent = batteryPercent
        self.onPause = onPause
        self.onResume = onResume
        self.onOpenDay = onOpenDay
        self.onSetUp = onSetUp
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                statusDot
                Text(HaloCardCopy.headline(for: state))
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.white)
                Spacer(minLength: 8)
                if let shown = HaloCardCopy.batteryToShow(state: state, reported: batteryPercent) {
                    Text("\(shown)%")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.6))
                }
            }

            // The sync line. Exactly three shapes and never a fourth — and
            // "out of range" reads as reassurance rather than alarm.
            Text(HaloCardCopy.syncLine(for: state, sync: sync))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.white.opacity(0.62))
                .fixedSize(horizontal: false, vertical: true)

            if let detail = HaloCardCopy.detail(for: state) {
                Text(detail)
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.55))
                    .fixedSize(horizontal: false, vertical: true)
            }

            actions
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(background)
        )
        .accessibilityElement(children: .contain)
    }

    private var statusDot: some View {
        Circle()
            .fill(HaloCardCopy.accent(for: state))
            .frame(width: 8, height: 8)
            // The reserved red is recording and nothing else, so a glow on it
            // can never be mistaken for any other state.
            .shadow(
                color: state == .recording
                    ? HaloCardCopy.accent(for: state).opacity(0.8)
                    : .clear,
                radius: 5
            )
    }

    private var background: Color {
        // Slate while paused: the state has to be unmistakable at a glance,
        // and impossible to leave by accident.
        switch state {
        case .paused: return Color(red: 0.16, green: 0.17, blue: 0.20)
        default: return Color.white.opacity(0.07)
        }
    }

    @ViewBuilder
    private var actions: some View {
        switch state {
        case .neverPaired:
            cardButton("Set up Halo", action: onSetUp)
        case .bluetoothDenied:
            cardButton("Open Settings", action: onSetUp)
        case .paused:
            cardButton("Resume", action: onResume)
        case .recording, .syncing, .outOfRange, .batteryLow, .charging:
            HStack(spacing: 10) {
                cardButton("Pause", action: onPause)
                cardButton("Your day", action: onOpenDay)
            }
        case .storageFull, .understandingUnavailable, .quietDay:
            cardButton("Your day", action: onOpenDay)
        }
    }

    private func cardButton(_ title: String, action: (() -> Void)?) -> some View {
        Button { action?() } label: {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.12)))
        }
        .buttonStyle(.plain)
        // 44pt minimum, so the pause control is actually hittable in a pocket.
        .frame(minHeight: 44)
    }
}

/// The card's words, kept out of the view so they can be tested as copy.
///
/// This matters more than it looks: these ten sentences are the entire
/// vocabulary in which Halo explains itself, and several of them are promises
/// (still recording · audio is safe · what will be deleted). Testing them as
/// data is how they stay true when the view is refactored.
public enum HaloCardCopy {
    public static func headline(for state: HaloCardState) -> String {
        switch state {
        case .neverPaired: return "No Halo yet"
        case .recording: return "Recording"
        case .paused: return "Paused"
        case .outOfRange: return "Out of range"
        case .syncing: return "Catching up"
        case .batteryLow: return "Battery low"
        case .storageFull: return "Storage full"
        case .charging: return "Charging"
        case .bluetoothDenied: return "Bluetooth is off for Cue"
        case .understandingUnavailable: return "Recorded, not yet read"
        case .quietDay: return "A quiet day"
        }
    }

    public static func syncLine(for state: HaloCardState, sync: HaloSync) -> String {
        switch state {
        case .neverPaired, .bluetoothDenied: return "nothing to sync yet"
        // Reassurance, not alarm: it is still recording and sync resumes.
        case .outOfRange: return sync.outOfRangeLine()
        default: return sync.cardLine
        }
    }

    /// The second line, where a state owes an explanation.
    public static func detail(for state: HaloCardState) -> String? {
        switch state {
        case .neverPaired:
            return "Pair a Halo to start keeping your days."
        case .outOfRange:
            return "Still recording. It will catch up when you're back in range."
        case .batteryLow(let percent):
            return "\(percent)% left — about an hour. Charging tonight makes tomorrow whole."
        case .storageFull:
            // States the deletion rule rather than only alarming.
            return "Oldest already-synced audio will be removed first. Nothing unsynced is touched."
        case .bluetoothDenied:
            return "Halo can't connect until Bluetooth is allowed for Cue in Settings."
        case .understandingUnavailable:
            // Audio is safe; understanding is delayed. Never imply loss.
            return "Your audio is safe. Cue will read it as soon as it can."
        case .quietDay:
            // A quiet day is success, not a failure to report.
            return "On, and up to date. Nothing today needed keeping."
        default:
            return nil
        }
    }

    /// The battery number to print, or nil when the card should not carry one.
    ///
    /// The state wins when it carries a percentage. Two states do —
    /// `batteryLow` and `charging` — and both also print it inside their
    /// detail line, so taking the reported value instead lets the card say
    /// "62%" in the corner and "8% left" underneath it. That contradiction
    /// showed up on the very first render of the gallery, and on a real
    /// screen it is the kind of thing that makes somebody stop believing the
    /// battery reading at all.
    public static func batteryToShow(state: HaloCardState, reported: Int?) -> Int? {
        switch state {
        case .neverPaired, .bluetoothDenied: return nil
        case .batteryLow(let percent), .charging(let percent): return percent
        default: return reported
        }
    }

    /// Reserved red is recording, and only recording.
    public static func accent(for state: HaloCardState) -> Color {
        switch state {
        case .recording: return Color(red: 0.898, green: 0.404, blue: 0.357)
        case .paused: return .white.opacity(0.45)
        case .batteryLow, .storageFull, .outOfRange, .understandingUnavailable:
            return Color(red: 1.0, green: 0.72, blue: 0.30)
        case .quietDay, .charging: return Color(red: 0.45, green: 0.85, blue: 0.55)
        case .neverPaired, .bluetoothDenied: return .white.opacity(0.35)
        case .syncing: return Color(red: 1.0, green: 0.72, blue: 0.30)
        }
    }
}
