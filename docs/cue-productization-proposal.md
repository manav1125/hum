# Cue — Productization Proposal (Alpha → Beta → Live)

**Date:** 2026-07-06 · **Status:** Draft for review · **Owner:** Manav
**Positioning:** *It already knows your next move.*

This is the plan to take Cue from a single production instance (yours) to a
product that alpha/beta users can sign up for, pay for, and run — with either
our shared LLM/tools or their own keys (BYOLLM).

---

## 1. Where we actually are (assets in hand)

What the last two months already bought us, productization-wise:

| Asset | State |
|---|---|
| Single-tenant cloud deploy | ✅ One `render.yaml` blueprint boots a full instance (daemon + gateway + SPA) from the Docker image; secrets are 6 `sync:false` env vars |
| Owner auth | ✅ Self-host bootstrap secret → signed actor token; remote clients (web/iOS/macOS) all authenticate through it |
| LLM key mechanics | ✅ `OPENROUTER_API_KEY` env → seeded into the secure store at boot; per-instance model override via `CUE_OPENROUTER_MODEL` — this **is** the BYOLLM mechanic already |
| Metering | ✅ Act ledger (every action, cost field), per-agent spend, Guardrails usage rollups + spend caps |
| Guardrails | ✅ Checkpoints (money/delete/send/publish/contact), tool scopes, model pins — the trust story enterprise buyers ask about first |
| Clients | ✅ Web SPA, macOS app (Electron), iOS on TestFlight |
| QA harness | ✅ `qa/prod-smoke.ts` — becomes the per-instance health check |
| Billing / signup / entitlements | ❌ Nothing exists. Greenfield. |

The punchline: **the hard product is built; what's missing is a thin
commercial shell around it** — signup, provisioning, billing, and cost
control.

---

## 2. The one big architecture decision: tenancy

Everything in the daemon assumes a single owner (`local:` principal, one
assistant, one SQLite DB, one workspace). Two ways to serve N users:

**Option A — Instance-per-customer (recommended for alpha/beta).**
Each customer gets their own Render service from the same blueprint/image.
- *Pros:* zero daemon changes; perfect data isolation (a real selling point —
  "your Cue is YOUR machine"); a bad instance can't hurt anyone else; upgrades
  are just image rolls; this is literally how we run today.
- *Cons:* ~$25–35/mo infra per customer (Render standard + disk); fleet ops
  (we automate this — see §3); doesn't price-scale to a $10/mo consumer tier.

**Option B — Multi-tenant daemon.** One deployment, many owners.
- *Pros:* marginal cost per user near zero.
- *Cons:* a multi-week rewrite touching auth, DB schema, workspace isolation,
  guardian trust, schedulers — every subsystem. High regression risk on a
  product we just spent weeks stabilizing.

**Recommendation: Option A now, unapologetically.** At alpha/beta scale
(10–100 users) instance-per-customer is *better product* (isolation, BYO
keys, per-user model pins) and the infra cost is covered by pricing (§6).
Revisit multi-tenancy only if we chase a low-price self-serve tier at >500
users — and even then, a "pooled starter tier + dedicated instance on paid
plans" split is the likely shape, not a full rewrite.

---

## 3. The control plane ("Cue HQ")

A small, boring, separate service (NOT inside the daemon) that owns the
commercial lifecycle. One Postgres DB + a few endpoints + a tiny admin UI.

**Responsibilities:**
1. **Waitlist + invite codes** — landing page form → row in DB; we mint
   invite codes (alpha is invite-gated).
2. **Provisioning** — on activation: call the Render API (we already drive it
   with the API key) to create a service from the blueprint, generate the
   per-instance secrets (`GUARDIAN_BOOTSTRAP_SECRET`, signing key, actor
   token), set the LLM key (§5), wait for health, then email the customer a
   **magic link** that opens `cue-<slug>.onrender.com` with the actor token —
   the exact localStorage bootstrap our QA harness uses today.
3. **Billing sync** — Stripe webhooks (`checkout.session.completed`,
   `subscription.updated/deleted`) flip the instance state:
   active → suspended (Render suspend API — instant, reversible, stops
   compute billing) → deleted after a grace window (with a data export).
4. **Entitlements** — writes plan limits into instance env
   (`CUE_PLAN=founding`, `CUE_MONTHLY_LLM_BUDGET=20`) which Guardrails spend
   caps already know how to enforce.
5. **Fleet health** — runs `prod-smoke.ts` against every instance nightly;
   one dashboard, alerts to your Telegram.

Estimated build: **3–5 focused days** for the alpha version (provision +
Stripe + magic link), because every hard primitive (Render API driving,
token minting, smoke harness) already exists in this repo — it's assembly,
not invention.

---

## 4. Signup & onboarding flow (alpha)

```
Landing page (waitlist) ──invite code──▶ Stripe Checkout (code = promotion code)
        │                                        │ webhook
        ▼                                        ▼
   "You're on the list"              Cue HQ provisions instance (~4 min)
                                                 │
                                                 ▼
                              Welcome email + magic link → onboarding wizard
                              (name → connect email/calendar → Brand Kit →
                               guardrails defaults → first next-move surfaced)
```

- The **onboarding wizard already exists** (hatch flow + Brand Kit in
  onboarding). Gap to close: a first-run "connect your accounts" step that
  strings existing connector flows together, ~1–2 days.
- Alpha is **invite-only**: invite code required at checkout. This doubles as
  our discount mechanism (§6) and our capacity valve.

---

## 5. LLM & tools packaging — shared vs BYOLLM

Offer **both from day one**; the mechanics for each are ~90% built.

