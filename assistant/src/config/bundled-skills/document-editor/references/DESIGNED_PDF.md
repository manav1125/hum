# Designed PDF — house style

The style system for `pdf_create({ html })`. Use it for every **presented artifact**:
proposal, one-pager, pitch, brief, client-facing report, case study, quote, invoice,
statement of work, flyer. Not for prose the user will keep editing — that belongs in
`document_create`.

The point of this file is that a generated proposal should look like somebody designed
it. Copy the `<style>` block verbatim, retune the three brand values at the top, then
compose the page out of the components below. Do not invent a parallel set of class
names — the components are what makes the output consistent.

---

## Hard constraints (the render is offline)

`pdf_create` renders with headless Chromium, **JavaScript disabled and the network
blocked**. Anything fetched over the wire silently becomes a blank box.

- **No remote fonts.** No `@font-face { src: url(...) }`, no Google Fonts, no
  `@import`. Use the system stacks below — every one ends in a generic family
  (`serif` / `sans-serif` / `monospace`) so it resolves on a bare Linux container
  where the only face installed may be FreeSerif/FreeSans/FreeMono. Never let a
  specific face be load-bearing.
- **No remote images.** No logos, no photos, no icon CDNs. Draw marks as type or
  inline SVG. A client logo you don't have is a placeholder, not a hotlink.
- **No JS.** No charts libraries, no `document.write`. Bars and meters are divs with
  a width percentage.
- **No blurred `box-shadow`.** Chromium rasterizes blurs into the PDF and they come
  out as flat grey slabs around the box — verified: the callout printed with a grey
  band behind it until the shadow came off. Every surface here takes its definition
  from a 1px border instead. A hard `inset` shadow with zero blur is fine — that's
  how the highlighted table row gets its accent bar.
- Data-URI images are allowed but count against the 2 MB content cap — use sparingly.

**Page geometry.** A4 is 210 × 297 mm; `margin_inches` applies a uniform paper margin
to _every_ page, and CSS `@page` is ignored.

| Shape                                                          | Call                 | Why                                                                                                                                                            |
| -------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-pager, or a proposal whose sections each fit inside a page | `margin_inches: 0`   | Lets the cover and footer bleed to the paper edge. Each `<section>` carries its own padding, so a section pushed to a new page still starts with air above it. |
| Long multi-page document (10+ pages, long running body copy)   | `margin_inches: 0.6` | Guarantees a margin on continuation pages. Drop the bleed: give `.cover` and `footer` a `border-radius: 14px`.                                                 |

With `margin_inches: 0` keep `break-inside: avoid` on every block-level component so
nothing is sliced mid-box, and keep sections shorter than one page.

**One theme.** A PDF is printed, not viewed in a browser — do **not** ship
`prefers-color-scheme`, a theme toggle, or hover states. Light ground, dark plates.

---

## Tokens

Declared once, everything reads through them. To rebrand, change `--accent`,
`--accent-deep`, `--accent-wash` (and `--plate` if the brand's dark is not neutral
slate). Leave the rest alone.

```css
:root {
  --ink: #1a2230; /* body text */
  --ink-2: #4a5568; /* secondary prose */
  --ink-3: #6b7688; /* labels, captions */
  --paper: #f4f6fa; /* page ground */
  --card: #ffffff; /* raised surfaces */
  --line: #e1e6ef; /* borders */
  --line-2: #edf0f6; /* internal rules */
  --accent: #3d6ee8; /* brand accent */
  --accent-deep: #2b53c4;
  --accent-wash: #e7edfc; /* accent at 8% — highlight rows, step bullets */
  --plate: #1a2230; /* cover + footer ground, dark in all cases */
  --flag: #a8791c; /* placeholders and caveats — amber, never decorative */
  --good: #277e41;
}
```

## Type

Three roles, three stacks. The serif carries titles and figures; the sans carries
everything you read; the mono carries eyebrows, table headers and numerals. That
pairing is most of the "designed" feeling — do not set headings in the body sans.

```css
--serif: Georgia, "Times New Roman", "Liberation Serif", serif;
--sans:
  -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial,
  "Liberation Sans", sans-serif;
--mono:
  ui-monospace, "SF Mono", "DejaVu Sans Mono", "Liberation Mono", Consolas,
  monospace;
```

Scale (print pt-equivalents at 96dpi): cover title 46px / section title 30px /
block heading 17px / body 11.5px / caption 10px / eyebrow 8.5px uppercase with
`.13em` tracking.

