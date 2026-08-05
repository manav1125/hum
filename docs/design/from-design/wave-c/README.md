# Cue HQ — redesign brief for code (2026-08-04)

**Why:** the shipped HQ stacks every module at full height, so a watcher-heavy account (348 signals/day) produces a mile of scroll — drift cards drawn twice, blocked rings drawn three times, a came-in list of 11+ rows, a full-bleed rings hero. This replaces it.

Two files:
- `cue-hq-valve-and-layouts.html` — **C1 the volume valve** (LOCKED) + the three layouts we explored.
- `cue-hq-toggle.html` — **the canonical desktop HQ**: one surface, Glance/Deck toggle. Build this.
- `cue-hq-mobile.html` — **the canonical mobile HQ**: always Glance, strip = the five lanes, tap-to-expand sheets.

---

## 1 · C1 — the volume valve (LOCKED, ship first)

A confidence bar **in the watcher pipeline**, before anything reaches HQ. No layout survives 348 daily signals; the valve turns 348 → ~6.

- **Three stops:** Everything (~348/day) · **Needs you (~6/day, default)** · Only urgent (~2/day).
- On "Needs you", Cue keeps off HQ: filed arrivals (→ weekly line), its own holding queue (→ Work), unreadable noise (→ auto-archive 48h), already-seen drift (→ surfaces once then rests).
- **It learns:** every ✕ / "not relevant" lowers that sender/type's score. The holding count shrinks on its own.
- **One global control, per-mission override.** Bump a hot mission to "Everything" while it's live.
- **Nothing is lost** — filtered items stay queryable in Work. The valve changes what *interrupts*, not what's *kept*.

**Every number in the HQ below is post-valve** (6 need you · 4 holding · 12 filed), not raw (6 · 105 · 230).

---

## 2 · Canonical HQ — one surface, two densities

A toggle top-right: **◒ Glance** / **▦ Deck**. Persisted per device, `⌘.` toggles.

### Glance (default on open — the 30-second check)
- Centered: greeting → capture → **one "Your next move" card** → "5 more need you ›".
- Footer **strip of five tappable numbers**: Need you · Blocked · Holding · Filed today · Watching.
- Tapping any number opens **Deck scrolled to that lane** — Glance is never a dead-end.

### Deck (when you sit down to work — the command surface)
- **Centre column:** greeting, capture, Your next move, **Needs you capped at 3 of 6** + "Triage all ›".
- **Right rail (300px), always visible, never scrolls** — the five lanes as live tiles:
  - **Missions** — carries **four progress rings** (on-track green / moving blue / blocked ◼). This is the one richness Deck earns over Glance; it replaces the old full-bleed rings hero. Blocked missions surface *once*, here.
  - **Cue is holding** — "4 queued, none need you".
  - **Came in today** — split bar + "12 filed · 6 dropped · 0 need you".
  - **In motion** — running agents + rhythms ("3 rhythms · next in 2h").
  - **Watching** — sources + last-check dot.

### The hinge
**The Glance strip numbers and the Deck rail tiles are the same data**, collapsed vs expanded. Nothing appears or disappears between views — it gains detail. That's what makes it one surface breathing, not two pages.

---

## 3 · What this deletes from the current build

- **Drift cards** (the amber "hasn't moved in N cycles" blocks with Replan/Step-in/Pause) → fold into the mission's own detail page. They were drawn directly above the missions they name.
- **The full-bleed rings hero** ("2 rings blocked on your call") → the missions rail tile's rings say this once.
- **The came-in list** (6 rows + "show 11 more") → becomes the "Came in" tile: the number and split only. Rows live in triage.
- **Blocked-ness drawn three times** (drift card + mission row + rings hero) → **once**, in the missions tile.

**Rule:** HQ answers *"what needs me right now"* and nothing else. Anything handled, held, filed, or watched is a **number you can tap**, never a row you scroll past.

---

## 4 · Mobile

Mobile is **always Glance** — the phone can't hold a rail, so it ships the strip-as-census. Same model, density adapts: desktop spreads into the rail, phone stacks into the census strip.

- **Default screen = one viewport, no scroll:** greeting → one "Your next move" card → "5 more need you ›" → **census strip pinned above the tab bar** (Need you · Blocked · Holding · Filed · Watching).
- **Every strip lane is tap-to-expand** — the desktop rail's five tiles become five sheets. **Tapping "Blocked" raises the four mission rings** (on-track green / moving blue / blocked ◼) with the blocked ones actionable underneath. That's how the rings reach the phone.
- **The strip stays pinned** wherever you are on Today — the persistent census, your anchor.
- **Removed from the shipped mobile HQ:** the two "I couldn't read" email rows (→ Filed number → triage), the delivered block, the missions block, the four grey lines (→ strip numbers), and "230 arrived — I filed 132…" (→ post-valve "12 filed"; raw count lives in the weekly review).

**Same five lanes everywhere:** a rail on desktop / a strip on mobile · tiles on desktop / sheets on mobile. One HQ, two axes.
