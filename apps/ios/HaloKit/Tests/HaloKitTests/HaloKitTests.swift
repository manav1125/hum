import XCTest
@testable import HaloKit

/// The rules the frames rest on, tested as maths rather than as pixels.
///
/// Three things are worth pinning without a simulator: the lag never invents a
/// number, the sky comes from the clock and nothing else, and the arc's three
/// treatments stay distinguishable — because if not-yet and gap ever collapse
/// into one, every morning renders as a broken day.
final class HaloSyncTests: XCTestCase {
    func testUnknownNeverPrintsANumber() {
        // A fabricated zero would claim Cue is current with a room it has
        // never heard.
        let sync = HaloSync(state: "unknown", behindSeconds: nil)
        XCTAssertEqual(sync.resolved, .unknown)
        XCTAssertEqual(sync.cardLine, "not connected")
        XCTAssertEqual(sync.islandLine, "—")
        XCTAssertFalse(sync.coverPill.contains("0"))
    }

    func testEverySurfaceSaysTheSameThingAboutTheSameNumber() {
        let sync = HaloSync(state: "behind", behindSeconds: 190)
        XCTAssertEqual(sync.cardLine, "synced to 3 min ago")
        XCTAssertEqual(sync.islandLine, "3m behind")
        XCTAssertEqual(sync.coverPill, "3m behind")
    }

    func testPhrasingRoundsRatherThanTicking() {
        // A number precise to the second reads as a stopwatch; this is a diary.
        XCTAssertEqual(HaloSync.phrase(45), "just now")
        XCTAssertEqual(HaloSync.phrase(190), "3 min")
        XCTAssertEqual(HaloSync.phrase(3600), "1 hour")
        XCTAssertEqual(HaloSync.phrase(7200), "2 hours")
        XCTAssertEqual(HaloSync.compact(190), "3m")
        XCTAssertEqual(HaloSync.compact(7200), "2h")
    }

    func testRoundingNeverUnderstatesHowStaleTheDayIs() {
        // 2h30m rounds UP. Overstating the lag is conservative; understating
        // it tells somebody Cue is fresher than it is, which is the one
        // direction this number must never fail in.
        XCTAssertEqual(HaloSync.phrase(9000), "3 hours")
        XCTAssertEqual(HaloSync.phrase(150), "3 min")
    }

    func testOutOfRangeReassuresRatherThanAlarms() {
        // Still recording. The wording says so rather than leaving the number
        // to imply something is broken.
        let sync = HaloSync(state: "behind", behindSeconds: 1800)
        XCTAssertTrue(sync.outOfRangeLine().contains("still recording"))
    }

    func testUpToDateIsNotABehindOfZero() {
        let sync = HaloSync(state: "up_to_date", behindSeconds: 20)
        XCTAssertEqual(sync.resolved, .upToDate)
        XCTAssertEqual(sync.cardLine, "up to date")
    }
}

final class SkyClockTests: XCTestCase {
    func testTheSkyComesFromTheHourAndNothingElse() {
        // Same hour, same sky — a day that went badly and one that went well
        // must look identical, because the sky is a fact about when.
        XCTAssertEqual(SkyClock.at(hour: 13), SkyClock.at(hour: 13))
    }

    func testMorningAndEveningAreDifferentSkies() {
        XCTAssertNotEqual(SkyClock.at(hour: 9), SkyClock.at(hour: 18))
    }

    func testItInterpolatesRatherThanSwitching() {
        // 11am must sit between the 9am and 1pm keyframes, or the app has
        // four themes instead of weather.
        let nine = SkyClock.at(hour: 9)
        let one = SkyClock.at(hour: 13)
        let eleven = SkyClock.at(hour: 11)
        XCTAssertGreaterThan(eleven.top.r, min(nine.top.r, one.top.r) - 0.001)
        XCTAssertLessThan(eleven.top.r, max(nine.top.r, one.top.r) + 0.001)
        XCTAssertNotEqual(eleven, nine)
        XCTAssertNotEqual(eleven, one)
    }

    func testALightSkyIsDetectedSoDimStrokesStayVisible() {
        // The first render drew a solid warm arc across an unheard afternoon:
        // 14% white is invisible on a midday sky, so the gap grammar silently
        // collapsed. Lightness has to be a property the arc can ask about.
        XCTAssertTrue(SkyClock.at(hour: 13).isLight)
        XCTAssertFalse(SkyClock.at(hour: 2).isLight)
        XCTAssertFalse(SkyClock.at(hour: 22).isLight)
    }

