# v28 — the four missing states (2026-08-03)

Coverage review of the whole mobile set found the gaps weren't features — they were **the states around the features**.

## K1 · Offline
Three honest blocks:
- **Queued** — each item **undoable**, which is what makes acting offline safe.
- **Still usable** — anything already loaded. *Reading works. Approving queues.*
- **Not until you're back** — new answers, Create, voice, anything an agent must run.

Composer **recedes with a recessed background, not dimmed text** (the explanatory sentence is the only thing saying why it's dead). **No spinner ever appears offline.**

## K2 · Push → screen
The interruption budget made visible on one lock screen:
- **Right now, always** — a correction Cue is reporting on itself; **breaks quiet hours**.
- **Within the hour** — one time-critical approval, with **Send it inline** (tap the action, don't open the app).
- **Morning brief** — 7:30, everything else.

**Three a day is stated on the lock screen itself.** Tapping a body opens the item; tapping the action does it.

## K3 · Day one
No tour, no empty deck. **One question that produces your first thing** without using the word — four chips or your own words. Footer is honest that nothing is connected, and sequences connectors **after** the first real answer.

## K4 · Search
Desktop's ⌘K, phone-shaped: **pull down from any screen**. Answer-first for questions, typed list for keywords, and **decision records as a first-class result** — the thing that makes it institutional memory rather than a file finder.

## K5 · Reach audit (a rule, not a frame)
**Every primary action below 60% of viewport height.** Composer, tab bar and card actions already pass. Back chevrons and `⋯` may sit top-side as escapes — **provided every screen has swipe-back**, so the chevron is never the only way out.

**Haptics, settled:** `.light` selection and swipe-reveal · `.medium` send/approve/hand-off · `.success` completion blooms only · `.error` real failures only. **Never on scroll, never on appear.**

## New colour rule found in this pass
**Never dim a container to express disabled.** An `opacity` wrapper is receding by contrast through the back door — invisible to a computed-colour check, but the same defect. Use the muted token plus a recessed background, and keep explanatory copy at full strength.

## Deliberately not drawn
iPad (a different layout problem, not a scaled phone) · Watch (its own interaction model) · Live Activities beyond the v3 frame · home-screen widget. **All post-launch; none blocks the build.**
