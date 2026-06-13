# Cue — Brand Identity

_The personal AI assistant that catches every cue and surfaces your next move._
Productivity- and business-first. Built on the forked assistant runtime; see `ROADMAP.md`.

## Positioning
- **Name:** Cue
- **Tagline:** Never miss your next move.
- **Voice:** Sharp, calm, capable. A tool that respects your time — not a chatty persona.
- **Promise:** It listens, remembers, and tells you the next action. Nothing dropped.

## Logo
Typographic system — the wordmark is the logo; there is no separate icon glyph.
- Wordmark: `cue.` set lowercase in DM Sans Medium, -3 tracking, slate ink, with a single
  electric-blue period (decisiveness: "done — next"). Source: `assets/cue/wordmark.svg`.
- App icon: a light "c" aperture (it sees and listens) with the blue period on the slate
  squircle. Font-independent so it renders identically at every size. Source: `assets/cue/icon.svg`.
- The period is always electric blue (`--accent-cue`), never green. Keep the wordmark lowercase.
- Clear space: ≥ the cap height of `c` on all sides. Don't stretch, outline, or add effects.

## Color
Single source of truth: `packages/design-library/src/tokens.css`.
Green is reserved for success semantics only — the brand accent is blue/violet.

| Token | Hex | Use |
| --- | --- | --- |
| Slate ink (`--primary-base`) | `#1A2230` | Primary text, buttons, the mark field |
| Electric blue (`--accent-cue`, `--system-info-strong`) | `#3D6EE8` | Links, active/selected, focus rings, the caret |
| Blue strong (`--accent-cue-strong`) | `#2B53C4` | Pressed/hover on accent |
| Blue weak (`--accent-cue-weak`, `--system-info-weak`) | `#DBE4FB` | Tints, badges, selection wash |
| Violet (`--accent-cue-violet`) | `#7F77DD` | Secondary accent, the dot, highlights |
| Violet strong (`--accent-cue-violet-strong`) | `#534AB7` | Violet pressed |
| Success green (`--system-positive-strong`) | `#277E41` | Success only — not brand |
| Warning amber (`--system-mid-strong`) | `#F1B21E` | Warnings |
| Danger (`--system-negative-strong`) | `#DA491A` | Errors/destructive |

Focus rings track `--accent-cue` in light and dark (`--ring`). Velvet theme keeps its own accent.

## Typography
Already bundled in the design library and the Swift client — no new fonts needed.
- **DM Sans** — UI and wordmark (weights 300–700 via variable axis).
- **DM Mono** — labels, metadata, keyboard hints, timestamps.
- **Instrument Serif** — editorial moments only (rare). Not for UI chrome.

## What this rebrand changed (Phase 1, macOS desktop)
- `tokens.css` — Cue accent palette + focus rings (propagates to macOS + web).
- `apps/macos/electron-builder.config.cjs` — `productName` → Cue; permission prompts; bundle/deep-link display labels.
- `apps/macos/src/main/*` — About panel, window/dialog/menu titles; tests updated in lockstep.

## Deliberately deferred (deep-rename phase — functional identifiers)
Renaming these requires coordinated code changes and a data migration, so they are out of
scope for the cosmetic rebrand:
- `@vellumai/*` package scope (823 files) · `VELLUM_*` env vars · `vellum.ai` domains (164 files)
- `~/.vellum` data dir + `~/.vellum.lock.json` lockfile · the `vellum` CLI binary + its dialogs
- Deep-link schemes (`vellum`, `vellum-assistant`) · `.vellum` UTI/extension · `Vellum-Organization-Id` wire header · app `appId`
