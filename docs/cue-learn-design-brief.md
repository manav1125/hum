# Cue Learn — Design Brief (v1)

**Owner:** Manav Gupta · **Surfaces:** 10 · **Ship seam:** tokens · assets · copy · **Themes:** light + dark, both real · **Locales:** 12

Cue Learn is the interactive-classroom surface inside Cue: say "teach me X" and it builds a narrated course with slides, a voiced teacher, classmates, quizzes and simulations. It works end-to-end in production today — on web, desktop and iOS — but it still *looks* like the open-source project it was grown from. This brief lists every surface where design can make it unmistakably Cue, and draws a hard line around what must not move.

---

## Why the line matters

Cue Learn is a maintained fork of a very active upstream project (~1,300 PRs). We deliberately keep our patch surface tiny so upstream improvements keep flowing to us monthly. Design therefore lands through three **merge-safe seams**, and almost never through structural edits:

| Seam | What it carries | Practical meaning for design |
|---|---|---|
| **Token layer** | One CSS custom-property sheet: colors, radii, type ramp, shadows, both themes | You can re-skin essentially the whole product by specifying token values. This is the highest-leverage deliverable in this brief. |
| **Asset layer** | Logo, mark, favicon, avatars, cover art, illustrations, PPTX master, sounds | Drop-in files. Same names, new art. Zero merge risk. |
| **Copy layer** | Display strings across 12 locales; brand name already swept to "Cue Learn" | Tone-of-voice changes are welcome; specify in English and we handle locale propagation. |

Anything requiring new components or moved layout is possible but costs us on every upstream merge — flag those ideas separately rather than baking them into the core direction.

---

## What exists today

An honest snapshot, so you know the starting line:

- **Identity:** a placeholder wordmark + mark generated in code — navy roundel, blue diamond, violet tassel, echoing a mortarboard. Functional, not loved. The header today renders the wordmark beside a leftover upstream "PRO" pill.
- **Color:** the app still runs upstream's palette — primary `#722ED1` (a purple that belongs to no Cue surface), near-white ground, shadcn-style radius ramp.
- **Type:** Geist Sans / Geist Mono via a font seam we control. Cue's own voice elsewhere is a serif display (Instrument Serif) with DM Mono labels over deep navy.
- **Cast:** the teacher and classmates use upstream's stock avatar set (generic PNGs/SVGs — "clown", "coder", "dreamer"…). This is the most visible non-Cue element in every single classroom.
- **Cue-side cards:** in Cue's Library, courses already have a branded cover treatment (navy ground, violet ◆ glyph, "Course" badge, real first-slide art when it exists) — designed by us in-app, and a useful anchor for the wider system.

### Cue brand anchors already in play

| Hex | Role |
|---|---|
| `#1A2230` | Cue ink / navy ground |
| `#3D6EE8` | Cue blue · action |
| `#7F77DD` | violet · Learn accent |
| `#C99A4E` | gold · covers, Deck kin |
| `#F3EEE4` | warm paper on covers |
| `#722ED1` | upstream purple — **to retire** |

Type anchors: **Instrument Serif** (display), **DM Mono** (labels, dates, data). Whether Learn adopts these wholesale or earns a sibling voice of its own — lighter, more daytime, more "classroom" — is genuinely open, and the most interesting call in this brief.

---

## The surfaces

### S1 · Identity — logo, mark, icon — **P1**

A real Cue Learn identity: clearly a member of the Cue family (the C-and-dot lives next door), clearly the *learning* one. The current mortarboard-diamond is a sketch to react against, not a direction to keep. Needs to hold up at 16px favicon, in the app header beside the wordmark, and as a square mark on course exports.

- **Design freely:** wordmark + standalone mark + favicon + monochrome variants; light-ground and dark-ground versions; whether "PRO" deserves a designed treatment or dies.
- **Hands off:** the name is **Cue Learn** — set, swept through 12 locales. File contract: ships as SVG at existing asset paths.

### S2 · Token system — color & type — **P1**

The single highest-leverage deliverable: a full token sheet that retires upstream purple and gives Learn a considered palette in **both themes**. The classroom is a daytime, content-forward surface — it likely wants a lighter hand than Cue's deep-navy HQ, while still reading as the same family when you cross the doorway between them.

- **Design freely:** complete palette (ground, surface, primary, accent, semantic states, focus ring — light and dark); type (display / body / mono choices and the ramp — we can swap the loaded families); radius + shadow language (upstream is rounded-everything; feel free to disagree).
- **Hands off:** deliver as token values, not component redesigns; WCAG AA contrast on body text in both themes; fonts must be self-hostable (no external font CDN at runtime).

### S3 · Learn home & composer — **P1**

