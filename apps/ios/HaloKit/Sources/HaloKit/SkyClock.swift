import SwiftUI

/// The sky clock — every Halo surface is lit by the hour it describes.
///
/// E1: "the app has weather instead of a theme". The gradient is computed from
/// the *time the surface is about*, not from the current time and not from
/// anything inferred about how the day felt. That distinction is the honesty
/// rule the design repeats: **sky gradients come from the clock, never from
/// inferred mood.** A day that went badly and a day that went well at the same
/// hour look identical, because the sky is a fact about when, not a judgement
/// about what.
///
/// Six keyframes, interpolated. Interpolating rather than switching is what
/// makes an 11am surface and a 1pm surface feel like the same day rather than
/// two themes.
public struct SkyClock: Equatable, Sendable {
    public let top: RGB
    public let bottom: RGB

    public struct RGB: Equatable, Sendable {
        public let r: Double, g: Double, b: Double
        public init(_ r: Double, _ g: Double, _ b: Double) {
            self.r = r; self.g = g; self.b = b
        }
        static func lerp(_ a: RGB, _ b: RGB, _ t: Double) -> RGB {
            RGB(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t)
        }
    }

    /// Keyframe hours and their skies, dark through dawn to night.
    /// Deliberately low-saturation: this sits behind text all day.
    static let keyframes: [(hour: Double, sky: SkyClock)] = [
        (0, SkyClock(top: RGB(0.04, 0.05, 0.11), bottom: RGB(0.02, 0.03, 0.07))),
        (6, SkyClock(top: RGB(0.16, 0.14, 0.26), bottom: RGB(0.35, 0.22, 0.26))),
        (9, SkyClock(top: RGB(0.24, 0.34, 0.52), bottom: RGB(0.52, 0.48, 0.53))),
        (13, SkyClock(top: RGB(0.28, 0.42, 0.62), bottom: RGB(0.44, 0.55, 0.68))),
        (18, SkyClock(top: RGB(0.34, 0.26, 0.42), bottom: RGB(0.66, 0.36, 0.31))),
        (21, SkyClock(top: RGB(0.10, 0.10, 0.20), bottom: RGB(0.18, 0.12, 0.20))),
        (24, SkyClock(top: RGB(0.04, 0.05, 0.11), bottom: RGB(0.02, 0.03, 0.07)))
    ]

    /// The sky at a given hour-of-day (0–24, fractional).
    public static func at(hour: Double) -> SkyClock {
        let h = hour.truncatingRemainder(dividingBy: 24)
        let clamped = h < 0 ? h + 24 : h

        for index in 0..<(keyframes.count - 1) {
            let (h0, sky0) = keyframes[index]
            let (h1, sky1) = keyframes[index + 1]
            guard clamped >= h0, clamped <= h1 else { continue }
            let span = h1 - h0
            let t = span == 0 ? 0 : (clamped - h0) / span
            return SkyClock(
                top: RGB.lerp(sky0.top, sky1.top, t),
                bottom: RGB.lerp(sky0.bottom, sky1.bottom, t)
            )
        }
        return keyframes[0].sky
    }

    /// The sky for a moment, in the owner's own timezone — the hour they
    /// lived, not the hour in UTC.
    public static func at(date: Date, calendar: Calendar = .current) -> SkyClock {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let hour = Double(parts.hour ?? 12) + Double(parts.minute ?? 0) / 60
        return at(hour: hour)
    }

    public init(top: RGB, bottom: RGB) {
        self.top = top
        self.bottom = bottom
    }
}

extension SkyClock.RGB {
    var color: Color { Color(red: r, green: g, blue: b) }
}

extension SkyClock {
    /// The gradient a surface paints itself with.
    public var gradient: LinearGradient {
        LinearGradient(
            colors: [top.color, bottom.color],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

extension SkyClock {
    /// Perceived lightness of the sky, 0 (midnight) to 1 (noon).
    ///
    /// Rec. 709 luma on the gradient's midpoint, because the arc crosses both
    /// stops and a stroke chosen for one end vanishes at the other.
    public var luminance: Double {
        let r = (top.r + bottom.r) / 2
        let g = (top.g + bottom.g) / 2
        let b = (top.b + bottom.b) / 2
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    /// True when the sky is light enough that a white dim stroke disappears
    /// into it — midday and early afternoon.
    public var isLight: Bool { luminance > 0.34 }
}
