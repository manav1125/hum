# Chrome Web Store listing — Cue browser extension (draft, pre-WS-D)

Publisher account: manav@brinc.io (registered + paid 2026-07-21). Recommend publisher display
name = **Cue**. This copy is ready to paste; the **.zip** and **screenshots** come from WS-D (the
rebranded extension). Permissions strings below must be reconciled against the final rebranded
manifest before submit.

## Item name
**Cue** — Browser Assistant  *(store name field; ≤ 45 chars)*

## Summary  *(≤ 132 chars)*
Let Cue work in your logged-in browser — research, pull data, fill forms — driven by your own Cue
assistant. No data collection.

## Category
Productivity  *(secondary: Workflow & Planning)*

## Description
Cue is your AI chief-of-staff. This extension lets Cue act inside the browser you're already signed
into — so it can research across your accounts, extract information, navigate, and fill forms on
your behalf, instead of asking you to do it.

How it works:
- Cue drives the page through Chrome's DevTools protocol — the same mechanism Chrome's own dev tools
  use. It observes and acts on tabs you point it at.
- It pairs with your Cue assistant (desktop app or your hosted Cue instance) over a secure
  connection. Nothing runs without your assistant on the other end.
- No content scripts, no background scraping, no data collection. The extension doesn't read pages
  on its own or send your browsing anywhere — it only does what your assistant explicitly asks,
  when you ask.

You stay in control: pause or stop any time, and Cue's approval rules govern what it's allowed to do
without checking with you first.

Requires a Cue assistant (get one at justcue.ai) and Chrome 120+.

## Permissions justification  *(store requires a reason per permission — reconcile with final manifest)*
- **debugger** — Cue drives the page via the Chrome DevTools protocol to navigate, click, type, and
  read content on tabs you direct it to. This is the core mechanism; without it the extension
  cannot act.
- **tabs** — to identify and target the specific tab Cue is working in.
- **nativeMessaging** / host access to the local Cue app + your hosted instance — to connect the
  extension to your assistant so commands and results can flow.
(If the rebrand drops any of these, delete its row.)

## Privacy practices (data disclosures)
- Does the extension collect user data? It transmits **website content** and **user activity** ONLY
  as needed to fulfill the assistant's explicit actions, routed to the user's OWN Cue instance —
  not to Cue/Brinc servers for storage, not sold, not used for advertising, not for creditworthiness.
- Data is used solely to operate the feature the user requested.
- Provide the privacy-policy URL (below).

## Privacy policy URL
NEEDS: a public privacy page. Fastest path = a `justcue.ai/privacy` page (HQ can serve it). Draft
content: what the extension accesses (page content on directed tabs), where it goes (the user's own
assistant instance), what is NOT done (no collection/sale/ads), retention (none by the extension),
contact. — flag to build alongside WS-D.

## Assets still needed (from WS-D)
- The packaged, rebranded extension .zip (WS-D output).
- 1280×800 (or 640×400) screenshots: the extension paired + Cue acting in a tab, the pair/connect
  popup, a run in progress. Capture from the built extension.
- 128×128 store icon (Cue "C." mark — reuse the app icon asset).
- Small promo tile 440×280 (optional but recommended).

## Distribution settings
- Visibility: **Unlisted** for alpha (shareable link, not publicly searchable) → flip to Public
  post-alpha. Alpha users also get the sideload .zip so they're never gated on review.
- Deterministic extension ID per environment (from the rebrand) so the OAuth/pairing redirect URIs
  stay stable — coordinate the ID with the gateway pairing config in WS-D.