The first screen: wordmark, a one-line promise ("Generative Learning in Multi-Agent Interactive Classroom" — upstream's words, not ours), three example prompts, the teacher/classmate picker, and the "Enter Classroom" composer. This is Learn's storefront and deserves a hero moment: the composer *is* the product.

- **Design freely:** hero composition, tagline copy, example-prompt curation (make them Cue-flavored: fundraising, product, ops); composer styling, mode chips, mic affordance; recent-courses shelf treatment (ties into S6).
- **Hands off:** element inventory stays (picker, mode toggle, composer, recents) — restyle, don't remove. The "Set up model" badge is an engineering bug, already on our list — don't design around it.

### S4 · The classroom & its cast — **P1**

Where learners spend 95% of their time: full-screen slides, a voiced teacher, classmates who ask questions, subtitles, playback controls. The stock avatar set is the loudest off-brand note in the product. We want a **designed cast** — a teacher and 4–6 classmates with names, faces and personality that feel native to Cue's world, consistent from picker thumbnail to in-class bubble. Illustration, not stock; a system, not one-offs (the cast must survive new members).

- **Design freely:** the cast — art direction, names, expressions/poses per character; subtitle & speech-bubble treatment; playback control bar; whiteboard frame; slide chrome defaults (safe margins, heading treatment) via tokens.
- **Hands off:** slide *content* is generated per course — design the frame, not the slides. Media weight: classroom assets must stay light; it streams voice in real time.

### S5 · Generation theater — **P2**

A course takes 2–6 minutes to build. Today that's a plain progress readout; it should be Learn's signature moment — the curriculum assembling, scene count ticking up, the cast "preparing the room." One well-orchestrated sequence beats scattered spinners. Motion spec welcome (CSS-achievable; respects reduced-motion).

### S6 · One cover system — **P2**

Courses appear as cards in three places: Learn's own recent shelf, Cue's Library (where we already ship a navy/violet ◆ "Course" cover with real first-slide art when available), and soon anywhere work is shared. Design one cover grammar all three use: how a course with slide art looks, how one without art still looks intentional, badge/type/date treatment. Extends the existing Library cover family (Site, Deck, Dash, Doc, Video, App) rather than replacing it.

### S7 · Learn inside Cue's chrome — **P2**

Learn lives embedded in Cue: a sidebar row on desktop, a row in the phone's ☰ sheet ("Learn — Your interactive courses"), full-bleed surface once inside, an "Ask Cue" button in the classroom header that hops back to chat, and "From your chat" provenance tags on Library cards linking a course to the conversation that made it. Design the connective tissue: row icons, the doorway transition, how "Ask Cue" and provenance read.

- **Design freely:** sidebar / drawer row iconography and labels; Ask-Cue button treatment; provenance-tag language.
- **Hands off:** navigation structure and routes are fixed; courses open in the Learn surface, never inside Library — owner decision.

### S8 · Quizzes, PBL, simulations — **P3**

Interactive scene types: multiple-choice quizzes, project-based-learning flows, small simulations. Mostly inherit S2 tokens for free; what needs a designed opinion is the feedback language — correct/incorrect states, encouragement copy, progress-through-quiz. Specify as component states on top of the token sheet.

### S9 · Exports that travel — **P3**

Courses export as PPTX (slides subset — by design) and as a full resource pack. These leave the product and carry the brand into other people's meetings: a branded PPTX master (title, section, content layouts, mark placement) is cheap surface area with outsized reach.

### S10 · Empty, waiting, broken — **P2**

The states nobody designs and everybody meets: zero courses ("0 courses" folder card today), Learn-not-configured, session-expired redirect, generation failure, offline classroom media. Each needs the same voice: honest about what happened, one clear next step, no apology theater. Small illustration set welcome if it earns its bytes.

> **A voice, too.** The teacher speaks with ElevenLabs voice "Sarah" because that was the default. If the cast (S4) gets named characters, the teacher's voice should be chosen — or cloned — to match the character we design. Cheap to change; large effect on how "ours" a classroom feels.

---

## Deliverables

| Deliverable | Format |
|---|---|
| Logo suite: wordmark, mark, favicon, mono + reversed variants | SVG |
| Token sheet: full palette (light + dark), type ramp, radius/shadow | CSS variables or JSON |
| Cast: teacher + 4–6 classmates, picker thumbnail + in-class pose each | SVG / PNG @2x |
| Cover grammar: with-art, without-art, badge + type spec | Figma + redlines |
| Learn home composition + composer spec | Figma |
| Generation-theater motion spec | Figma / CSS-achievable spec |
| State pack: empty / error / expired copy + any illustration | Figma + copy doc |
| PPTX master | .pptx |

---

## Ground rules

- **Both themes, always.** Every color decision ships as a light and dark value. The classroom renders in whichever theme the user runs Cue in.
- **Twelve locales.** Copy changes are specified in English; German will be ~30% longer — leave room in anything with a text label.
- **Tokens and assets, not rebuilds.** If a direction needs structural component changes, propose it as a flagged extra with the merge cost named.
- **Performance is a design constraint.** The classroom streams voice and renders generated media; identity assets stay in the tens of kilobytes, not megabytes.
- **Never rename the plumbing.** Internal ids, file formats (`.maic.zip`), API headers and package names keep their upstream names on purpose — invisible to users, load-bearing for merges.

---

Working references available on request: live product at the Learn tab of any Cue instance; `docs/cue-learn-runbook.md` covers architecture; the Library cover components show the existing Cue-side card language. Engineering wires every deliverable — nothing on this list requires design to touch code.
