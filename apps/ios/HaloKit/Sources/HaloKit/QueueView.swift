import SwiftUI

/// "From your days" — F2, the proposal queue.
///
/// Bee's to-do list with the three things it hasn't got: every item carries
/// **its heard-quote provenance**, the accept chip **names its destination**
/// before you tap, and low-confidence items **wait behind a fold** instead of
/// diluting the queue.
///
/// ## The fold is the feature
///
/// A queue that mixes "you promised Dana a one-pager" with "you might have
/// meant to buy milk" teaches people to skim it, and a skimmed queue is a
/// dead queue. So unsure items are counted, collapsed and honestly labelled —
/// "2 more Cue is less sure about" — rather than either hidden or mixed in.
///
/// ## Dismissal is data
///
/// The footer is a trust ledger, and it only exists because ✕ is recorded.
/// It says nothing at all until there is something true to say: a fresh
/// install must not claim to have learned a bar it has not learned.
public struct QueueView: View {
    public let proposals: [HaloProposal]
    public let ledger: HaloLedger
    public let dockLabel: String
    public let dockCount: Int
    public var onAccept: ((HaloProposal) -> Void)?
    public var onDismiss: ((HaloProposal) -> Void)?

    @State private var foldOpen = false
    @State private var flying: String?
    /// Cards that have landed. Removed from layout so the queue closes up —
    /// a flown card that still occupies its row leaves a hole where the work
    /// used to be, which reads as a bug rather than as completion.
    @State private var landed: Set<String> = []
    /// Docked accepts this session. The count ticks because these really
    /// happened, not because a tap was registered.
    @State private var dockedHere = 0
    @State private var caught = false
    @State private var undo: String?
    @State private var lastAccepted: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        proposals: [HaloProposal],
        ledger: HaloLedger,
        dockLabel: String = "Renew Acme",
        dockCount: Int = 3,
        onAccept: ((HaloProposal) -> Void)? = nil,
        onDismiss: ((HaloProposal) -> Void)? = nil
    ) {
        self.proposals = proposals
        self.ledger = ledger
        self.dockLabel = dockLabel
        self.dockCount = dockCount
        self.onAccept = onAccept
        self.onDismiss = onDismiss
    }

    private var open: [HaloProposal] {
        proposals.filter { !landed.contains($0.id) }
    }
    private var confident: [HaloProposal] {
        open.filter { !$0.confidenceTier.isBehindTheFold }
    }
    private var unsure: [HaloProposal] {
        open.filter { $0.confidenceTier.isBehindTheFold }
    }

    public var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    ForEach(confident) { card(for: $0) }
                    if !unsure.isEmpty { fold }
                    MissionDock(
                        label: dockLabel,
                        openCount: dockCount + dockedHere,
                        isCatching: caught
                    )
                        .padding(.top, 4)
                    footer
                }
                .padding(20)
                .padding(.bottom, 60)
            }

            if let undo {
                UndoPill(message: undo) { undoLast() }
                    .padding(.bottom, 18)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .background(SkyClock.at(hour: 20).gradient.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .animation(HaloMotion.standardEase(reduceMotion: reduceMotion), value: undo)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("From your days")
                .font(.system(size: 24, weight: .regular, design: .serif))
                .foregroundStyle(.white)
            Text(open.isEmpty
                 ? "Nothing waiting."
                 : "\(open.count) open")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.white.opacity(0.55))
        }
    }

    private func card(for proposal: HaloProposal) -> some View {
        ProposalCard(
            proposal: proposal,
            onAccept: { accept(proposal) },
            onDismiss: { onDismiss?(proposal) }
        )
        // The lift, then the flight. Both collapse to nothing under Reduced
        // Motion — the accept still happens, only the journey is removed.
        .scaleEffect(flying == proposal.id ? HaloMotion.liftScale(reduceMotion: reduceMotion) : 1)
        .rotationEffect(.degrees(flying == proposal.id ? HaloMotion.liftRotation(reduceMotion: reduceMotion) : 0))
        .opacity(flying == proposal.id ? 0 : 1)
        .offset(y: flying == proposal.id && !reduceMotion ? 220 : 0)
        .animation(HaloMotion.dockSpring(reduceMotion: reduceMotion), value: flying)
    }

    /// The fold: counted, collapsed, and honest about why.
    private var fold: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(HaloMotion.standardEase(reduceMotion: reduceMotion)) {
                    foldOpen.toggle()
                }
            } label: {
                HStack {
                    Text("\(unsure.count) more Cue is less sure about")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.6))
                    Text(foldOpen ? "Hide" : "Show ›")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.8))
                    Spacer()
                }
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)

            if foldOpen {
                ForEach(unsure) { card(for: $0) }
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Dismissing teaches · nothing runs until you say so")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.white.opacity(0.4))
            // Silent until there is something true to say.
            if let line = ledger.line {
                Text(line)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.4))
            }
        }
        .padding(.top, 6)
    }

    private func accept(_ proposal: HaloProposal) {
        let outcome = HaloAcceptOutcome.planned(for: proposal)
        outcome.haptic?.play()
        onAccept?(proposal)

        // A draft opens the composer; the dock waits for send or park, because
        // the thing that docks has to be the real artifact.
        guard outcome.docksNow else { return }

        flying = proposal.id
        caught = true
        undo = outcome.undoMessage
        lastAccepted = proposal.id

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(HaloMotion.dockFlight * 1_000_000_000))
            // The card lands: it leaves the layout and the count ticks, both
            // at the catch rather than at the tap.
            withAnimation(HaloMotion.standardEase(reduceMotion: reduceMotion)) {
                landed.insert(proposal.id)
                dockedHere += 1
            }
            flying = nil
            caught = false

            try? await Task.sleep(nanoseconds: UInt64(HaloMotion.undoWindow * 1_000_000_000))
            if lastAccepted == proposal.id { undo = nil }
        }
    }

    /// Undo puts the row back and un-ticks the count — the pill has to mean
    /// it, or it is decoration on an irreversible action.
    private func undoLast() {
        guard let id = lastAccepted else { return }
        withAnimation(HaloMotion.standardEase(reduceMotion: reduceMotion)) {
            landed.remove(id)
            dockedHere = max(0, dockedHere - 1)
            undo = nil
        }
        lastAccepted = nil
    }
}
