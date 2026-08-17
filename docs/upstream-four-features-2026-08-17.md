# The four upstream features — what they are and what they cost (2026-08-17)

Scoping document. **Research only — no code was written.** Companion to
`upstream-ledger-2026-08-16.md`, which recommended closing all four of these. That
recommendation was overruled: Manav wants all four woven in. This document therefore
does not re-argue whether to do them. It works out **what each one actually is** and
**what each one actually costs**.

## How to read the confidence marks

Same convention as the ledger.

| Mark | Meaning |
|---|---|
| **[tree]** | Read in our source on `cue/voice-replatform`. Trust it about us. |
| **[up]** | Read in the upstream tree at `upstream/main` (tip `c0c2f8d0ce`). Trust it about upstream. |
| **[inf]** | Inference. **Check before acting.** |
| **[?]** | Could not determine. Stated as a gap, not filled with a guess. |

Upstream was fetched fresh for this document and read via `git show upstream/main:<path>`;
nothing was checked out.

---

## The short version

| | What it is | Cost | The catch |
|---|---|---|---|
| **1. Teleport** | Move a whole assistant between local / Docker / **their cloud**. | CLI already ours, ~30 lines behind. Web UI ~1,440 lines. | **Every direction requires a Vellum Platform account and their GCS bucket** — including local→docker. It is SaaS-shaped. |
| **2. Discord** | A bot in the owner's own Discord server. Mention-only in allowlisted channels. | ~3,700 non-test lines upstream; realistically ~1,100 transfer near-verbatim, the rest is glue. **No migration needed.** | The "empty list admits nobody" claim is **true for guild channels and false for DMs** — DMs bypass both controls. Our floor catches it; theirs leans on a downstream check. |
| **3. Logs-DB split** | Move request/telemetry logs into their own DB file. | Much smaller than it looks — **we already built the relocation engine** on 2026-08-05. | The premise needs correcting in *both* directions. See §3. |
| **4. Memory map** | Already built and shipped. | n/a | There is no plan to finish. It is a design question. |

---

## 1. Teleport — what it actually is

### In plain English

**Teleport moves an entire assistant — identity, memory, relationships, credentials —
from one home to another.** Upstream's glossary puts it directly: "migrating from the
Vellum managed platform to a self-hosted Mac Mini, or from a desktop app to a Docker
container" [up, `GLOSSARY.md:97`].

Mechanically it is `export → transfer → import → verify → switch → retire source`:

1. The **source daemon** produces a `.vbundle` archive of itself.
2. The bundle is uploaded to a **Google Cloud Storage signed URL**.
3. The **target daemon** downloads and imports it (optionally `--dry-run` for a preflight
   report of what would change).
4. The source is **kept alive** until the user confirms the new one works, then retired.

The "confirm before you burn the old one" property is the genuinely nice bit: the web card
has an explicit `verifying` phase with *Confirm & Switch* / *Cancel*
[up, `clients/web/src/domains/settings/teleport/teleport-card.tsx`].

### Is it real, or roadmap?

**Real, shipped, and largely already ours.** [tree]

- `cli/src/commands/teleport.ts` is **1,561 lines in our tree**, registered unconditionally
  in `cli/src/index.ts:29,67` and listed in `--help`. It is not flag-gated. We inherited it
  at the fork.
- Upstream's is 1,590 lines. `git diff` between them is **61 insertions / 90 deletions** —
  we are marginally behind, not missing it.
- The runtime plumbing is all ours too: `assistant/src/runtime/routes/migration-routes.ts`,
  `assistant/src/config/sanitize-for-transfer.ts`,
  `assistant/src/runtime/migrations/origin-mode.ts`.
- The **web UI is the only genuinely missing piece**. We have the feature-flag entry in
  both `meta/feature-flags/feature-flag-registry.json:191` and
  `apps/web/src/lib/feature-flags/feature-flag-registry.json:191`, but **no card** —
  `find apps/web/src -ipath "*teleport*"` returns nothing [tree].

Upstream's flag `teleport` is `"defaultEnabled": false` and additionally requires
`isElectron()` [up, `feature-flag-registry.json:145-152`, `general-page.tsx:341`]. So on
their side it is shipped-but-off-by-default. A live branch `Shaarson/remove-hatch-teleport-flags`
is un-gating the platform destination and keeping Docker behind a flag [up] — i.e. they are
moving it toward GA, but that has **not landed on `main`**.

### Does it make sense for a self-hosted single owner?

**No, not as built.** This is the answer to the question the brief actually asked, and the
evidence is unambiguous.

**Every teleport direction requires a Vellum Platform account.** Not just the ones that
touch their cloud — *all of them*, including local→docker:

```
cli/src/commands/teleport.ts:376  const platformToken = readPlatformToken();
cli/src/commands/teleport.ts:379  "Not logged in. Run 'vellum login' first (required for GCS-based teleport)."
```

and again at `:588-591` on the import side [tree — this is *our* copy]. The transport is a
signed GCS URL minted by their platform (`platformRequestSignedUrl` → `POST /v1/migrations/signed-url/`)
[up, `cli/src/lib/platform-client.ts:1022`].

**And the bucket cannot be repointed at our own storage without patching a security
validator.** The runtime hard-refuses any host but Google's:

```
assistant/src/runtime/migrations/gcs-signed-url.ts:31
const EXPECTED_HOST = "storage.googleapis.com";
const DEFAULT_ALLOWED_HOSTS: readonly string[] = [EXPECTED_HOST];
```

with an options bag that widens the host list **for tests only** and carries the comment
"Production code MUST NOT pass a wider list" [tree, `:34-42`]. The URL must also carry a
`X-Goog-Signature` or `Signature` param. This is a deliberate SSRF guard and it is doing its
job; the point is that it makes "teleport, but to my own S3" a patch to a security control,
not a config change.

