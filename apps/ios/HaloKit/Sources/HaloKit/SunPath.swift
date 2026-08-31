import SwiftUI

/// The sun path — the day drawn as an arc that fills as it is lived.
///
/// E5 calls it "one hero, everywhere": an Island stub, the Today tile's edge,
/// the Day cover, the recap, the share card, a watch complication. The rule is
/// **one drawing, scaled — never redrawn differently**, because that is what
/// makes the product recognisable at a glance. So the geometry is computed
/// here, once, in normalised space, and every size is the same maths through a
/// different rect.
///
/// ## The three treatments, and why they cannot be shared
///
/// S6 ruling 4 fixes the arc's grammar, and the distinction is the whole point:
///
/// - **lived** — solid warm stroke. This happened, and Cue heard it.
/// - **not yet** — fine dotted at 18%. The rest of today, unwritten. *Dotted
///   reads as promise.*
/// - **gap** — dim solid at 14%, with a caption. Time that passed unheard.
///   *Dim-solid reads as record.*
///
/// If not-yet and gap looked alike, every morning would render as a broken
/// day — at 8am the arc is mostly future, and that has to read as morning
/// rather than as failure. That single sentence is why this file draws three
/// stroke styles instead of two.
///
/// A soft glow head marks the now-point, so "filled to now" has an obvious tip.
public struct SunPathGeometry: Equatable, Sendable {
    /// Where the day starts and ends on the arc, as hours-of-day.
    public let startHour: Double
    public let endHour: Double

    public init(startHour: Double = 6, endHour: Double = 22) {
        self.startHour = startHour
        self.endHour = endHour
    }

    /// Position along the arc for an hour-of-day, 0...1.
    ///
    /// Clamped rather than extrapolated: a 3am chapter belongs at the very
    /// start of the arc, not off the end of it, and the alternative is a bead
    /// drawn outside the drawing.
    public func progress(forHour hour: Double) -> Double {
        let span = endHour - startHour
        guard span > 0 else { return 0 }
        return min(max((hour - startHour) / span, 0), 1)
    }

    /// The point on a semicircular arc at `t` (0 = dawn, left; 1 = dusk, right).
    ///
    /// A half-circle inscribed in the rect: the sun rises on the left, peaks
    /// at the top centre, sets on the right.
    public func point(at t: Double, in rect: CGRect) -> CGPoint {
        let clamped = min(max(t, 0), 1)
        let angle = Double.pi * (1 - clamped)
        let radiusX = rect.width / 2
        let radiusY = rect.height
        return CGPoint(
            x: rect.midX + cos(angle) * radiusX,
            y: rect.maxY - sin(angle) * radiusY
        )
    }

    /// The arc from `from` to `to` as a path, in the given rect.
    public func path(from: Double, to: Double, in rect: CGRect, steps: Int = 64) -> Path {
        var path = Path()
        guard to > from, steps > 0 else { return path }
        for step in 0...steps {
            let t = from + (to - from) * (Double(step) / Double(steps))
            let point = self.point(at: t, in: rect)
            if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        return path
    }
}

/// One stretch of the arc, and how it must be drawn.
public struct SunPathSegment: Equatable, Sendable, Identifiable {
    public enum Treatment: Equatable, Sendable {
        /// Solid warm — heard.
        case lived
        /// Fine dotted, 18% — the rest of today. A promise, not a hole.
        case notYet
        /// Dim solid, 14% — time that passed unheard, with its reason.
        case gap(reason: HaloGap.Reason, caption: String?)
    }

    public let id: String
    public let from: Double
    public let to: Double
    public let treatment: Treatment

    public init(id: String, from: Double, to: Double, treatment: Treatment) {
        self.id = id
        self.from = from
        self.to = to
        self.treatment = treatment
    }
}

/// Turn a day into the arc's segments.
///
/// Pure, so the grammar can be tested without rendering anything. The order
/// matters: gaps are laid over the lived stretch, and the not-yet tail is
/// whatever remains after `now`.
public enum SunPathBuilder {
    public static func segments(
        day: HaloDay,
        now: Date,
        geometry: SunPathGeometry = SunPathGeometry(),
        calendar: Calendar = .current
    ) -> [SunPathSegment] {
        func hour(_ epochMs: Int) -> Double {
            let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
            let parts = calendar.dateComponents([.hour, .minute], from: date)
            return Double(parts.hour ?? 0) + Double(parts.minute ?? 0) / 60
        }

        let nowParts = calendar.dateComponents([.hour, .minute], from: now)
        let nowHour = Double(nowParts.hour ?? 0) + Double(nowParts.minute ?? 0) / 60
        let nowT = geometry.progress(forHour: nowHour)

        // Gaps first, because lived is defined as *what is left over*.
        //
        // The obvious implementation — one lived stroke, gaps painted on top —
        // does not work and looks fine while being wrong: a 14% white overlay
        // TINTS the warm stroke rather than replacing it, so an unheard
        // afternoon renders as a slightly paler heard afternoon. The three
        // treatments have to be mutually exclusive stretches of the arc, not
        // layers, or the grammar collapses exactly where it matters most.
        var gapRanges: [(from: Double, to: Double, gap: HaloGap)] = []
        for gap in day.gaps {
            let from = geometry.progress(forHour: hour(gap.startedAt))
            // An open gap runs to now, not to dusk: it is still happening, and
            // drawing it to the end of the day would claim the evening too.
            let to = min(gap.endedAt.map { geometry.progress(forHour: hour($0)) } ?? nowT, nowT)
            guard to > from else { continue }
            gapRanges.append((from, to, gap))
        }
        gapRanges.sort { $0.from < $1.from }

        var segments: [SunPathSegment] = []
        var cursor = 0.0

        for range in gapRanges {
            // The heard stretch before this gap.
            if range.from > cursor {
                segments.append(
                    SunPathSegment(
                        id: "lived-\(segments.count)",
                        from: cursor,
                        to: range.from,
                        treatment: .lived
                    )
                )
            }
            // Gaps overlap in real days — a battery death inside an unworn
            // morning is two true facts about the same minutes. Sorted by
            // start, a gap already covered by an earlier one contributes
            // nothing; drawing it anyway produces a backwards segment.
            guard range.to > cursor else { continue }
            segments.append(
                SunPathSegment(
                    id: range.gap.id,
                    from: max(range.from, cursor),
                    to: range.to,
                    treatment: .gap(reason: range.gap.reason, caption: range.gap.caption)
                )
            )
            cursor = range.to
        }

        // Whatever is heard between the last gap and now.
        if nowT > cursor {
            segments.append(
                SunPathSegment(
                    id: "lived-\(segments.count)",
                    from: cursor,
                    to: nowT,
                    treatment: .lived
                )
            )
        }

        // The tail. Dotted, because the rest of today is unwritten — at 8am
        // this is most of the arc, and it has to read as morning.
        if nowT < 1 {
            segments.append(
                SunPathSegment(id: "not-yet", from: nowT, to: 1, treatment: .notYet)
            )
        }

        return segments
    }

    /// Where each chapter's bead sits on the arc.
    public static func beads(
        day: HaloDay,
        geometry: SunPathGeometry = SunPathGeometry(),
        calendar: Calendar = .current
    ) -> [(episode: HaloEpisode, t: Double)] {
        day.episodes.map { episode in
            let date = Date(timeIntervalSince1970: Double(episode.startedAt) / 1000)
            let parts = calendar.dateComponents([.hour, .minute], from: date)
            let hour = Double(parts.hour ?? 0) + Double(parts.minute ?? 0) / 60
            return (episode, geometry.progress(forHour: hour))
        }
    }
}
