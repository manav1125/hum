# Upstream multi-user & organisations — what they actually have

**Date:** 2026-08-16
**Subject:** `vellum-ai/vellum-assistant`, read at `upstream/main` = `c0c2f8d0ce`. Our fork point is `63127a2cc0` (2026-06-13).
**Purpose:** product decision input. Not a port plan.

## How to read the sourcing marks

Every load-bearing claim carries one:

- **[code]** — read in their source at `upstream/main`.
- **[spec]** — read in an API schema they commit (`clients/web/openapi-schemas/platform.yaml`, generated from a repo we cannot see).
- **[docs]** — their prose: `GLOSSARY.md`, `AGENTS.md`, docs site.
- **[inference]** — my reasoning from the above. Argue with these.
- **[unknown]** — I could not determine it from what is public. Listed explicitly at the end.

This document deliberately does not cite our own delta docs. One of them is corrected at the end.

---

## Bottom line

Two answers, and they point in opposite directions from what you'd expect.

**1. Their "organisation" is a billing tenant, not a team.** It owns money and a bucket of assistants. It does not own conversations, memory, connectors, or skills, and it has no members, no roles, and no invitations. **[spec][code]**

**2. Their real multi-person model is not organisations at all** — it is one guardian plus N *contacts*, and a contact is an email address or a Slack handle, not a person with a login. This is shipped, on by default, deep, and thoughtful. It is also, by their own written architectural doctrine, permanently capped at one owner per assistant. **[code][docs]**

And the thing that matters most for reuse: **the organisation code is not in the open-source repo at all.** It lives in a closed Django service, `vellum-ai/vellum-assistant-platform` **[docs]**. What is open-source is the *client* of it — an ID in a header, a Zustand store, and billing screens. There is nothing to port, because there is nothing there.

---

## 1. What is an organisation to them?

### What it owns

| Thing | Scope | Evidence |
|---|---|---|
| Billing account: credits, subscription, machine tier, storage tier, invoices, auto-top-up, daily credit limit | **per organisation** | ~35 endpoints under `/v1/organizations/billing/…`; `POST /v1/organizations/billing/summary/` "Creates a `BillingAccount` … for organizations that don't yet have one" **[spec]** |
| Notification feed (operational/billing alerts) | **per organisation**, optionally filtered by assistant | `/v1/organizations/notifications/` — "List notifications for the authenticated organization", query param `assistant_id` **[spec]** |
| The set of assistants | **per organisation** — `GET /v1/assistants/` is scoped by the `Vellum-Organization-Id` header | **[spec]** |
| Usage attribution | per organisation, sliceable by assistant | `/v1/organizations/billing/usage/series/` accepts `group_by` ∈ {`assistant`, `model`, `llm_call_site`, …}. **There is no `user` dimension.** **[spec]** |

### What it does *not* own

Conversations, memory, contacts, skills, connectors, trust rules, approvals. **None of these ever traverse the platform API.** They live inside the assistant instance's own database and workspace; the platform proxies runtime traffic but does not model the content. **[spec][inference — from the complete absence of any such path in the 10,039-line spec]**

Connectors specifically are **per assistant**, not per organisation: `/v1/assistants/{assistant_id}/oauth/connections/`. **[spec]**

### The shape of the object itself

```yaml
OrganizationRead:
  properties:
    id:   { type: string, format: uuid, readOnly: true }
    name: { type: string, maxLength: 255 }
```
**[spec]** That is the entire schema. And there is exactly **one** non-billing, non-notification organisation endpoint — `GET /v1/organizations/`, a paginated list. No create, no update, no members, no roles, no invitations.

I grepped the whole 10k-line spec for `member`, `role`, `permission`, `invite`, `invitation`, `seat`: **zero matches.** **[spec]**

### How org-aware is the software that actually runs?

Barely, and deliberately.

- The **daemon** holds exactly one org id, `PLATFORM_ORGANIZATION_ID`, stored as a credential. Their own comment: *"UUID of the organization this assistant belongs to. Used for Sentry tagging and platform API calls."* (`assistant/src/config/env.ts`) **[code]**
- The **gateway** — the service whose entire job is deciding who may talk to the assistant — contains **no organisation logic whatsoever**. A grep of `gateway/src` for "organization" returns two hits: an unrelated comment about email domains, and `"Vellum-Organization-Id"` in the CORS allowed-header list. **[code]**