---

## The stylesheet

Paste this whole block. It is the system; the components below are just markup.

```html
<style>
  * {
    box-sizing: border-box;
  }
  :root {
    --ink: #1a2230;
    --ink-2: #4a5568;
    --ink-3: #6b7688;
    --paper: #f4f6fa;
    --card: #ffffff;
    --line: #e1e6ef;
    --line-2: #edf0f6;
    --accent: #3d6ee8;
    --accent-deep: #2b53c4;
    --accent-wash: #e7edfc;
    --plate: #1a2230;
    --flag: #a8791c;
    --good: #277e41;
    --serif: Georgia, "Times New Roman", "Liberation Serif", serif;
    --sans:
      -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial,
      "Liberation Sans", sans-serif;
    --mono:
      ui-monospace, "SF Mono", "DejaVu Sans Mono", "Liberation Mono", Consolas,
      monospace;
  }
  html,
  body {
    margin: 0;
    padding: 0;
  }
  body {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 11.5px;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet {
    padding: 0 18mm;
  } /* repeats on every page */
  h1,
  h2,
  h3 {
    margin: 0;
    text-wrap: balance;
  }
  p {
    margin: 10px 0;
  }
  strong {
    font-weight: 600;
  }
  a {
    color: var(--accent);
    text-decoration: none;
  }
  .eyebrow {
    font-family: var(--mono);
    font-size: 8.5px;
    font-weight: 500;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  /* Cover ------------------------------------------------------------- */
  .cover {
    background: var(--plate);
    color: #f6f8fc;
    padding: 30mm 18mm 20mm;
    break-inside: avoid;
  }
  .cover .eyebrow {
    color: #8fa6d8;
  }
  .wordmark {
    font-family: var(--sans);
    font-weight: 600;
    font-size: 17px;
    letter-spacing: -0.02em;
    color: #fff;
  }
  .cover h1 {
    font-family: var(--serif);
    font-weight: 400;
    font-size: 46px;
    line-height: 1.04;
    letter-spacing: -0.015em;
    margin: 16px 0 12px;
    max-width: 17ch;
  }
  .cover .lede {
    font-size: 13.5px;
    color: #c3cfe6;
    max-width: 58ch;
    margin: 0;
  }
  .cover-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 16px;
    margin-top: 26px;
    padding-top: 18px;
    border-top: 1px solid rgba(255, 255, 255, 0.18);
  }
  .cover-meta dt {
    font-family: var(--mono);
    font-size: 8px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: #8fa6d8;
    margin-bottom: 4px;
  }
  .cover-meta dd {
    margin: 0;
    font-size: 11px;
    color: #eaf0fb;
    line-height: 1.4;
  }

  /* Sections ---------------------------------------------------------- */
  section {
    padding: 12mm 0;
    break-inside: avoid;
  }
  section + section {
    border-top: 1px solid var(--line);
  }
  .sec-head {
    display: flex;
    gap: 14px;
    align-items: baseline;
  }
  .sec-num {
    font-family: var(--mono);
    font-size: 9.5px;
    font-weight: 500;
    color: var(--accent);
    letter-spacing: 0.1em;
    flex: none;
    padding-top: 5px;
  }
  h2.sec-title {
    font-family: var(--serif);
    font-weight: 400;
    font-size: 30px;
    line-height: 1.1;
    letter-spacing: -0.01em;
  }
  .sec-sub {
    color: var(--ink-2);
    font-size: 13px;
    max-width: 64ch;
    margin: 10px 0 0 34px;
  }
  .body {
    max-width: 70ch;
    margin-left: 34px;
  }
  h3.blk {
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 4px;
  }

  /* Stat row ---------------------------------------------------------- */
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    margin-top: 20px;
    break-inside: avoid;
  }
  .stat {
    background: var(--card);
    padding: 14px 14px;
  }
  .stat .n {
    font-family: var(--serif);
    font-size: 27px;
    line-height: 1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .stat .l {
    font-size: 9.5px;
    color: var(--ink-3);
    margin-top: 5px;
    line-height: 1.35;
  }

  /* Cards ------------------------------------------------------------- */
  .cards {
    display: grid;
    gap: 12px;
    margin-top: 20px;
  }
  .c2 {
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  }
  .c3 {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 16px 16px 18px;
    break-inside: avoid;
  }
  .card .tag {
    font-family: var(--mono);
    font-size: 8px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--accent);
    display: block;
    margin-bottom: 7px;
  }
  .card p {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--ink-2);
    line-height: 1.5;
  }

  /* Tables ------------------------------------------------------------ */
  .tw {
    margin-top: 20px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--card);
    overflow: hidden;
    break-inside: avoid;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  th,
  td {
    text-align: left;
    padding: 9px 13px;
    border-bottom: 1px solid var(--line-2);
    vertical-align: top;
  }
  thead th {
    font-family: var(--mono);
    font-size: 8px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--ink-3);
    font-weight: 500;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  td.num,
  th.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-family: var(--mono);
    font-size: 10.5px;
  }
  th.num {
    white-space: nowrap;
  }
  tr.hi td {
    background: var(--accent-wash);
  }
  tr.hi td:first-child {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  tfoot td {
    font-weight: 600;
    border-top: 1px solid var(--line);
  }
  .pill {
    display: inline-block;
    font-family: var(--mono);
    font-size: 8px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 20px;
    background: var(--accent-wash);
    color: var(--accent-deep);
    white-space: nowrap;
  }
  .pill.good {
    background: #e4f2e9;
    color: var(--good);
  }

  /* Callout / pull quote ---------------------------------------------- */
  .callout {
    background: var(--card);
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: 0 10px 10px 0;
    padding: 16px 18px;
    margin-top: 20px;
    break-inside: avoid;
  }
  .callout p {
    margin: 0;
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .quote {
    font-family: var(--serif);
    font-size: 16px;
    line-height: 1.35;
    color: var(--ink);
  }
  .who {
    font-family: var(--mono);
    font-size: 8.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
    margin-top: 10px;
  }

  /* Numbered steps / timeline ----------------------------------------- */
  .steps {
    counter-reset: s;
    display: grid;
    gap: 10px;
    margin-top: 20px;
  }
  .step {
    display: flex;
    gap: 13px;
    align-items: flex-start;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    break-inside: avoid;
  }
  .step::before {
    counter-increment: s;
    content: counter(s);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    color: var(--accent);
    background: var(--accent-wash);
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .step h3 {
    font-size: 12.5px;
    font-weight: 600;
    margin: 1px 0 3px;
  }
  .step p {
    margin: 0;
    font-size: 11px;
    color: var(--ink-2);
  }

  /* Unknown figures --------------------------------------------------- */
  .tbd {
    font-family: var(--mono);
    font-size: 9.5px;
    color: var(--flag);
    background: #fbf3e2;
    border: 1px dashed var(--flag);
    border-radius: 4px;
    padding: 1px 5px;
    white-space: nowrap;
  }

  /* Footer ------------------------------------------------------------ */
  footer {
    background: var(--plate);
    color: #b9c6de;
    padding: 16mm 18mm 18mm;
    font-size: 9.5px;
    line-height: 1.55;
    break-inside: avoid;
  }
  footer h3 {
    color: #f2f6fc;
    font-size: 10.5px;
    font-weight: 600;
    margin: 0 0 7px;
  }
  footer ol {
    margin: 0;
    padding-left: 15px;
  }
  footer li {
    margin: 4px 0;
  }
  .foot-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 24px;
  }
</style>
```

