# App Store submission brief — Cue - AI Assistant v1.0

<!-- generic-examples:ignore-next-line — reason: 6782594510 is Apple's App Store app ID, not a phone number -->
**App:** Cue - AI Assistant · `com.ventureverse.cue` · Apple ID `6782594510`
**Version:** 1.0 (iOS) · state `PREPARE_FOR_SUBMISSION`
**Build to attach:** `202608121221` (uploaded 2026-08-11, processing `VALID`)
**Status when this was written:** the version record was completely empty — no copy, no
screenshots, no build, no age rating, no category, no price, no privacy policy URL.

This document is the source of truth for the listing. Section 1 is the copy (ready to paste or
push via the API). Section 2 is the screenshot brief — hand it to Claude Design as-is.

---

## 1. Copy

All fields are within Apple's limits; counts are shown so edits stay legal.

### App name — 18 / 30
```
Cue - AI Assistant
```
Already set on the app record. Leaving it alone avoids a name change inside a first review.
(ASO alternative if you want it: `Cue: AI Chief of Staff` — 22 chars, stronger keyword coverage.)

### Subtitle — 22 / 30
```
Your AI chief of staff
```
Indexed for search. Picks up "AI" and "chief of staff" without repeating the app name.

### Promotional text — 157 / 170
```
Cue watches your email, calendar and chats, surfaces the one thing that needs you, and does the work — pausing for a tap when it matters. Invite-only access.
```
Editable later **without** a new review, so this is the right home for launch-phase messaging.

### Keywords — 98 / 100
```
agent,autonomous,email,inbox,calendar,tasks,todo,productivity,automation,voice,memory,brief,agenda
```
No spaces after commas (spaces burn characters). Deliberately excludes words already in the name
and subtitle — Apple indexes those separately, so repeating them wastes the field.

### Description — 1,727 / 4,000
```
Cue is the personal and professional AI that catches what you'd miss — and then does something about it.

Most assistants wait to be asked. Cue watches your email, calendar, and conversations, works out what actually needs you, and gets on with it — pausing for a one-tap approval before anything leaves your hands.

WHAT CUE DOES

• Surfaces your next move. One screen that answers "what needs me right now" instead of another inbox to dig through.

• Does the work, not just the talking. Drafts the reply, pulls the numbers, builds the one-pager, books the table, files the receipt.

• Runs while you sleep. Give a standing agent a charter and a spending cap and it works in the background overnight, inside the limits you set.

• Remembers what matters. Eight kinds of memory — facts, plans, habits, moments — each traceable to where it came from, and all of it yours to edit or delete.

• Talks back. Hold a real conversation by voice, hands-free, with the same memory behind it.

YOU'RE ALWAYS IN CONTROL

Reading is free. Writing asks first. Destructive actions stay off until you allow them — per tool, per agent, always visible. Every action is logged and reversible, and stop always wins.

ON YOUR PHONE

Your Cue comes with you. Today's brief, your projects, the work in flight, voice, and the handful of approvals waiting on you — the same assistant and the same memory you have at your desk.

PRIVACY

Your Cue runs on its own isolated instance. Your data is never sold and never used to train models. Export or delete everything, at any time.

REQUIRES A CUE ACCOUNT

Cue is in invite-only early access. This app is a client for your own Cue instance — you need an account to sign in. Request access at justcue.ai.
```

The closing "REQUIRES A CUE ACCOUNT" block is not optional. Apple requires the account
dependency to be disclosed, and it heads off the one-star "I downloaded it and it just asks for
an email" reviews that invite-only apps collect.

### URLs

| Field | Value | Note |
|---|---|---|
| Support URL | `https://justcue.ai/support` | **Does not exist yet** — being created. Required field. |
| Marketing URL | `https://justcue.ai/` | Live. |
| Privacy policy URL | `https://justcue.ai/privacy` | **Does not exist yet** — see the blocker below. |

### Copyright
```
2026 Cue
```