That second point is the sharpest fact in this document. Their security layer has never heard of organisations. **[inference]** The org boundary is enforced entirely in the closed Django service, above the product.

**Summary:** organisation = a Stripe customer with a UUID, holding N assistants. Per-user: nothing but a login. Per-assistant: everything that matters.

---

## 2. What can two people in one org actually do together?

**Through the organisation: essentially nothing.** There is no product surface for a second person.

- **No org switcher, no org UI.** `setCurrentOrganizationId` has exactly one caller in the entire tree outside its own tests, and it is in the *teleport* flow (moving an assistant between homes). **[code]**
- **No team settings.** The settings sections are: ai, api, billing, credentials, keyboard-shortcuts, mcp, pair-device, security, teleport. No organisation, no team, no members. **[code]**
- **The CLI takes the first org and never asks.** `fetchOrganizationId` reads `body.results?.[0]?.id` and throws "No organization found for this account." if absent. **[code]** A user in two orgs gets an arbitrary one.
- **No seat-based billing.** No `seat` or `quantity` anywhere in the billing spec. **[spec]**
- **No shared-assistant UI language.** Their own docs site says the opposite: *"This isn't a shared assistant that treats everyone the same. This one is yours."* **[docs]**
- **A second person cannot sign in to the app and reach the assistant at all** — see §3, the `vellum` channel default.

**Through the assistant: yes, quite a lot — but as a *contact*, not a colleague.** This is their real answer, and it is unrelated to organisations.

A second person interacts by messaging the assistant on Telegram, WhatsApp, Slack, email, or phone. Concretely, for that person:

| | |
|---|---|
| **Share an assistant?** | Yes — as an inbound correspondent on a messaging channel. Not as a second seat. |
| **See each other's conversations?** | No. The contact sees only their own thread. |
| **Hand off a thread?** | No such primitive. |
| **Shared connectors?** | The assistant's own connectors are used on the contact's behalf, at the guardian's risk. There is no "link your own Gmail" for a contact. |
| **Shared memory?** | **Explicitly no.** Memory recall is gated on actor role: *"Untrusted actors (non-guardian, unverified_channel) must not receive memory recall results"*, enforced at both the write gate and the read gate. **[code — `assistant/src/approvals/AGENTS.md`]** |
| **Approve anything?** | No. See §3. |

So: two people in one org get **one shared credit balance and one shared notification feed** — and that is the complete list. **[inference]**

---

## 3. Roles and permissions

There are two role systems, and neither is in WorkOS.

### The organisation has no roles

Nothing in the platform API exposes a role, permission, or membership. **[spec]** Whether Django enforces one internally is **[unknown]** (see the end).

### The assistant has exactly two roles, and it is a hard invariant

```ts
export type ContactRole = "guardian" | "contact";
```
`assistant/src/contacts/types.ts` **[code]**. The DB default is `"contact"`, and `role`/`principalId` are write-protected — not accepted as inputs on create or update. **[code — `gateway/src/db/schema.ts`, `gateway/src/db/contact-store.ts`]**

There is no owner, no admin, no manager. And it is not an oversight — it is written down as doctrine:

> **Single-Guardian Invariant.** Each assistant instance serves exactly one guardian. **Multi-guardian is not supported and will never be.** All connections, browser sessions, approval channels, and trust contexts within a single assistant process belong to the same guardian principal. Do not introduce guardian-keyed maps, per-guardian routing logic, or multi-guardian multiplexing…
>
> — `assistant/src/approvals/AGENTS.md` **[code/docs]**

Their glossary makes the same point in product language: a person is a *guardian* of their assistant, and separately a *user* of the platform SaaS — *"A person can be a guardian of a Vellum assistant without being a user of the Vellum Platform."* **[docs]**

### The trust ladder (this is where the real granularity lives)

Derived at message time, four classes: `guardian` › `trusted_contact` › `unverified_contact` › `unknown`. **[code — `packages/gateway-client/src/trust-verdict-contract.ts`]** The middle two differ **only** at admission; downstream they are treated identically. **[code]**

Per-channel admission floors gate who gets in the door at all:

```
policies: no_one > guardian_only > trusted_contacts > any_contact > strangers
default:  trusted_contacts
```
**[code — `packages/gateway-client/src/admission-policy-contract.ts`]**

