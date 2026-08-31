import SwiftUI

/// Onboarding — H1, seven steps.
///
/// The shape the design protects is **promise before permission, proof before
/// autonomy**, and the order is the whole design:
///
/// 1. Recognise — Cue notices a Halo rather than making somebody find a menu.
/// 2. **The promise** — what is recorded, where it goes, how to stop it. Three
///    lines, before any permission is asked for. This screen is where the
///    product is either trusted or not.
/// 3. Bluetooth — asked here and nowhere earlier, with the reason stated in
///    the sentence above the system prompt.
/// 4. **Pairing** — carrying the single-bond warning, because it is
///    destructive and must be dressed as such.
/// 5. **The first capture** — thirty seconds, and a button press. Not a
///    settings toggle: this is where the only gesture the device has gets
///    taught, and where the loop is first seen to close.
/// 6. Autonomy — asked once, in Halo's own terms.
/// 7. Wear it.
///
/// Steps 2, 4 and 5 are the ones that cannot be reordered or skipped. The
/// others can be, and in the bridge phase some of them are.
/// What the device in somebody's hand can actually do.
///
/// This exists because of a bug in the onboarding copy: the promise screen
/// said "the light is on whenever it's listening", which is true of the Halo
/// on the product page and **false of the reSpeaker Clip prototype**, whose
/// firmware ships `display` and `input` drivers and no LED at all. On the
/// screen where the product is trusted or not, describing an indicator that
/// does not exist is the worst possible sentence to get wrong — somebody
/// would look for a light, not find one, and reasonably conclude the thing
/// was recording them silently.
///
/// So the copy asks the hardware what it has, and the prototype's answer is
/// the honest default.
public struct HaloHardware: Equatable, Sendable {
    /// A light others can see from across a table.
    public let hasPrivacyLight: Bool
    /// A screen the wearer can read, but nobody else can.
    public let hasDisplay: Bool

    public init(hasPrivacyLight: Bool, hasDisplay: Bool) {
        self.hasPrivacyLight = hasPrivacyLight
        self.hasDisplay = hasDisplay
    }

    /// The reSpeaker Clip: an OLED and a vibration motor, no LED.
    public static let prototype = HaloHardware(hasPrivacyLight: false, hasDisplay: true)
    /// Halo as specified — the light is part of the industrial design.
    public static let halo = HaloHardware(hasPrivacyLight: true, hasDisplay: true)

    /// How the promise screen describes "you can tell when it is on".
    ///
    /// Never claims more than the device delivers, and never goes silent
    /// either: a device with no visible indicator has to say so, because that
    /// is precisely the fact somebody needs before they wear it.
    public var indicatorLine: String {
        if hasPrivacyLight {
            return "One press pauses it. The light is on whenever it's listening."
        }
        if hasDisplay {
            return "One press pauses it. Its screen shows when it's listening — and Cue always shows it here."
        }
        return "One press pauses it. This one has no light, so Cue shows you here whenever it's listening."
    }
}

public enum HaloOnboardingStep: Int, CaseIterable, Identifiable, Sendable {
    case recognise, promise, bluetooth, pairing, firstCapture, autonomy, wear

    public var id: Int { rawValue }

    public var title: String {
        switch self {
        case .recognise: return "A Halo is nearby"
        case .promise: return "What Halo does"
        case .bluetooth: return "Halo talks over Bluetooth"
        case .pairing: return "Link this Halo"
        case .firstCapture: return "Say something"
        case .autonomy: return "What Cue may do with it"
        case .wear: return "Wear it"
        }
    }

    /// The lines each step is trusted or not trusted on, kept in code where
    /// they can be tested rather than in a design file where they can drift.
    public func body(hardware: HaloHardware = .prototype) -> [String] {
        switch self {
        case .recognise:
            return ["Set it up in about a minute."]
        case .promise:
            return [
                "It records the conversations you're in, and throws the audio away once Cue has read it.",
                "Everything it keeps lives in your Cue — nobody else's.",
                hardware.indicatorLine
            ]
        case .bluetooth:
            return ["Cue needs Bluetooth to reach your Halo. Nothing else uses it."]
        case .pairing:
            return [
                "Halo links to one phone at a time.",
                "Setting it up here will erase anything it hasn't sent yet."
            ]
        case .firstCapture:
            return [
                "Say something out loud for a few seconds.",
                "Then press the button once — that's how you tell Cue something matters."
            ]
        case .autonomy:
            return [
                "Cue proposes, you approve.",
                "You can let it act on the obvious ones later."
            ]
        case .wear:
            return [
                "The button: hold to start or stop, click to mark a moment.",
                "A buzz means it heard you.",
                "Out of range is fine — it keeps recording and catches up."
            ]
        }
    }

