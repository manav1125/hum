---
name: document-editor
description: Use whenever the user wants to write or draft ANY document or long-form content — a letter (cover letter, business/formal letter, reference, support, or application letter), memo, proposal, report, brief, essay, article, blog post, plan, statement, contract draft, story, or any multi-paragraph written piece. Prose goes into a rich text editor instead of chat or a scratch file, so it can be streamed, reviewed, edited, and exported; a presented artifact (proposal, one-pager, pitch, client report, invoice, flyer) is built instead as a designed PDF with `pdf_create`.
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "✍️"
  vellum:
    display-name: "Document Writer"
    category: "content"
    activation-hints:
      - "User asks to write, draft, compose, or prepare ANY document — a letter (cover/business/formal/reference/support/application letter), memo, proposal, report, brief, essay, article, blog post, plan, statement, contract draft, story, or any multi-paragraph written piece — ALWAYS create it in the document editor, never as a chat reply and never by writing to a scratch/temp file"
      - "User wants written content they will iterate on, review, sign, send, or export — use the editor instead of inline markdown"
      - "A file attachment contains a draft or document the user wants to revise — open it in the editor"
      - "User asks for a PDF — a report, invoice, one-pager, or an export of an existing document"
      - "User asks for a document in a specific file format — Word/.docx (especially 'so I can edit it' or 'to redline'), PowerPoint/.pptx (structured slides they can edit), Excel/.xlsx, an image/PNG to paste somewhere, HTML, or Markdown — export it with document_export or file_create"
      - "User asks for something they will SHOW someone — a proposal, one-pager, pitch, brief, client-facing report, case study, quote, invoice or flyer — build it as a designed PDF with pdf_create(html), never in the Markdown editor"
    avoid-when:
      - "The user wants an interactive app, dashboard, calculator, game, or anything with state or data — use app-builder instead"
      - "A one or two sentence answer is enough — just reply in chat"
---

Write and edit long-form documents using the built-in rich text editor. Documents open in workspace mode with chat docked to the side. When a request is about writing prose (an article, blog post, report, essay, story, or similar), create it here rather than writing it into the chat response.

## Tools

- **document_create** - Opens a new document editor with an optional title and initial Markdown content. Returns a `surface_id` for subsequent updates. This is the entry point for any new piece of writing.
- **document_update** - Updates content in an open document editor by `surface_id`. Supports `replace` (overwrite) and `append` (add to end) modes.
- **document_read** - Reads the current content of a document by `surface_id` when it belongs to the current conversation, or when the current actor is the guardian/local user. Use to verify content before editing.
- **document_find** - Searches a document for text or regex patterns. Returns matching lines with line numbers, match positions, and matched text.
- **document_replace_text** - Targeted find-and-replace within a document. Supports literal and regex patterns (with backreferences). Optionally limit the number of replacements.
- **document_list** - Lists documents. Without `query`, lists the current conversation's documents. With `query`, searches by title; guardian/local users can search across conversations, while other actors are scoped to the current conversation.
- **document_open** - Opens an existing document in the editor panel by `surface_id`. Use this when a document exists but isn't visible in the editor — for example after the user switches devices, refreshes the page, or when the editor panel was closed. Fetches the document from storage and sends it to the client.
- **document_delete** - Deletes a document by `surface_id`. Use to clean up unwanted documents.
- **document_export_pdf** - Renders an existing document to a polished PDF and delivers it as an in-chat attachment. The share/print/send path.
- **document_export** - Exports an existing document in any format: `pdf`, `png`, `markdown`, `html`, `docx` (Word), `xlsx` (Excel), `pptx` (PowerPoint). See the format table below.
- **pdf_create** - Builds a standalone PDF from self-contained HTML (or plain markdown) without creating an editable document first. This is the path for every **designed** deliverable — proposal, one-pager, pitch, brief, client report, invoice, flyer. Style it with `{baseDir}/references/DESIGNED_PDF.md`.
- **file_create** - The non-PDF sibling of `pdf_create`: a standalone `png`, `html`, `markdown`, `docx`, `xlsx` or `pptx` from markdown or self-contained HTML, without an editable document first.

## FIRST: which path — editor, or designed PDF?

