# Cue Commerce & Access — Claude Design Brief

**Date:** 2026-07-06 · **For:** Claude Design session extending the existing Cue marketing site
**Deliverable:** the 6 pages + 4 email templates below, as static HTML in the site's existing design system
**After design:** hand the HTML back to engineering — every form/button below has a named integration hook that gets wired to the Cue HQ backend. Design the states; do not write any JavaScript beyond what presentation needs.

---

## 1. Context — what this is

Cue is an AI chief of staff for founders. The marketing site already exists in this design system; this brief adds the **commercial layer**: pricing, invite redemption, checkout hand-off, the provisioning moment, sign-in, and account management.

Positioning line (this is the anchor of everything, verbatim):

> **It already knows your next move.**

Tagline (supporting, verbatim):

> Cue watches your email, calendar, and conversations — surfaces what needs you, and takes care of it. You can also set goals and let it run. One assistant. One memory. Everywhere you work.

**Business model context you must design around:** Cue is a *fully managed* product. Users buy a plan with **credits** included. We NEVER mention LLM vendors, models, tokens, APIs, or "bring your own key" anywhere. The product does work; credits measure work. That's the whole vocabulary.

**Access model:** alpha is invite-only. An invite code is redeemed at signup, checkout happens on Stripe (hosted — we don't design card forms), and within ~3 minutes the customer's personal Cue is live and they receive a magic link. There are **no passwords anywhere in the product** — sign-in is always an emailed magic link. Treat this as a feature, not a limitation.

---

## 2. Design foundations (extend, don't reinvent)

- **Use the existing site's system**: same palette, type scale, spacing, button and card styles, nav and footer. These new pages must be indistinguishable in craft from the current pages.
- Dark, calm, premium. The commerce pages are where trust is won — no SaaS-template energy, no confetti, no marketing-tool gradients that fight the existing look.
- Voice: composed, confident, second person, short sentences. Cue speaks like a great chief of staff — never excited, never apologetic. ("Your Cue is being prepared." not "Hang tight! We're setting up your awesome workspace! 🎉")
- Every page has exactly one primary action. Everything else is quiet.
- Responsive: design desktop-first but every page must hold at 390px. Forms full-width on mobile.
- Accessibility: visible focus states on all inputs/buttons, error text tied to fields (not toasts), AA contrast.

---

## 3. The user journeys (design against these, in order)

**A. Invited founder:** receives an invite code → `/redeem` → enters code + email + name → Stripe Checkout (hosted, leaves our site) → returns to `/welcome` → watches Cue being prepared (~3 min) → clicks through / gets magic-link email → is inside the product.

**B. Curious visitor (no code):** landing page → `/pricing` → wants in → waitlist form → confirmation state → (later) receives invite email → journey A.

**C. Returning customer, new device:** `/signin` → enters email → "link sent" state → opens email → inside the product.

**D. Customer managing their plan:** `/account` → sees plan, credit balance, usage → tops up, upgrades, or opens Stripe's billing portal.

---

## 4. Pages

### 4.1 `/pricing` — Plans & credits

**Purpose:** make the managed offer legible in one screen; route people to redeem (has code) or waitlist (doesn't).

**Sections, top to bottom:**
1. **Header block** — H1: `One assistant. Priced by the work it does.` Sub: one sentence — every plan is a fully managed, private Cue: your own assistant, your own memory, nothing shared.
2. **Three plan cards** (middle card visually elevated + badge `Founding member`):

| | **Assistant** | **Chief of Staff** ← featured | **Operator** |
|---|---|---|---|
| Price | $49/mo | $99/mo | $249/mo |
| Credits | 4,000 credits/mo | 10,000 credits/mo | 30,000 credits/mo |
| For | "Sees what needs you." | "Runs your day." | "Runs your operation." |
| Features | Chat & voice notes · Watches one channel · Daily next moves · Memory | Everything in Assistant · All channels (email, calendar, chat, SMS) · Full Create Studio · People & relationship memory · Voice everywhere | Everything in Chief of Staff · Video studio · Parallel agent runs · Agent org & spend controls · Priority support |

   Each card CTA: `Redeem an invite` (primary on featured card). Under all cards, one quiet line: `Alpha is invite-only. No code yet? Join the waitlist.` (link → waitlist section on landing page).
3. **"What's a credit?" explainer** — a compact horizontal strip, not a wall of text. Lead line: `A credit is a unit of Cue's work.` Then 4–5 example chips with soft icons: `Triage an email — ~2` · `Recap a meeting — ~10` · `Research memo — ~25` · `Full deck — ~40` · `Produced video — ~300`. Close with one line: `Credits refresh monthly. Need more? Top up anytime — 1,000 for $10.` No math beyond this. Never explain where credits "come from".
4. **FAQ (5 items, accordion):** Is my data private? (Yes — your Cue runs on its own isolated instance; your memory is yours alone.) · What happens when I run out of credits? (Cue pauses new heavy work and asks you; top up in one click. Nothing is lost.) · Can I change plans? (Anytime; changes prorate.) · Can I cancel? (Anytime; you can export everything.) · What's "founding member"? (Alpha pricing, locked for life.)

**Integration hooks:** plan cards render from `GET /plans` (id, name, priceUsd, monthlyCredits, features[]) — design with the table values above as the real content; CTA buttons link to `/redeem?plan=<id>`.

---

### 4.2 `/redeem` — Invite redemption

**Purpose:** the velvet rope. Short, exclusive, zero friction.

**Layout:** single centered column, max ~420px. Site nav minimal (logo only). H1: `You're invited.` Sub: `Enter your invite code to set up your Cue.`

**Form (in one card):**
- `Invite code` — monospace input, auto-uppercase, generous letter-spacing (codes look like `FOUNDER-7K2M`)
- `Name` — placeholder "What should Cue call you?"
- `Work email`
- Plan indicator: if arriving via `?plan=`, show a quiet selected-plan row (name + price) with a `change` link back to /pricing; if no plan param, show the three plans as compact radio rows inside the form (featured pre-selected).
- Primary button: `Continue to payment` — full width. Under it, small print: `Secure checkout by Stripe. Cancel anytime.`

**States to design (all four):**
1. Default
2. **Invalid code** — inline error under the code field: `That code isn't valid. Check for typos, or join the waitlist.` (waitlist link)
3. **Expired/used code** — `This code has already been used or expired. Reach out to whoever invited you, or join the waitlist.`
4. **Submitting** — button shows quiet spinner + `Preparing checkout…`

**Integration hooks:** form POSTs `{code, email, name, plan}` to `POST /redeem`; success responds with a checkout URL the page redirects to. Name the form `id="redeem-form"` and keep the field `name` attributes exactly: `code`, `email`, `name`, `plan`.

---

### 4.3 `/welcome` — Provisioning (the magic moment)

**Purpose:** the ~3 minutes after payment while their instance is created. This is the customer's first experience of the product — it must feel like Cue is *waking up for them*, not like a server spinner. Spend design effort here.

**Layout:** full-viewport, centered, no nav. Site background but calmer.

**Core treatment:** a single centered orb/mark (reuse the product's orb motif if present in the system) breathing slowly, with a **sequence of status lines that read like Cue coming online** — each line fades in, holds, gets a subtle check, the next appears:

1. `Securing your private space…`
2. `Waking your assistant…`
3. `Preparing memory…`
4. `Learning your name, {firstName}…`
5. `Ready.`

Timing guidance: lines pace to ~3 minutes total; design them as a loop-safe sequence (if provisioning runs long, the 4th line holds with the breathing orb — never a stall or a percentage bar).

**Completion state:** orb settles, H1: `{firstName}, your Cue is ready.` Primary button: `Open Cue` (this becomes the magic link). Secondary line: `We also sent a link to {email} — it signs you in on any device.`

**Failure state (design it, rare but real):** calm, not alarming: `Setup is taking longer than expected. We're on it — you'll get your sign-in link at {email} within the hour.` No retry button (support handles it).

**Integration hooks:** page reads `?session_id=` on arrival; engineering polls status and swaps states — design the three states (`provisioning`, `ready` with `data-magic-link` on the button, `delayed`) as toggleable sections.

---

### 4.4 `/signin` — Magic-link sign-in

**Purpose:** returning customers, new device. Minimal.

Centered column, same shell as /redeem. H1: `Welcome back.` One field: `Work email`. Button: `Email me a sign-in link`. Small print: `No passwords. We'll send a secure link that signs you in.`

**States:** default · **sent** (replace form with: envelope motif + `Check your inbox. We sent a sign-in link to {email}. It's valid for 15 minutes.` + quiet `use a different email` reset link) · **unknown email** — do NOT reveal non-existence; the sent state shows regardless. (Design only the two visible states.)

**Integration hooks:** POSTs `{email}` to `POST /signin`; form `id="signin-form"`.

---

### 4.5 `/account` — Plan, credits & billing

**Purpose:** the one place a customer manages the commercial relationship. Everything else lives inside the product.

**Layout:** product-adjacent (this page is behind sign-in): compact header with logo + customer email + `Open Cue` button. Single column, max ~720px, three cards:

1. **Plan card** — plan name + price, renewal date, `Change plan` (opens the three-tier chooser as a modal or inline expansion; upgrades immediate, downgrades at period end — one line stating that) and quiet `Manage billing` link (subtitle: invoices, payment method, cancel) → Stripe customer portal.
2. **Credits card — the centerpiece.** Big number: current balance. Horizontal usage bar: used vs remaining this cycle, with refresh date. Below, two top-up buttons as cards: `+1,000 credits — $10` and `+5,000 credits — $40` (badge: `Best value`). Microcopy under bar when <15% remains: `Running low — Cue will check with you before starting big jobs.`
3. **Usage card** — last 30 days as a simple bar sparkline by day + a short list of the top 5 credit activities (e.g. `Deck: Q3 investor update — 42`, `Email triage (daily) — 61`). Design with realistic dummy data.

**States:** healthy · low-credits (<15%) · zero-credits (banner on credits card: `You're out of credits. Top up to keep Cue working — nothing has been lost.`) · payment-failed (top-of-page banner: `Your last payment didn't go through. Update your card to keep Cue running.` + `Update payment` → portal).

**Integration hooks:** balance/usage from `GET /account/summary` (engineering provides); top-up buttons POST `{pack}` to `/account/topup` → Stripe checkout redirect; `Manage billing` → `/account/portal`.

---

### 4.6 Landing page additions (not a new page)

1. **Waitlist form** (exists or add): fields `email`, `name` optional, button `Request an invite`. **Confirmation state**: replace form inline — `You're on the list. We invite founders in small batches — watch your inbox.` Hook: POST to `/waitlist`, form `id="waitlist-form"`.
2. **Nav additions:** `Pricing` link; `Sign in` (quiet, right-aligned).
3. **Footer additions:** Terms · Privacy · `hello@` support mail link.

### 4.7 `/legal/terms` + `/legal/privacy`

Simple long-form text template in site chrome: H1, dated, ToC sidebar on desktop, prose column ~680px. Design the template once with placeholder sections (engineering supplies the text). Privacy page gets one designed callout block near the top: `Your Cue runs on its own isolated instance. Your data and memory are yours — we don't train on them, and we can't read them.`

---

## 5. Email templates (4) — same visual language, light-friendly

Design as simple, robust HTML email (single column, 560px, logo top, generous whitespace; assume dark-on-light fallback is acceptable in clients that force it). One primary button each. No marketing footers beyond the legal minimum + support address.

1. **Welcome / your Cue is ready** — Subject: `Your Cue is ready.` Body: `{firstName} — your Cue is live. It's already private, already yours. This link signs you in on any device:` Button: `Open Cue`. PS line: `Save this email — the link is your key. You can request a fresh one anytime at cue…/signin.`
2. **Sign-in link** — Subject: `Your sign-in link`. One line + button `Sign in to Cue` + `Valid for 15 minutes. If you didn't request this, ignore it.`
3. **Credits low (15%)** — Subject: `Running low on credits`. Balance + one line + button `Top up` → /account. Tone: informative, zero urgency-marketing.
4. **Payment failed** — Subject: `Payment issue — Cue keeps running for now`. States we'll retry, grace period applies, button `Update payment method`.

---

## 6. Do / Don't

**Do:** reuse existing components everywhere · design every listed state, not just happy paths · keep the provisioning page cinematic but restrained · make credits feel like a natural unit of work.

**Don't:** mention OpenRouter/Anthropic/models/tokens/API keys anywhere · add passwords, "verify email" ceremonies, or captchas to any flow · use urgency patterns (countdowns, "only 3 left") · introduce new colors/type styles · design card-number forms (Stripe hosts checkout) · add cookie banners or chat widgets.

## 7. Delivery format

- One HTML file per page: `pricing.html`, `redeem.html`, `welcome.html`, `signin.html`, `account.html`, `legal.html`, plus `emails.html` containing all four templates stacked with labels, and the landing-page diff (waitlist states + nav/footer additions) noted at top of `pricing.html` or as `landing-additions.html`.
- Keep all states present in the markup (hidden sections with clear class/id names like `state-invalid`, `state-sent`, `state-ready`) so engineering can toggle them.
- Keep the form field `name` attributes and form `id`s exactly as specified in each "Integration hooks" note — the backend contract is already built against them.