    /// Steps that cannot be reordered or skipped without breaking the shape.
    public var isLoadBearing: Bool {
        switch self {
        case .promise, .pairing, .firstCapture: return true
        default: return false
        }
    }

    /// True while Seeed's app still owns pairing and the bond (phase A).
    public var isStubbedInBridgePhase: Bool {
        switch self {
        case .recognise, .bluetooth, .pairing: return true
        default: return false
        }
    }

    /// Pairing is destructive — it clears the bond and formats the card — so
    /// its primary action is dressed as destruction rather than as progress.
    public var isDestructive: Bool { self == .pairing }

    public var primaryActionTitle: String {
        switch self {
        case .recognise: return "Set it up"
        case .promise: return "I understand"
        case .bluetooth: return "Allow Bluetooth"
        case .pairing: return "Link and erase"
        case .firstCapture: return "Continue"
        case .autonomy: return "Cue proposes, I approve"
        case .wear: return "Start my first day"
        }
    }

    /// The second choice, where a step offers one.
    public var secondaryActionTitle: String? {
        switch self {
        case .autonomy: return "Let Cue act on the obvious ones"
        case .pairing: return "Not now"
        default: return nil
        }
    }
}

public struct OnboardingView: View {
    public let step: HaloOnboardingStep
    /// The first capture's transcript, once it lands. Continue stays disabled
    /// until it does — the step's whole job is proving the loop closes.
    public let firstCaptureTranscript: String?
    public let hardware: HaloHardware
    public var onPrimary: (() -> Void)?
    public var onSecondary: (() -> Void)?

    public init(
        step: HaloOnboardingStep,
        firstCaptureTranscript: String? = nil,
        hardware: HaloHardware = .prototype,
        onPrimary: (() -> Void)? = nil,
        onSecondary: (() -> Void)? = nil
    ) {
        self.step = step
        self.firstCaptureTranscript = firstCaptureTranscript
        self.hardware = hardware
        self.onPrimary = onPrimary
        self.onSecondary = onSecondary
    }

    private var sky: SkyClock { SkyClock.at(hour: 8) }

    public var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Spacer(minLength: 20)

            Text("STEP \(step.rawValue + 1) OF \(HaloOnboardingStep.allCases.count)")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .tracking(1.3)
                .foregroundStyle(.white.opacity(0.45))

            Text(step.title)
                .font(.system(size: 30, weight: .regular, design: .serif))
                .foregroundStyle(.white)

            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(step.body(hardware: hardware).enumerated()), id: \.offset) { _, line in
                    Text(line)
                        .font(.system(size: 16))
                        .foregroundStyle(.white.opacity(0.78))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if step == .firstCapture { capture }
            if step == .promise { bridgeNote }

            Spacer()

            actions
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(sky.gradient.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    /// The first capture proves the loop, so the label never claims live
    /// listening — it says what it is: what the device recorded so far.
    private var capture: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("WHAT IT RECORDED SO FAR")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .tracking(1.1)
                .foregroundStyle(.white.opacity(0.45))
            Text(firstCaptureTranscript ?? "listening for your voice…")
                .font(.system(size: 15, design: firstCaptureTranscript == nil ? .monospaced : .serif))
                .foregroundStyle(.white.opacity(firstCaptureTranscript == nil ? 0.45 : 0.9))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(0.07))
        )
    }

    /// Phase A sends audio through Seeed's cloud. Said plainly, on the screen
    /// where trust is decided, rather than buried in a policy nobody opens.
    private var bridgeNote: some View {
        Text("While Halo is in preview, recordings pass through Seeed's servers on the way to Cue.")
            .font(.system(size: 13))
            .foregroundStyle(.white.opacity(0.55))
            .fixedSize(horizontal: false, vertical: true)
    }

    private var actions: some View {
        VStack(spacing: 10) {
            Button { onPrimary?() } label: {
                Text(step.primaryActionTitle)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(step.isDestructive ? .white : .black.opacity(0.85))
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 52)
                    .background(
                        Capsule().fill(
                            step.isDestructive
                                // Amber carries destructive warnings; it is
                                // never styled as ordinary forward progress.
                                ? Color(red: 0.85, green: 0.45, blue: 0.25)
                                : Color.white.opacity(0.92)
                        )
                    )
            }
            .buttonStyle(.plain)
            .disabled(step == .firstCapture && firstCaptureTranscript == nil)
            .opacity(step == .firstCapture && firstCaptureTranscript == nil ? 0.4 : 1)

            if let secondary = step.secondaryActionTitle {
                Button { onSecondary?() } label: {
                    Text(secondary)
                        .font(.system(size: 15))
                        .foregroundStyle(.white.opacity(0.7))
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 48)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