    func testMidnightWrapsCleanly() {
        // 24:00 and 00:00 are the same sky, or the arc seams at midnight.
        XCTAssertEqual(SkyClock.at(hour: 0), SkyClock.at(hour: 24))
        XCTAssertEqual(SkyClock.at(hour: -1), SkyClock.at(hour: 23))
    }
}

final class SunPathTests: XCTestCase {
    private let geometry = SunPathGeometry(startHour: 6, endHour: 22)
    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()

    /// Epoch ms for an hour on the test day, in UTC.
    private func at(_ hour: Double) -> Int {
        var parts = DateComponents()
        parts.year = 2026; parts.month = 8; parts.day = 30
        parts.hour = Int(hour)
        parts.minute = Int((hour - Double(Int(hour))) * 60)
        return Int(calendar.date(from: parts)!.timeIntervalSince1970 * 1000)
    }

    private func day(gaps: [HaloGap] = [], episodes: [HaloEpisode] = []) -> HaloDay {
        HaloDay(
            date: "2026-08-30", verdict: nil, heardSeconds: 0, wornSeconds: 0,
            firstHeardAt: nil, lastHeardAt: nil, closedAt: nil,
            sync: HaloSync(state: "unknown", behindSeconds: nil),
            counts: .init(conversations: episodes.count, marks: 0, places: 0),
            episodes: episodes, gaps: gaps
        )
    }

    func testDawnIsTheStartAndDuskIsTheEnd() {
        XCTAssertEqual(geometry.progress(forHour: 6), 0, accuracy: 0.001)
        XCTAssertEqual(geometry.progress(forHour: 22), 1, accuracy: 0.001)
        XCTAssertEqual(geometry.progress(forHour: 14), 0.5, accuracy: 0.001)
    }

    func testHoursOutsideTheArcClampInsteadOfDrawingOffIt() {
        // A 3am chapter belongs at the very start, not off the end.
        XCTAssertEqual(geometry.progress(forHour: 3), 0, accuracy: 0.001)
        XCTAssertEqual(geometry.progress(forHour: 23.5), 1, accuracy: 0.001)
    }

    func testTheArcRisesLeftPeaksCentreAndSetsRight() {
        let rect = CGRect(x: 0, y: 0, width: 100, height: 50)
        let dawn = geometry.point(at: 0, in: rect)
        let noon = geometry.point(at: 0.5, in: rect)
        let dusk = geometry.point(at: 1, in: rect)

        XCTAssertEqual(dawn.x, 0, accuracy: 0.5)
        XCTAssertEqual(dusk.x, 100, accuracy: 0.5)
        XCTAssertEqual(noon.x, 50, accuracy: 0.5)
        // Peak is highest on screen, i.e. smallest y.
        XCTAssertLessThan(noon.y, dawn.y)
        XCTAssertLessThan(noon.y, dusk.y)
    }

    func testMorningReadsAsMorningNotAsBreakage() {
        // At 8am the arc is mostly future. If not-yet drew like a gap, every
        // morning would look like a broken day — this is the reason there are
        // three treatments rather than two.
        let now = Date(timeIntervalSince1970: Double(at(8)) / 1000)
        let segments = SunPathBuilder.segments(
            day: day(), now: now, geometry: geometry, calendar: calendar
        )

        let notYet = segments.filter { $0.treatment == .notYet }
        XCTAssertEqual(notYet.count, 1)
        XCTAssertGreaterThan(notYet[0].to - notYet[0].from, 0.8)
        XCTAssertFalse(segments.contains { if case .gap = $0.treatment { return true } else { return false } })
    }

    func testAGapIsDrawnDistinctlyFromTheFuture() {
        let now = Date(timeIntervalSince1970: Double(at(18)) / 1000)
        let segments = SunPathBuilder.segments(
            day: day(gaps: [
                HaloGap(id: "g1", startedAt: at(9), endedAt: at(12),
                        reason: .notWorn, caption: "at home until noon")
            ]),
            now: now, geometry: geometry, calendar: calendar
        )

        let gaps = segments.filter { if case .gap = $0.treatment { return true } else { return false } }
        XCTAssertEqual(gaps.count, 1)
        // And it carries its reason and caption, so the arc can label it.
        if case .gap(let reason, let caption) = gaps[0].treatment {
            XCTAssertEqual(reason, .notWorn)
            XCTAssertEqual(caption, "at home until noon")
        } else {
            XCTFail("expected a gap treatment")
        }
    }