Two channels are seeded stricter — and this is the one that answers "can a colleague just log in?":

```ts
export const CHANNEL_ADMISSION_DEFAULTS = { vellum: "guardian_only", plugin: "guardian_only" };
```
with the comment *"`vellum` (the local desktop/web client) defaults to `guardian_only`: only the guardian's own local client is admitted by default."* **[code — `gateway/src/db/seed-admission-policy.ts`]**

**The desktop and web app is guardian-only by default.** A second human is architecturally a messaging correspondent, never an app user. **[inference, but a direct one]**

### Approvals and autonomy in a shared context

Whose guardian is it? There is only ever one, and only they can approve.

| Trust class | Self-approve tools | Sensitive tools | Memory |
|---|---|---|---|
| `guardian` | `true` | `"self"` | full |
| `trusted_contact` | `false` | `"escalate-and-wait"` | none |
| `unverified_contact` | `false` | `"escalate-and-wait"` | none |
| `unknown` | `false` | `"deny"` (fail closed) | none |

`assistant/src/runtime/capabilities.ts` **[code]**. A contact's sensitive action escalates to the guardian and blocks. **A contact can never approve anything — not their own action, and not anyone else's.** **[code]**

Identity is bound the same way: actor tokens are minted per `(guardianPrincipalId, hashedDeviceId)`, *"exclusively for the guardian principal (device pairing)"*. **[code — `gateway/src/auth/guardian-bootstrap.ts`]** The supported multiplicity is **one guardian across many devices**, never many guardians.

### How is any of it enforced?

Entirely in their own code, in the gateway and daemon — SQLite tables and TypeScript gates. **Zero of it is enforced by WorkOS.** **[code]**

---

## 4. Invitation, onboarding and identity

**An invite grants channel access, not an account.** **[code]**

- The gateway owns the lifecycle (`ingress_invites`: code hash, token hash, `maxUses` default 1, `useCount`, `expiresAt`, `contactId`). Redemption *"gates on existing gateway membership, claims the row atomically, and applies the verified-channel ACL side effect."* Success message: `"Welcome! You've been granted access."` **[code]**
- Redemption is allowlisted to four channels: `telegram`, `whatsapp`, `slack`, `email`. Phone uses a caller-bound voice code instead. **[code — `packages/gateway-client/src/invite-contract.ts`]**
- The daemon side is presentation only — it generates a one-or-two-sentence instruction telling **the guardian** how to hand the code over, with a deterministic fallback: *"Tell {contact} to message me on {channel} with the code below."* The share URL is never sent to the LLM, because it carries the redemption credential. **[code — `assistant/src/runtime/invite-instruction-generator.ts`]**

**What the invited person gets:** the right to message that one assistant on that one channel, at `trusted_contact` — no memory, no self-approval, sandboxed shell, and a prompt hardened with social-engineering defence. **[code]**

**What SSO / directory sync buys:** nothing that I can find. There is no SCIM, no Directory Sync, no SAML, no org-scoped auth anywhere in the tree. **[code — grepped `clients/`, `cli/`, `gateway/`, `assistant/`, `packages/`: zero hits for `scim`, `directory sync`, `saml`, `org_id`]** Whether the closed Django service consumes any of it is **[unknown]**.

Assistant-to-assistant invites (`a2a-invite-store`) are a separate, daemon-local mechanism for peer *assistants*, behind flag `a2a-channel`, **`defaultEnabled: false`**. **[code — `meta/feature-flags/feature-flag-registry.json`]**

---

## 5. How deeply is WorkOS wired in?

**Thin. Much thinner than our notes assume.** WorkOS is an identity provider and nothing else.

**What it is:** a single django-allauth social provider whose id is the literal string `"workos"` — `export const PROVIDER_ID = "workos";` and `{ id: "workos", label: "Continue with WorkOS" }`. **[code — `clients/web/src/domains/account/login-flow.ts`, `social-auth.ts`]**

**The native flow, end to end** (identical across CLI, macOS, iOS, Android, Chrome extension) **[code]**:

