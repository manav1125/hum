# Upstream vellum-assistant UI — visual reference pack

> Internal design reference only — upstream (vellum-assistant) UI, captured from their source at `f68e27b9dd2ee29214ed01b8ba7cdc37f9f778ba` (origin/main, 2026-08-03). For color/context, not for copying.

Captured 2026-08-05 from upstream's own Storybook (`clients/web`, `storybook dev`), screenshotted headless with Playwright at 2x device scale. Story ids are noted so any shot can be re-rendered. The voice "Reactive Animations" stories are demo harnesses — the small `driver: speech / amp` header strip at the top of those shots is the story's debug control, not product UI.

## 1. Live voice

| File | Story id | What it shows |
|---|---|---|
| `voice-room-desktop-dark.png` | `chat-voice-reactive-animations--room-desktop` | Full-screen voice room, dark: green avatar surface with half-moon eyes, reactive listening wave along the bottom edge. |
| `voice-room-desktop-light.png` | same, light theme | Same room composition on the light theme (room surface stays avatar-colored; page chrome lightens). |
| `voice-room-mobile-390-dark.png` | `chat-voice-reactive-animations--room-mobile` @ 390px | Mobile voice room: rounded full-bleed card, eyes centered, wave amplitude pinned to the bottom third. |
| `voice-bar-minimized-composer-dark.png` | `chat-voice-reactive-animations--minimized-composer-bar` | Minimized voice bar docked above the chat composer: mic icon left, live wave through the middle, speaker/expand/close controls right. |
| `voice-bar-minimized-composer-light.png` | same, light theme | Light-theme variant of the minimized composer bar. |
| `voice-reactive-states-dark.png` | `chat-voice-reactive-animations--states` | The reactive wave engine across session states (idle/listening/thinking/responding) side by side. |
| `voice-responding-response-dark.png` | `chat-voice-reactive-animations--responding-response` | Responding state: how the wave + caption behave while the assistant speaks. |
| `voice-caption-emphasis-dark.png` | `chat-voice-reactive-animations--caption-emphasis` | Caption emphasis treatment for spoken text inside the room. |
| `voice-mesh-waves-showcase-dark.png` | `chat-voice-reactive-animations--mesh-showcase` | Mesh wave rendering showcase — the fine line-mesh texture variants of the voice wave. |
| `voice-avatar-eyes-states-dark.png` | `chat-voice-voiceavatar--states` | Avatar eye states grid (idle, listening, thinking, speaking...), dark. |
| `voice-avatar-eyes-states-light.png` | same, light theme | Same eye-state grid, light. |
| `voice-avatar-void-look-states-dark.png` | `chat-voice-voiceavatar--void-look-states` | The "void look" avatar treatment across states (alternate eye/face style). |
| `voice-transcript-spoken-word-highlight-dark.png` | `chat-voice-transcript--spoken-word-highlight` | Voice transcript with word-level spoken-word highlight (karaoke cursor). |

Not storied upstream, so not captured: the full `voice-room.tsx` composition with live session store (title-bar `voice-session-pill.tsx` has tests but no story), and a mid-call approval treatment inside the room (approvals are storied only as chat surfaces — see section 3).

## 2. Transcript & result cards

| File | Story id | What it shows |
|---|---|---|
| `chat-transcript-conversation-light.png` | `chat-transcript--conversation` | Baseline chat transcript: user bubbles right, assistant prose left, inline code chips. |
| `chat-transcript-rich-content-light.png` | `chat-transcript--rich-content` | Transcript with rich markdown content (tables/code/lists treatment). |
| `work-result-inbox-cleanup-light.png` | `chat-surfaces-workresult--inbox-cleanup` | Work-result surface: completed-run summary card with metrics and item list (inbox cleanup example). |
| `work-result-compact-metrics-light.png` | `chat-surfaces-workresult--compact-metrics-only` | Compact metrics-only variant of the work-result card — the closest storied analog to a summarize/compact result treatment. |
| `work-result-document-diff-dark.png` | `chat-surfaces-workresult--document-diff` | Work-result card presenting a document diff, dark theme. |

