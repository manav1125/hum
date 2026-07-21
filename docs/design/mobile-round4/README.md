# Cue for iPhone — Round 4 (frames 53–64)

One self-contained file: **cue-mobile-round4.html**. Same v3 contract (SF Pro, glass over aurora, floating tab bar, Gravity ring, taxonomy is law). The HTML is the spec — inspect inline styles.

## New this round
**○ parked style** (header strip, dark + light): 12px circle, 1.5px **dashed** border rgba(154,154,168,.7) dark / rgba(90,102,114,.7) light, no fill, mono microlabel "PARKED · WAITING FOR ▶". Deliberately colorless — no state color spent on "waiting". Used in frame 58. NEW 4.1 — **queued** treatment (frame 58): solid hollow ring in faint blue rgba(127,163,242,.55) — "will run on its own", vs parked's dashed mono "waiting for you".

## Frames & decisions
- **53 Identity** — You-cluster leaf: ring-as-avatar card, grouped rows (Name / Role & personality / Voice with live 2-bar preview / Working style), each → focused edit sheet. Endpoints exist.
- **54 Shared mobile header** — the grammar (spec printed in-frame): row1 back "‹ parent" + ≤2 icon actions, 44pt min; row2 title 28/700; row3 optional scrolling filter pills w/ count on active + right-edge fade; large-title condense on scroll. Shown applied to Contacts.
- **55 Review queue index** — compact ◱ rows (title/project/age/agent), newest first; stale = 65% opacity below a mono "OLDER — LIKELY STALE" divider with amber "From Jul 4 — likely stale"; bulk hygiene = "Archive N stale" header pill (confirm sheet; archive never delete). Tap seeds the existing pager; swipe-left archive per frame-48 grammar.
- **56 Connector health** — BOTH states. A (ships now): neutral "Linked" chip + honest footnote, NO green dots. B (**NEEDS BACKEND**, flagged on-frame): green dot + last-call time; amber "Needs attention · failing since X" row; detail sheet with last-success timestamp, error honesty ("token_revoked · 214 attempts"), blast radius line, amber Reconnect CTA.
- **57 Skill detail + install confirm** — card tap → detail sheet (description, "WILL BE ABLE TO" consent rows reusing frame-30 vocabulary incl. amber ‖ ask-first line, tools/source, official/community badge); "Get" opens the same sheet with confirm card focused. No naked installs.
- **58 Mission detail** — charter in quotes (agent grammar), owning agent + cadence line, quiet ⏸ Pause chip; work items across projects keep taxonomy states incl. ○ parked; run history as sweeps, honest "no action" days. Read + pause only (alpha).
- **59 Template chooser** — 2-col grid; 96px thumbnails cropped anchored TOP-LEFT (titles live there); EXACT/INSPIRED as corner mono badge never inline with name (name gets full row, ellipsizes); footer CTA pinned over gradient fade, always "Use ‹name› →".
- **60 Today collapse** — condensed-bar frame + physics spec (in-frame, verbatim): hero 285→56px over scrollY 0–200 linear, transform/opacity only; 0–80 orbit chips fade (1→0, scale .92), rings to .3; 40–160 ring 80→30px translates to bar-left, greeting⇄"Today" cross-fade (out 40–100, in 100–160); 120–200 caption→"working on N ›", hairline+blur in. Rubber-band re-expand; reduced motion = 200ms cross-fade at threshold 100.
- **61 Usage & spend** — segmented period pills; 2-col stat tiles (tokens full-width w/ in/out); full-bleed per-day bar chart, peak highlighted + narrated caption; per-agent tinted spend bars. No horizontal overflow at 390.
- **62 Notifications** — aspirational leaf, whole frame flagged NEEDS BACKEND: category rows use the taxonomy glyphs (‖ Needs you / ◱ Review ready / ring Morning brief / @ Mentions) + quiet-hours row. Degrade rule printed in-frame: honest state is one routing line ("via Telegram/email — set up in Connections ›"), never dead toggles.
- **63 Theme control** — went with (a): ⋯ menu gets a value-preview link row "Appearance · Dark ›" → radio leaf (System/Light/Dark). (b) rejected — undo-toast theming treats the symptom, adds a timer race.
- **64 Workspace** — re-cut as a **gallery of what Cue made**, not a file list: hero card = newest artifact with real first-page preview + provenance strip ("FRESH FROM OPS", size, project, agent, blue ⇪); 2-col grid of thumbnail cards (actual doc/chart/image render, corner type chip, title + date + agent sub-line). Tap = iOS Quick Look; ⇪ = share sheet. Flat newest-50, read-only, no tree (fence in-frame). Filenames demoted to human titles. Needs the existing list endpoint + a thumbnail render (first page) — if thumbnails lag, cards degrade to the tinted type-chip block.

## Round 4.1 (reconciliation — applied in place)
- **59**: corner-badge rule formalized — badges always opaque: solid light chip on dark art, dark glass chip (rgba(10,12,18,.78)+blur+hairline) on light/busy art. Engineering treatment blessed; light-art EXACT badge now dark glass too.
- **61**: chart fixed (height:100% + flex-end, px bars); floor accepted with refinement — nonzero days floor at 6%, true-$0 days render a 2px mono hairline tick, never the floor. Labels re-lettered: "LLM calls", "By actor" + footnote (per-agent attribution NEEDS BACKEND).
- **64**: caption corrected to gallery; preview-sheet deviation blessed (in-app v3 sheet, honest "no preview for ‹type›" + Share/Download); sub-lines date · folder; hero agent provenance = target state.
- **55**: archive confirm sheet drawn (shipped copy blessed); "Archive N stale" pill hit area ≥44pt via padding.
- **60**: ring handoff blessed (150–190 opacity cross-fade to static bar ring; bar chrome owns top layer); condensed title deliberately 16/700 vs shared header 17/600.
- **58**: cadence without clock time; approval row re-lettered ◱ ready-for-review; queued row drawn; ⋯ removed.
- **53**: "Working style" row removed — it was the autonomy dial by another name; the dial lives on You root only.
- **65 (new)**: came-in undo — pill mounts in a fixed layer above the tab bar (sibling of the bar, never occluded by row animations), visible countdown, promotes per frame 47 if a sheet opens, coalesces ("2 archived — Undo").
- **C11**: batch partial failure = V3 frame 46 / HQ Filing D4 — already drawn, build to those.

## Deviations
- 62: designed quiet-hours as a row → leaf (not inline pickers) to keep the leaf one screen.
- 64: renamed "Workspace" → "Files" on mobile — the desktop word describes a browser, the phone job is retrieval.

Light: no other new colors introduced this round; all frames re-tone per the V3 README rules (parked light spec above).