**The web card is worse — it is org-shaped by construction.** `resolveDestination` offers
exactly two moves: managed→local and local→platform. Anything else returns `null` and the
card renders nothing [up, `teleport-types.ts:80-90`]. Its error enum includes
`no_organizations`, `multiple_organizations`, `existing_platform_assistant`
[up, `teleport-types.ts:25-37`], and the hook imports `useOrganizationStore` /
`getActiveOrganizationIdForRequests` and `useAuthStore` [up, `use-teleport.ts:32-35`].
Both destinations terminate at their platform. A Fly-hosted self-host is neither `local`,
`docker`, nor `vellum`, so it classifies as `"other"` and the card would render nothing —
**[inf]**, because I could not read the `cloud` value on Manav's live lockfile **[?]**.

The CLI's platform path also calls `fetchCurrentUser` + `fetchOrganizationId` and injects
`vellum:assistant_api_key`, `platformOrganizationId`, `webhookSecret` into the target
[up/tree, `teleport.ts:1129-1190`]. That is SaaS onboarding, not portability.

### The thing that makes this cheap anyway

**We can already do the useful 80% today, with no platform account, using commands we
already ship.** [tree]

`backup` and `restore` have a **local byte-stream path with no GCS and no token**:

- `cli/src/commands/backup.ts:116` — `POST {runtimeUrl}/v1/migrations/export`, bearer =
  the daemon's own token.
- `cli/src/commands/restore.ts:698` — `POST {runtimeUrl}/v1/migrations/import`,
  `Content-Type: application/octet-stream`, raw bundle bytes.
- `restore.ts:565` dispatches to the platform path **only** when `cloud === "vellum"`.

So `vellum backup <src> -o bundle.vbundle && vellum restore <dst> --file bundle.vbundle`
is a working self-hosted teleport **right now**. What upstream's teleport adds on top is:
orchestration (hatch the target, retire the source, confirm-and-switch), the GCS transport,
and platform destinations. For one owner, only the first of those three is wanted.

### Cost

| Option | Size | Touches |
|---|---|---|
| **A. Catch the CLI up to upstream** | **XS**, ~90 lines | `cli/src/commands/teleport.ts` only. Two real deltas: the docker `consumer: "runtime"` URL-signing fix, and `--dry-run` preflight for local/docker targets — the latter needs a new runtime route, see below. |
| **B. A self-hosted teleport that actually works** | **S–M** | A `--local-transport` path through `/v1/migrations/export` + `/v1/migrations/import` (both already exist), skipping GCS and the platform token entirely. Wraps the existing backup/restore byte path in teleport's hatch/verify/retire orchestration. Touches `cli/` only. |
| **C. Port the web card** | **M**, ~1,440 lines / 7 files | `apps/web/**` (off-limits this session; other sessions live). Depends on `local-mode`, `local-mode-host`, `organization-store` — **all three exist in our tree** [tree], so it is not a rewrite. But it would produce a card that shows nothing or errors `no_organizations` on a self-host unless `resolveDestination` and the org checks are reworked first. |

**Missing runtime route:** we have `export`, `import-preflight`, `import`, `export-to-gcs`,
`import-from-gcs` — but **not** `preflight-from-gcs`. Upstream has it (7 references);
ours has 0 [tree/up]. That is exactly why our teleport dropped the local/docker `--dry-run`
branch that upstream has.

### What Manav would have to do

- **For option A or B: nothing.** No account, no credential.
- **For anything using the shipped GCS path: a Vellum Platform account and `vellum login`.**
  That is the whole question. If he does not want one, options A and B are the only live ones.

### Never-adopt hazards

None specific to teleport. But note the platform-credential injection block
(`teleport.ts:1129-1190`) is the SaaS-coupling seam — if the CLI is touched, do not port
that half.

**Recommendation:** do **B**, optionally **A**. Do not do **C** without first answering
whether a self-hosted destination model even exists for the card to offer.

---

## 2. Discord

### In plain English

A Discord bot the owner invites to his own server. In a **guild channel** it answers only
when (a) the channel is on an operator-authored allowlist and (b) the message directly
`@`-mentions the bot. In a **DM** it answers whoever the trust floor lets through.

### The premise, checked

The brief's summary was **"mention-only, operator-allowlisted, empty list admits nobody."**
Two-thirds right, and the wrong third matters. I read `admit.ts` myself rather than relying
on the docstring, because of the guard-polarity scar.

- **Empty allowlist admits nobody — CONFIRMED.** `readDiscordAllowedChannelIds` returns
  `new Set(getStringArray(...) ?? [])`; an absent or malformed setting yields an empty set,
  and `admit.ts` only ever calls `.has()` on it. **There is no `size === 0 → allow all`
  branch** [up, `gateway/src/discord/allowed-channels.ts:24-27`, `admit.ts:127-137`].
  The polarity is correct and fail-closed.
- **Mention-only — CONFIRMED for guild channels.** Discord omits `@everyone`/`@here` and
  role pings from the mentions array, so a room-wide announcement cannot satisfy the check
  [up, `admit.ts:139-145`].
- **REFUTED as a blanket statement: DMs bypass both controls.**

```
gateway/src/discord/admit.ts  (~line 118)
if (!candidate.guildId) {
  return ADMITTED;
}
```

  This returns **before** the allowlist check and **before** the mention check. Anyone who
  can DM the bot is admitted at the *room* level; who actually gets answered is deferred
  entirely to the downstream trust-class floor [up]. Upstream is explicit that this is the
  design ("What that lane admits is a *room*, not a person"), so it is not a bug — but
  "empty list admits nobody" is not what the code says.

