# Cue mobile — surface audit & design brief

**15 August 2026** · Scope: `apps/web/src/mobile-v3` (137 files, 17 areas, 20 shared primitives)
Method: read-only source audit on `cue/voice-replatform`. Reachability traced through the route
table, the nav models and the iOS push router — not inferred. Every claim resolves to a file.

---

## The headline

The mobile problem is not that screens look unfinished. It is that **several finished,
data-bound screens have no door.** The Morning Brief opens only from an iOS push
notification. The Weekly review has no inbound link at all.

---

## Ten gaps, worst first

Ranked by how much each costs someone using Cue on a phone today.

**01 · The Morning Brief has no in-app door** — CRITICAL
The flagship daily ritual — worked on as recently as 12 August — is reachable *only* by
tapping an iOS push. Miss the push, or use web or Electron, and the surface does not exist.
Nothing on Today, in the ⋯ menu, or in Your Cue links to it.
`mobile-v3/brief/` · route `/assistant/brief`

**02 · The Weekly review is fully orphaned** — CRITICAL
A built, tested, data-bound four-beat surface with zero inbound links, zero pushes, zero nav
entries and no feature flag. Reachable only by typing the URL.
`mobile-v3/weekly/` · route `/assistant/weekly`

**03 · A failed voice turn still looks like silence** — CRITICAL
The "I couldn't finish that one" notice reaches only full-screen voice. The compact in-thread
bar — the default presentation on a phone — returns silently to Listening. This is the exact
failure the fix was written to remove. *(Engineering gap, not a design question — being fixed.)*
`domains/chat/components/mobile-thread-voice.tsx:195,312`

**04 · The desktop-organizer remote is a shell** — PARTIAL
Plan card and live mirror are inert pending a daemon emission that never landed. Anyone
arriving from Cue Live sees a permanently empty state. Oldest area in the set (31 July).
`mobile-v3/organizer/organizer-remote-page.tsx:17-25`

**05 · Memory on a phone loses the map** — PARTIAL
The 3D concept graph — the largest recent memory investment — has no mobile entry. The
mobile branch returns before the List/Map switcher is constructed.
`domains/intelligence/memories-page.tsx:107`

**06 · Five routes serve the phone page to desktop** — PARTIAL
Brief, Came-in, Brand, Watching and Weekly have no device branch, so a desktop visitor gets a
390px phone screen inside desktop chrome. Watching is the sharp case — desktop users are
actively navigated to it. `domains/review/review-routes.tsx` is the pattern that fixes this.
`routes.tsx:712, 722, 767, 903, 913`

**07 · Brand kit is buried one level too deep** — POLISH
A complete, real-data surface reachable from exactly one row inside Settings → Brand, despite
being what every Create output is meant to honour.
`mobile-v3/brand/` · entry at `domains/settings/mobile/mobile-settings-leafs.tsx:2179`

**08 · Voice camera hides behind an expand gesture** — POLISH
On the one device that actually has a camera, the control appears only after expanding the
compact bar to full screen.
`domains/chat/voice/voice-fullscreen.tsx:270-287`

**09 · Two parallel offline systems, one unused** — POLISH
`states/offline-state.tsx` has zero consumers and its barrel file is imported by nothing. The
shipped offline experience is `offline-takeover.tsx`, a different component.

**10 · Plugin-declared schedules are invisible** — POLISH
They reconcile into ordinary schedule rows with nothing indicating which plugin declared them,
so unexplained entries appear. No UI on either platform.

---

## What is already strong — please don't design this away

Across 137 files there are **zero** TODO or FIXME comments, and **not one surface renders
sample or fabricated content**. The codebase holds a consistent rule — *omit rather than fake* —
and states it explicitly in nine separate files.

| Surface | Deliberately missing | Because |
| --- | --- | --- |
| Memory | "applied N times" | the count is null daemon-side |
| Review pager | "IN YOUR BRAND ✓" | outputs carry no brand metadata |
| Watch live | the Redirect control | no endpoint exists |
| Identity | the Working style row | no config key backs it |
| Skills | per-skill runs / reversals / spend | no per-skill data source |
| People | the "you owe a reply" state | needs question detection that isn't built |
| Watching | a complete census | the API caps at 200 rows — and says so |

**Two consequences for a refresh.** If a comp shows a metric, it needs a real source or it ships
as empty space. And more interesting: **several screens are quietly thinner than their mocks** —
not built badly, just missing a data source. Those are the specs worth revisiting.

---

## The navigation ceiling

Every reachability problem above traces to one deliberate constraint.

Mobile has **three tabs and never a fourth** — HQ, Talk, Work (`components/nav/nav-model.ts:144`,
`tab-bar-v3.tsx:1-10`). Everything else hangs off the ⋯ menu top-left and the avatar top-right.
The ⋯ currently holds ten entries: People, All conversations, Library, Agents, Skills, All of Your
Cue, Create, Data & logs, Search, Add tasks.

> **The decision design owes.** The Brief and the Weekly review are both *time-based rituals* — a
> morning beat and a Friday beat. They do not belong in an alphabetical utility menu, and there is
> no fourth tab available.
>
> Options worth drawing: a time-aware slot on Today that surfaces the Brief in the morning and the
> Weekly on Friday; a dated entry in the HQ header; or a first-class "rituals" grouping in ⋯.
> **This is the highest-value call in this brief — two finished surfaces are dark because of it.**

---

## Surface by surface

### Unreachable or near-unreachable

**Morning Brief** · `mobile-v3/brief/` · NO DOOR
A 7:30 tap-through in three beats: what Cue finished overnight → the one thing that needs you →
the day ahead → "Start my day". Actively worked on last week.
→ *Design owes:* where this lives when there is no push. It is the product's daily first impression.

