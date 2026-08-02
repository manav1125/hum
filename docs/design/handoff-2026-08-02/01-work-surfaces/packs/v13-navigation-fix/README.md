# v13 — navigation fix, desktop & web (2026-08-02)

The built sidebar reached **13 items** plus Channels, Pinned and Preferences. Only **two** are places you go and stay.

## Our fault, partly
v11's C1 frame listed five items under a **"DEEPER"** heading at the same visual weight as the destinations. That reads as a flat list you can keep appending to — and it was appended to. **A heading is not a boundary.** This pack replaces that frame.

## The two tests a sidebar item must pass
1. You'd **go there and stay** — not visit, change one setting, and leave.
2. You'd do it **more than once a week**.

HQ and Work pass. Nothing else currently does.

## The sidebar (frame N1)
Four zones, in order of use:
```
cue.
✎ New conversation        ⌘N     ← the action you take most
◈ HQ                      13     ← destination
▤ Work                     5     ← destination
PINNED / RECENT                  ← your conversations (the point of a chat-first sidebar)
👤 Manav · Autonomous · $4.10    ← account, bottom
```
The conversation list is most of what this sidebar should hold; the current build gives it less room than the settings links.

## Where everything went — nothing deleted
| Removed | Now lives | Why |
|---|---|---|
| Talk to Cue | ＋ New conversation | Same thing. One button, `⌘N`. |
| Create | Composer chip | Already there as "Make a doc". You *ask for* creation. |
| Voice | Mic in composer | A mode of talking. Already in the input — twice. |
| Library | **Work → Files** | Third view beside Things and Everything. Artifacts also sit inside the thing that made them. |
| Channels / Email / WhatsApp | HQ came-in filter | **Inputs, not destinations.** You want *what arrived from WhatsApp*. Setup → Account → Connections. |
| Pinned | Top of conversation list | Pinned *conversations* belong with conversations. |
| People | Account → People | Also from any person's name anywhere — 95% of real entry. |
| Agents | Account → Agents | Also from any agent chip on a running task. |
| Rhythms | Account → Rhythms | Also from HQ's ↻ Tier-3 line. |
| What Cue does | Account → What Cue does | Also from HQ's pulse line. |
| Trust & guardrails | Account → Trust | Also from the mode chip and every tier chip. |
| Intelligence | **Account → Memory** | And rename it — "Intelligence" names the mechanism, "Memory" names what the user came to see. |
| Preferences | Account → Preferences | Where every app puts it. |

**Six of the seven Account items are also reachable from the exact moment you'd want them.** Contextual entry beats a permanent link, because a permanent link taxes every screen where you don't want it.

## Account (frame N2)
One destination, eight tabs, reached from the avatar: **Agents · Trust · Rhythms · Connections · Memory · People · What Cue does · Preferences.** The account row itself shows mode and spend, which removes the most common reason to open it. **Mobile is already this shape** (avatar top-right), so the platforms finally agree.

## The rule that stops regrowth
- **Go-there-and-stay + weekly** → sidebar.
- **Something you ask for** → composer chip. These grow freely without costing navigation.
- **Something you configure** → Account tab. The ninth surface then costs a tab, not a sidebar row.
- **Prefer contextual entry** to a permanent link.

## Supersedes
v11 frame C1's sidebar (the "DEEPER" list).