**Does our floor hold?** Yes, and I traced it rather than assuming. A first-time DM'er has
no contact row → `enforceIngressAcl` denies at the non-member branch. And upstream's
`upsertContactChannel` seeds a row with `status='unverified', policy='allow'` on every
admitted event *before* any trust check [up] — but our ACL checks
**`resolvedMember.channel.status !== "active"` and denies there, before the policy branch
is ever reached** [tree, `assistant/src/runtime/routes/inbound-stages/acl-enforcement.ts:473`
vs `:720`]. So an `unverified`/`allow` row cannot clear our gate. **Our side is stricter
than theirs.** That resolves the sharpest open question from the research pass.

**But** the denial path is not free: it fires `notifyGuardianOfAccessRequest` and delivers
a rejection reply [tree, `acl-enforcement.ts:655-712`]. On a public Discord server that is
a guardian-notification spam vector and an unbounded contact-row growth vector. Worth a rate
limit before this goes anywhere near a non-private guild. **[inf]** on severity — depends on
server size.

### One structural note

`admit.ts`'s DM branch keys on the *absence* of `guild_id`. Upstream's ingress schema
deliberately collapses a malformed `guild_id` to a **sentinel** rather than to `undefined`,
specifically so a parse failure stays on the guild (safe) path [up, `admit.ts` comment +
`message-schemas.ts`]. A port that "tidies that up" to `undefined` silently converts a
malformed guild message into an unallowlisted, unmentioned admit. **Do not touch that
without moving the branch onto positive evidence of a DM.**

### Size

| Area | Non-test | Test | Total |
|---|---|---|---|
| `gateway/src/discord/**` | 1,902 | 2,070 | 3,972 |
| `assistant/src/messaging/providers/discord/**` | 800 | 587 | 1,387 |
| Discord privacy/verification tests | — | 722 | 722 |
| `clients/web` (nudge banner, logo) | 258 | 0 | 258 |
| `skills/discord-app-setup/**` | 698 | — | 698 |
| **Total (named set)** | **3,658** | **3,379** | **7,037** |

[up]. Largest single file: `gateway-socket.ts`, 735 lines. **This undercounts** — roughly 50
further upstream files carry Discord wiring, heaviest `gateway/src/index.ts` (33 references)
and `assistant/src/oauth/seed-providers.ts` (26).

### What transfers, what does not

**Near-verbatim (~1,100 lines + tests):** `backoff`, `close-codes`, `heartbeat`, `intents`,
`session-state`, `thread-parents`, `message-schemas`, `normalize` — pure Discord protocol.
`admit.ts` is a pure function and `allowed-channels.ts` is 28 lines. The REST/chunking layer
(`api.ts`, `render.ts`, `send.ts`) is essentially standalone.

Two dependency checks, both now resolved [tree]:
- `gateway/src/util/exponential-backoff.ts` — **exists in our tree.** Fine.
- `ConfigFileCache.getStringArray` — **does not exist in ours** (we have
  `getString`/`getNumber`/`getBoolean`/`getRecord`). One small method to add.

**Does not transfer:**
- `transport.ts` implements upstream's `ChannelTransport` interface. We have no such
  abstraction — `assistant/src/messaging/providers/index.ts` is a hand-rolled
  `isXCallback()` / `deliverX()` dispatcher. ~80 lines, mechanical rewrite [tree].
- `assistant/src/approvals/guardian-channel-delivery.ts` **does not exist in our tree**;
  the requester-notice DM routing has no landing pad [tree].
- The whole `clients/web` half — our web tree and nudge system differ. Cosmetic; skip it.

**Our files a port must touch** [tree]: `gateway/src/channels/types.ts`,
`gateway/src/channels/inbound-event.ts`, `gateway/src/index.ts`,
`gateway/src/credential-reader.ts`, `gateway/src/config-file-cache.ts`,
`assistant/src/messaging/providers/index.ts`, `assistant/src/channels/types.ts`,
`assistant/src/config/schemas/services.ts`, `assistant/src/daemon/handlers/config-channels.ts`,
`assistant/src/contacts/types.ts`, `assistant/src/util/canonicalize-identity.ts`.

### Trust-class plumbing

Our `packages/service-contracts/src/trust.ts` has **3 ranks**: `unknown(0) | trusted_contact(1) | guardian(2)`.
**This file does not exist upstream** — it is ours [tree/up].

Upstream has **4 classes** (`+ unverified_contact`) in
`packages/gateway-client/src/trust-verdict-contract.ts:27-31`, **plus an entire second axis
we do not have**: a per-channel admission policy (`no_one | guardian_only | trusted_contacts | any_contact | strangers`)
backed by a DB table, a startup seed, and a "Channel Trust Floors" UI [up].

**A Discord sender maps onto our model cleanly and needs no new machinery:**
`sourceChannel: "discord"` → `canonicalizeInboundIdentity` → `findContactChannel` → our
`TrustClass`. We *have* the `unverified` contact status
[tree, `assistant/src/contacts/types.ts:71-76`] but our `TrustClass` collapses it into
`unknown`. Consequence: **we would be stricter than upstream**, and upstream's
verification-code-over-DM upgrade flow (265 lines of tests) has nowhere to land. That is an
acceptable trade for one owner — it just means "let a stranger verify themselves into a
contact" is not a feature we get for free.

### Credentials Manav would have to create

**Yes — a new one.** About 10 minutes of clicking, no approvals [up, `skills/discord-app-setup/SKILL.md`]:

1. Create a Discord application at `discord.com/developers/applications`. No manifest API —
   it is click-through.
2. Reset the **bot token**; it is shown once. Stored under credential key
   `discord_channel:bot_token` via the secure credential prompt (never pasted in chat).
