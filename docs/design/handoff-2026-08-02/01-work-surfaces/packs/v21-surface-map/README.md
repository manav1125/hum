# v21 — the real surface map (2026-08-02) · corrects v20

## What I got wrong
I consolidated on **label similarity** — "skills, plugins, tools, marketplace all sound like capabilities" — without reading what each does. They're four distinct objects with four lifecycles:

- **Skills** — 98 behaviours, categorised, create-your-own from chat
- **Plugins** — 10 packages *pinned to a commit*, reviewed, uninstallable; adds tools, hooks and app surfaces
- **Marketplace** — 1,288 installables across 7 GitHub sources with per-source curation
- **Tools & Apps** — 500 connectors with live health ("working ✓ just now")

**Withdrawn from v20:** Plugins→Skills · Marketplace→sub-tab · Cue Live→composer mode (it has Look/Point/Take control/Stream, two macOS grants and a streaming banner — a subsystem, not a mode) · Connections→delete (it's per-person channel *verification* — guardian profile, verified Slack ID, revoke).

## The actual duplication — two shells, one idea
About Assistant and Settings grew separately. **Four concepts live in both:**

| About Assistant | Settings | Resolution |
|---|---|---|
| Tools & Apps · 500 connectors | Integrations · same list | One page: **Connectors** |
| — | Guardrails · Permissions & Privacy | One page: **Guardrails** (checkpoints + agent scopes + autonomy + trust rules). System grants stay separate — macOS, not policy. |
| Workspace · file tree | Archive | One page: **Workspace**, archive as a filter |
| (Usage standalone) | Budget & Spend | One page: **Usage & spend** |

**That's −4 pages from 22, not −14.**

## Your Cue — one shell, 18 leaves, 5 groups
- **Who Cue is** — Identity · Brand
- **Who works for you** — Agents · Skills (98) · Plugins (10) · Marketplace (1288) · Connectors (9/500)
- **How Cue reaches you** — Channels · Agent network (A2A) · Cue Live
- **What Cue knows & sees** — Memory · Watching
- **What it does alone** — Schedules · Guardrails · System access
- **Running Cue** — Models · Usage & spend · Workspace · Preferences

App sidebar keeps its five rows (Talk to Cue · HQ · Work — People · Library — Your Cue); the depth lives in Your Cue's own left nav.

## Kept from earlier rounds
- **The accumulation test holds for the sidebar** — People and Library accumulate, so they're destinations. What was wrong was applying it *inside* the config shell to justify merging distinct registries.
- **Intelligence → Your Cue** rename still right.
- **Depth is fine; duplication isn't.** 18 leaves in one shell is honest for a product this large.