Decide on the **shape of the deliverable, not its length**. This is the most
consequential choice in the skill and you make it before any other tool call.

| The deliverable is… | Path |
| --- | --- |
| **Prose** the user will read, iterate on, sign, paste or send as text — letter, memo, essay, article, blog post, plan, meeting notes, statement, contract draft, story, internal write-up | `document_create` → stream with `document_update` (the editor) |
| **A presented artifact** — something they will put in front of someone else — proposal, one-pager, pitch, brief, client-facing report, case study, quote, statement of work, invoice, flyer, menu, certificate | `pdf_create({ html })` using the house style in `{baseDir}/references/DESIGNED_PDF.md` |

**The tells for a designed PDF**, any one of which decides it: the user says "one
pager", "proposal", "pitch", "deck", "brochure", "invoice", "quote"; or says they'll
"share it with them", "send it to the client", "show the board"; or names an external
recipient organisation. "Build me a proposal for X that I can share with them" is a
designed PDF, unambiguously.

On the designed path: **read `{baseDir}/references/DESIGNED_PDF.md` with `file_read`
before writing any HTML.** It carries the tokens, the type pairing, the components
(cover, numbered sections, stat rows, pricing tables, callouts, steps, assumptions
footer) and the offline-render constraints. Don't improvise a visual system — the
whole point is that these come out looking designed rather than like a text dump.
Then call `pdf_create` once with the finished HTML. Do **not** create a document, do
**not** append eight Markdown chunks, and do **not** export the editor's Markdown as
the proposal — that path is what produces the flat text-only PDF this skill exists to
avoid.

If you started in the editor and only then realised the deliverable is an artifact,
stop, build it with `pdf_create({ html })`, and tell the user the document is still
there as the working draft.

**If `file_read` can't reach the reference** (it lives outside the sandbox in some
environments), still take the designed path — apply at minimum: CSS custom properties
for `--ink / --accent / --paper / --plate` declared once at `:root` and used
everywhere; a serif for the title and section headings against a sans body and a mono
for eyebrows, table headers and money; a dark full-width cover block with the title,
one-line lede and a who/for/when meta strip; numbered sections (`01`, `02`); bordered
cards and tables with `break-inside: avoid` and a highlighted recommended row; a dark
footer carrying assumptions and sources. Nothing remote (no webfonts, no images —
every font stack ends in `serif` / `sans-serif` / `monospace`), no blurred
`box-shadow` (it prints as a grey slab), no `prefers-color-scheme` — a PDF has one
theme. Call with `margin_inches: 0` when the cover bleeds.

`pdf_create` also accepts `markdown` — that is for a plain text file (a receipt, a
transcript, a quick note as a file), never for something with a client's name on it.

### Exporting a document the user already has

When the user says "PDF", "send it", "share it", or "print it" about an existing
document: finish its content first, then call `document_export_pdf` with its
`surface_id` — the PDF arrives as an attachment they can download. When a document
you produced is deliverable-shaped, proactively offer the export: "Want this as a
PDF?"

## Which export format?

**Choose on what the recipient will DO with the file, not on what sounds
impressive.** A PDF is the right answer for something final; it is the wrong
answer for something the other side has to change.

| They will… | Format | Tool |
| --- | --- | --- |
| Read it, print it, file it — nothing changes | `pdf` | `document_export_pdf`, or `pdf_create({ html })` for a designed artifact |
| **Edit or redline it in Word** — contracts, proposals, anything going through legal or a client's review | `docx` | `document_export` / `file_create` |
| **Present it, or edit the slides in PowerPoint** — a structured deck they will re-order and retype | `pptx` | `document_export` / `file_create` |
| **Re-calculate the numbers** — pricing, budgets, line items, any data table | `xlsx` | `document_export` / `file_create` |
| **Paste it into Slack, a deck, a doc, a message** — anywhere an image travels better than a file | `png` | `document_export` / `file_create` |
| Publish it, paste it into a CMS, or send it as an email body | `html` | `document_export` / `file_create` |
| Take the raw source into their own tooling | `markdown` | `document_export` / `file_create` |