## 3. Approval / guardian cards & intelligence chrome

| File | Story id | What it shows |
|---|---|---|
| `tool-approval-card-basic-light.png` | `chat-surfaces-toolapprovalcard--basic-tool-approval` | Standard in-chat tool approval card: tool metadata, allow/deny actions. |
| `tool-approval-card-dangerous-dark.png` | `chat-surfaces-toolapprovalcard--dangerous-tool` | Dangerous-tool approval variant, dark — elevated risk styling. |
| `inline-confirmation-card-light.png` | `chat-inlineconfirmationcard--default` | Inline confirmation card (the lighter-weight mid-conversation confirm). |
| `access-request-card-light.png` | `chat-surfaces-accessrequestcard--normal-user` | Guardian-style access request card for a user requesting access to the assistant. |
| `intelligence-layout-section-chrome-light.png` | `intelligence-intelligencelayout--section-chrome` | Intelligence surface layout chrome (section framing around memory/concept views). |

Not captured: bookmarks page (`domains/settings/pages/bookmarks-page.tsx`) and concept graph (`domains/intelligence/components/concept-graph/`) have no stories and fetch live data; rendering them would have required adding harness files to the upstream clone's source, which this pack deliberately avoids.

## Appendix — iOS Dynamic Island / Live Activity (SwiftUI source)

No Xcode render available; the layout source is short and self-documenting. Two files, verbatim from the same commit.

### `clients/ios/App/VoiceActivity/VoiceSessionLiveActivity.swift` — the four island presentations

```swift
import ActivityKit
import SwiftUI
import WidgetKit

/// The live-voice session, rendered on the Lock Screen and in the Dynamic
/// Island.
///
/// All four presentations are the same handful of facts at four sizes, composed
/// from the primitives in `VoiceSessionIslandViews.swift`; see that file for
/// the two rules they share (no native phase copy, accent as decoration only)
/// and for which facts survive into the tightest slots.
///
/// **There are no interactive controls, by design.** An in-island end button
/// would need a `LiveActivityIntent` plus a signalling path into the running
/// app, and it contradicts the voice room's established invariant that the
/// room is a full-app takeover whose ✕ is the only exit. Tap-to-return is the
/// single affordance, so both halves of "look at it" and "act on it" resolve
/// to the same place: the room.
///
/// The tap target is `VoiceModeDeepLink.resume`, the same shared contract the
/// App Intents use: it foregrounds the app into the live voice room, falling
/// through to a fresh session if the app was killed and the session is gone.
/// Its URL is built from *this* build's own scheme, so a Dev island opens the
/// Dev app even with production installed — and is `nil` on a build that
/// declares no scheme, which correctly leaves the presentation untappable
/// (`.widgetURL(_:)` takes an optional) rather than sending a Dev island into
/// the production app.
struct VoiceSessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceSessionAttributes.self) { context in
            VoiceSessionLockScreenView(
                assistantName: context.attributes.assistantName,
                state: context.state,
                startedAt: context.attributes.startedAt,
                isStale: context.isStale,
                avatarImageData: context.attributes.avatarImageData
            )
            .widgetURL(VoiceModeDeepLink.resume.url())
        } dynamicIsland: { context in
            let state = context.state
            let isStale = context.isStale
            let label = state.displayLabel(isStale: isStale)
            let detail = state.displayDetail(isStale: isStale)
            let avatar = context.attributes.avatarImageData
            let startedAt = context.attributes.startedAt
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VoiceAccentBadge(accent: state.accentColor, avatarImageData: avatar)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    // Elapsed time, plus the mute glyph while muted. There is
                    // still no always-present mic glyph, which would read as a
                    // control, and there are none here.
                    HStack(spacing: 6) {
                        VoiceSessionTimer(startedAt: startedAt, isStale: isStale)
                        if state.muted {
                            VoiceMuteGlyph()
                        }
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    VoiceSessionText(
                        text: context.attributes.assistantName,
                        font: .headline
                    )
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // Everything the activity knows, because reaching this
                    // presentation is deliberate: it takes a touch and hold,
                    // and someone who did that is asking for the detail the
                    // inline slots had to drop. So the phase and the activity
                    // line both render here rather than competing for one row.
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            VoicePhaseGlyph(state: state, isStale: isStale)
                            VoiceSessionText(text: label, color: .secondary)
                        }
                        if !detail.isEmpty {
                            VoiceSessionText(
                                text: detail,
                                font: .caption,
                                color: .tertiary
                            )
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                VoiceCompactIdentity(accent: state.accentColor, avatarImageData: avatar)
            } compactTrailing: {
                // A few characters wide. The passed label truncates to a
                // fragment here, and the fragments for "Listening…" and
                // "Thinking…" are not worth telling apart, so the phase shows
                // as a glyph instead. A glyph is not a native *string*, which
                // is what the copy rule actually guards against; shortening
                // the wording, if it is ever wanted here, belongs to the web
                // layer that owns the wording.
                VoicePhaseGlyph(state: state, isStale: isStale, scale: .small)
            } minimal: {
                // **The presentation a voice session most likely gets.** iOS
                // shows the minimal slot when the island is shared, and a live
                // session always shares it: the system's microphone privacy
                // indicator is on for the whole call, including while muted,
                // because muting streams silence rather than stopping capture.
                //
                // So this one circle is the entire island for most of a call,
                // and it carries the phase rather than the avatar. Identity is
                // the fact that does not change and that the user already
                // knows; whether it is still listening is the one they cannot
                // get from a locked phone. The accent tint keeps identity
                // present, weakly, in the glyph's color.
                VoiceMinimalPresentation(
                    state: state,
                    isStale: isStale,
                    avatarImageData: avatar
                )
            }
            .widgetURL(VoiceModeDeepLink.resume.url())
            .keylineTint(state.accentColor)
        }
    }
}
```