    func testAGapReplacesTheLivedArcRatherThanTintingIt() {
        // The bug this exists to catch renders as a slightly paler heard
        // afternoon instead of an unheard one — it looks fine and is wrong.
        // The treatments must be mutually exclusive stretches, not layers.
        let now = Date(timeIntervalSince1970: Double(at(18)) / 1000)
        let segments = SunPathBuilder.segments(
            day: day(gaps: [HaloGap(id: "g1", startedAt: at(9), endedAt: at(12), reason: .notWorn)]),
            now: now, geometry: geometry, calendar: calendar
        )

        let lived = segments.filter { $0.treatment == .lived }
        let gap = segments.first { if case .gap = $0.treatment { return true } else { return false } }!

        // Two heard stretches: before the gap and after it.
        XCTAssertEqual(lived.count, 2)
        // And no heard stretch overlaps the gap.
        for stretch in lived {
            XCTAssertTrue(
                stretch.to <= gap.from + 0.001 || stretch.from >= gap.to - 0.001,
                "a lived stretch overlaps the gap — the gap will only tint it"
            )
        }
    }

    func testBackToBackGapsDoNotProduceAnInvertedStretch() {
        let now = Date(timeIntervalSince1970: Double(at(18)) / 1000)
        let segments = SunPathBuilder.segments(
            day: day(gaps: [
                HaloGap(id: "g1", startedAt: at(9), endedAt: at(13), reason: .notWorn),
                HaloGap(id: "g2", startedAt: at(10), endedAt: at(12), reason: .battery)
            ]),
            now: now, geometry: geometry, calendar: calendar
        )
        // Overlapping gaps are real (a battery death inside an unworn morning).
        // Every segment must still run forwards.
        for segment in segments {
            XCTAssertGreaterThanOrEqual(segment.to, segment.from)
        }
    }

    func testAnOpenGapStopsAtNowRatherThanClaimingTheEvening() {
        let now = Date(timeIntervalSince1970: Double(at(14)) / 1000)
        let segments = SunPathBuilder.segments(
            day: day(gaps: [HaloGap(id: "g1", startedAt: at(12), endedAt: nil, reason: .battery)]),
            now: now, geometry: geometry, calendar: calendar
        )
        let gap = segments.first { if case .gap = $0.treatment { return true } else { return false } }!
        XCTAssertEqual(gap.to, geometry.progress(forHour: 14), accuracy: 0.001)
    }

    func testAnUnknownGapReasonFallsBackRatherThanLying() throws {
        // A reason from a newer daemon must not render as "not worn", which
        // would claim something untrue about the wearer.
        let json = """
        {"id":"g","startedAt":1,"endedAt":2,"reason":"solar_flare","caption":null}
        """.data(using: .utf8)!
        let gap = try JSONDecoder().decode(HaloGap.self, from: json)
        XCTAssertEqual(gap.reason, .unknown)
    }

    func testShortBeadsRenderSmaller() {
        // S6 ruling 2: under five minutes at 70%, so density reads without
        // crowding.
        let short = HaloEpisode(id: "a", chapterIndex: 1, startedAt: at(9), endedAt: at(9.05))
        let long = HaloEpisode(id: "b", chapterIndex: 2, startedAt: at(10), endedAt: at(11))
        XCTAssertEqual(short.beadScale, 0.7)
        XCTAssertEqual(long.beadScale, 1.0)
    }

    func testBeadsSitWhereTheirChapterHappened() {
        let episodes = [
            HaloEpisode(id: "a", chapterIndex: 1, startedAt: at(6), endedAt: at(7)),
            HaloEpisode(id: "b", chapterIndex: 2, startedAt: at(14), endedAt: at(15))
        ]
        let beads = SunPathBuilder.beads(
            day: day(episodes: episodes), geometry: geometry, calendar: calendar
        )
        XCTAssertEqual(beads[0].t, 0, accuracy: 0.001)
        XCTAssertEqual(beads[1].t, 0.5, accuracy: 0.001)
    }
}