The tells, and they are usually explicit: "so I can edit it", "send me the Word
version", "put it in a doc" → **docx**. "as a spreadsheet", "in Excel", "can I get
the pricing in a sheet" → **xlsx**. "screenshot of this", "as an image", "so I can
drop it in the deck" → **png**. "in PowerPoint", "as slides", "a deck I can edit"
→ **pptx** — and say in the same breath that it is the structure as slides, not
the designed layout.

**docx is the one that wins deals.** When a proposal, quote, statement of work or
contract is going to a client who will comment on it, offer the Word version in
the same message as the PDF — a PDF forces them to retype your terms into their
own document, and that is where your language stops being yours. The export keeps
real headings, lists, tables and character styles, so track changes works on it.

**pptx exports structure, not a design — say so.** Each `#` and `##` becomes a
16:9 slide titled with that heading; the content under it becomes the body, with
bullets, numbered lists, nesting, tables and bold/italic all landing as real
PowerPoint objects the recipient can click into and retype. A section too long
for one slide is split across several, and the extra slides are titled
"… (cont.)" so the reader knows the list didn't restart. A `---` in the markdown
is honoured as an explicit slide break.

What it is **not** is a picture of a designed layout. The slides wear
PowerPoint's own styling, not the house style from `references/DESIGNED_PDF.md`.
So when you hand one over, name it: "editable slides built from the structure —
the styling is PowerPoint's, not the designed layout". A user who thinks they
received their designed deck and then emails it to a client is the bad outcome
this sentence exists to prevent.

**A designed deck stays a PDF.** A slide deck built with `app-builder` is HTML
and CSS; there is no honest conversion from that into editable shapes, and the
alternative — one screenshot per slide — produces a file that looks like a real
export until someone tries to fix a typo. Export those with `deck_export_pdf`.
If the user wants a designed deck *and* something editable, offer both: the PDF
for how it looks, a pptx built from the same structure for what they can change.

**xlsx** takes the document's markdown **tables** and writes one sheet per table,
with currency and percentage cells as real numbers (so `$12,000.00` sums, and
`35%` is `0.35` formatted as a percent). A document with no tables cannot be
exported as xlsx — say so and offer another format rather than shipping an empty
workbook.

**png** renders at 2x by default so it stays sharp when shared. Pass `selector` to
capture one element instead of the whole page — `selector: "table"` for just the
pricing table, `selector: ".cover"` for a designed cover. That is the "export this
one part" path.

Offer more than one when it is obviously useful: a priced proposal is usefully a
PDF *and* a docx *and* an xlsx of the pricing table. Deliver them in one message.

## Creating a new document

This is the path for prose (see the routing table above — an artifact goes to
`pdf_create` instead).

1. **Create the document**: Call `document_create` with a title (inferred from the request). Call the tool immediately, not after conversational preamble. Capture the `surface_id` from the response — every subsequent `document_update` call must reference it.
2. **Write content in Markdown**: Use proper structure (`#` for titles, `##` for sections), **bold**, _italic_, code blocks, tables, lists, blockquotes as appropriate.
3. **CRITICAL - Stream content in chunks**: Call `document_update` MULTIPLE times, not just once. Break content into logical chunks (paragraphs, sections, or every 200-300 words). Call `document_update` with `mode: "append"` for EACH chunk separately. The user experiences real-time content appearing as you write.

### Recovering from a failed update

If a `document_update` call fails with an `Invalid input` error (for example because `surface_id` was missing), do NOT call `document_create` again. The `surface_id` you need is in the tool result of the most recent `document_create` call in this turn. Retry `document_update` with that `surface_id` and the same content. Creating a second document with the same title produces a duplicate for the user.

## Editing an existing document

When the user requests changes to a document:

1. Find the `surface_id` from the `<active_documents>` context block.
2. Use `document_update` with the existing `surface_id` — do NOT call `document_create` again.
3. **Choose the right editing tool:**
   - `document_update` with `mode: "append"` — adding new content to the end.
   - `document_update` with `mode: "replace"` — ONLY for full rewrites where the majority of the document is changing.
   - `document_find` + `document_replace_text` — **for everything else**. Fixing typos, renaming terms, swapping sections, reordering content, adjusting formatting, or any edit that touches only part of the document. This is the default choice for edits. It avoids rewriting the entire document and eliminates the risk of accidentally dropping content.