1. Fetch the public client id from *the platform*, not from config: `GET {origin}/_allauth/app/v1/config`. There is no hardcoded WorkOS client id or AuthKit domain anywhere in the repo — the only hardcoded value is `https://api.workos.com`.
2. Authorize with `scope = "openid profile email"`, `provider=authkit`, PKCE S256. **No `organization_id` parameter is ever sent.**
3. Exchange the code, and parse **exactly one field** out of the response: `as { access_token?: string }`. The WorkOS `user`, `organization_id`, and `impersonator` fields in that response are **discarded**.
4. Trade the access token for a Django session: `POST /_allauth/app/v1/auth/provider/token` with `{ provider: "workos", process: "login", token: {…} }`, keeping `data.meta.session_token`.

**Then the org id is fetched from the platform's own database**, not from WorkOS: `GET /v1/organizations/` → `results[0].id` → echoed back as the `Vellum-Organization-Id` header. **[code]**

**Nothing in the entire client tree reads a WorkOS organization, membership, role, or permission claim.** **[code — zero hits for `org_id`, WorkOS `organization_id`, `permissions`, `sso`, `scim`]**

**Server side:** `git grep workos` across `gateway/`, `assistant/`, `packages/`, `plugins/`, `scripts/` returns **one file, and it is a markdown doc**. There is no WorkOS code in any service in this repo. **[code]** Their own architecture note lists the two as *separate* responsibilities of the closed service: *"Handles authentication (WorkOS OIDC), organization management, assistant lifecycle, and runtime proxying."* **[docs — `AGENTS.md`]**

Secondary use: TOTP/MFA is proxied to WorkOS by the platform (error codes `no_workos_account`, `workos_rate_limited`), behind flag `account-mfa`, `defaultEnabled: false`. **[code]**

### So: could someone have this capability without WorkOS?

**Yes, trivially — and that is the wrong question.**

Replacing WorkOS is swapping one allauth social provider plus AuthKit-hosted MFA. It touches five near-identical PKCE files in the clients and nothing else. **[inference, well-supported]**

The real obstacle is different and much larger: **the organisation capability is not open-source.** The platform OpenAPI spec we can read is generated from `vellum-ai/vellum-assistant-platform` (recorded in `platform-source.json` with a source SHA), a repo that is not public. Their glossary states the carve-out plainly: *"The exception is the platform — the multi-tenant infrastructure that hosts assistants… Billing, tenancy isolation, secrets management, support tooling… You rent the platform. You own the assistant."* **[docs]**

Reusable from upstream: an OpenAPI spec, a ~300-line Zustand store, a header interceptor, and billing screens. The MIT licence **[code — `LICENSE`]** makes that legally free and practically worthless, because the tenancy logic — membership, authorisation of the header, provisioning — is all behind the wall.

**Verdict on our standing "WorkOS-coupled ⇒ not mergeable" flag:** the conclusion holds, the reason is wrong. It is not WorkOS coupling. It is that the org model was never shipped as open source. Anything we build here is a build, not a merge — regardless of which IdP we choose. **[inference]**

---

## 6. What this would mean for Cue

Today: one instance per person. `hq/` is a provisioning and billing control plane — `customers` (unique email), `instances` (`customerId` FK, indexed, so 1:N is already possible), `subscriptions`, `credit_ledger`, `signin_tokens`. **No org table, no membership table, no roles.** **[code — `hq/src/db.ts`]**

Worth seeing plainly: **`hq/` is already structurally isomorphic to their platform.** `customers` ≈ their `Organization`, `instances` ≈ their assistants, `credit_ledger` ≈ their `BillingAccount`. The only difference is that their tenant is nominally an organisation and ours is nominally a person — and since their organisation has no members and no roles, that difference is mostly a label. **[inference]**

Four shapes. Not picking one.

### A. Do nothing new — use the contacts model we already have

Our fork carries `ContactRole = "guardian" | "contact"`, the trust classes, and the Single-Guardian Invariant verbatim. **[code — verified in our tree]** A colleague already becomes a contact on Slack/email/WhatsApp today.

- **Cost:** ~zero. Upstream's newer pieces (`admission-policy-contract.ts`, `seed-admission-policy.ts`, `capabilities.ts`) landed after our June fork point and are absent here; cherry-picking the per-channel admission floors is a contained, genuinely mergeable job — no platform coupling. **[code]**
- **Risk:** it is deliberately a weak collaborator. A contact gets no memory, cannot approve, and is sandboxed. If the ask is "my ops person should work *with* Cue", this does not deliver it.
- **Honest note:** this *is* upstream's answer. Adopting it is agreeing with their product bet.