**Shared (default — "it just works"):**
- Use the **OpenRouter Provisioning API** to mint a *child key per customer
  with a hard dollar limit* — this gives us isolation, metering, and a kill
  switch per customer for free, and slots into the exact same
  `OPENROUTER_API_KEY` env the instance already consumes. No daemon changes.
- Belt-and-suspenders: Guardrails monthly spend cap set from the plan.
- Replicate (images/video) in alpha: our shared token with a Guardrails cap;
  move to per-customer metering in beta if creative usage gets heavy.

**BYOLLM ("bring your own key"):**
- Customer pastes their own OpenRouter key (and optionally Replicate token) —
  either at provisioning or later in Settings → AI. Env + re-seed at boot is
  the mechanism that runs in prod today.
- Cheaper plan (we carry no inference cost), and it's the answer for
  privacy-sensitive users ("my tokens, my provider relationship").
- Gap to close: a Settings UI field that writes the key to the secure store
  and re-seeds without a redeploy (~1 day; the store + seeding code exist,
  it needs a route + form).

**Important constraint learned this week:** OpenRouter blocks
Anthropic/OpenAI/Google for requests originating from some regions (the HK
403). Instances run on Render US, so *shared* is safe; for BYO we document
that keys are exercised server-side from US IPs, which also sidesteps the
customer's local region.

---

## 6. Pricing & discount codes (alpha sketch)

Anchors: neo.work and peers sit at $200–500+/mo for "AI chief of staff /
AI employee" products. Our infra floor is ~$30/mo/instance. Proposal:

| Plan | Price | Includes |
|---|---|---|
| **Founding Member** (alpha) | **$99/mo** | Dedicated instance, shared LLM with $25/mo allowance (~everyday usage), all channels, all Create/Studio, priority Telegram support, price locked for life |
| **Founding Member — BYO** | **$49/mo** | Same, minus our LLM/tools spend (their keys) |
| Overage | +$10 per +$10 LLM allowance | Toggled in Settings, capped by Guardrails |
| Design partners | 100% off, 3 months | Stripe promotion code, 5–10 hand-picked |

- **Discount codes = Stripe promotion codes** — zero custom code; the invite
  code IS the promo code. `FOUNDER50` (50% for 3 months), `PARTNER100`, etc.
- Margin check: $99 − ~$32 infra − ~$25 LLM ≈ **$42/customer/mo gross** while
  alpha-sized; BYO tier is ~$17 net. Fine for alpha; real margins come from
  annual plans + beta pricing.
- Alpha capacity target: **20 founding members** (fleet ops + support are
  hand-manageable; $2k MRR validates willingness to pay).

---

## 7. Hardening gaps to close BEFORE first external user

Ranked; ~1–2 weeks of work total, parallelizable:

1. **Per-instance backups** — nightly SQLite + workspace snapshot to R2/S3
   (we have the export tooling from the migration). Non-negotiable.
2. **Key hygiene** — per-instance secrets generated at provision time (never
   shared across customers); rotate the QA actor-token pattern into a proper
   per-instance admin token held only by Cue HQ.
3. **Settings → AI key management UI** (the BYO gap, §5).
4. **First-run connect wizard** (§4).
5. **Legal shell** — ToS, privacy policy, DPA-lite ("your instance, your
   data, we can't read it"), the isolation story written down. One day with a
   template + the legal:compliance-check pass.
6. **Support loop** — a shared Telegram/WhatsApp channel per founding member
   (on-brand: Cue is a chief of staff; support lives in chat), + the fleet
   smoke dashboard so we see breakage before they do.
7. **Upgrade discipline** — image rolls go: staging instance → your instance
   → fleet. The smoke harness gates each step.
8. Kill the known cosmetics before demos: stale "DeepSeek V4 Pro" label,
   errored-turn avatar, dead-Anthropic-key log noise.

Explicitly **deferred to beta**: multi-tenant pooling, self-serve no-invite
signup, team/multi-seat accounts, SOC2-track work, usage-based billing
beyond the allowance toggle, Android.

---

## 8. Phased rollout

**Phase 0 — Commercial shell (week 1)**
Cue HQ control plane (provision + suspend + magic link) · Stripe products +
promo codes · landing page with waitlist + positioning line · hardening items
1–3. *Exit test: a stranger's email → paid checkout → working instance in
under 10 minutes, untouched by hand.*

**Phase 1 — Closed alpha (weeks 2–5)**
5 design partners (free) + up to 20 founding members. Weekly image rolls.
Success metrics: D7 retention on the work loop (≥4 sessions/wk), ≥1
"it caught something I would have missed" moment per user per week (the
next-move accept rate is the proxy), <$25/mo median LLM spend on shared.

**Phase 2 — Open beta (weeks 6–10)**
Self-serve checkout (still promo-gated for discounts), BYO Replicate,
annual plans, testimonial-driven landing refresh with the hero demo video,
TestFlight → App Store submission.

**Phase 3 — Live**
Public pricing, affiliate/referral codes (Stripe handles), decide the
pooled-tier question with real usage data.

---

## 9. Decisions needed from you

1. **Tenancy:** confirm instance-per-customer for alpha (§2). ← biggest one
2. **Pricing:** $99 / $49-BYO founding tiers, 20-member cap — adjust?
3. **Stripe account:** which entity (Brinc-affiliated or new)? I need the
   account to exist; everything else I can wire.
4. **Domain:** instances at `<name>.getcue.app`-style subdomains (Render
   custom domains) or raw `onrender.com` for alpha?
5. **Design partners:** who are the first 5 hands-on founders you'd invite?
6. **Support channel:** Telegram, WhatsApp, or email for founding members?

Say the word on 1–2 and I can start Phase 0 immediately — the control plane
and Stripe wiring need none of the answers to 3–6 to begin.
