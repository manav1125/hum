# v25 — chat, create, voice + the keyboard spec (2026-08-03)

## G3 · Keyboard spec — build exactly
**The bug:** the built version scrolls the whole window, so the header leaves and the thread jumps. **The window must not move.** Only the composer position and the thread's viewport height change.

1. **Layout, not scroll.** Thread is a fixed-height flex child between a pinned header and the composer. Keyboard appears → the **container shrinks**; the page never translates.
2. **Bottom-anchored thread.** `justify-content:flex-end` — short threads sit against the composer, not floating at the top. New messages appear with no scroll jump.
3. **Composer sits on the keyboard.** Bottom inset = keyboard height, animated with the system curve (`0.25s easeInOut`) so it rises *with* the keys, never after.
4. **Tab bar hides while typing.** Returns on dismiss — it's navigation, and you're not navigating.
5. **Header stays and compacts.** Title + thing chip + avatar, one line. Never scrolls off: it's how you know which conversation you're in and how you leave.
6. **Scroll position preserved on dismiss.** If you scrolled up to read, dismissing keeps you there — no snap to bottom.
7. **Multiline grows to 5 lines** then scrolls internally. The thread shrinks; nothing else moves.
8. **Interactive dismiss.** Dragging the thread down dismisses proportionally (iMessage-style), not an all-or-nothing tap.

**Test to pass:** type in a 2-message thread *and* a 200-message thread. In both, the newest message must be visible above the composer and the header must not move. If either scrolls, it's the bug.

## G1 · Start a chat
Composer above the tab bar with four affordances: **＋ attach · ✎ Create · ▦ Library · mic**. Mic is primary — talking is the fastest input on a phone. Tapping the field starts a chat; tapping a suggestion sends immediately. Suggestions come from real state (a needs-you item, the free block, an active thing).

## G4 · Create
A **sheet over the composer**, not a destination. Prompt first → type → template strip with the brand-matched pick pre-selected. **Inherits the current thing** (`▤ Renew Acme`) so output files itself. Result lands **in the thread** as an artefact card.

## G5 · Voice
**The mark is the mic** — same ring, ripples while listening, live transcription so you see what's heard before it sends. **Hold-to-talk by default, tap to latch** for hands-free. Keeps the thing chip. Read-replies-aloud toggle at the bottom. `⌨` returns to typing with session context intact.

## G6 · Why these aren't destinations
All three are **states of one composer** — same context, same thing chip, same thread; only input method and output shape differ.

| Mode | Output |
|---|---|
| Type | a message (sources collapsed underneath) |
| ✎ Create | an artefact card in the thread, filed to the current thing |
| ◎ Voice | spoken turns as italic 🎙 bubbles in the same thread, searchable later |
| ▦ Library | a reference attached to what you're saying |

**The rule:** a mode changes *how you say something*; a destination changes *what you're looking at*. Modes live in the composer — which is why Create and Voice never earned sidebar rows, and why a fourth mode would be another chip, not another tab.

**Long work leaves the chat.** Anything over ~30s becomes a task with a live line ("I'll have it in ten minutes") instead of a spinner. The conversation never blocks.