### B. Shared memory and/or shared connectors across separate instances

- **Cost:** high. Memory is per-instance SQLite + Qdrant; connectors are per-instance credentials. This means a new shared service, a tenancy model inside Qdrant, and a consistency story for concurrent writes.
- **Risk — the serious one:** memory is a trust boundary, not a data store. Upstream gates recall on actor role precisely so an untrusted actor cannot pull the guardian's memory. **[code]** A shared memory pool across guardians deletes that gate by construction: person A's assistant recalls person B's private context with no actor check anywhere in the path. This needs a designed answer before any code, not after.
- **Shared connectors carry the same shape of risk one level down** — a shared Gmail grant means A's assistant acts in B's mailbox with no per-actor attribution.

### C. An org layer in `hq/` above independent instances

Add `organizations` + `organization_members`, point `signin_tokens` at an org, roll billing up.

- **Cost:** lowest of the three build options. The schema step is small and `instances.customerId` already permits fan-out. **[code]**
- **Risk:** it buys consolidated billing, consolidated admin, and one invoice — and **no ability for people to work together at all**, because the instances stay fully isolated. It is precisely upstream's shape, including upstream's limitation.
- **Worth knowing before choosing it:** this is the option where we can honestly check the value first. If the demand is "one invoice for my company", C answers it. If the demand is "we want to share work", C answers nothing.

### D. Genuinely multi-tenant single instance

- **Cost:** highest by a wide margin. Every table in `assistant/` and `gateway/` is single-tenant by construction; the whole DB *is* the tenant boundary. Upstream considered this and wrote "will never be" into their architecture docs. **[code]**
- **Risk — likely disqualifying as things stand:** we already know from prior work that the credential vault cannot be protected from a co-tenant by any file-level measure, because the instance shell is root with NOPASSWD sudo. In a single-tenant instance that is acceptable, because the only actor is the owner. In a multi-tenant one, tenant A's bash tool reaches tenant B's secrets, and no file mode or directory move closes it — it needs the daemon to drop uid first. That work is a prerequisite, not a detail. **[inference, from our own established findings — worth re-verifying before it is quoted in a decision]**

---

## 7. Correcting the record

`docs/upstream-ledger-2026-08-16.md` (lines 58–61, 366) says upstream has *"WorkOS orgs and `organization-store.ts`, which is a real multi-tenant membership model we deliberately do not want."*

That was the correction to an earlier error, and it overshot. Three things in it are wrong:

1. **There is no membership model** — open-source or in the client-visible API. Zero endpoints, zero role enums, zero UI. **[spec][code]**
2. **`organization-store.ts` is not evidence of one.** It is a billing-tenant id picker whose setter has one non-test caller, in the teleport flow. **[code]**
3. **They are not "WorkOS orgs."** WorkOS supplies a login; the org id comes from the platform's own database and the clients never read a WorkOS org claim. **[code]**

The accurate statement: *upstream's organisation is a billing tenant with no members and no roles; their actual multi-person model is guardian-plus-contacts, which we already have; and their org-management code is closed source, so nothing about it is mergeable regardless of the identity provider.*

The part of the earlier correction that stands: we have no multi-user model, `hq/` is single-owner instance provisioning, and upstream has no counterpart to `hq/`.

---

## What I could not determine

All of it sits behind `vellum-ai/vellum-assistant-platform`, which is not public:

1. Whether their Django `Organization` ↔ `User` relation is many-to-many at all, or effectively 1:1. The endpoint is paginated and the client caches per `(token, url)` as if switching were possible, but `results[0]` is taken blindly and no switcher exists — so multi-org is *modelled* and *unused*. **[inference]**
2. How `Vellum-Organization-Id` is authorised server-side — whether DRF verifies membership, and against what role.
3. Whether their `SocialAccount` sync reads WorkOS `organization_id` or memberships when provisioning the Django org. This is the single residual place where real WorkOS org coupling could hide. Nothing client-side suggests it; absence here is not proof.
4. Whether WorkOS SSO / Directory Sync / SCIM connections are configured in their dashboard. Nothing in the repo references them.
5. Whether `GET /v1/assistants/` returns *all* assistants in an org or only the caller's own. This is the one server-side answer that would change §2 materially — if it returns all of them, two people in one org can see and operate each other's assistants, which no client-side code anticipates. **Worth a direct question to them if this decision turns on it.**
