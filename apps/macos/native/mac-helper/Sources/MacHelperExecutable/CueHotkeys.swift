import AppKit
import Foundation

/// Cue Live dynamic hotkeys — backlog #29 "dynamic / user-configurable hotkeys
/// + a ⌥R push-to-run key".
///
/// The summon hotkey used to be hardcoded (Control+Option+Space) inside
/// `CueLiveController.installHotkeyMonitors`. This file factors the binding out
/// into a parsed value type (`CueHotkey`) and a small holder
/// (`CueHotkeyBindings`) so the daemon can push user-chosen bindings over
/// JSON-RPC without the helper hardcoding any specific chord. It is purely
/// additive: with no config pushed, the defaults reproduce the previous
/// behavior (summon = Control+Option+Space) and add a new ⌥R push-to-run key.
///
/// Why a value type rather than RegisterEventHotKey: the summon path already
/// runs on global / local `NSEvent` monitors (so it can also intercept Escape
/// for abort), and reusing that path keeps a single matching codebase for every
/// binding. The Fn push-to-talk hotkey in `main.swift` is unrelated and keeps
/// its Carbon registration.

/// A parsed keyboard chord: a set of modifier flags plus a single key.
/// Matching is order-independent and case-insensitive on the spec.
struct CueHotkey: Equatable, Sendable {
    /// The non-modifier key's virtual keycode (kVK_* / NSEvent.keyCode).
    let keyCode: UInt16
    /// Required modifier flags (device-independent mask).
    let modifiers: NSEvent.ModifierFlags
    /// The canonical spec string this was parsed from (for echoing to the UI).
    let spec: String

    /// Parse a spec like `"control+option+space"`, `"option+r"`, `"cmd+shift+k"`.
    /// Tokens are `+`-separated, case-insensitive, whitespace-tolerant. Modifier
    /// aliases: cmd/command/⌘, ctrl/control/⌃, opt/option/alt/⌥, shift/⇧.
    /// Returns nil when there is no non-modifier key or the key is unknown.
    init?(spec rawSpec: String) {
        let tokens = rawSpec
            .lowercased()
            .split(whereSeparator: { $0 == "+" || $0 == " " || $0 == "-" })
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !tokens.isEmpty else { return nil }

        var mods: NSEvent.ModifierFlags = []
        var key: UInt16?
        for token in tokens {
            if let mod = Self.modifierAliases[token] {
                mods.insert(mod)
                continue
            }
            // Exactly one non-modifier key is allowed; reject a second one and
            // any unknown token.
            guard key == nil, let code = Self.keyCodes[token] else {
                return nil
            }
            key = code
        }
        guard let key else { return nil }
        self.keyCode = key
        self.modifiers = mods
        // Canonical spec: sorted modifier names + key, "+"-joined.
        let modNames = Self.canonicalModifierNames(mods)
        let keyName = Self.keyNames[key] ?? "key\(key)"
        self.spec = (modNames + [keyName]).joined(separator: "+")
    }

    /// True when `event` matches this chord: the required modifiers are exactly
    /// present (extra incidental flags like CapsLock are ignored) and the
    /// keyCode matches.
    func matches(_ event: NSEvent) -> Bool {
        guard event.keyCode == keyCode else { return false }
        let active = event.modifierFlags
            .intersection(.deviceIndependentFlagsMask)
            .intersection(Self.allMatchable)
        return active == modifiers
    }

    // Only these flags participate in matching; ignore CapsLock / function /
    // numericPad so a stray modifier doesn't break the chord.
    private static let allMatchable: NSEvent.ModifierFlags = [
        .command, .control, .option, .shift,
    ]

    private static let modifierAliases: [String: NSEvent.ModifierFlags] = [
        "cmd": .command, "command": .command, "⌘": .command, "meta": .command,
        "ctrl": .control, "control": .control, "⌃": .control,
        "opt": .option, "option": .option, "alt": .option, "⌥": .option,
        "shift": .shift, "⇧": .shift,
    ]

    private static func canonicalModifierNames(
        _ mods: NSEvent.ModifierFlags
    ) -> [String] {
        var names: [String] = []
        if mods.contains(.control) { names.append("control") }
        if mods.contains(.option) { names.append("option") }
        if mods.contains(.shift) { names.append("shift") }
        if mods.contains(.command) { names.append("command") }
        return names
    }