4. **Do NOT use `document_update` with `mode: "replace"` for targeted edits.** Rewriting the entire document to change a few words or rearrange sections is wasteful and error-prone.

## Honoring a design contract (Create Studio)

When the request is prefixed with a **`DESIGN CONTRACT`** or **`BRAND`** block (compiled by Create Studio, above a `---` divider), honor what a Markdown document can carry:

- **Voice & tone** — write ALL copy in the specified tone; follow the brand's do/don't lists; weave the boilerplate in where natural (e.g. an intro or closing line). This is the part that matters most for docs and you must apply it.
- **Boilerplate / naming** — use the exact brand name, product names, and any required phrasing verbatim.
- **Palette / fonts / logo** — _in the editor_, the canvas is Markdown: you can't set arbitrary hexes or font faces inline, and inline HTML won't render, so don't try. Brand styling is applied at the `document_export_pdf` layer; keep the content brand-appropriate. If a logo asset is named, mention it as a placeholder at the top ("_[Brand logo]_") rather than embedding a remote image.
- **A contract with a real palette is itself a signal.** If the user handed you brand colours and fonts, they expect to see them — that is a presented artifact, so take the designed-PDF path and express the palette through the tokens in `{baseDir}/references/DESIGNED_PDF.md` (`--accent`, `--accent-deep`, `--accent-wash`, `--plate`). There you _can_ honour the palette exactly. Fonts still have to come from the system stacks — the render has no network — so match the brand's *category* (serif display vs. geometric sans), never a remote webfont.

The user's words after the `---` are the primary instruction; the contract shapes the writing style. Absent any such block, write as usual.

## Retrieving existing documents

When the user asks to see, open, or pull up a document:

1. Check the `<active_documents>` block in your context — it lists all documents in this conversation with their `surface_id` and title.
2. If the document is NOT in `<active_documents>`, call `document_list` with a `query` matching the document title. For guardian/local users, this searches across previous conversations and sessions.
3. Once you have the `surface_id`, call `document_open` to open the editor panel. This surfaces the editor on the client and returns document metadata (`surface_id`, `title`, `word_count`) — not the full content. If you need the actual document text, follow up with `document_read`.

**Never** search the filesystem, conversation history, or archives to find a document. Always use `document_list` with a `query`.

**If the user says they can't see a document you know exists** (e.g. after switching from macOS to web, or after a page refresh), call `document_open` with the `surface_id` to re-surface the editor panel on their current client.

## Find & Replace

Use `document_find` and `document_replace_text` for surgical edits that target specific text patterns without rewriting the entire document.

### document_find

Search a document for literal text or regex patterns. Parameters:

- `surface_id` (required) — the document to search
- `query` (required) — the search string or regex pattern
- `regex` (optional, default `false`) — treat `query` as a regular expression
- `case_sensitive` (optional, default `false`) — match case exactly

Returns a list of matches with line numbers, line content, match positions, and matched text. Use this to preview what will be affected before making replacements.

### document_replace_text

Targeted find-and-replace within a document. Parameters:

- `surface_id` (required) — the document to modify
- `find` (required) — the search string or regex pattern
- `replace` (required) — the replacement string (supports `$1`, `$2` backreferences when `regex` is `true`)
- `regex` (optional, default `false`) — treat `find` as a regular expression
- `case_sensitive` (optional, default `false`) — match case exactly
- `max_replacements` (optional) — limit the number of replacements made

Returns the number of replacements made and whether the content changed.

### Workflow

1. Call `document_find` to preview matches and confirm the pattern is correct.
2. Call `document_replace_text` to apply the changes.

**Examples:**

- **Fix a recurring typo**: Find `"recieve"`, replace with `"receive"`.
- **Rename a term throughout**: Find `"widget"` (case-insensitive), replace with `"component"`.
- **Reformat dates with regex**: Find `(\d{2})/(\d{2})/(\d{4})` with `regex: true`, replace with `$3-$1-$2` to convert `MM/DD/YYYY` to `YYYY-MM-DD`.
- **Swap or reorder sections**: Use `document_read` to get the content, identify the sections to swap, then call `document_replace_text` to replace the first section with the second and vice versa. For complex rearrangements, use multiple `document_replace_text` calls with `max_replacements: 1`.

