# Cue — marketing & commerce site

Self-contained static build. Every page is plain HTML that loads `support.js` (the
client-side render runtime) from the same folder; fonts come from the Google Fonts CDN.

## How it's served (production)

**Cue HQ serves this directory itself** (`hq/src/site.ts`): every non-API
GET on the HQ origin falls through to these files with clean URLs
(`/pricing` → `pricing.html`, `/` → `index.html`, `/checkout/success` →
`welcome.html`, `/checkout/cancel` → `pricing.html`). Point `HQ_SITE_DIR`
elsewhere to override; set `HQ_PUBLIC_SITE_URL` to HQ's own origin.

The commerce pages (index waitlist, pricing, redeem, welcome, signin,
account) are wired to HQ through **`commerce.js`** (same-origin fetch —
`window.CUE_HQ_BASE` can point at a remote HQ for local previews). The
per-page logic lives in each page's `data-dc-script` component; all HTTP
lives in commerce.js. Backend contract: `hq/README.md` § "Website
integration contract". `emails.html` is the design source for the four
transactional emails in `hq/src/email.ts` — keep them in sync.

## Deploy (Netlify — kept for reference)

The site still works as a pure static deploy (commerce calls then need
`window.CUE_HQ_BASE` set to the HQ origin + CORS handling, which HQ does
not do yet — production path is HQ-served, above):
- **Drag & drop:** open https://app.netlify.com/drop and drag this folder in.
- **CLI:** `netlify deploy --dir=. --prod`
- **Git:** commit the folder; `netlify.toml` sets `publish = "."`.

## ⚙️ Domain: done — justcue.ai
SEO tags, canonical URLs, `sitemap.xml`, and `robots.txt` are set to the real
domain **`https://justcue.ai`** (swapped from the old `https://cue.ai`
placeholder across `index.html`, `halo.html`, `sitemap.xml`, `robots.txt`, and
the contact `hello@justcue.ai` mailtos on every page). If the domain ever
changes again, find-and-replace `https://justcue.ai` across those files.
Non-canonical hosts (justcue.io, www) 301 to justcue.ai — handled by HQ's
`HQ_CANONICAL_HOST` redirect, see `hq/README.md` § Domains.

## SEO / indexability
- **Static `<head>`** on the public pages (`index.html`, `halo.html`): real `<title>`,
  meta description, `canonical`, Open Graph + Twitter cards, `theme-color`, favicon, and
  JSON-LD structured data (SoftwareApplication / Product). These are in the served HTML
  (not JS-injected), so Google **and** non-JS crawlers / social scrapers read them.
- **`sitemap.xml`** lists the two public marketing URLs (`/` and `/halo`).
- **`robots.txt`** allows crawling and points to the sitemap.
- **App-screen demos** (home, chat, memory, connectors, design-book, …) carry
  `<meta name="robots" content="noindex,follow">` — they won't compete in search; only
  the marketing pages rank.

## Mobile
`index.html` and `halo.html` are fully responsive — multi-column sections collapse to a
single column, and the nav becomes a hamburger menu under 860px.

## Pages
- `index.html` — marketing landing (Cue)
- `halo.html` — Cue Halo wearable / pre-sale  (clean URL `/halo` via netlify.toml)
- `design-book.html` — internal index of every product surface (noindex)
- product surfaces: home, chat, memory, connectors, cuelive, identity, skills, agents,
  channels, contacts, impact, settings, library, logs, directory, plugins, … (all noindex)

## Notes
- The landing's "Ask Cue" demo uses a live model in-app; on the public site it auto-falls
  back to built-in canned responses — no API key needed.
- `assets/` holds the 4 PNGs the landing tour uses — the only binary deps.