    /// Map of spec key tokens → virtual keycodes. Covers letters, digits, and
    /// the common named keys; extend as the UI exposes more.
    private static let keyCodes: [String: UInt16] = [
        // Named keys
        "space": 49, "return": 36, "enter": 36, "tab": 48, "escape": 53,
        "esc": 53, "delete": 51, "backspace": 51,
        "up": 126, "down": 125, "left": 123, "right": 124,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        // Letters (US layout virtual keycodes)
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
        "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31,
        "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
        "w": 13, "x": 7, "y": 16, "z": 6,
        // Digits
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
        "7": 26, "8": 28, "9": 25,
    ]

    /// Reverse map for canonicalization (keyCode → display token).
    private static let keyNames: [UInt16: String] = {
        var out: [UInt16: String] = [:]
        for (name, code) in keyCodes where out[code] == nil {
            out[code] = name
        }
        return out
    }()
}

/// The set of Cue Live hotkey bindings the daemon can configure. Each is
/// optional; a nil binding disables that action. Defaults reproduce the
/// previously-hardcoded behavior so existing callers are unaffected.
struct CueHotkeyBindings: Sendable {
    /// Summon Cue Live at the cursor (read → highlight → card → guidance).
    var summon: CueHotkey?
    /// Push-to-run: a one-shot "act on what you said / see now" trigger,
    /// distinct from summon. ⌥R by default (backlog #29).
    var run: CueHotkey?
    /// Point-at-element: a pointing-only look gesture — fly the cursor to the
    /// element the user most likely needs next, no take-control. ⌥P by default.
    var point: CueHotkey?

    /// The shipped defaults: summon = Control+Option+Space, run = Option+R,
    /// point = Option+P.
    static let defaults = CueHotkeyBindings(
        summon: CueHotkey(spec: "control+option+space"),
        run: CueHotkey(spec: "option+r"),
        point: CueHotkey(spec: "option+p")
    )

    /// Apply a partial update: an `.absent` field keeps the current binding (so
    /// a partial update doesn't clobber the others), while `.present(hotkey)`
    /// replaces it (with `nil` disabling the action).
    func applying(
        summon: CueHotkeyField, run: CueHotkeyField, point: CueHotkeyField
    ) -> CueHotkeyBindings {
        var result = self
        if case let .present(hotkey) = summon { result.summon = hotkey }
        if case let .present(hotkey) = run { result.run = hotkey }
        if case let .present(hotkey) = point { result.point = hotkey }
        return result
    }
}

/// One field of a partial hotkey update, extracted from the loosely-typed RPC
/// params into a Sendable form so it can cross an actor boundary. `.absent`
/// means the key wasn't sent; `.present(nil)` means it was sent empty/invalid
/// (→ disable the binding).
enum CueHotkeyField: Sendable {
    case absent
    case present(CueHotkey?)

    /// Read `params[key]`: missing key → `.absent`; an empty/invalid spec →
    /// `.present(nil)`; a valid spec → `.present(hotkey)`.
    static func from(params: [String: Any], key: String) -> CueHotkeyField {
        guard params.keys.contains(key) else { return .absent }
        guard let spec = params[key] as? String, !spec.isEmpty else {
            return .present(nil)
        }
        return .present(CueHotkey(spec: spec))
    }
}

/// Cue Live vision-capture mode (backlog #29 "scoped / always-on capture
/// modes"). This is the contract the daemon configures; the helper stores it
/// and reports it back. Frame-streaming for the always-on / scoped modes is
/// intentionally not implemented here (that needs Screen-Recording runtime
/// verification we can't do in CI) — `manual` keeps today's behavior exactly.
enum CueCaptureMode: String, Sendable {
    /// Capture only on an explicit `captureScreen` call (today's behavior).
    case manual
    /// Capture is scoped to a single app/window the daemon names (future:
    /// the helper would filter `SCContentFilter` to that window).
    case scoped
    /// Always-on: the helper would periodically push frames to the daemon.
    case alwaysOn = "always-on"

    /// Lenient parse: unknown / missing values fall back to `manual`. Accepts
    /// both "always-on" and "alwayson"/"always_on" spellings.
    static func parse(_ raw: Any?) -> CueCaptureMode {
        guard let s = (raw as? String)?
            .trimmingCharacters(in: .whitespaces)
            .lowercased()
        else { return .manual }
        switch s {
        case "scoped": return .scoped
        case "always-on", "alwayson", "always_on", "on": return .alwaysOn
        default: return .manual
        }
    }
}