3. Confirm all three **privileged** intents stay **OFF** (Presence, Server Members, Message
   Content). The gateway requests `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES` only
   [up, `gateway/src/discord/intents.ts:56-59`] — **none privileged, so no Discord review**.
4. Invite the bot with `scope=bot+applications.commands`, `permissions=277025770560`
   (view/send/threads/embed/attach/history/react/emoji/slash). No Administrator, no Manage,
   no Mention Everyone.
5. `assistant config set discord.allowedChannelIds '["<id>"]'` — **without this the bot is
   online and silent**, which is the correct default.

Because the intents are unprivileged, "monitor the whole community" is **not reachable** on
this bitmask and would need Message Content + portal review. Upstream's own file calls that
out as a deliberate ceiling [up].

### Never-adopt hazards

- **No migration required — clean.** No Discord table, no gateway `m00xx`, no assistant
  migration. It rides the existing `contacts`/`contact_channels` tables [up]. The
  renumbering hazard does not apply to this feature.
- **No approval exemption found.** Approvals render on Discord as **plain text with no
  buttons**, by design: "Discord is not a guardian channel: approval prompts are actioned
  from the guardian's own channel" [up, `transport.ts:55-58`]. That is the opposite of the
  `9efc65cea1` / `bd2aa0b1eb` pattern.
- **Egress mention safety is already right:** `allowed_mentions: { parse: ["users"] }`
  withholds `everyone` and `roles`, so agent-composed or echoed untrusted text cannot ping
  a server [up, `send.ts:33`].
- **A real hazard the port inherits:** Discord has **no ephemeral messages outside
  interactions**. Upstream carries two dedicated regression tests (370 lines) preventing a
  decision notice or a live 6-digit verification code from being posted into a guild channel
  instead of a DM. **Our tree has no equivalent guard.** Port the tests with the feature.
- **A contradiction in upstream's own tree:** `admission-policy-contract.ts` documents
  Discord as hidden because "`discord` has no ingress implementation" — while
  `gateway/src/index.ts` boots a full Discord client. Effect: Discord is enforced at
  `trusted_contacts` but **invisible in their Channel Trust Floors UI**, with the seed
  re-pinning any drifted row. The owner cannot see or change Discord's floor [up]. We have
  no such UI, so we inherit the confusion only if we port the policy axis — which we should
  not.
- **[?] Unresolved:** whether `skills/vellum-oauth-integrations/references/provider-app-setups/discord.md`
  describes a separate, older OAuth-connector Discord path that would conflict with this
  bot-token one. It looks separate. Not read.

**Status: shipped and wired, not a stub, not flag-gated.** It is credential-gated and
UI-invisible — the connection exists only while `discord_channel:bot_token` does, and
`discord` is deliberately kept out of `BASE_AVAILABLE_CHANNELS` [up].

---

## 3. Logs-DB split — re-examined honestly

### The verdict up front

**The "obsolete because retention defaults to 1 hour" call was wrong — but not for the
reason the counter-argument assumed.** The split is still worth doing, and it is much
cheaper than it looks. But **neither of the two facts in the brief dominates. They compose,
and a third fact is probably the real story.**

### What upstream actually built [up]

Shipped, wired, **not** flag-gated:

- `assistant/src/util/logs-db-path.ts` → `<dataDir>/db/assistant-logs.db`
- `assistant/src/persistence/db-connection.ts` — `openDedicatedDb("logs"|"memory"|"telemetry", path)`,
  `getLogsDb({createIfMissing})`
- `assistant/src/persistence/migrations/297-move-llm-request-logs-to-logs-db.ts`
- `assistant/src/persistence/migrations/helpers/relocation.ts` — the generic drain engine

They actually did **three** splits: a memory DB, a logs DB, and a `assistant-telemetry.db`
for `telemetry_events` + `flush_checkpoints` (migrations 327–334).

Only `llm_request_logs` moves to the logs DB. Mechanics: **separate connection, not ATTACH**,
so cross-DB joins are impossible in-process and conversation-delete becomes two
deliberately non-atomic deletes backstopped by an orphan sweep. `getLogsDb` returns `null` on
failure and the daemon stays up (fail-soft). The migration renames
`main.llm_request_logs` → `llm_request_logs__relocating` (instant, metadata-only, so live
traffic routes to the new file immediately), then drains 10,000 rows/batch, ending with
`PRAGMA wal_checkpoint(TRUNCATE)`. Their stated goal: the two files "VACUUM/checkpoint
independently."

### The retention claim, checked

**Literally true, materially incomplete.** [tree]

- `memory.cleanup.llmRequestLogRetentionMs` default **= 1 hour**
  (`assistant/src/config/schemas/memory-lifecycle.ts:159-182`). Nullable; `null` = forever.
- `memory.cleanup.enabled` default **true** (`:94-97`). So yes, on in a fresh install.
- **But `memory.cleanup.enqueueIntervalMs` default = 6 hours** (`:98-103`). The prune is only
  *enqueued* on that cadence (`memory/jobs-worker.ts:1098-1130`). **The real steady-state
  window is up to ~7 hours of logs, not 1 hour.**
- The prune is `DELETE … LIMIT 1000` with self-re-enqueue (`job-handlers/cleanup.ts:64-90`).
  **It does not VACUUM.** SQLite deletes do not shrink the file.
- We *do* have a VACUUM: `maybeRunDbMaintenance()` (`assistant/src/memory/db-maintenance.ts:129`),
  defaults `intervalMs` 24h and `quietPeriodMs` **3 hours since the last *interactive* user
  message** (`memory-lifecycle.ts:200-219`). It VACUUMs main and `assistant-memory.db`.
