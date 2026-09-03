# Cue Learn — Design Brief, Round 2

**Owner:** Manav Gupta · **Follows:** `cue-learn-design-brief.md` + your v1 handoff (`learn-handoff/`) · **Same seams:** tokens · assets · copy · **Same ground rules** (both themes, 12 locales, no structural rebuilds, never rename plumbing).

Round 1 is accepted and going in as a **toggleable front-end layer** — nothing you locked changes. This round covers (a) the three surfaces you flagged as not-yet-designed, (b) surfaces the product grew *after* the first brief, and (c) small defects in the v1 files to correct at source.

---

## A · Carried over from round 1 (you flagged these)

### R2-1 · S7 — Chrome connective tissue — **P1**
Learn's doorways inside Cue, now MORE visible than when first briefed (a mobile drawer row shipped):

- **Desktop sidebar row** and **phone ☰ sheet row**. The phone row today reads "Learn — Your interactive courses" (engineering placeholder — replace it). Rows need: glyph (the violet-period mark family at ~18px), label, and sub-line copy. German +30%.
- **Ask Cue button** in the classroom header (hops from a lesson back to chat with a prefilled question). Treatment + label.
- **Doorway transition**: what entering/leaving Learn feels like (fade/slide spec, CSS-achievable, reduced-motion variant).

### R2-2 · S8 — Quiz / PBL / simulation feedback — **P2**
Component states on top of the v1 token sheet: option rest/hover/selected, correct (uses `--cl-success` — see D-2), incorrect, "reveal answer", progress-through-quiz, end-of-quiz summary line. Copy voice per the state-pack rules: the fact, one useful detail, one CTA, no cheerleading.

### R2-3 · S9 — PPTX master — **P2**
Title, section, content, quote and closing layouts; mark placement; the paper (#F3EEE4) slide ground from the Homeroom voice. Ships as `.pptx`. This is the brand's travel document.

### R2-4 · Final cast illustration — **P2**
Mira, Nova, Felix, Juno, Pip to final art, same paths/names/64×64 self-clipped circle contract as the placeholders. Add one **spare classmate** (bench depth for future modes).

---

## B · New surfaces since the first brief

### R2-5 · Course chip in chat — **P1 (most-seen new surface)**
Cue's chat now *tutors from* courses: it builds them, quizzes from them, and links to them mid-conversation. Today a course renders as a bare markdown link. Design a **course chip**: compact inline card — mark or ◆, serif title, `{N} SCENES · {M} MIN` mono meta, optional "BUILDING · NN/NN" state (gold, per your S6 grammar), tap = opens the classroom. Must sit comfortably in Cue's chat stream on desktop and phone, both themes. Reuse the cover grammar; this is its smallest size class.

### R2-6 · The workbench (`/learn/workspace`) — **P3**
The Pro editing surface where wizard-made courses are built (outline editor, scene list, agent runtime panels). It inherits the S2 tokens automatically; what it needs from you is a **pass, not a redesign**: confirm the token mapping reads well on dense editor chrome, and specify any exceptions (e.g. mono-first tables, tighter radii). Deliver as notes/redlines on screenshots we'll provide.

### R2-7 · Byline + building covers, data-complete — **no design needed, FYI**
"TAUGHT BY MIRA" and the building-state cover are designed; engineering is plumbing teacher + progress data to the Library cards. Nothing to do unless you want to adjust once you see it live.

---

## C · Defects in the v1 package to fix at source

- **D-1 · Wordmarks carry live `<text>`** (your own ⚠). In-app is safe (DM Sans is loaded) so we're shipping them there, but exports/favicons/cold contexts will fall back. Deliver **outlined-to-paths** `wordmark.svg` + `wordmark-reversed.svg`, same names.
- **D-2 · Dark-theme semantic colors missing.** `--cl-success / --cl-warning / --cl-danger` aren't re-specified for dark; `#F4BF50` on navy needs a contrast check. Extend both token files.
- **D-3 · Mode names don't map.** "LECTURE · SEMINAR · QUICK TAKE" vs the product's actual modes (interactive mode on/off, task-engine mode). Either map three labels onto real states or give us two labels + a length-suffix pattern ("QUICK TAKE" as a duration preset is fine to drop).
- **D-4 · PRO pill** — decision taken: **it dies** under the new identity (the family system replaces it). No asset needed; noted here so v2 comps don't include it.

---

## Deliverables checklist

| # | Deliverable | Format |
|---|---|---|
| R2-1 | Row glyph + labels/sub-lines (EN masters), Ask-Cue treatment, doorway motion spec | SVG + copy + CSS-achievable spec |
| R2-2 | Quiz state sheet + copy | Figma states + copy doc |
| R2-3 | PPTX master | .pptx |
| R2-4 | Final cast (6 files) | SVG / PNG @2x, same contract |
| R2-5 | Course chip (desktop + phone, light + dark, built/building) | Figma + redlines |
| R2-6 | Workbench token-mapping notes | annotated screenshots |
| D-1 | Outlined wordmarks | SVG |
| D-2 | Dark semantic tokens | patch to cue-learn.css/.json |
| D-3 | Mode-label mapping | one-paragraph decision |

Engineering wires everything; nothing here requires touching code. Screenshots of every live surface (including the new theme layer running) available on request.
