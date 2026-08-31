import SwiftUI

/// The motion contract, in one place.
///
/// E5 fixes the timings, and they are a contract rather than taste: 240ms
/// standard, 180ms dismiss, 280ms sheet, 320ms shared-element, and the dock's
/// 520ms flight at spring damping ~0.82. Scattering those numbers across
/// views is how an app ends up feeling like several apps, so they live here
/// and the views ask for them by name.
///
/// ## Reduced Motion is a first-class path, not a degradation
///
/// Under Reduced Motion everything becomes an 80ms crossfade with **zero
/// translation**. That matters more here than in most apps: the dock's whole
/// point is a card flying across the screen, and for somebody who gets motion
/// sick that is not a delight, it is a reason to stop using the product. The
/// accept still happens, the count still ticks, the undo pill still appears —
/// only the flight is removed.
public enum HaloMotion {
    public static let standard: Double = 0.24
    public static let dismiss: Double = 0.18
    public static let sheet: Double = 0.28
    public static let sharedElement: Double = 0.32
    /// The dock's flight, from lift to catch.
    public static let dockFlight: Double = 0.52
    /// How long the undo pill stays. Long enough to notice, short enough not
    /// to become a second decision to make.
    public static let undoWindow: Double = 5.0

    public static let springDamping: Double = 0.82

    /// The spring the dock flies on.
    public static func dockSpring(reduceMotion: Bool) -> Animation {
        reduceMotion
            ? .easeInOut(duration: 0.08)
            : .spring(response: dockFlight, dampingFraction: springDamping)
    }

    public static func standardEase(reduceMotion: Bool) -> Animation {
        .easeInOut(duration: reduceMotion ? 0.08 : standard)
    }

    public static func dismissEase(reduceMotion: Bool) -> Animation {
        .easeInOut(duration: reduceMotion ? 0.08 : dismiss)
    }

    /// The lift the card takes before it flies. Zero under Reduced Motion —
    /// scale and rotation are translation's cousins for anyone susceptible.
    public static func liftScale(reduceMotion: Bool) -> Double {
        reduceMotion ? 1.0 : 1.03
    }

    public static func liftRotation(reduceMotion: Bool) -> Double {
        reduceMotion ? 0 : -2
    }
}

/// Haptics, mapped once so they cannot drift.
///
/// E5's map is deliberately sparse, and the two prohibitions are the load
/// bearing part: **never on scroll, never on appear.** A device that buzzes
/// when something merely arrives trains people to ignore the buzz, and Halo
/// needs the buzz to still mean something when it is the clip confirming a
/// bookmark. `.error` is never used at all — nothing in Halo fails loudly;
/// failures are quiet amber cards.
public enum HaloHaptic: Equatable, Sendable {
    /// Bead tap, chapter open, swipe reveal.
    case selection
    /// The dock catch, a bookmark landing, a hand-off.
    case commit
    /// The day-close "Good night", and nothing else.
    case bloom

    #if canImport(UIKit)
    public func play() {
        switch self {
        case .selection:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .commit:
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .bloom:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
    }
    #else
    public func play() {}
    #endif
}