- **The quiet gate is the hole.** VACUUM is skipped entirely unless no human has messaged for
  3 straight hours. Our own code comments acknowledge the starvation risk
  (`conversation-crud.ts:1843`). On a daily-driver instance, deleted log pages can sit in the
  freelist indefinitely.

### The measurement that settles it

The 701MB file is on prod (Fly) and was **not** touched. No local DB over 100MB exists on this
machine **[?]** — so the 701MB itself is **unmeasured**. What *was* measured, read-only via
`dbstat` on a stale 51MB local copy:

```
llm_request_logs:   34 rows, avg 380,493 bytes/row, max 588,987, total 12.94 MB  (25% of file)
messages:         1684 rows, avg   4,160 bytes/row, total 7.0 MB
```

**A single LLM request-log row averages 380 KB — 91× a message row.** That is consistent with
the known ~93k-token tool-schema payload being serialized into every request. Reaching 701 MB
needs only **~1,850 log rows**; reaching it via `messages` would need **~167,000**.

The local sample predates our memory-DB split, so it still carries `memory_segments` /
`memory_v2_activation_logs` in main. Post-split, `llm_request_logs` is **~34% of what remains
in main** [inf, from the same measurement].

### Which fact dominates?

**Neither. And the honest answer is that a third one probably does.**

1-hour retention bounds the **row count**; it does nothing about **churn** or **file size**.
A 701MB file and an aggressive retention policy are perfectly consistent — the most likely
explanation is that **rows are deleted but the file is never VACUUMed**, because the 3-hour
quiet gate never opens on an actively-used instance. **[inf] — but directly testable, and it
should be tested before anyone writes code.** One read-only query on prod settles it:

```sql
PRAGMA freelist_count; PRAGMA page_count; PRAGMA page_size;
SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC LIMIT 15;
```

A high `freelist_count / page_count` ratio proves it is un-reclaimed space — and the fix is to
ungate VACUUM, which is far cheaper than the split. A fat *live* `llm_request_logs` proves the
split is the right answer. Note `cue db status` already prints sizes and largest tables but
does **not** report `freelist_count`, and falls back to `COUNT(*)` because Bun's bundled
SQLite omits `dbstat` [tree, `assistant/src/cli/commands/db/status.ts`].

### What the split buys that retention does not

1. **WAL contention — the strongest argument, and it is measured, not speculative.** Every log
   write pushes ~380 KB through the **main** DB's WAL, and every prune batch deletes up to
   1,000 rows ≈ **380 MB of deletions through the same WAL** — the WAL that user-facing reads
   traverse. The 67MB WAL is exactly the shape this predicts. **Retention makes this worse,
   not better:** the pruner is what generates the largest single write bursts.
2. **VACUUM becomes possible.** VACUUM on a 701MB main DB holds an exclusive lock for minutes
   and is therefore quiet-gated into never running. A logs DB holding ~7 hours of data is small
   enough to VACUUM ungated — or to skip VACUUM entirely by deleting the file.
3. **"Reclaim the space now" becomes `rm`.** One file deletion, no lock, no downtime.
4. **Backup lock duration.** `assistant/src/backup/db-snapshot.ts` does a FULL `wal_checkpoint`
   then `VACUUM INTO`. Checkpointing a 67MB WAL fat with log churn on a busy daemon is
   precisely the known backup-deadlock shape. Excluding the logs DB shrinks both the checkpoint
   and the read. Backup *size* is already fine (`VACUUM INTO` emits a compacted copy) — **the
   win is lock duration, not bytes.** Note upstream has **no** `db-snapshot.ts`; our backup
   layer is Cue-only, so upstream gives no guidance on backing up the extra file.

**Discount these:** cross-DB correctness gets *worse* (conversation delete becomes two
non-atomic deletes), and there is no query-performance win.

### Cost — much lower than the ledger implied

**We already built the drain engine.** On **2026-08-05**, commit `9c2c049553`
("split high-churn memory tables into a dedicated assistant-memory.db") landed
`assistant/src/memory/migrations/memory-db-relocation.ts` plus **five** shipped relocations
(324–328), explicitly described in its own header as a "design port of upstream
vellum-assistant's memory-DB cutover — 342929dfba, b593de8041, 2b70d1d246 — onto our
step-list migration runner" [tree]. Migration **326** already moved
`memory_v2_activation_logs`, which that file calls "historically the single largest driver of
assistant.db growth (~100KB+ per row)".

So this is not novel engineering. It is one more `RelocatedTableSpec` pointed at a third file.
And our `llm_request_logs` schema is **column-identical to upstream's**
(`assistant/src/memory/schema/infrastructure.ts:179-201`) [measured], so the spec ports 1:1.

**~10–13 non-test files, no gateway changes:**

- NEW `assistant/src/util/logs-db-path.ts`
- `assistant/src/memory/db-connection.ts` — our `getMemoryDb()` (`:145-179`) is simpler than
  upstream's generic `openDedicatedDb`; needs generalizing to a third slot
- `assistant/src/memory/llm-request-log-store.ts`, `llm-request-log-source.ts`
- `assistant/src/memory/job-handlers/cleanup.ts` — **and** `pruneConversationsCore`'s
  `DELETE FROM llm_request_logs WHERE conversation_id = ?`, currently inside the main-DB
  transaction, must move cross-DB exactly like the existing `purgeConversationMemoryTables` call
- `assistant/src/memory/conversation-crud.ts` (incl. the wipe at `:2358`)
- `assistant/src/backup/db-snapshot.ts` — decide whether to snapshot the logs DB
  (**recommend not**; that is where the backup win is)
- `assistant/src/memory/db-maintenance.ts`, `assistant/src/cli/commands/db/status.ts`
- NEW migration + registry entry

