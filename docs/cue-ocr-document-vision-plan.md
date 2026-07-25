# Cue Document Vision & Unlimited-OCR — Assessment + Integration Plan

**Date:** 2026-07-10
**For:** the Cue builder.
**Question:** how does Baidu `Unlimited-OCR` work, and how should Cue use it to read documents?
**Short answer:** the model is real and excellent, but the pasted analysis over-scopes the fix. Cue's document blind spot is real, yet the cheapest correct v1 is **populate document text at ingestion using tools Cue already has (unpdf + the existing vision tier)** — *not* a self-hosted GPU microservice. Reserve Unlimited-OCR for a targeted tier-2 (serverless first) where its structured/long-doc fidelity or on-prem privacy actually earns the infra.

---

## 1. What Unlimited-OCR actually is (verified)

Baidu open-sourced it **2026-06-22** (arXiv [2606.23050](https://arxiv.org/abs/2606.23050), model card [huggingface.co/baidu/Unlimited-OCR](https://huggingface.co/baidu/Unlimited-OCR), **MIT license**). The pasted analysis's technical claims **all check out**:

- **Base:** DeepSeek-OCR, pushed further. **DeepEncoder** = SAM-ViT + CLIP-ViT cascade with **16× token compression** → a 1024×1024 page becomes **256 visual tokens**. This "contexts optical compression" (representing text as compressed vision tokens) is the DeepSeek-OCR lineage's real idea.
- **The innovation — R-SWA (Reference Sliding Window Attention):** every decoder attention layer is replaced so generated tokens attend to *all* visual tokens (the "reference") plus a **fixed 128-token sliding window** of recent output. Older tokens drop from cache → **KV cache goes from linear to constant**, so memory is flat and latency is a flat line regardless of length (vs DeepSeek-OCR's linear growth). This lets it parse **~40+ pages in one 32K-context forward pass**.
- **Size:** 3B params, **500M active (MoE)** — sparse/efficient, but still a real GPU model.
- **Quality:** **OmniDocBench v1.6 = 93.92% (new SOTA)** vs DeepSeek-OCR 87.01% (v1.5). Notably strong on *structure*: table TEDS 84.97→90.93, formula CDM 83.37→92.61, text edit distance 0.073→0.038.
- **Serving:** raw OCR decoder, **no chat template**. vLLM (`docker pull vllm/vllm-openai:unlimited-ocr`, CUDA 13, or `-cu129` for Hopper) or SGLang, with a required `DeepseekOCRNoRepeatNGramLogitProcessor` (ngram_size 35). Prompt form `"<image>document parsing."`. **Needs a GPU** — won't run in Cue's container.

So: best-in-class *specialist* document parser, MIT-licensed, GPU-bound. The standout is structured extraction (tables/formulas) and long single-pass documents.

## 2. What Cue does with documents TODAY (the pasted analysis is only half right)

Verified against the codebase. "Cue has no document vision pipeline" is **wrong for images, right for scanned/binary docs on the default brain.**

**EXISTS:**
- **Vision-tier routing** — `assistant/src/agent/vision-tier.ts`. Image-bearing turns auto-reroute to a vision model (default `qwen/qwen3.6-flash` on OpenRouter; per-provider `vision-optimized` intent maps to Claude Opus / GPT-5.4 / Gemini-3-flash). So Cue **can already see images**.
- **Native PDF reading — but only on some brains.** Anthropic (`application/pdf` → native `document` block) and Gemini (`inlineData`) natively OCR PDFs *including scanned pages*. `assistant/src/providers/{anthropic,gemini}/client.ts`.
- **Attachment storage** — `assistant/src/memory/attachments-store.ts` + `attachments` table.
- **Replicate already wired as a generic model-runner** — `assistant/src/config/bundled-skills/replicate/tools/replicate-run.ts` runs *any* Replicate model and materializes outputs into chat. A serverless OCR model can be called through this **today, no new infra**.

**MISSING / the real gap:**
- **No dedicated OCR anywhere** (no Tesseract/Textract/pdf-raster/OCR provider).
- **The default production brain is text-only** (DeepSeek v4 via OpenRouter / `CUE_OPENROUTER_MODEL`; qwen only handles image blocks). On that brain a **PDF file-block is dead weight**.
- **`extracted_text` is threaded through the whole stack but never populated** — `MessageAttachmentInput.extractedText` / `FileContent.extracted_text` are always passed through, no server-side code computes them, and there's **no `extracted_text` column** on the attachments table. OpenAI/OpenRouter/DeepSeek paths emit `"No extracted text available."` for PDFs.
- **Image blocks trigger vision-tier; PDF file-blocks do not** — so a scanned PDF on the default brain is invisible unless it happens to land on Anthropic/Gemini.
- **No Gmail/email binary-attachment ingestion** (only Slack image hydration exists).
- The only server-side text extraction that exists is `assistant/src/brand/brand-extract-job.ts` using **`unpdf`** (serverless pdf.js, **already a dependency**) — digital text layer only, scoped to brand extraction, not the chat path.

**Net:** the genuine gap is real — **on the default text brain, Cue can't reliably read a PDF/scanned document** — but it's a *pipeline/plumbing* gap (`extracted_text` is never filled), not a "we need a SOTA GPU OCR model" gap.

## 3. The decision: capability yes, GPU-microservice-first no

Build the capability. But the pasted plan (stand up an A100 vLLM microservice as the entry point) is the most expensive way in and the wrong first step for Cue's stage/economics. Tiered, cheapest → heaviest:

### Tier 0 — Populate `extracted_text` at ingestion (do this first; ~no new infra)
Make documents visible to whatever brain is active by pre-extracting at upload:
- **Born-digital PDFs (the majority — statements, contracts, decks-exported-to-PDF):** run **`unpdf`** (already in the tree) at ingestion, write the text into a new `extracted_text` column, thread it into the existing `FileContent.extracted_text` that every provider already renders. This alone unblocks most of the pasted analysis's use cases (financial statements, contracts, pitch decks) on the *text* brain, with a dependency Cue already ships.
- **Scanned PDFs / images:** rasterize page(s) → send to the **existing vision tier** (qwen3.6-flash / Gemini / Claude) for OCR→markdown, cache into `extracted_text`. Cue already has the vision plumbing; this just points a document at it.

Hooks: add `extracted_text` column to `attachments` (`assistant/src/memory/schema/conversations.ts`); populate in `assistant/src/daemon/conversation-messaging.ts:persistQueuedMessageBody()` / `assistant/src/agent/attachments.ts`; mirror the `unpdf` usage from `brand-extract-job.ts`. This is the 80% solution and the correct v1.

### Tier 1 — Unlimited-OCR via **serverless GPU** (no box to manage), for the docs Tier 0 is weak on
Where born-digital extraction and general vision models fall short — **dense financial tables, formula-heavy pages, 40+ page single-pass parsing, high-fidelity structure** — call Unlimited-OCR **pay-per-use** on **Modal / RunPod / Replicate** (Replicate only if/when someone publishes it; otherwise a small Modal or RunPod vLLM endpoint exposing the OpenAI-compatible API). No idle GPU cost.
- **Cleanest hook:** it's an **OpenAI-compatible vLLM endpoint** → register it as a provider (`assistant/src/providers/`, catalog entry `supportsVision:true`) *or* — lower-friction — call it as a **tool** mirroring `speech-to-text/` and the Replicate runner: `providers/ocr/` sibling family, or a bundled `document-ocr` tool that writes `extracted_text`. The STT provider family (`assistant/src/providers/speech-to-text/`) is the exact precedent for a non-chat extraction provider.
- Use it selectively (route only structured/long/low-confidence docs here), so cost stays proportional to value.

### Tier 2 — Self-host Unlimited-OCR on a dedicated GPU (the pasted plan) — only when a trigger fires
Justified only when one of these is true, none of which hold at current alpha scale:
1. **Volume:** document throughput high enough that a reserved A100 (~$1.5-2/hr) beats per-page serverless/vision-token cost. At one-founder alpha, a mostly-idle A100 is worse economics than Tier 0/1 and cuts against Cue's cheap-COGS posture ([[cue-hosting-economics]]).
2. **Privacy/on-prem:** enterprise/self-host customers who require documents never leave their box — this is where Unlimited-OCR's MIT license + local GPU is a genuine differentiator (Gemini/Claude send the doc to a lab). Real, but a later enterprise motion.
3. **Quality ceiling at scale:** you've measured Tier 0/1 failing on your actual document mix and need SOTA structure fidelity in volume.

## 4. Honest take on the "R-SWA is architecturally interesting for Cue broadly" point

The pasted analysis floats reusing R-SWA / optical-compression for long email threads, transcripts, archives. Accurate as a research direction (constant-memory decoding for long-horizon copying), but it's **not a near-term Cue feature** — it would mean adopting a research attention kernel into the inference path, which is far outside Cue's build surface. File under "watch," not "build." Cue's long-context needs are better served today by the brain's own long context + prompt caching + retrieval.

## 5. Recommendation

1. **Ship Tier 0 now** — `extracted_text` at ingestion via `unpdf` (digital) + the existing vision tier (scanned). Small, no new infra, unblocks the DocuSign/statement/contract use cases on the default brain. This is the real fix for "Cue can't read my documents."
2. **Add Tier 1 when structure fidelity matters** — Unlimited-OCR on serverless GPU (Modal/RunPod), called as a tool/provider, routed only to dense/long/low-confidence docs.
3. **Defer Tier 2 (self-host GPU)** until a volume, privacy, or measured-quality trigger fires — then it's the right call, especially for the enterprise/self-host privacy story.
4. Separately, if inbound email attachments are a target (the DocuSign case), note there's **no Gmail binary-attachment ingestion path today** — that pipeline is its own small build regardless of which OCR tier feeds it.

**Bottom line:** Unlimited-OCR is a genuinely strong, permissively-licensed specialist worth having in Cue's toolbox — but the document blind spot is fixed first by plumbing (`extracted_text`) using capabilities Cue already owns. Bring in Unlimited-OCR serverlessly for the hard structured/long documents, and self-host it only when scale or privacy makes the GPU pay for itself.
