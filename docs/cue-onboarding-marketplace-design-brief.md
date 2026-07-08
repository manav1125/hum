# Cue — Onboarding, Brand Setup & Marketplace Design Brief

**Date:** 2026-07-08 · **For:** Claude Design · **Deliverable:** redesigned HTML for 3 surfaces
**Context:** These surfaces were built functionally overnight (real data, real routes, all working) but to a "works" bar, not Cue's visual bar. This pass makes them feel finished. Engineering will re-wire the redesigned markup to the live data.

**Design system:** Match the existing Cue product — the serif display headings + mono microlabels + soft cards seen in Projects/HQ (screenshots attached). Dark-on-light product chrome. The onboarding cards use a lighter, calmer treatment (see the current first-run screens). Do NOT invent a new palette; extend what exists.

**The single biggest fix across all three:** real logos, not letter monograms. Every connector/app/skill card currently shows a grey circle with a letter ("G", "C", "N", "S"). This is the #1 thing making it feel unfinished. Engineering is wiring real logo URLs (Composio provides per-app logos; skills have emoji/icon fields) — design the cards **around real 20–24px app icons** with a tasteful fallback (monogram chip) only when an icon is genuinely missing.

---

## Surface 1 — Onboarding connect-tools step ("Connect where work flows")

Current state (screenshot): STEP 3/6, "Easy connect / Custom" tabs, a search box, a 2-column grid of app cards (Gmail ✓CONNECTED, Composio, GitHub, Notion, Slack, Supabase, Outlook, Perplexity…), "470 more — keep typing to narrow it down," Continue / Skip for now.

**Design goals:**
1. **Real app logos** on every card (Gmail red envelope, Notion, GitHub octocat, Slack, etc.) — the grid should look like a real integration marketplace, not placeholders.
2. **Connected state** should feel rewarding — a clear green check + subtle card treatment, distinct from the "Connect" CTA cards.
3. **Density & hierarchy:** 470+ apps behind search — show ~8–10 popular ones by default in a clean grid, search narrows. Consider category chips (Email · Calendar · Dev · Docs · Messaging) as quick filters.
4. Keep the honest, calm copy ("Connect a few now, or skip and add them anytime"; "Nothing leaves without your say-so"). Keep Easy connect / Custom tabs.
5. This is first-run — it should feel inviting and low-pressure, every card skippable.

## Surface 2 — Brand setup step ("Set up your brand")

Current state (screenshot): STEP shown as "5/6 · BRAND PROFILE," palette swatches (primary/accent/bg/surface/text), logo on-light/on-dark/mark, type (heading serif / body sans), a "LIVE PREVIEW — same deck, in your brand" card, voice (tone, do/don't), "Save & apply everywhere."

**Design goals:**
1. This is a **strong** screen conceptually (live-preview of a deck in the user's brand is great) — mostly needs polish and logo realism.
2. **Fix the cramped logo cards** — the "QA Test Brand (delete me)" text overflows the on-light/on-dark logo chips; give logos proper containment and truncation.
3. Make the **live-preview card the hero** — it's the "aha" (your brand, applied). Consider enlarging it / making the before→after more obvious.
4. Tighten the palette + type + voice cards into a cohesive board; they currently read as separate loose cards.
5. Keep "Add another brand" + "Save & apply everywhere."

## Surface 3 — Marketplace ("Explore / Sources / Installed")

Current state: functional but plain — an Explore grid of skills aggregated from GitHub sources, a Sources tab (add/remove GitHub repos), an Installed tab. Cards show skill name + description + owner/repo attribution. (This surface isn't in the attached screenshots — it's the new "Marketplace" tab in the Intelligence/About-Assistant nav.)

**Design goals:**
1. Make it feel like a real marketplace (think VS Code extensions / shadcn registry): **skill cards with an icon, name, one-line description, source badge (owner/repo), and an Install button**; capability/consent hints (declared secrets/connectors) as small chips.
2. **Explore**: searchable grid, per-source filter chips, streaming-load skeleton states (skills stream in per source).
3. **Sources**: clean "Add a GitHub source" affordance + the 7 seeded sources as manageable rows with attribution + counts.
4. **Installed**: cards with update badges (a skill has an update available → a subtle indicator + a diff-then-confirm flow).
5. Trust cues matter — this installs third-party content; surface the "review before use" / capability-consent moment tastefully (this is a differentiator: we ship consent before competitors do).

---

## What engineering is doing in parallel (so the redesign lands on real data)
- Wiring **real Composio logo URLs** into the connect-tools route so cards render actual app icons.
- Reconciling the **HQ build-out tile counts** to match each destination page exactly (Integrations tile = Connections page's connected count; Skills tile = Skills page's headline).
- All three surfaces already have live routes + data; the redesigned markup gets re-bound to them.

## Delivery
One HTML file per surface (`onboarding-connect.html`, `brand-setup.html`, `marketplace.html`), states present as toggleable sections (connected/available, empty/loading/populated, install-consent), real-logo-first with monogram fallback. Keep field/section hooks stable so engineering can re-wire.
