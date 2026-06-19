# Cue — Design Handoff (for Claude Code / production)

High-fidelity reference designs for the Cue app. These are the **visual + interaction
source of truth** — build the real app to match these screens.

## How to open
- Start at **`Cue Design Book.dc.html`** (project root) — the index of every surface, grouped by tier. Open it in a browser; click any card to open that screen.
- Every screen lives in **`surfaces/`** as a self-contained `.dc.html` file and opens directly in a browser. No build step, no server.
- `support.js` (root + surfaces) is the tiny runtime the files load. Keep it alongside them.

## What these files are
- **Design Components** — streaming HTML files. Each is one screen with inline styles only.
- Interactive states are real: where a screen has a state switcher (top-right pills), click to toggle (e.g. Chat New/Acting/Streaming/Error, Memory Ready/Loading/Empty/Error, Connector detail Permissions/Connection-issue). The Directory tabs and Home feed actions are live too.
- Treat them as **design intent**, not production code — rebuild in your real stack; copy the exact tokens, type, spacing, copy, and layout.

## Design system (copy these exactly)
- **Color** — ink `#1A2230` / `#24303F`; primary blue `#3D6EE8` (`-strong #2B53C4`, `-wash #DBE4FB`); violet `#7F77DD` (`-strong #534AB7`); success green `#277E41` (success only — never a memory type); amber `#C98A1B`; danger `#DA491A`. Neutrals: bg `#F4F6F9`, surface `#FFFFFF`, sunken `#EEF1F6`, lines `#E5E9F0` / `#D7DDE7`. Text `#1A2230` / `#5A6672` / `#8D99A5`.
- **Type** — DM Sans (UI), DM Mono (labels/timestamps/meta), Instrument Serif (editorial "moment" headlines, used sparingly).
- **Brand** — the `C` monogram with the blue pupil dot; the living "aperture" avatar (idle look-around + blink + ping) used in headers and heroes.
- **Motion rule** — animation comes from genuinely dynamic elements (avatar, count-ups, slide-on-action, live pulses), never from template entrance animations. Everything is `prefers-reduced-motion` safe.

## Surface map (in `surfaces/`)
**Core**: Home · Impact · Chat · Memory · Contacts
**Intelligence hub (About Assistant, 8 tabs)**: Identity · Connectors · Channels · Agents · CueLive · Skills · Memory · Workspace
**Trust & discovery**: ConnectorDetail (per-tool permission matrix + connection-issue) · Directory (marketplace) · SkillDetail
**Settings**: Settings (General template + Voice / Privacy / Devices / Billing)
**Catalog & data**: Library · LibraryDetail · Plugins · Documents · Logs
**Onboarding & auth**: Onboarding (incl. hatching state) · Account
**Desktop**: ElectronPanels (quick-input, command-palette, dictation-overlay, about, bundle/confirm)
**Explorations (reference only)**: Home Options (5 directions) · Home States (empty/loading/error)

## Key interaction principles baked into the designs
- **Moment surfaces vs working surfaces** — Home, Impact, Onboarding, empty states get the editorial lead + warmth + motion; dense working/config surfaces (Settings, Logs, Documents, permission matrix) stay calm.
- **Trust model is per-tool** — read-only tools default "always allow"; write/delete default "ask"; high-impact default "never." Stop always wins. See ConnectorDetail.
- **Value is surfaced** — Home shows hours-saved; Impact is the weekly recap; Connectors/Skills frame "connect/create more = unlock more."
- **One memory, every channel** — the assistant recognizes the user across voice/email/Slack/etc; provenance (SourceTags + confidence) is shown wherever memory appears.

## Notes
- All copy/data is representative demo content — swap for real strings.
- Mobile/device framing exists for Onboarding/Account (440×630); the rest are desktop (~1280px in a window chrome).
- No external dependencies beyond Google Fonts (DM Sans, DM Mono, Instrument Serif).