/// The card's ten states, tested as copy.
///
/// These sentences are the entire vocabulary in which Halo explains itself,
/// and several of them are promises. Testing them as data is how they stay
/// true when the view is refactored.
final class HaloCardTests: XCTestCase {
    private let behind = HaloSync(state: "behind", behindSeconds: 1800)

    func testOutOfRangeReadsAsReassuranceNotAlarm() {
        // It is still recording and sync resumes; the card must say so rather
        // than leaving a number to imply something broke.
        let line = HaloCardCopy.syncLine(for: .outOfRange, sync: behind)
        XCTAssertTrue(line.contains("still recording"))
        XCTAssertTrue(HaloCardCopy.detail(for: .outOfRange)!.contains("catch up"))
    }

    func testStorageFullStatesTheDeletionRule() {
        // Alarming without saying what gets deleted is how people stop
        // trusting a recorder.
        let detail = HaloCardCopy.detail(for: .storageFull)!
        XCTAssertTrue(detail.contains("already-synced"))
        XCTAssertTrue(detail.lowercased().contains("nothing unsynced"))
    }

    func testUnavailableUnderstandingNeverImpliesLostAudio() {
        let detail = HaloCardCopy.detail(for: .understandingUnavailable)!
        XCTAssertTrue(detail.contains("audio is safe"))
    }

    func testAQuietDayIsSuccessNotAnError() {
        XCTAssertEqual(HaloCardCopy.headline(for: .quietDay), "A quiet day")
        XCTAssertEqual(
            HaloCardCopy.accent(for: .quietDay),
            HaloCardCopy.accent(for: .charging(percent: 80)),
            "a quiet day should read in the same register as a healthy one"
        )
        XCTAssertFalse(HaloCardCopy.detail(for: .quietDay)!.lowercased().contains("no "))
    }

    func testReservedRedIsRecordingAndOnlyRecording() {
        let recording = HaloCardCopy.accent(for: .recording)
        for state: HaloCardState in [
            .paused, .outOfRange, .syncing, .storageFull, .quietDay,
            .charging(percent: 80), .batteryLow(percent: 8),
            .neverPaired, .bluetoothDenied, .understandingUnavailable
        ] {
            XCTAssertNotEqual(HaloCardCopy.accent(for: state), recording,
                              "\(state) must not wear the recording red")
        }
    }

    func testTheCornerBatteryCanNeverContradictTheDetailLine() {
        // The first gallery render showed "62%" beside "8% left". A card that
        // disagrees with itself about the battery is a card nobody believes.
        XCTAssertEqual(
            HaloCardCopy.batteryToShow(state: .batteryLow(percent: 8), reported: 62), 8
        )
        XCTAssertEqual(
            HaloCardCopy.batteryToShow(state: .charging(percent: 40), reported: 62), 40
        )
        XCTAssertEqual(
            HaloCardCopy.batteryToShow(state: .recording, reported: 62), 62
        )
        // And a card with no device has no battery to report.
        XCTAssertNil(HaloCardCopy.batteryToShow(state: .neverPaired, reported: 62))
        XCTAssertNil(HaloCardCopy.batteryToShow(state: .bluetoothDenied, reported: 62))
    }

    func testEveryStateHasAHeadlineAndASyncLine() {
        for state: HaloCardState in [
            .neverPaired, .recording, .paused, .outOfRange, .syncing,
            .batteryLow(percent: 5), .storageFull, .charging(percent: 40),
            .bluetoothDenied, .understandingUnavailable, .quietDay
        ] {
            XCTAssertFalse(HaloCardCopy.headline(for: state).isEmpty)
            XCTAssertFalse(HaloCardCopy.syncLine(for: state, sync: behind).isEmpty)
        }
    }
}

final class HaloProposalTests: XCTestCase {
    private let heard = HaloProposal.Heard(
        quote: "I'll get you the one-pager before Thursday",
        at: 1_788_000_000_000, place: "Verve", speaker: "You"
    )

    func testTheChipNamesItsDestinationBeforeYouTapIt() {
        let proposal = HaloProposal(
            id: "p", title: "Send the one-pager", verb: .file,
            destinationLabel: "Renew Acme", heard: heard
        )
        XCTAssertEqual(
            proposal.verb.chipLabel(destination: proposal.destinationLabel),
            "▤ File to Renew Acme"
        )
    }

