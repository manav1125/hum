# Notes back from build — Wave C package (v35–v37), 2026-08-05

All six rulings and the W1–W3 answer sets are implemented on `cue/upstream-wave-c`.
What follows is what shipped as specified, plus the deviations and gaps you should
know about — each one is a build constraint, not a taste disagreement.

## Landed as specified

- **Spoken voice copy (W3)** — your ack/progress phrase lists and the tone block are
  in verbatim, flag-off pending device QA.
- **Ruling 3** — Bookmarked filter leads All conversations (desktop chip, mobile-v3
  pills); flat saved-messages rows with snippet/thread-link/remove; Settings leaf
  retired behind a permanent redirect; long-press row unchanged. Your empty-state
  copy is verbatim on both surfaces (no desktop variant was drawn, so mobile's line
  is used on both — flag if you want a desktop-specific one).
- **Ruling 4** — one quiet system-card treatment for summarize//compact//clean:
  centered hairline row, mono microlabel derived from the card's first line, muted
  body, timestamp. All daemon card copy rewritten to fact statements; no "I".
- **Ruling 5** — one shared status line across in-app/Slack/Telegram; expiry states
  its consequence ("never answered — nothing was sent"); glyphs stay per-surface.
- **Ruling 6** — all 68 skills' display copy says Cue; protocol ids untouched; the
  rule is now in the skills authoring guide.
- **Import flow (§2)** — three steps with your copy verbatim; parsing is fully
  client-side ("Nothing leaves your machine during import" is literally true);
  optional card on the onboarding connect step + an Import toggle on the Memory
  page; skippable, never gates.

## Deviations and gaps (with reasons)

1. **The error-flavored idle fallback ("Still working — this one's taking longer
   than I thought.") is not used in the idle slot.** The neutrality invariant for
   idle progress forbids implying a problem; the line reads as one. It's reserved
   for a future retry/error path where it's accurate.
2. **Step-2 live counts tick per chunk, not continuously.** The ingest route is
   batch, not streaming; parse-side counts (conversations/messages found, year
   being worked through) are live, daemon-side counts advance per chunk response.
   A streaming ingest API would close this; not worth building for this alone.
3. **"People added to People" (your step-3 frame) is omitted** — no
   people-extraction API is reachable from this flow today.
4. **The provenance badge ("imported from ChatGPT · Aug 2026") has no UI yet.**
   Imported material carries `source: import:chatgpt` + `origin_date` in its
   frontmatter, but no API response exposes it and concept pages have no detail
   surface. The data contract is in place; the badge lands when that surface
   exists.
5. **System cards streamed live render as plain text for a few seconds** until the
   refetch lands the marked row — the marker rides message metadata, which the
   live stream doesn't carry. Older clients see plain text permanently (graceful).

## Open question for design

The reconciliation (v37.1) is adopted as written — upstream's interaction numbers,
Cue's language. Nothing else is owed on Wave C; the voice re-platform package is
complete and becomes its own project.
