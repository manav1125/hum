# WS4 — Platform Features: Plan & Decisions Required

WS4 turns Cue from a local-only app into a product with accounts, cloud/managed assistants, billing, and fleet management. **Unlike WS1–WS3, most of WS4 cannot be built or verified locally** — it requires a hosted backend, third-party accounts (WorkOS, Stripe), deployment, and several product/architecture decisions that are yours to make. This doc lays out exactly what each piece needs so you can provision/decide, and what can be built in-repo once those are settled.

> Status legend: **[DECIDE]** needs your call · **[PROVISION]** needs an external account/infra · **[BUILD-LOCAL]** can be implemented in-repo now · **[BUILD-AFTER]** buildable once a dependency is met.

---

## 0. The foundational decision — is there a hosted "Cue platform" backend?

Today Cue is local-first: the daemon runs on the user's machine; there is no Cue-owned server. Every WS4 feature (login, managed assistants, billing, device sync, auto-update feed) presumes a **hosted backend service** that Cue operates. So the first decision gates the rest:

**[DECIDE] Do we stand up a hosted Cue backend, and on what stack?**
- Option A — **Stay local-first, add a thin cloud control-plane** (auth + billing + license + managed-assistant orchestration only; user data stays local). Lower cost, preserves the privacy story, but managed/cloud assistants are limited.
- Option B — **Full hosted platform** (cloud-run assistants, server-side connectors, multi-device sync). Maximum capability, but it's a real backend product with ops, security, and data-residency obligations — and it weakens the "local-first / your data never leaves your machine" positioning.
- Recommendation: **A** for now — a minimal control-plane that enables accounts + billing + license gating and *coordinates* managed OAuth (already covered by Composio) and managed assistants, without relocating user data. Revisit B when demand is proven.

Everything below assumes a control-plane exists once you choose A or B.

---

## 1. Authentication & accounts (login / signup / SSO)
- **[PROVISION] WorkOS** (the codebase already references WorkOS-style auth and has `/account/*` screens). Needs: a WorkOS account, client ID/secret, redirect URIs, and the hosted callback endpoint on the control-plane.
- **[DECIDE]** Auth model: personal email/password + Google SSO only, or org/SSO (WorkOS Organizations) for teams? This drives the data model (users vs orgs vs workspaces).
- **[BUILD-AFTER]** The `/account/login|signup|callback|password-reset` screens exist as UI shells; wiring them needs the control-plane's auth endpoints + token storage. The daemon already has a `VellumPlatformClient` that expects a platform base URL + credentials — point it at the control-plane.
- **Security note:** per policy, the app must never collect passwords directly into fields it controls — route sign-in through WorkOS's hosted flow / the OS browser, not an in-app password field.

## 2. Managed / cloud assistants
- **[DECIDE]** What does "managed" mean concretely — (a) an assistant whose **OAuth/connectors** are brokered by the platform (largely already solved by Composio per-user), (b) an assistant that **runs in the cloud** 24/7 (needs hosted compute), or (c) both?
- **[BUILD-LOCAL]** The "local vs managed" distinction in the assistant selector + a Settings surface to view/manage managed assistants (read-only until the backend exists). The dead "Managed" tab was hidden in this fork — re-enable behind a flag once the backend is real.
- **[BUILD-AFTER]** Cloud execution (b) requires hosted compute + secure credential handling (CES in the cloud) — a significant backend build. Defer unless A→B is chosen.

## 3. Billing (Stripe)
- **[PROVISION] Stripe** account, products/prices, webhook endpoint on the control-plane. **[DECIDE]** pricing model (seats, usage/tokens, tiers) and what's gated (managed assistants? connector count? Cue Live?).
- **[BUILD-AFTER]** The Settings → Billing page exists as a shell. Wiring needs Stripe customer/subscription state from the control-plane + a `licenseTier` the daemon can read to gate features. **Per policy I won't implement payment capture in-app** — checkout must go through Stripe's hosted checkout.
- **[BUILD-LOCAL]** A `licenseTier` / entitlements abstraction in config + feature-gating hooks, defaulting to "local/unlimited" so nothing is gated until billing is live.

## 4. Auto-update feed
- **[DECIDE]** Distribution channel — keep electron-updater but **repoint the publish URL** from the upstream vellum bucket to a Cue-owned release bucket (the current auto-updater noise about `Vellum-0.8.12` is because it still points upstream).
- **[PROVISION]** A release bucket/CDN + code-signing identity for Cue (signing is currently disabled via `CSC_IDENTITY_AUTODISCOVERY=false`). **[BUILD-AFTER]** wire the updater feed + a "what's new" surface once the bucket + signing cert exist.

## 5. Device management & feature flags
- **[BUILD-LOCAL]** Feature flags already exist in the daemon (gateway flag listener). Surface a Settings → Developer/Advanced flag panel (local override) now; the *remote* flag source needs the control-plane. **[BUILD-AFTER]** remote flag delivery.
- **[BUILD-AFTER]** Multi-device list/sync (Settings → Devices shell exists) needs the control-plane to register devices against an account.

---

## What I can build in-repo right now (no external deps), if you want it
1. **Entitlements/licenseTier abstraction** + feature-gating hook (defaults to unlimited) — so billing can later flip gates without code churn. **[BUILD-LOCAL]**
2. **Local feature-flag override panel** in Settings → Developer. **[BUILD-LOCAL]**
3. **"Local vs managed" assistant framing** in the selector + a managed-assistants Settings surface (read-only placeholder wired to `VellumPlatformClient`, shows "connect a Cue account" when no control-plane). **[BUILD-LOCAL]**
4. Repoint the **auto-update publish URL** to a placeholder Cue bucket + remove the upstream-vellum confusion. **[BUILD-LOCAL]** (needs the real bucket URL from you to finish.)

## Decisions I need from you to proceed on the rest
- **D1:** Control-plane — Option A (thin) or B (full)? (gates everything)
- **D2:** Auth — WorkOS personal vs org/SSO? Provision WorkOS + share keys.
- **D3:** Billing — Stripe pricing/tiers + what's gated? Provision Stripe.
- **D4:** Releases — Cue release bucket URL + code-signing cert for auto-update + signed builds.
- **D5:** "Managed assistant" definition — brokered-connectors / cloud-run / both?
