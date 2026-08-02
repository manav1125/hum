# v8 — mobile + web catch-up (2026-08-02)

Closes the gap: v5–v7 never reached mobile or web. After this pack all three surfaces are on one version for the first time since v4.

## Banned text tokens — read before editing these frames
`#5B5B68` has now regressed **three times** across three packs. It is **never a text colour** on any surface (2.5–2.9:1 on our dark grounds). Dark-theme muted text is **`#9A9AA8`**, full stop — including chevrons, hint lines, and "swipe for more" affordances. Light-theme equivalents: use `#6B6B60`; **never** `#8A8A7E` (3.1:1) or `#A8A89C` (2.4:1), which are ground/hairline colours only. See §19 of `WORK-SURFACES.md`.

## The finding
**v7's two best ideas are mobile ideas drawn on desktop first.** A composer you land on, and a render rule where empty lanes cost one line — that's what you'd invent if 390px were the only canvas. So this is not a shrink-to-fit: **mobile takes the tiers further than desktop**, and web mostly inherits.

## Frames
- **M1 · Mobile landing** — composer **docked at the bottom** (thumb reach beats symmetry), delivery sentence as a tappable card above the prompts, prompts drawn from real state. **Tab bar is now Cue · HQ · Missions · You** — the `+` is gone because the composer *is* the plus; keeping both repeats the duplication v7 removed. HQ carries the only badge in the app.
- **M2 · Mobile HQ** — **no Tier 2 at 390px: a lane is a card or a line, never between.** Cards for needs-you / delivered / missions; four Tier-3 grey lines for arrivals, waiting, rhythms, pulse (same honest statements as desktop, including "0 need you"). Headline *is* the number. Census docks above the home indicator so it never needs scrolling to.
- **M3 · Weekly review + correction** — weekly as a swipeable card stack, receipts → the ask → what slipped; the leash proposal is full-width because it's the only mobile screen where trust changes hands. **The correction is a full takeover on its own ground (`#150E0D`)** — not a card, not a dismissible push. It's the one screen that interrupts everything, so it looks like nothing else.
- **W1 · Web search** — **`/` or `⌘K`; `⌘F` is never intercepted.** Find-in-page is a reflex older than the app. Also web-only: single-key verbs (`O L D F H`) **suspend while any input has focus**, and every surface has a real URL (`/hq`, `/m/renew-acme`, `/w/2026-07-27`).
- **W2 · Signed-out / first-run** — a deep link hit while signed out **names what's behind the door** and proves continuity ("the 7 items you were triaging on your phone"). Sign-in returns to the requested URL, not `/hq`.
- **W3 · Weekly review as a URL** — the one thing only web can do. Share scope is explicit; **two hard rules: `⌂` Life is never shareable, and Cue's leash proposals never travel** (asking for more autonomy is a private conversation; putting it in a shared doc would change the answer).

## Deliberately desktop-only
The **ledger at 31+ with bulk multi-select**, **triage mode**, and the **rhythms editor**. All sit-down work. Mobile links out with an honest "better on desktop" line rather than a cramped port — same call as Cue Live.

## Rule of thumb going forward
Desktop can afford a middle tier because horizontal space is cheap. The phone forces "does this lane deserve a card *today*?" — which is what fixed the desktop deck. **If a future surface disagrees with mobile about what deserves weight, mobile is probably right.**

## Precedence
v8 supersedes canonical **K2** (mobile Today) and the mobile tab bar in `05-mobile-native`. It adds web rules on top of `04-parity-plus`, which otherwise stands. Desktop frames transfer to web 1:1 inside browser chrome — **do not redraw them**.