    func testADraftOpensTheComposerRatherThanDocking() {
        // S6 ruling 3: the thing that docks has to be the real artifact.
        XCTAssertTrue(HaloProposal.Verb.draft.opensComposer)
        XCTAssertFalse(HaloProposal.Verb.file.opensComposer)
        XCTAssertFalse(HaloProposal.Verb.schedule.opensComposer)
    }

    func testAnUnknownVerbFallsBackRatherThanFailingToDecode() throws {
        let json = """
        {"id":"p","title":"t","owner":null,"verb":"teleport","destinationLabel":null,
         "confidenceTier":"confident","episodeId":null,
         "heard":{"quote":null,"at":null,"place":null,"speaker":null}}
        """.data(using: .utf8)!
        let proposal = try JSONDecoder().decode(HaloProposal.self, from: json)
        XCTAssertEqual(proposal.verb, .file)
    }

    func testThePillSurvivesAMissingQuote() {
        // A quote that could not be verified arrives absent; the pill shows
        // time and place rather than inventing words.
        let bare = HaloProposal.Heard(quote: nil, at: nil, place: "Verve", speaker: nil)
        XCTAssertEqual(bare.pillLine, "◉ heard · Verve")
    }

    func testTheLedgerSaysNothingUntilItHasLearnedSomething() {
        // A fresh install must not claim a bar it has not learned.
        XCTAssertNil(HaloLedger(proposed: 3, accepted: 0, dismissed: 0).line)
        XCTAssertEqual(
            HaloLedger(proposed: 1, accepted: 34, dismissed: 7).line,
            "34 accepted · 7 dismissed · Cue is learning your bar"
        )
    }
}

/// The dock, and the rules it must not break.
///
/// The dock is the one place where an animation makes a factual claim — "this
/// went into that mission" — so the interesting tests are about when it is
/// allowed to play at all.
final class DockTests: XCTestCase {
    private func proposal(verb: HaloProposal.Verb, destination: String? = "Renew Acme") -> HaloProposal {
        HaloProposal(
            id: "p", title: "Send the one-pager", verb: verb,
            destinationLabel: destination,
            heard: .init(quote: nil, at: nil, place: nil, speaker: nil)
        )
    }

    func testAFileDocksAndOffersUndo() {
        let outcome = HaloAcceptOutcome.planned(for: proposal(verb: .file))
        XCTAssertTrue(outcome.docksNow)
        XCTAssertEqual(outcome.undoMessage, "Filed to Renew Acme")
        XCTAssertEqual(outcome.haptic, .commit)
    }

    func testADraftDoesNotDockOnTheTick() {
        // S6 ruling 3. The dock fires on send or park, because the thing that
        // docks has to be the real artifact — not a promise of one.
        let outcome = HaloAcceptOutcome.planned(for: proposal(verb: .draft))
        XCTAssertFalse(outcome.docksNow)
        XCTAssertEqual(outcome, .opensComposer(workItemId: ""))
    }

    func testNothingFiledMeansNothingToUndo() {
        // Offering "Undo" for a draft would offer to undo something that has
        // not happened yet.
        XCTAssertNil(HaloAcceptOutcome.opensComposer(workItemId: "w").undoMessage)
        XCTAssertNil(HaloAcceptOutcome.drafting.undoMessage)
        XCTAssertNil(HaloAcceptOutcome.failed(reason: "offline").undoMessage)
    }

    func testAFailureIsQuiet() {
        // Nothing in Halo fails loudly; failures are quiet amber cards, and
        // `.error` is not in the haptic map at all.
        XCTAssertNil(HaloAcceptOutcome.failed(reason: "offline").haptic)
        XCTAssertNil(HaloAcceptOutcome.drafting.haptic)
    }

    func testAFileWithNoNamedDestinationStillReadsHonestly() {
        let outcome = HaloAcceptOutcome.planned(for: proposal(verb: .file, destination: nil))
        XCTAssertEqual(outcome.undoMessage, "Filed")
    }
}

final class MotionTests: XCTestCase {
    func testReducedMotionRemovesTheJourneyNotTheAccept() {
        // For somebody who gets motion sick, a card flying across the screen
        // is not a delight — it is a reason to stop using the product. The
        // accept still happens; only the flight is removed.
        XCTAssertEqual(HaloMotion.liftScale(reduceMotion: true), 1.0)
        XCTAssertEqual(HaloMotion.liftRotation(reduceMotion: true), 0)
        XCTAssertEqual(HaloMotion.liftScale(reduceMotion: false), 1.03)
        XCTAssertEqual(HaloMotion.liftRotation(reduceMotion: false), -2)
    }