### Category
- **Primary:** Productivity
- **Secondary:** Business

Productivity is where assistant apps are browsed and is the honest fit. Business as secondary
picks up the standing-agents and vendor/invoice framing without competing in a category the app
would rank poorly in.

### App Review notes

This is the highest-leverage text in the whole submission. It has two jobs: get the reviewer
*into* the app, and pre-empt a Guideline 4.2 "this is a website in a shell" rejection.

```
WHAT CUE IS

Cue is a personal AI assistant. Each customer runs their own isolated Cue instance; this app is
the iOS client for that instance. There is no shared multi-tenant backend, which is why the first
screen asks for your email rather than showing a generic signed-out feed.

HOW TO SIGN IN (no need to contact us)

We have provisioned a dedicated instance for App Review, pre-seeded with sample content so every
surface is populated:

  Email:    [DEMO EMAIL]
  Password: [DEMO CREDENTIAL]

Sign-in is by emailed magic link by default. For review we have enabled direct credential sign-in
on this account so no mailbox access is required. If anything blocks you, [FALLBACK].

WHAT TO EXERCISE

  Today   — the brief: what needs the user now, and the work already handled
  Voice   — hands-free conversation with the assistant (microphone permission)
  Projects/Work — work items in flight, grouped by project
  Approvals — actions the assistant is holding for a one-tap yes/no

NATIVE FUNCTIONALITY (re: Guideline 4.2)

This is not a repackaged website. The app ships native iOS functionality:
  • Home Screen widgets (WidgetKit) showing the current brief and pending approvals
  • Push notifications via APNs when the assistant needs a decision
  • Native voice capture with haptic feedback
  • Universal Links (applinks:justcue.ai) so a sign-in link opens directly in the app
  • Device-motion parallax and native splash/launch experience

PRIVACY

Data is scoped to the reviewer's own instance and is deleted on request. Nothing is sold, and
nothing is used to train models.

Contact: the App Review contact on the App Store Connect record
```

Bracketed values get filled once the demo instance is provisioned.

---

## 2. Screenshot brief — for Claude Design

### Hard requirements