**Migration: yes, and renumber.** Upstream's is `297`; our max is
`330-ritual-snapshots.ts`, so ours becomes **331**. **Do not merge upstream 297 as-is** — it
lives in a different directory (`assistant/src/persistence/migrations/`) under the memory
relocation we do not adopt.

### What Manav would have to do

- **Run the freelist query above first.** If it is mostly free pages, ungating VACUUM is the
  cheaper fix and the split can wait.
- **No downtime, no config change** for the split itself. The rename is instant; the drain runs
  in batches on a background boot step.
- **Take a backup first** — the drain is a non-atomic cross-DB copy.
- **Check free space on `/workspace` before the first boot on the new image.** At 380 KB/row
  the drain is potentially hundreds of MB of subprocess I/O, and `/workspace` has a documented
  history of filling to 100%.

### Never-adopt hazards

- Upstream migration `297` and everything under `assistant/src/persistence/migrations/` — that
  is the memory-relocation directory move. Renumber to 331 in **our** directory; never merge.
- Their `telemetry_events` split (migrations 327–334) collides head-on with our 327/328.

---

## 4. Memory map — what next

### The honest headline

**It is built, shipped, reachable, and not flag-gated. There is no plan to finish, because
the "phases 3-4" previously cited never existed.** The ledger already established that
(`upstream-ledger-2026-08-16.md:297` — "Ill-defined — do not schedule it"). This section
does not reconstruct a roadmap. It surveys what is there and offers three options, one of
which is "do nothing".

### What exists [tree]

- Renderer: `apps/web/src/domains/intelligence/components/concept-graph/concept-graph-view.tsx`,
  **1,736 LOC**; the whole suite (`build-force-layout.ts`, `concept-detail-panel.tsx`,
  `concept-graph-legend.tsx`, `detect-clusters.ts`, `recency-lens.tsx`, …) is **~3,501 lines**,
  landed in one commit `eb70c146f5`.
- **Not a 3D library.** Hand-rolled: deterministic 3D force layout projected via yaw/pitch
  onto a 2D `<canvas>` at 60fps with depth alpha. No three.js, r3f or force-graph anywhere
  in `apps/web`.
- **Reachable in three clicks:** rail → *What Cue knows & sees* → **Memory**
  (`components/nav/your-cue-model.ts:186`, route `routes.tsx:1391`), then the **List ⇄ Map**
  SegmentControl at `memories-page.tsx:413` (default `list`).
- Gated by a *capability* bit, not a feature flag: `graph_supported` from `GET /memory/stats`,
  which in our fork is exactly `tier === "v2"`
  (`assistant/src/runtime/routes/memory-graph-routes.ts:53-59`). The old
  `memory-concept-graph` flag was removed and had been on everywhere.
- **Desktop only.** Mobile swaps to `apps/web/src/mobile-v3/memory/mv3-memory-page-v24.tsx`,
  which has no map.

**What it reads:** `GET /v1/assistants/{id}/memory-graph` →
`assistant/src/memory/graph-topology/build-memory-graph.ts`. **Not a table** — it walks the
markdown concept pages at `memory/concepts/*.md` plus their authored `links:` / `[[wikilinks]]`,
plus unconsolidated `memory/buffer.md` facts as `pending` nodes.

**Interactive:** orbit-drag, scroll zoom, name search with fly-to, All/Month/Week recency
lens, legend toggles, cluster colouring with hub labels, hover neighbourhood highlight, click
→ detail drawer, and two footer buttons that prefill a chat. **No edit, no delete, no pin from
the map** — those live only in the List view.

**Genuinely dead code, flagged honestly** [tree]: `createMemory()` and
`invalidateMemoryQueries()` have **zero callers**; the `handleRef` fly-to-node handle and
`onToggleFullscreen` are never passed by `memories-page.tsx`, so the fullscreen button never
renders; `memory-telemetry.ts` is a deliberate **no-op stub**.

### Theirs vs ours

**Upstream has the same map — ours is a direct port of it — and it is upstream's *only*
memory UI.** They have no list, no table, no timeline; their `MemoryItem` type still exists
but nothing imports it, a fossil of a removed list view. Their `concept-graph-view.tsx` is
1,747 lines vs our 1,736 — essentially the same file. [up]

**They can, we cannot** (four small things): add a memory from the map via
`create-memory-modal.tsx` (we ported the client call and left it uncalled); explain an
unavailable graph and offer the fix via `memory-upgrade-prompt.tsx` (**deliberately** not
ported — the migration skill it seeds does not exist in our fork, so this is a correct
adaptation, not a gap); fullscreen; real telemetry.

**We can, they cannot** (rather more): the whole provenance **List** view (`memories-page.tsx`,
1,101 LOC — 8 memory kinds, server-side counts, search, confident-only filter, inline **edit**
and **forget**) which upstream deleted; **"applied N times"** (`memory-item-routes.ts:162`,
migration 329) with no upstream equivalent; a mobile memory screen; ChatGPT memory import.

**Net: on the map itself we are ~4 small affordances behind; on memory UI overall we are well
ahead.**

### The one inert lane — and why it is the cheapest real option

The renderer **fully** styles `kind: "learned"` edges — colour, hover copy "Learned
association", legend toggle, density fog — but the endpoint never builds a learned adjacency.
The code says so itself:

```
assistant/src/memory/graph-topology/build-memory-graph.ts:276-283
// The graph surfaces only authored `link` edges; learned (co-selection)
// associations are intentionally omitted here. assembleMemoryGraph accepts an
// optional learned adjacency, but this endpoint does not build one (the
// learned graph needs a DB handle; see memory-v3-shadow/learned-edges.ts).
```