    func testTheContractsTimingsAreTheDesignsTimings() {
        XCTAssertEqual(HaloMotion.standard, 0.24)
        XCTAssertEqual(HaloMotion.dismiss, 0.18)
        XCTAssertEqual(HaloMotion.sheet, 0.28)
        XCTAssertEqual(HaloMotion.sharedElement, 0.32)
        XCTAssertEqual(HaloMotion.dockFlight, 0.52)
        XCTAssertEqual(HaloMotion.springDamping, 0.82)
        XCTAssertEqual(HaloMotion.undoWindow, 5.0)
    }
}

/// The recap and the onboarding, tested as the promises they make.
final class DayCloseTests: XCTestCase {
    private func day(worn: Int, sync: HaloSync) -> HaloDay {
        HaloDay(
            date: "2026-08-30", verdict: "Seven conversations. One deal. Nothing dropped.",
            heardSeconds: worn, wornSeconds: worn,
            firstHeardAt: nil, lastHeardAt: nil, closedAt: nil,
            sync: sync, counts: .init(conversations: 7, marks: 1, places: 3),
            episodes: [], gaps: []
        )
    }

    func testTheFactsLineIsThreeVerifiableFacts() {
        let line = DayCloseCopy.factsLine(
            day: day(worn: 11 * 3600, sync: HaloSync(state: "up_to_date", behindSeconds: 10))
        )
        XCTAssertEqual(line, "Worn 11h · synced fully · audio discarded")
    }

    func testADayStillSyncingDoesNotClaimToBeSynced() {
        // The forward-looking sentence underneath only earns its place because
        // every clause above it is true.
        let line = DayCloseCopy.factsLine(
            day: day(worn: 5 * 3600, sync: HaloSync(state: "behind", behindSeconds: 1800))
        )
        XCTAssertFalse(line.contains("synced fully"))
        XCTAssertTrue(line.contains("still to sync"))
    }

    func testAClauseIsDroppedRatherThanFaked() {
        // Nothing worn means no hours to report — not "Worn 0h".
        let line = DayCloseCopy.factsLine(
            day: day(worn: 0, sync: HaloSync(state: "unknown", behindSeconds: nil))
        )
        XCTAssertFalse(line.contains("Worn"))
        XCTAssertEqual(line, "audio discarded")
    }
}

final class OnboardingTests: XCTestCase {
    func testPromiseComesBeforeAnyPermission() {
        // The shape the design protects: somebody reads what this does before
        // they are asked to allow anything.
        XCTAssertLessThan(
            HaloOnboardingStep.promise.rawValue,
            HaloOnboardingStep.bluetooth.rawValue
        )
        XCTAssertLessThan(
            HaloOnboardingStep.promise.rawValue,
            HaloOnboardingStep.pairing.rawValue
        )
    }

    func testProofComesBeforeAutonomy() {
        // Nobody is asked what Cue may do until they have seen it work.
        XCTAssertLessThan(
            HaloOnboardingStep.firstCapture.rawValue,
            HaloOnboardingStep.autonomy.rawValue
        )
    }

    func testThePromiseAnswersTheThreeQuestions() {
        let lines = HaloOnboardingStep.promise.body().joined(separator: " ").lowercased()
        XCTAssertTrue(lines.contains("records"), "what is recorded")
        XCTAssertTrue(lines.contains("your cue"), "where it goes")
        XCTAssertTrue(lines.contains("pauses"), "how to stop it")
    }

    func testTheCopyNeverPromisesALightTheDeviceHasNot() {
        // The prototype's firmware ships display and input drivers and no LED.
        // Somebody who looks for a light and finds none would reasonably
        // conclude the thing was recording them silently.
        let prototype = HaloOnboardingStep.promise.body(hardware: .prototype)
            .joined(separator: " ")
        XCTAssertFalse(prototype.contains("The light is on"))
        // And it does not go quiet about it either — the absence is stated.
        XCTAssertTrue(prototype.lowercased().contains("listening"))

        let halo = HaloOnboardingStep.promise.body(hardware: .halo).joined(separator: " ")
        XCTAssertTrue(halo.contains("The light is on"))
    }