---

## Components

**Cover** — the whole first impression. Eyebrow, wordmark, one serif line that states
the offer, a lede of one sentence, then a meta strip of who/for/when/validity.

```html
<div class="cover">
  <div class="eyebrow">Commercial proposal</div>
  <div class="wordmark" style="margin-top:6px">
    Acme<span style="color:#7C9EF6">.</span>
  </div>
  <h1>An AI operating layer for your 12,000 member companies</h1>
  <p class="lede">
    A 16-week pilot, priced per founder, with the vetting module included.
  </p>
  <dl class="cover-meta">
    <div>
      <dt>Prepared for</dt>
      <dd>Dubai SME</dd>
    </div>
    <div>
      <dt>Prepared by</dt>
      <dd>Acme Ltd</dd>
    </div>
    <div>
      <dt>Date</dt>
      <dd>14 August 2026</dd>
    </div>
    <div>
      <dt>Valid until</dt>
      <dd>30 September 2026</dd>
    </div>
  </dl>
</div>
```

**Numbered section** — real numbering (`01`, `02`, …). People reference proposals by
section, and the numerals give the page its spine.

```html
<div class="sheet">
  <section>
    <div class="sec-head">
      <div class="sec-num">01</div>
      <h2 class="sec-title">The ask</h2>
    </div>
    <p class="sec-sub">One sentence framing what this section answers.</p>
    <div class="body"><p>Body copy…</p></div>
  </section>
</div>
```