**Weekly review** · `mobile-v3/weekly/` · ORPHANED
Horizontally-paged Friday review: what moved · who did what · what slipped · the autonomy
question. Complete and data-bound. No desktop counterpart appears to exist either.
→ *Design owes:* an entry point, and whether the four-beat pager survives as a format.

**Brand kit** · `mobile-v3/brand/` · BURIED
Palette, type, logos and voice, with "Apply everywhere" as a real activation.
→ *Design owes:* promotion — it likely belongs next to Create rather than inside Settings.

### Reachable but hollow

**Desktop-organizer remote** · `mobile-v3/organizer/` · SHELL
The phone as a remote for a file-tidying run on your Mac. The daemon emission behind it was
never built, so it honestly shows an empty state rather than a faked mirror. Undo shipped once
as a button that did nothing and has since been removed.
→ *Design owes:* is this worth completing, or should the entry be withdrawn until the backend exists?

**Watch live** · `mobile-v3/watch/` · PARTIAL
Step into one running item: timestamped stream, current step pulsing, Stop / Take over.
Redirect omitted (no endpoint); step rows don't expand (results aren't persisted per step).
→ *Design owes:* whether step detail earns the backend work, or the stream reads fine flat.

**Came in today** · `mobile-v3/triage/` · PARTIAL
Swipe-triage of arrivals with provenance. Batch grouping and the filing-correction takeover are
drawn in the spec but absent.
→ *Design owes:* whether batching earns its place, given the surface works without it.

### Shipped and live

**Today (HQ tab)** · `mobile-v3/today/` · 14 files
Greeting, Cue ring with orbit chips, then Next move → Needs your OK → Review ready → Working
now → Came-in, collapsing into a pinned 56px bar. The day strip deliberately omits unlabelled bars.
→ *Design owes:* nothing structural — but it is the natural home for the Brief and Weekly entries.

**Your Cue** · `mobile-v3/you/` · 29 files — the largest and newest area
The configuration shell plus mobile Identity, Agents, Skills, Plugins, Connections, Rules, Ledger,
Automations. Skill revision history landed 13 August; the developer-unlock version row 14 August.
Plugins and Marketplace are flag-gated and hidden until flags hydrate.
→ *Design owes:* a look at the two newest additions — neither has had a design pass, and the
skill-history card was built to a described shape, not a comp.

**Create** · `mobile-v3/create/` · 27 files
A staged sheet — purpose → fill gaps → build → gallery — as a pushed stage stack rather than
nested sheets. Reached only from ⋯ and the chat composer.
→ *Design owes:* the CSS still reconciles against "the v27 mock" in four places. Is v27 still the reference?

**Review** · `mobile-v3/review/`
List plus a full-bleed swipe pager to judge deliverables, with Approve / Redo and correction chips.
Properly device-branched — desktop gets its own page.
→ *Design owes:* nothing. This is the model the five unbranched routes should follow.

---

## New capability — did the phone get it?

| Capability | Mobile | The gap |
| --- | --- | --- |
| Timed approval grants | ✅ yes | Same day as desktop, behind "More options". Desktop also has a live countdown chip; the phone has no equivalent. |
| Skill revision history | ✅ yes | Purpose-built for a 320px sheet, not a port. No design pass yet. |
| Developer unlock | ✅ yes | Landed 14 August; desktop-only until then. |
| Skill & channel cards | ✅ inherited | Render through the shared transcript — but drawn desktop-first, no phone treatment. |
| Voice camera | ⚠️ partial | Full-screen only; the compact bar has no camera control. |
| Voice failure notice | ⚠️ partial | Same shape — the primary surface still fails silently. |
| Memory map | ❌ no | Desktop-only; mobile returns before the view switcher exists. |
| Desktop companion | — n/a | Electron-only by definition, flag off. |
| Plugin schedules | ❌ no | No UI on either platform. |

---

## The primitive system

| Primitive | Used in | Read |
| --- | ---: | --- |
| SheetShell | 38 | The spine of the phone UI |
| GlassCard | 34 | Core material — untouched since the July foundation |
| AuroraBackdrop | 22 | The ground every full canvas sits on |
| CueRing | 16 | Crosses into voice, onboarding, capture |
| LargeTitleHeader | 3 | Today, Review, Watch, Weekly, Watching and Brief all roll their own headers |
| ApprovalSheet | 1 | The highest-stakes component in the app, used in one place |
| SharedMobileHeader | 1 | And that consumer isn't a mobile screen — superseded, stale since 21 July |
| OfflineState | 0 | Zero consumers; its barrel file is imported by nothing |

The bottom four are the design signal. **A header primitive used by three screens while six
hand-roll their own is a system that didn't finish converging** — and it is the cheapest
consistency win available.

---

## Where mobile and desktop have drifted

**Mobile has, desktop doesn't:** Morning Brief · Weekly review · Came-in as a destination ·
the Cue screen · Create · pull-to-search · offline takeover · Live Activity bridge ·
push interruption budget.

**Desktop has, mobile doesn't:** the memory map · the approval countdown chip · the companion ·
per-tool connector scopes (stated in-product: *"managed from the desktop app for now"*) ·
the feature-flags panel.

> **Worth naming:** some of this drift is correct. A floating desktop companion has no phone
> meaning, and a 3D graph may genuinely be a desktop object. But the Brief and the Weekly review
> existing *only* on mobile is not a considered split — it is where the work stopped. Deciding
> which of these are deliberate and which are accidents is a design call, not an engineering one.

---

*Palette and type references in the companion page are taken from the product's own live
`--mv3-*` tokens, so the amber marking unreachable surfaces is the same amber Cue uses for
"needs you".*