| Spec | Value |
|---|---|
| Size | **1284 × 2778 px** portrait (6.5" display slot) |
| Alternatives Apple accepts here | 1242 × 2688 · 2688 × 1242 · 2778 × 1284 |
| Format | PNG or JPEG, **no alpha channel**, sRGB or P3 |
| Count | Minimum 1, maximum 10. **Deliver 5.** First 3 matter most — they're the only ones shown on the install sheet |
| Naming | `01-today.png` … `05-control.png` so upload order is unambiguous |

### Rules Apple enforces

- No device frames that imply hardware Apple doesn't sell, and no frame that crops the content.
- No pricing, "Free", or promotional badges baked into the image.
- No Apple product imagery or Apple-owned marks.
- Text in the image must be legible at thumbnail size — the install sheet renders these small.
- Content shown must exist in the shipped build. Don't illustrate features that aren't there.

### Source material

Real captures of the current signed-in app at iPhone width are already in the repo and are the
ground truth for layout, spacing, and content:

- `assistant/qa/artifacts/iphone-home.png` — the Today surface
- `assistant/qa/artifacts/iphone-work.png` — work items
- `assistant/qa/artifacts/iphone-projects.png` — projects

These are 390 × 844 (1×) so they are **reference only**, not upload-ready. The final frames need
to be composed at 1284 × 2778.

### Brand

Pull from `justcue.ai` and `apps/web/capacitor-shell/index.html`, which carry the current system:

| Token | Value |
|---|---|
| Accent | `#3D6EE8` |
| Deep ground | `#0F1620` / `#0B0B0F` |
| Surface | `#16161D`, `#1D1D26` |
| Text | `#F4F4F6` primary, `#9A9AA8` muted |
| Good / Danger | `#4BB57A` / `#E5675B` |

Voice: calm, declarative, second person. The site's register is "It already knows your next move"
— confident and quiet, never hype. Captions should read like the product talking, not like
advertising.

### The five frames

Each frame is a caption band plus the app screen. Keep the caption to one line where possible;
these are read in under a second.

**01 — Today / the brief.** *This is the money shot; it's the first thing on the install sheet.*
Caption: **"It already knows your next move."**
Show the Today surface: the mission ring on track, the next move card with a drafted reply ready
to send, and the "watching for you" strip. Use realistic but fictional content — no real names,
no real email addresses, no real company data.

**02 — It works while you're away.**
Caption: **"It runs while you sleep."**
The overnight log: timestamped actions taken autonomously, a spend figure inside its cap, and one
item held back for approval. This is the differentiator — it deserves a full frame.

**03 — Approvals.**
Caption: **"Nothing acts without you."**
An approval card mid-decision: what the action is, what it costs, Approve / Deny. This frame does
double duty — it sells the safety story to users and pre-answers the trust question a reviewer
will have.

**04 — Voice.**
Caption: **"Just talk to it."**
The voice surface live, with a short exchange visible so it's obvious this is a conversation with
memory behind it, not a dictation box.

**05 — Memory / control.**
Caption: **"It remembers. You stay in control."**
The memory view with a few typed memories and their provenance, or the guardrails view showing
per-tool permission levels. Either works; memory is the warmer of the two.

### Optional

An app preview video (up to 3, 15–30s each) lifts conversion meaningfully but is **not** required
and is not blocking this submission. If Claude Design has capacity, frame 02 is the strongest
candidate to animate.

---

## 3. Status

Everything except the screenshots is done and verified. **Screenshots are the only thing standing
between this and submission** — which is why section 2 is the live part of this document.

### Resolved

**Privacy policy — was placeholder text, now real.** `justcue.ai/legal.html` had shipped
`[Placeholder — legal to supply]` for every section of both the Privacy Policy and the Terms.
There was a second, quieter bug: the footer linked to `legal.html#privacy`, but the page defaulted
to `doc: "terms"` and never read the hash, so anyone following the privacy link landed on the
Terms of Service. Both documents are now written for real — including a subprocessor disclosure
naming OpenRouter, Google, OpenAI, Deepgram, ElevenLabs, Replicate, Composio, Fly, Stripe, Resend,
Klaviyo, and APNs — and `/privacy`, `/terms`, and a new `/support` page are live.

**Demo access for App Review.** A dedicated instance is provisioned at
a dedicated `appreview@` instance, pinned to production's exact
image (`v2f1d1ad39b`). A 30-day pre-authorised sign-in link is in the review notes and has been
verified in a browser to sign straight in. It expires **16 September 2026** — if review slips past
that, mint a fresh one from HQ admin.

**App Privacy.** Published. 12 data types declared — Name, Email Address, Emails or Text Messages,
Photos or Videos, Audio Data, Other User Content, User ID, Device ID, Product Interaction, Crash
Data, Performance Data, Other Diagnostic Data — every one of them App Functionality purpose only,
linked to the user's identity, and **not** used for tracking. No advertising or analytics purposes
declared.

**Everything else on the version:** build `202608121221` attached, age rating 4+, Productivity +
Business, Free in 175 territories, copy and URLs all set.

### Also worth knowing

**Guideline 4.2 (minimum functionality)** is the real risk on this submission. The iOS app is a
~2 MB shell that loads the user's instance over HTTPS, and Apple rejects thin web wrappers. The
mitigation is genuine — widgets, push, native voice, universal links — and it's argued explicitly
in the review notes. Worth going in with eyes open: a 4.2 challenge is plausible and answerable,
not fatal.

**Guideline 3.1.1 (in-app purchase)** is a smaller risk. Cue instances are bought outside the
app. That's normally fine under the multiplatform-services allowance — the app must simply not
link out to or advertise the purchase flow. Keep the app free and don't add a "Subscribe" button.