**Stat row** — three to five figures, serif numerals, mono-free labels. Only for
numbers you can source (see below).

```html
<div class="stats">
  <div class="stat">
    <div class="n">500</div>
    <div class="l">Connectors available</div>
  </div>
  <div class="stat">
    <div class="n">16</div>
    <div class="l">Weeks to first cohort</div>
  </div>
  <div class="stat">
    <div class="n">92%</div>
    <div class="l">Tasks closed without escalation</div>
  </div>
</div>
```

**Pricing / comparison table** — the component that decides deals. Wrap in `.tw`,
right-align money with `.num`, mark the recommended row `class="hi"`, put the total in
a `<tfoot>`. One `.pill` per row at most.

```html
<div class="tw">
  <table>
    <thead>
      <tr>
        <th>Tier</th>
        <th>Included</th>
        <th class="num">Per founder / mo</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><b>Starter</b></td>
        <td>Core assistant, 5 connectors</td>
        <td class="num">AED 320</td>
      </tr>
      <tr class="hi">
        <td><b>Cohort</b> <span class="pill">Recommended</span></td>
        <td>Everything in Starter + vetting module</td>
        <td class="num">AED 540</td>
      </tr>
    </tbody>
    <tfoot>
      <tr>
        <td colspan="2">100 founders, 12 months</td>
        <td class="num">AED 648,000</td>
      </tr>
    </tfoot>
  </table>
</div>
```

**Callout / pull quote** — one per two sections, maximum. Use it for the sentence you
want remembered, not for decoration.

```html
<div class="callout">
  <p class="quote">
    Every founder gets an operator on day one, not on hire number four.
  </p>
  <div class="who">Programme director, pilot cohort</div>
</div>
```

**Next steps** — close with `.steps`. Each step is an action with an owner and a date.

**Footer** — dark plate, and it carries the assumptions. See below.

---

## Numbers, sources, and what you must not invent

A proposal loses the deal on a number that turns out to be made up. This is the part
of the house style that is not aesthetic.

- **Never fabricate** a metric, a percentage, a client name, a testimonial, a case
  study, an award, a logo, or a headcount. Not as a "realistic example", not as
  filler, not because the layout has a gap to fill.
- **Attribute every figure you do print.** Either it came from the user in this
  conversation, from a tool result, or from a cited public source — and the footer
  says which.
- **A figure you need but don't have is a visible placeholder**, never a plausible
  invention: `<span class="tbd">[client to confirm: 2026 headcount]</span>`. The
  amber dashed box is deliberately impossible to miss on a printed page — the user
  fills it in before sending, and cannot ship it by accident.
- **Arithmetic must close.** If a pricing table has a total, add the rows up. If a
  discount is quoted, apply it to the worked example.
- **Tell the user in chat** which figures are placeholders and which need a source,
  in the same message that delivers the PDF.

The assumptions footer is a required part of a priced proposal:

```html
<footer>
  <div class="foot-grid">
    <div>
      <h3>Assumptions</h3>
      <ol>
        <li>
          Pricing assumes 100 seats billed annually in AED, exclusive of VAT.
        </li>
        <li>Timeline assumes a kickoff no later than 1 October 2026.</li>
      </ol>
    </div>
    <div>
      <h3>Sources</h3>
      <ol>
        <li>
          Cohort size and programme dates: Dubai SME briefing, 12 Aug 2026.
        </li>
        <li>Product figures: measured on a live instance, Aug 2026.</li>
      </ol>
    </div>
  </div>
</footer>
```

---

## Preflight

Before you call `pdf_create`, check each of these:

1. No `http://`, `https://`, `@import`, or `@font-face` anywhere in the HTML.
2. Every font stack ends in `serif`, `sans-serif`, or `monospace`.
3. No `prefers-color-scheme`, no `<script>`, no hover-only affordances, no blurred
   `box-shadow`.
4. Every colour reads from a token — no raw hexes outside `:root` and the two dark
   plates.
5. Headings are serif; eyebrows, table headers and money are mono.
6. Every `.card`, `.tw`, `.stats`, `.callout`, `.step` has `break-inside: avoid`.
7. Sections are numbered and each one fits inside a page (with `margin_inches: 0`).
8. Every number on the page is sourced, or is inside a `.tbd` placeholder.
9. A priced document ends with the assumptions/sources footer.
10. `margin_inches: 0` for a bleeding cover; `0.6` for a long multi-page document.