And `computeLearnedEdgeGraph` **already exists and already runs** in the retrieval path
(`assistant/src/plugins/defaults/memory-v3-shadow/learned-edges.ts:90`, with tests). Verified
both ends directly [tree]. The gap is one DB handle.

### Signals that exist in data but are not on the map [tree]

**Slug-keyed — same id space as the map's nodes, directly joinable:**

| Signal | Where |
|---|---|
| `memory_v3_selections(conversation_id, turn, slug, source, pinned, created_at)` — every time a concept was actually selected into context | migration `268`, written live at `memory-v3-shadow/shadow-plugin.ts:465` |
| `memory_v3_auto_edges(source_slug, target_slug, weight, last_reinforced_at)` — learned association strength | migration `263` |
| `memory_v3_coactivation`, `memory_v3_ever_injected` | migrations `262`, `277` |
| Page frontmatter `source:` (`import:chatgpt`, `import:fathom`), `origin_date`, `current`, `tags`, `status`, `leaves` | `assistant/src/memory/v2/types.ts:60-81` |
| `PageIndexEntry.freshAt` (origin-date-aware recency) | `assistant/src/memory/v2/page-index.ts:72` — the map's recency lens uses raw file `modifiedAt` instead, so **every imported page reads as "this week"** [inf, but the code path is unambiguous] |

**Node-id-keyed — the List view's id space, NOT joinable to the map:** `accessCount`
(migration 329), `confidence`, `importance`, `fidelity`, `stability`, `reinforcementCount`,
`emotionalCharge`, `sourceType`, plus stored-but-unexposed `source_conversations`,
`last_reinforced`, `event_date`, `memory_graph_edges.relationship`
(`contradicts`/`supersedes`/`caused-by`), and node-edit history.

**Do not conflate the two id spaces.** The applied-count commit `39c8cfcf9d` says so in its
own body: counting is keyed by graph node id, not by concept-page slug, "a different id space
with no join to it" — and with `memory.v2.enabled` (our shipped default) graph nodes are never
injected, so **`accessCount` reads zero in prod today**. `docs/decisions-2026-08-16.md` §5
frames this as an open product call. Any proposal to "put applied counts on the map" is
blocked on exactly that.

### Three options

**Option A — turn on the learned-edge layer. (S/M)**
The map stops showing only what it was *told* and starts showing what it *does*: pages that
keep getting used together. Everything already exists — the data (`memory_v3_selections`), the
computation (`computeLearnedEdgeGraph`, live and tested), and every pixel of the rendering.
**Touches ~2 files** (`build-memory-graph.ts`, `memory-graph-routes.ts`) plus tests. Depends
on nothing new. Highest ratio of visible change to risk of anything in this document.

**Option B — slug-keyed usage on the map. (M)**
Add `selectionCount` / `lastSelectedAt` per node from `memory_v3_selections` and size or dim
nodes by it. **This is the honest version of "applied N times" for the map** — same id space,
real historical data, no backfill problem, no id reconciliation. Touches graph-topology types,
the builder, the route, the generated SDK, and the renderer's size mapping. Depends on
agreeing that "selected into context" is what "used" means. **Verify first:** `weight` is
currently degree and drives truncation ranking, so adding a second scalar means deciding which
one sizes a node.

**Option C — do nothing; it is a design question. (zero code)**
The map is finished and reachable. The four things upstream has that we lack are one modal,
one prompt we deliberately declined, one button, and a telemetry stub. The honest position is
that **what it should do next is a question for Manav about what he wants to see, not an
engineering backlog item.** If he wants a cheap win without a product decision first, Option A
costs almost nothing.

**Not proposed, and why:** anything using `accessCount`, `confidence`, `importance`,
`supersedes`, or per-memory provenance **on the map** — all node-id-keyed or unexposed, and
blocked on the id-space decision in `decisions-2026-08-16.md` §5.

### Never-adopt hazards

- **Their memory relocation.** Upstream memory lives at `assistant/src/plugins/defaults/memory`;
  ours stays at `assistant/src/memory` (ledger:336, confirmed still divergent). Merging it
  breaks every import path in the tree. Our own `memory-graph/types.ts:7` docblock already
  points at the upstream path — a harmless live artifact, and a good illustration of how the
  relocation leaks.
- **The v3 tier gate.** Upstream gates the graph on `isV3TierActive`. We deliberately gate on
  memory-v2 because we run v2 + v3-shadow over the same concept tree. **Blindly taking any
  upstream change to `isGraphSupported` ships the map dead in our fork.** Upstream's
  `ed4a99ba8d` and `aae860e85a` are in that blast radius.
- **Migration numbering.** Ours 328–330; upstream persistence **366**, in a different
  directory. Never merge migration files; renumber. Upstream renumbers before merge, so a
  migration number quoted in upstream commit prose is untrustworthy.
- Not a hazard, a closed item: upstream's memory-buffer trio (`f8dd56b2e8`, `9b473bf88d`,
  `e1f0f78619`) is **already ported** (ledger:105-106). The buffer feeds the map's `pending`
  nodes, so that path is current.

---

## Recommended order

Ordered by *cost-to-value*, and by what unblocks what. Two of the four are not really
engineering items at all, which is the main finding of this document.

### 0. Before anything: one read-only query on prod (minutes)

Run the `freelist_count` / `dbstat` query from §3 against the live `assistant.db`. It is
read-only, it takes seconds, and it decides whether the 701MB is real data or un-reclaimed
free pages. **If it is free pages, the fix is ungating VACUUM — a config change — and item 2
below shrinks dramatically.** Doing item 2 without this risks building the right machine for
the wrong problem. This is the single highest-value action in the document.

### 1. Memory map → Option A: turn on the learned-edge layer (S/M)