## Comments

Users can leave inline comments on documents. Open comments are surfaced in a `<document_comments>` context block so you can see pending feedback.

- **comment_list** — Lists open comments on a document by `surface_id`. Use this to check for feedback before or after editing, especially when the user asks you to address comments.
- **comment_resolve** — Marks a comment as resolved by `comment_id`. Use this after you have addressed the feedback in the document content. Always edit the document first, then resolve the comment.
- **comment_reply** — Posts a reply to an existing comment by `comment_id`. Use this to ask clarifying questions or explain why you made (or declined) a change before resolving.

### Addressing comments workflow

1. Read the `<document_comments>` block or call `comment_list` to see open comments.
2. For each comment, edit the document to address the feedback.
3. Call `comment_resolve` on comments you have addressed.
4. If a comment is ambiguous, call `comment_reply` to ask for clarification instead of guessing.

## Numbers you can defend

Anything the user will put in front of a client is a document that can be checked.
A fabricated figure is the failure mode that actually loses the deal, so this applies
on **both** paths, editor and PDF:

- **Never invent** a metric, percentage, price, headcount, client name, testimonial,
  case study, award or logo — not as a "realistic example", not as filler, not
  because a layout has a gap.
- **Every figure you print must be traceable** to this conversation, a tool result,
  or a cited public source. Say which, in the document.
- **A number you need but don't have is a visible placeholder**, never a plausible
  invention. In the editor: `**[client to confirm: 2026 headcount]**`. In a designed
  PDF: `<span class="tbd">[client to confirm: 2026 headcount]</span>`, which prints
  as an amber dashed box nobody can send by accident.
- **Arithmetic must close.** Totals equal the sum of their rows; a quoted discount is
  applied in the worked example.
- **A priced document ends with an assumptions/sources block**, and you tell the user
  in chat which figures are placeholders, in the same message that delivers the file.

## Anti-Patterns

- **Don't build a proposal, one-pager or pitch in the Markdown editor.** Eight
  `document_update` appends followed by `document_export_pdf` produces a text-only
  PDF for something the user is about to show a client. Route it to
  `pdf_create({ html })` with the house style instead.
- **Don't improvise a visual system.** On the designed path, read
  `{baseDir}/references/DESIGNED_PDF.md` and use its tokens and components.
- **Don't reference anything remote in PDF or PNG HTML** — no webfonts, no hosted
  logos, no CDN scripts. The render blocks the network and they come out blank.
- **Don't send a PDF when the user said they need to edit it.** "Can I get this in
  Word" is a request for `docx`, not for a PDF with an apology.
- **Don't pass `html` to the docx, xlsx or pptx export.** Those are built from
  the markdown's structure; the tool will refuse rather than embed a picture of
  the page. Pass the content as markdown.
- **Don't offer pptx as a way to "convert" a designed deck.** It exports
  structure into PowerPoint's styling. Claiming it reproduces a designed layout
  is the one mistake here that reaches the user's client.
- **Don't use `app_create` for blog posts, articles, or written content.** Use `document_create` — apps are for interactive content with state/data.
- **Don't write the article into the chat response.** Long-form prose goes in the document editor via `document_create`, not in chat and not into a `.md` file in the workspace. Acknowledge what you're doing and stream to the editor.
- **Don't wait to generate everything before sending.** Stream content in chunks via `document_update` with `mode: "append"` so users see progress in real time.

## Usage Notes

- The `mode` parameter on `document_update` defaults to `append`.
- Documents are automatically saved and accessible via the Generated panel.
- Users can manually edit documents at any time.
- Write in clear, engaging prose. Use active voice, vary sentence structure, and break content into logical sections with descriptive headings.

## Reference files

Read with `file_read` (`{baseDir}` resolves to this skill's directory):

- `{baseDir}/references/DESIGNED_PDF.md` — the house style for `pdf_create({ html })`:
  tokens, type pairing, cover / numbered sections / stat rows / pricing tables /
  callouts / steps / assumptions footer, the offline-render constraints, and the
  preflight checklist. Read it before writing HTML for any presented artifact.
