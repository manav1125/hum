# v14 — navigation v2 (2026-08-02) · supersedes v13

**v13 was an over-correction.** It used one test — *how often do you go there* — and that test buries anything you visit rarely **but need to know exists.** Library and Intelligence aren't settings; they're the surfaces that *show what Cue is*. Hiding them in an avatar menu was a product decision disguised as a navigation decision.

## The missing idea: three tiers, not two

| Tier | Test | Where |
|---|---|---|
| **1 · Where you work** | You go there and stay, daily | Always visible: **Talk to Cue · HQ · Work** (three rows) |
| **2 · What Cue is** | It demonstrates the product | Grouped under a **CUE** heading: **Agents · Rhythms · Memory · Library · Watching** |
| **3 · How it's set** | Genuinely a setting | Avatar menu: **Trust · Preferences · Billing** |

## Why the five share a heading
They aren't a leftovers drawer — each answers one part of *"what is this thing I'm using?"*, which is why one word above them does the work five separate rows were failing to do.

- **◆ Agents** — who works for you
- **↻ Rhythms** — what runs without you
- **🧠 Memory** — what Cue knows (people, facts, your rules)
- **▦ Library** — what Cue has made
- **👁 Watching** — where it's all coming from

**This is the demo, sitting in the sidebar.** If someone asks what Cue does, you click these five in order. That's a better test than frequency alone — the test v13 got wrong.

## Collapse is the pressure valve (frame V1)
The rail auto-collapses to **52px icons the moment you open a conversation** (the Claude behaviour). Badge still shows, everything still one click, `◧` or `⌘\` pins it open. **This is what lets us afford discoverability without paying for it constantly** — ten rows is right when navigating and wrong when reading.

## Library (frame V2) — right to protect
The single best proof the product works: a wall of real output with the agent and the thing that produced each item, filtered by type. Header line is the argument — **"48 things Cue has made for you · 11 this week · 6 hours of drafting."** Burying that in a Work sub-view was throwing away the product's best evidence to save a sidebar row. Everything here also lives inside the thing that made it; **Library is the drive view for when you don't remember which.**

## Names
- **One row, not two.** v13 collapsed "New conversation" and "Talk to Cue" because they were one intent — correct. v14 keeps that collapse but **inverts which survives**: the *destination* keeps the row, the *action* becomes the `✎` icon inside it (plus `⌘N`). Standard mail-app compose pattern. **Tier 1 is three rows.**
- **"Talk to Cue" stays** — warmer than a generic composer label, and it names the relationship.
- **Intelligence → Memory** — the only rename. "Intelligence" names the machinery; "Memory" names what you came to look at, and it's the word Cue itself uses (*"I remember you said…"*).
- **People folds into Memory** as a tab — "who I work with" is something Cue knows, not a separate system.

## The revised rule
1. **Two questions, not one.** *Go there often?* → Tier 1. *Shows what Cue is?* → Tier 2. Neither → avatar.
2. **Tier 2 is capped at six and needs a shared sentence.** Currently "what is Cue", holding five. A sixth must answer the same question or it's Tier 3. **The cap is what prevents thirteen happening again — a heading isn't enough.**
3. **Collapse in conversations**, always.
4. **Still no destination for a mode** — Create and Voice stay composer chips; channels stay inputs (surfaced in Watching, filterable on HQ). Those v13 calls were right.

## Changed from v13
Library, Memory, Agents, Rhythms, Watching return to the sidebar as a named group instead of avatar tabs · "Talk to Cue" keeps its name and row · rail auto-collapses · Trust, Preferences and Billing stay in the avatar menu.