**First because it is nearly free and needs no decision from anyone.** The data exists, the
computation already runs in the retrieval path, and every pixel of the rendering is already
written and tested. The gap is a DB handle in one route. ~2 files. It also converts a visible
piece of inert UI (a legend toggle that can never do anything) into a working one.

The rest of the memory-map question is **not** an engineering item — see §4 Option C. Do not
schedule Option B until Manav has said what he wants the map to *mean*.

### 2. Logs-DB split (M, contingent on step 0)

**Second because the engine already exists** — we shipped the relocation machinery on
2026-08-05 and this is one more spec pointed at a third file — **and because it is the only
one of the four that touches a live operational problem** (a 67MB WAL, a backup that
deadlocks). But it is contingent: if step 0 shows free pages, do the VACUUM fix first and
re-time this.

Note the honest framing: this is a **WAL-contention and backup-lock** fix that also helps
size, not primarily a size fix. Sell it that way or it will look like it failed.

### 3. Teleport → option B: a local-transport teleport (S/M)

**Third because it is genuinely wanted but the shipped version does not fit us.** Do not port
what upstream has; build the thin thing. The runtime routes (`/v1/migrations/export`,
`/v1/migrations/import`) already exist and already work without a platform token — `backup` +
`restore` prove it today. What teleport adds that is worth having for one owner is the
*orchestration*: hatch the target, keep the source alive, verify, then switch and retire.
CLI-only, no `apps/web` changes, no account for Manav to create.

Optionally fold in the ~90-line CLI catch-up (option A) at the same time.

**Explicitly do not** port the web card until someone has answered what a self-hosted
destination model looks like. As written it offers only managed↔local and errors
`no_organizations`.

### 4. Discord (M–L)

**Last, despite being the most straightforward port**, for three reasons:

- It is the only one of the four requiring **Manav to create a credential** (a Discord app +
  bot token). Nothing else in this list has an external dependency on him.
- It is the **largest** true delta — ~1,100 lines transfer near-verbatim but the glue touches
  11 of our files across `gateway/` and `assistant/`, both of which other sessions are live in.
- It is the only one that **adds a new inbound attack surface**. Everything else is internal.

None of that is an argument against doing it — the code is good, the admission polarity is
correct, the intents are unprivileged, and no migration is needed. It is an argument for doing
it when the tree is quiet and with the two upstream privacy regression tests ported alongside.

### Why not the other order

Discord is the most *legible* win and the temptation is to lead with it. Resist that: it is
the item most likely to collide with the four live sessions, and the only one gated on an
external account. Conversely, the memory map looks like the biggest item and is actually the
smallest — because it is already built.

---

## Consolidated never-adopt list

Standing hazards, re-verified against our tree for this document. **None of the three named
hazard commits are ancestors of our HEAD** [tree, `git merge-base --is-ancestor`].

| Item | Status | Note |
|---|---|---|
| `ca2b5a122e` — voice sensitive-tool gate | **Not in our tree.** Absent: `grep VOICE_APPROVAL_TIMEOUT_MS` returns nothing [tree]. | **Nuance worth recording:** the commit is *net-tightening* — it closes a hole where `isGuardian` alone cleared every voice confirmation. The hazard is two lines inside it: `const VOICE_APPROVAL_TIMEOUT_MS = 45_000` and a fallback that resolves the request as **`"allow"`** on timeout ("Voice approval timed out — falling back to the guardian allow") [up]. If we ever want the good half, take it **without** the timeout branch. Do not dismiss the whole commit as bad, and do not take it whole. |
| `9efc65cea1` — plugin-ingress approval exemption | Not in our tree. | Serves `signer: "vellum"` routes without approval. Plugin ingress is deferred anyway. |
| `bd2aa0b1eb` — channel permission cell lifts the sensitive-tool floor | Not in our tree. | Lets a room's Relaxed/Full setting lift lane A for a non-guardian. This is the second axis described in §2 that we deliberately do not have. **Do not port it with Discord.** |
| WorkOS / SaaS coupling | Live risk in **Teleport** only. | `fetchOrganizationId`, `useOrganizationStore`, `platformOrganizationId`, `assistant_api_key` injection. §1. |
| Migrations ≥103 / gateway m0007+ | **Live and consuming.** Ours: memory/assistant **330**, gateway **m0004**. Upstream: persistence **366**, gateway **m0017** [tree/up]. | Gateway m0005–m0017 are largely the assistant→gateway table relocation (verification sessions, guardian requests, ingress invites) — the multiuser work. Renumber, never merge. Upstream renumbers before merge, so a migration number quoted in upstream prose is untrustworthy. |
| Their memory relocation | Confirmed still divergent. | Upstream memory is at `assistant/src/plugins/defaults/memory` and migrations at `assistant/src/persistence/migrations`; ours stay at `assistant/src/memory`. Affects §3 (migration 297) and §4. |

---

## What I could not determine

Listed plainly rather than papered over.

- **The composition of the 701MB prod `assistant.db`.** It is on Fly and was not touched. No
  local copy over 100MB exists. Everything in §3 about table shares is extrapolated from a
  stale 51MB local copy. The freelist query in step 0 is what closes this.
- **The `cloud` value on Manav's live lockfile**, and therefore whether upstream's teleport
  card would render at all on his instance. Reasoned as `"other"` → hidden, marked [inf].
- **Whether `skills/vellum-oauth-integrations/references/provider-app-setups/discord.md`
  (122 lines) is a separate, older OAuth-connector Discord path** that would conflict with the
  bot-token one. It looks separate. Not read.
- **Whether the Discord guardian-notification path needs a rate limit** before facing a public
  guild. The mechanism is confirmed (§2); the severity depends on server size and was not
  modelled.
