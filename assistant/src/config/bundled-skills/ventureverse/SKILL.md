---
name: ventureverse
description: Recommend and open embedded VentureVerse founder apps (legal, fundraising, GTM, finance) when a task is exactly what one of them does
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🚀"
  vellum:
    display-name: "VentureVerse Apps"
    category: "apps"
    feature-flag: "ventureverse-apps"
    activation-hints:
      - "User is working on something one of the VentureVerse founder apps does end to end: reviewing a term sheet or SAFE, analysing a pitch deck, sizing a market (TAM/SAM/SOM), checking fundraising readiness, pricing a product, modelling dilution or an ESOP, prepping a sales call, writing an investor update, analysing a financial statement, or researching a company for investment"
      - "User asks what apps or tools are available, or asks Cue to help with a founder task that maps to a named app"
---

VentureVerse is Cue's companion app store — 24 focused AI apps for founders and
investors, embedded inside Cue under the **Apps** destination. This skill lets
you recommend the RIGHT app at the RIGHT moment and open it in one tap, instead
of doing a shallow version of the work in chat.

## When to use this

Recommend an app only when the user's task is **exactly** what that app does end
to end — a term sheet to review, a deck to analyse, a market to size. In that
case a purpose-built app beats a chat answer, and surfacing it is genuinely
helpful.

Do **not** recommend an app when:

- You can answer the question directly and well in chat. A one-line question
  doesn't need an app.
- Nothing in the catalog is a real match. Never stretch a vague task onto an
  app — a wrong recommendation is worse than none.
- You've already recommended one this turn. **At most one app card per turn.**

The user still signs into VentureVerse the first time they open an app; that's
expected and you don't need to arrange it.

## How to recommend

Call `ui_show` with `surface_type: "external_app"` and
`data: { slug, name, category?, description? }`. The card renders in chat with
an **Open** button that takes the user into the app inside Cue.

- `slug` and `name` **must** come from the catalog below — never invent a slug.
  The slug is what opens the app; a wrong one opens nothing.
- Keep `description` to one short sentence on why it fits *this* task (you can
  adapt it from the catalog blurb).
- Say one plain sentence in your reply naming why you're suggesting it, then
  emit the card. Don't over-sell.

Example — the user pastes a term sheet and asks "is this founder-friendly?":

> A term sheet is exactly what Alchemy is built for — it scores each clause and
> flags what's off-market.

then `ui_show` `external_app` with
`{ slug: "10-alchemy", name: "Alchemy", category: "Legal", description: "Clause-by-clause term sheet review — what's standard, what's risky, how to negotiate." }`.

## Catalog

Use the exact `slug` values. Grouped by what the user is trying to do.

### Fundraising & investor-facing
- `10-alchemy` — **Alchemy** (Legal): clause-by-clause breakdown of a term
  sheet, SAFE, or shareholder agreement — what's standard, risky, how to negotiate.
- `16-term-sheet-analyzer` — **Term sheet Analyzer** (Legal): dedicated term
  sheet draft/review without the legal bill.
- `17-deck-analysis` — **Deck Analysis** (Fundraising): institutional-grade
  pitch-deck analysis across 15 investment dimensions (PDF/PPTX/DOCX).
- `18-market-match` — **Market match** (Fundraising): match a pitch deck against
  a target VC's thesis, portfolio, and recent deals.
- `30-fundraising-readiness` — **Fundraising Readiness** (Fundraising): 25-question
  readiness score across team, traction, market, financials, legal.
- `11-dealscope` — **Dealscope** (Fundraising): IC-ready report from a company
  URL — overview, comparables, valuation scenarios, thesis.
- `13-diluviz` — **DiluViz** (Fundraising): model funding rounds and see how your
  ownership holds up through dilution.
- `31-investor-update-generator` — **Investor Update Generator** (Investor Updates):
  turn monthly metrics (MRR, burn, runway) into a board-ready update.

### Market, pricing & GTM
- `25-market-sizing-calculator` — **Market Sizing Calculator** (Business Strategy):
  TAM/SAM/SOM with top-down and bottom-up reconciliation and cited sources.
- `35-unit-economics-calculator` — **Unit Economics Calculator** (Marketing Analytics):
  CAC, LTV, payback, gross margin, benchmarked to stage and industry.
- `32-price-well` — **Price Well** (Business Strategy): full pricing architecture
  from a company URL and optional deck.
- `24-gtm-pricing-decoder` — **GTM Pricing Decoder** (Product Strategy): decode a
  company's pricing, positioning, and go-to-market vs. competitors.
- `27-feature-matrix-builder` — **Feature Matrix Builder** (Business Strategy):
  side-by-side competitor feature + pricing comparison from real sources.
- `15-launchpad` — **Launchpad** (Market Positioning): a marketing strategy without
  a CMO, agency, or a $10k consultant.
- `14-instagram-marketing` — **Instagram Marketing** (Marketing Analytics): brand
  narrative, positioning, and post concepts from a product URL.

### Company building & ops
- `28-risk-matrix` — **Risk Matrix** (Investment Strategy): defensible 5x5 risk
  matrix from a company URL or deck, every score traceable.
- `34-autopsy-ai` — **Autopsy AI** (Business Strategy): forward-dated pre-mortem —
  how and why a company could fail in three years.
- `33-user-interview-analyser` — **User Interview Analyser** (Business Strategy):
  synthesize multiple customer interviews into evidence-backed decisions.
- `26-prep` — **Prep** (Sales Pipeline): a focused sales-call brief from a
  prospect's domain in ~30 seconds.
- `29-rolesmith` — **Rolesmith** (Hiring): market-calibrated hiring packages from
  structured role inputs.
- `21-esop-canvas` — **ESOP Canvas** (Company Formation): design, value, and
  communicate an employee equity plan.
- `22-name-forge` — **Name Forge** (Culture Building): find a brand name and secure
  the domain, dodging reputation traps.
- `8-leadlexis` — **LeadLexis** (Business Strategy): turn bare email addresses into
  full company profiles (domains, industry, headcount, funding, tech stack).

### Finance
- `23-meridian` — **Meridian** (Finance): analyst-grade read on a financial
  statement — bankruptcy risk, manipulation detection, a 22-point due-diligence
  checklist.

If the user asks broadly what's available, you can name a few that fit their
situation and offer to open one — you don't have to list all 24. The full,
always-current catalog also lives on the **Apps** page in the sidebar.