### `clients/ios/App/VoiceActivity/VoiceSessionIslandViews.swift` — shared primitives (avatar badge, phase glyph, timer, lock-screen row)

```swift
import SwiftUI
import UIKit

// Shared building blocks for the live-voice Live Activity.
//
// The Lock Screen, expanded, compact and minimal presentations are four
// separately-sized renderings of the *same* facts: identity (the avatar and
// the assistant's name), the current phase (as a glyph and as passed-through
// wording), how long the call has been running, and whether the mic is muted.
// They compose from these primitives rather than each growing its own copy
// that drifts.
//
// Which of those a slot can show is a function of its size, and the order they
// drop in is by how much they tell the user: the compact and minimal
// presentations keep identity and the phase glyph, because a glyph survives
// being 20 points wide and a sentence does not.
//
// Two rules run through all of them:
//
// 1. **No native phase copy.** Every user-facing string here is either
//    `ContentState.label` or `VoiceSessionAttributes.assistantName`, both
//    passed through from the web side. `LIVE_VOICE_STATE_LABELS` /
//    `liveVoiceSurfaceLabel` in `live-voice-store.ts` own the wording — this
//    shell ships on App Store cadence while that copy deploys continuously,
//    so a native `switch` over `phase` would fossilize old strings. Tight
//    slots truncate the passed label; they never substitute a shorter native
//    one.
// 2. **Accent is decoration, never the carrier.** `accentHex` is the user's
//    avatar color and can be any brightness, while the Lock Screen renders
//    over a wallpaper in either appearance. Text is therefore always
//    `.primary`/`.secondary`, which adapts; the accent only fills shapes that
//    carry a hairline `.primary` border so their edge stays visible whatever
//    is behind them.

extension VoiceSessionAttributes.ContentState {
    /// The avatar accent as a SwiftUI color.
    ///
    /// `accentHex` is canonicalized on the way in — including through
    /// `init(from:)`, so it survives decoding into this extension — to a form
    /// `UIColor(cssHex:)` accepts. The final fallback is unreachable in
    /// practice and exists only so this stays non-optional.
    var accentColor: Color {
        Color(cssHex: accentHex)
            ?? Color(cssHex: Self.neutralAccentHex)
            ?? .secondary
    }

    /// The phase label to render, or nothing once ActivityKit has marked the
    /// content stale.
    ///
    /// Staleness means the app stopped pushing updates before this state's
    /// `staleDate` (`VoiceLiveActivityPlugin.contentStaleAfter`). For a session
    /// driven entirely by a web view that iOS may have suspended, that is far
    /// more likely to mean "wedged" than "still genuinely listening" — and the
    /// phase wording is the one thing on the island that can be *wrong*, so it
    /// is what drops. The assistant name and accent stay: a session with this
    /// assistant does exist, and tapping through still returns to it.
    func displayLabel(isStale: Bool) -> String {
        isStale ? "" : label
    }

    /// The activity line to render, or nothing when there is none and once the
    /// content has gone stale.
    ///
    /// Stale drops it for the same reason it drops the phase label, only more
    /// so: "Reading a file" is a claim about work happening *right now*, which
    /// makes it the sentence on the island most likely to be a lie once
    /// nothing is driving updates any more.
    func displayDetail(isStale: Bool) -> String {
        isStale ? "" : detail
    }

    /// The SF Symbol standing for this phase.
    ///
    /// **A glyph is not copy, which is why this may switch on `phase` when
    /// nothing else here may.** The rule the rest of this file follows exists
    /// because wording deploys continuously while this shell ships on App Store
    /// review; a symbol has no such second source to drift from. The phase
    /// vocabulary itself is the contract, and it already cannot change without
    /// changing ``Phase``, where a new case makes this switch a compile error.
    ///
    /// It earns its place by being the one part of the island that is legible
    /// at every size. Before this, all six phases rendered the same waveform
    /// and the compact trailing slot's job was done by a caption truncated to
    /// two or three characters, so in the presentation the user actually sees
    /// most of the time, "Listening…" and "Thinking…" were indistinguishable.
    var phaseSymbol: String {
        switch phase {
        case .connecting: return "antenna.radiowaves.left.and.right"
        case .listening: return "waveform"
        case .transcribing: return "text.bubble"
        case .thinking: return "ellipsis"
        case .speaking: return "speaker.wave.2.fill"
        case .ending: return "phone.down.fill"
        }
    }
}

/// The phase glyph: an accent-tinted symbol standing for the current phase.
///
/// Drops to nothing once ActivityKit marks the content stale, for the same
/// reason the label does: it is a claim about a session nothing has confirmed
/// is still running. See ``VoiceSessionAttributes/ContentState/displayLabel``.
struct VoicePhaseGlyph: View {
    let state: VoiceSessionAttributes.ContentState
    let isStale: Bool
    var scale: Image.Scale = .medium

    var body: some View {
        if !isStale {
            Image(systemName: state.phaseSymbol)
                .imageScale(scale)
                .foregroundStyle(state.accentColor)
                .accessibilityHidden(true)
        }
    }
}

/// Elapsed call time.
///
/// **The only moving part on the island that costs no update.**
/// `Text(timerInterval:)` is driven by the system from a start date carried in
/// the attributes, so it keeps counting through a suspended web layer, through
/// a missed push, and through the ActivityKit rate limit that makes every
/// content update expensive. That makes it the honest answer to "is this thing
/// still going". For a session whose phase can sit unchanged for minutes,
/// it is the difference between an island that looks frozen and one that
/// visibly is not.
///
/// Hidden once the content is stale: at that point how long the *activity* has
/// been up is no longer evidence of how long a session has, and the whole point
/// of staleness is to stop the island making claims it cannot support.
struct VoiceSessionTimer: View {
    let startedAt: Date
    let isStale: Bool
    var font: Font = .caption

    var body: some View {
        if !isStale {
            Text(
                timerInterval: startedAt...Date.distantFuture,
                countsDown: false,
                showsHours: false
            )
            .font(font)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .lineLimit(1)
            // Fixed so a digit rolling over cannot shove the layout around;
            // the timer sits next to truncating text in every slot it appears
            // in, and that text would reflow on every tick.
            .frame(minWidth: 40, alignment: .trailing)
            .accessibilityLabel("Call duration")
        }
    }
}

/// The accent-tinted state indicator: a waveform, tinted with the avatar
/// accent. Small enough to be the entire content of the minimal presentation
/// and of the compact leading slot.
struct VoiceAccentGlyph: View {
    let accent: Color
    var scale: Image.Scale = .medium

    var body: some View {
        Image(systemName: "waveform")
            .imageScale(scale)
            .foregroundStyle(accent)
            .accessibilityHidden(true)
    }
}

/// The assistant's avatar at a given size.
///
/// Takes an already-decoded image so each slot decides its own fallback: the
/// roomy layouts substitute an accent-filled badge, the tight ones a bare
/// glyph. Decoding is the only image work done here, because the bytes arrive
/// already sized and encoded from the web side, and a Live Activity cannot
/// fetch or resize anything at render time.
///
/// **Deliberately neither cropped to a circle nor bordered.** A character
/// avatar is a shaped creature on a transparent background whose silhouette
/// runs out to the edges of its square, so a circular mask cuts the edges off
/// and a ring drawn around it frames empty space. `scaledToFit` keeps the whole
/// silhouette, and the alpha the PNG rungs preserve is what lets it sit
/// directly on the island.
///
/// The cost is a custom *uploaded* avatar, which is square and would look
/// tidier masked. Distinguishing them would mean sending the avatar kind across
/// the bridge; the shaped creature is the default and the common case, so it
/// wins the single treatment until that is worth the plumbing.
struct VoiceAvatarImage: View {
    let image: UIImage
    var diameter: CGFloat

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(width: diameter, height: diameter)
            .accessibilityHidden(true)
    }
}

/// Decode the avatar attribute, or `nil` when there is none and when the bytes
/// do not form an image. A payload that fails to decode is treated exactly
/// like an absent one: the slot falls back to its accent treatment rather than
/// rendering a gap.
func voiceAvatarImage(_ data: Data?) -> UIImage? {
    guard let data else { return nil }
    return UIImage(data: data)
}

/// The assistant's avatar for the roomier Lock Screen and expanded layouts,
/// falling back to the accent glyph as a filled badge.
///
/// In the fallback the glyph is black or white by the accent's own luminance
/// so it is legible on any avatar color, and the hairline border is `.primary`
/// so the badge's edge reads against a light *and* a dark Lock Screen.
struct VoiceAccentBadge: View {
    let accent: Color
    var avatarImageData: Data?

    var body: some View {
        if let image = voiceAvatarImage(avatarImageData) {
            VoiceAvatarImage(image: image, diameter: 34)
        } else {
            VoiceAccentGlyph(accent: accent.contrastingForeground)
                .frame(width: 34, height: 34)
                .background(accent, in: Circle())
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
        }
    }
}

/// The identity mark for the compact leading slot: the avatar if there is one,
/// the accent waveform if not.
///
/// Sized rather than left to the slot because the inline presentations are the
/// ones iOS renders against the status bar, where an unconstrained image would
/// be laid out against the whole island rather than its own corner.
struct VoiceCompactIdentity: View {
    let accent: Color
    var avatarImageData: Data?

    var body: some View {
        if let image = voiceAvatarImage(avatarImageData) {
            VoiceAvatarImage(image: image, diameter: 20)
        } else {
            VoiceAccentGlyph(accent: accent, scale: .small)
        }
    }
}

/// The minimal presentation: the phase glyph, falling back to the identity
/// mark once the content is stale.
///
/// The fallback is what keeps this slot from rendering nothing at all.
/// ``VoicePhaseGlyph`` draws no view when stale, which is correct wherever
/// something else remains on screen, and wrong here: this circle *is* the whole
/// island in the shared presentation, so an empty one reads as a broken app
/// rather than as an activity with nothing to claim. Identity is the right
/// thing to fall back to, for the same reason the Lock Screen keeps the avatar
/// and drops the phase: the session's existence is not the part in doubt.
struct VoiceMinimalPresentation: View {
    let state: VoiceSessionAttributes.ContentState
    let isStale: Bool
    var avatarImageData: Data?

    var body: some View {
        if isStale {
            VoiceCompactIdentity(
                accent: state.accentColor,
                avatarImageData: avatarImageData
            )
        } else {
            VoicePhaseGlyph(state: state, isStale: false, scale: .small)
        }
    }
}

/// Mute indicator, shown only while the session is muted. Not accent-tinted:
/// this is a status the user must be able to read at a glance regardless of
/// their avatar color.
struct VoiceMuteGlyph: View {
    var body: some View {
        Image(systemName: "mic.slash.fill")
            .imageScale(.small)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Muted")
    }
}

/// The one text primitive: a single passed-through line — the phase label or
/// the assistant name — sized for whichever slot it lands in.
///
/// Always one line with a tail ellipsis. The web side decides how long the
/// string is, so the tight slots shorten what they were given instead of
/// substituting a native string of their own. Every phase that reaches an
/// activity has a non-empty label (`LIVE_VOICE_STATE_LABELS` maps only the
/// phases with no activity to `""`), and the plugin rejects an empty
/// `assistantName`, so there is no empty-string case to special-case.
struct VoiceSessionText: View {
    let text: String
    var font: Font = .subheadline
    var color: HierarchicalShapeStyle = .primary

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}

/// Lock Screen and notification-banner presentation: the avatar, the assistant
/// name, the phase (glyph and label), elapsed call time, and a mute glyph while
/// muted.
///
/// The roomiest of the four presentations, so it is the one that shows
/// everything; the island slots below are this, minus whatever does not fit.
///
/// No `activityBackgroundTint` — the system background already adapts to the
/// Lock Screen's appearance, and tinting it with an arbitrary avatar color is
/// exactly how the label text stops being readable in one of the two modes.
struct VoiceSessionLockScreenView: View {
    let assistantName: String
    let state: VoiceSessionAttributes.ContentState
    /// When the activity started, for the elapsed timer. See
    /// ``VoiceSessionAttributes/startedAt``.
    let startedAt: Date
    /// Whether ActivityKit considers this content out of date; drops
    /// everything that asserts something about a live session (the phase
    /// label, the phase glyph, and the timer). See
    /// `ContentState.displayLabel(isStale:)`.
    let isStale: Bool
    var avatarImageData: Data?

    var body: some View {
        let detail = state.displayDetail(isStale: isStale)
        return HStack(spacing: 12) {
            VoiceAccentBadge(accent: state.accentColor, avatarImageData: avatarImageData)
            VStack(alignment: .leading, spacing: 2) {
                VoiceSessionText(text: assistantName, font: .headline)
                HStack(spacing: 5) {
                    VoicePhaseGlyph(state: state, isStale: isStale, scale: .small)
                    VoiceSessionText(
                        text: state.displayLabel(isStale: isStale),
                        color: .secondary
                    )
                }
                // The activity line, when there is one. Below the phase rather
                // than replacing it: the two answer different questions ("is
                // it my turn to talk" and "what is it doing"), and a turn that
                // is thinking *and* reading a file is both.
                //
                // Absent rather than blank when empty, so an idle session's
                // card is two lines tall instead of two lines and a gap.
                if !detail.isEmpty {
                    VoiceSessionText(
                        text: detail,
                        font: .caption,
                        color: .tertiary
                    )
                }
            }
            Spacer(minLength: 0)
            // Trailing column, top-aligned with the name: the two status facts
            // that are not the phase. Stacked rather than inline so the mute
            // glyph keeps its place when the timer's width changes.
            VStack(alignment: .trailing, spacing: 4) {
                VoiceSessionTimer(startedAt: startedAt, isStale: isStale)
                if state.muted {
                    VoiceMuteGlyph()
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
```