    func testADeviceWithNoIndicatorAtAllSaysSoPlainly() {
        let blind = HaloHardware(hasPrivacyLight: false, hasDisplay: false)
        XCTAssertTrue(blind.indicatorLine.contains("no light"))
    }

    func testPairingIsDressedAsDestruction() {
        // It clears the bond and formats the card. A default-styled "Continue"
        // would be the wrong shape for that.
        XCTAssertTrue(HaloOnboardingStep.pairing.isDestructive)
        XCTAssertTrue(HaloOnboardingStep.pairing.primaryActionTitle.lowercased().contains("erase"))
        XCTAssertTrue(
            HaloOnboardingStep.pairing.body().joined(separator: " ").contains("one phone at a time")
        )
        // And it is the ONLY destructive step.
        for step in HaloOnboardingStep.allCases where step != .pairing {
            XCTAssertFalse(step.isDestructive)
        }
    }

    func testTheFirstCaptureTeachesTheOnlyGestureThereIs() {
        let lines = HaloOnboardingStep.firstCapture.body().joined(separator: " ")
        XCTAssertTrue(lines.contains("press the button once"))
    }

    func testAutonomyDefaultsToProposing() {
        XCTAssertTrue(
            HaloOnboardingStep.autonomy.primaryActionTitle.lowercased().contains("approve")
        )
        XCTAssertNotNil(HaloOnboardingStep.autonomy.secondaryActionTitle)
    }

    func testTheBridgePhaseStubsOnlyTheStepsSeeedOwns() {
        // Pairing, discovery and Bluetooth belong to their app for now; the
        // three load-bearing screens are ours in both phases.
        for step in HaloOnboardingStep.allCases where step.isLoadBearing {
            XCTAssertFalse(
                step.isStubbedInBridgePhase && step != .pairing,
                "\(step) is load-bearing and must not be stubbed"
            )
        }
    }

    func testEveryStepHasWords() {
        for step in HaloOnboardingStep.allCases {
            XCTAssertFalse(step.title.isEmpty)
            XCTAssertFalse(step.body().isEmpty)
            XCTAssertFalse(step.primaryActionTitle.isEmpty)
        }
    }
}

/// The Island's vocabulary, pinned here because it lives in a second binary.
///
/// `HaloActivityCopy` in the widget extension cannot import HaloKit — an
/// app-extension and a package are separate compilation units and the
/// ActivityKit pattern is to duplicate the shared types. So the phrasing is
/// duplicated on purpose, and these tests pin the outputs both copies must
/// produce. If somebody changes `HaloSync` and forgets the widget, this fails.
final class IslandCopyParityTests: XCTestCase {
    /// The widget's implementation, transcribed. Any divergence shows up as a
    /// failure here rather than as two surfaces disagreeing on a lock screen.
    private func widgetLagLine(behindSeconds: Int?, offTheRecord: Bool = false) -> String {
        if offTheRecord { return "off" }
        guard let behindSeconds else { return "—" }
        if behindSeconds < 90 { return "live" }
        let minutes = Int((Double(behindSeconds) / 60).rounded())
        if minutes < 60 { return "\(minutes)m behind" }
        return "\(Int((Double(minutes) / 60).rounded()))h behind"
    }

    func testTheIslandAndTheCardAgreeOnTheSameNumber() {
        for seconds in [0, 45, 89, 90, 190, 3600, 9000] {
            let card = HaloSync(state: "behind", behindSeconds: seconds)
            let island = widgetLagLine(behindSeconds: seconds)
            // Both use the same rounding; the Island just says it shorter.
            if seconds < 90 {
                XCTAssertEqual(island, "live")
            } else {
                XCTAssertTrue(
                    island.hasPrefix(HaloSync.compact(seconds)),
                    "island '\(island)' should start with card's '\(HaloSync.compact(seconds))'"
                )
            }
            XCTAssertFalse(card.islandLine.isEmpty)
        }
    }

    func testTheIslandNeverPrintsAZeroItInvented() {
        XCTAssertEqual(widgetLagLine(behindSeconds: nil), "—")
    }

    func testOffTheRecordSaysSoRatherThanShowingALag() {
        // A chosen silence is a fact, not a sync problem.
        XCTAssertEqual(widgetLagLine(behindSeconds: 600, offTheRecord: true), "off")
    }
}
