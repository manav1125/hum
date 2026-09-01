import SwiftUI
import HaloKit

/// The whole product, in the order somebody actually meets it.
///
/// Unbox → the promise → pairing → first capture → autonomy → wear it → the
/// day filling in → a chapter → the queue and the dock → the 9pm recap. Every
/// step is the real component with real demo data; nothing here is a mock of
/// a screen that exists elsewhere.
///
/// It exists for two audiences. Someone deciding whether the product is good
/// needs to move through it rather than read about it. And an App Store
/// reviewer cannot evaluate Halo on an empty account — the surfaces are
/// *about* a day, and with no day they render their honest-empty states,
/// which look like a broken app to somebody who has never seen a full one.
struct Walkthrough: View {
    /// Start anywhere: `SIMCTL_CHILD_HALO_STEP=8` opens the Day directly.
    /// Screenshotting a nine-step flow by tapping through it is how frames
    /// stop being checked.
    @State private var step = Int(
        ProcessInfo.processInfo.environment["HALO_STEP"] ?? "0"
    ) ?? 0
    @State private var firstCapture: String?

    /// Onboarding's seven steps, then the five surfaces they lead to.
    private var onboardingCount: Int { HaloOnboardingStep.allCases.count }
    private var totalSteps: Int { onboardingCount + 5 }

    var body: some View {
        content
            // An inset rather than an overlay: the harness must not sit on top
            // of the screen it is showing, and the onboarding's primary button
            // lives exactly where a floating bar would land.
            .safeAreaInset(edge: .bottom) { controls }
            .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var content: some View {
        if step < onboardingCount {
            OnboardingView(
                step: HaloOnboardingStep(rawValue: step) ?? .promise,
                firstCaptureTranscript: firstCapture,
                onPrimary: { advance() },
                onSecondary: { advance() }
            )
        } else {
            switch step - onboardingCount {
            case 0: todayStage
            case 1: DayCoverView(day: Demo.day, now: Demo.now)
            case 2: EpisodeView(episode: Demo.acme, proposals: Array(Demo.proposals.prefix(1)))
            case 3: QueueView(proposals: Demo.proposals, ledger: Demo.ledger)
            default: DayCloseView(day: Demo.day, receipts: Demo.receipts)
            }
        }
    }

    /// Today, as it looks once Halo is on: the live tile in place of the card.
    private var todayStage: some View {
        VStack(spacing: 14) {
            Spacer()
            Text("TODAY")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .tracking(1.3)
                .foregroundStyle(.white.opacity(0.4))
            TodayTileView(
                day: Demo.day, now: Demo.now, isRecording: true,
                topProposal: Demo.proposals.first
            )
            .padding(.horizontal, 16)
            HaloCardView(
                state: .recording,
                sync: Demo.day.sync,
                batteryPercent: 62
            )
            .padding(.horizontal, 16)
            Spacer()
        }
        .background(Color(red: 0.05, green: 0.05, blue: 0.08).ignoresSafeArea())
    }

    private var caption: String {
        if step < onboardingCount {
            return "Setup · step \(step + 1) of \(onboardingCount)"
        }
        switch step - onboardingCount {
        case 0: return "Today — Halo is on"
        case 1: return "Your day, as it filled in"
        case 2: return "One conversation, opened"
        case 3: return "What came out of it — tap ✓ to watch it file"
        default: return "9pm — the day closes"
        }
    }

    private var controls: some View {
        VStack(spacing: 8) {
            Text(caption)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.white.opacity(0.6))
            HStack(spacing: 10) {
                Button("‹ Back") { back() }
                    .disabled(step == 0)
                    .opacity(step == 0 ? 0.3 : 1)
                Button("Restart") { step = 0; firstCapture = nil }
                Button("Next ›") { advance() }
                    .disabled(step >= totalSteps - 1)
                    .opacity(step >= totalSteps - 1 ? 0.3 : 1)
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.white)
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 18)
        .padding(.top, 10)
        .padding(.bottom, 14)
        .background(.black.opacity(0.82))
    }

    private func advance() {
        step = min(step + 1, totalSteps - 1)
        armFirstCapture()
    }

    private func back() {
        step = max(step - 1, 0)
        armFirstCapture()
    }

    /// The capture lands a beat after the step opens, so the disabled-Continue
    /// state — the thing that proves the loop closed — is actually visible.
    private func armFirstCapture() {
        guard HaloOnboardingStep(rawValue: step) == .firstCapture else { return }
        firstCapture = nil
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            firstCapture = "Right — the one-pager for Dana before Thursday."
        }
    }
}
