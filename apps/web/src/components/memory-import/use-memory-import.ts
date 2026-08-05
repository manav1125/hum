/**
 * The memory-import state machine (v37 §2 / W4): drop → ingest → summary.
 *
 * Wired to the two daemon routes that already exist — nothing new was added
 * for this flow:
 *
 *   - `POST …/conversations/import` (chunked; dedupes on sourceKey, so
 *     re-dropping the same export skips rather than duplicates);
 *   - `POST …/memory/ingest` (batch concept pages; per-page verdicts).
 *
 * HONESTY NOTE — the "live counts" of step 2 are scoped to what actually
 * streams. The parse phase counts genuinely live (conversations, messages
 * and memory material found while the export is walked in the browser, plus
 * the year being worked through). The daemon phase is chunked requests, so
 * its counts tick per response — the ingest route returns batch summaries,
 * not a stream, and this flow does not pretend otherwise.
 */

import { useCallback, useRef, useState } from "react";

import {
  conversationsImportPost,
  memoryIngestPost,
} from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";

import {
  buildConceptPages,
  parseChatGptExport,
  type ParseProgress,
} from "./chatgpt-export";

const CONVERSATIONS_PER_CALL = 25;

export interface ImportCounts extends ParseProgress {
  /** Conversations the daemon accepted (deduped re-imports excluded). */
  conversationsImported: number;
  /** Conversations skipped as already imported. */
  conversationsSkipped: number;
  /** Messages the daemon accepted. */
  messagesImported: number;
  /** Memory items on pages the daemon wrote. */
  memoriesKept: number;
  /** Memory items on pages skipped as already present (a re-import). */
  memoriesAlreadyKnown: number;
  /** Memory items on pages the ingest rejected as invalid. */
  memoriesDropped: number;
  /** Secret-shaped values redacted before anything was written. */
  redactions: number;
}

export type MemoryImportState =
  | { step: "drop" }
  | { step: "ingest"; phase: "reading" | "writing"; counts: ImportCounts }
  | { step: "done"; counts: ImportCounts }
  | { step: "error"; message: string; counts: ImportCounts | null };

function emptyCounts(): ImportCounts {
  return {
    conversationsFound: 0,
    messagesFound: 0,
    memoryItemsFound: 0,
    workingThroughYear: null,
    conversationsImported: 0,
    conversationsSkipped: 0,
    messagesImported: 0,
    memoriesKept: 0,
    memoriesAlreadyKnown: 0,
    memoriesDropped: 0,
    redactions: 0,
  };
}

export function useMemoryImport(assistantId: string | null) {
  const [state, setState] = useState<MemoryImportState>({ step: "drop" });
  const busyRef = useRef(false);

  const reset = useCallback(() => {
    busyRef.current = false;
    setState({ step: "drop" });
  }, []);

  const importFile = useCallback(
    async (file: File) => {
      if (busyRef.current || !assistantId) return;
      busyRef.current = true;
      let counts = emptyCounts();
      const update = (
        phase: "reading" | "writing",
        patch: Partial<ImportCounts>,
      ) => {
        counts = { ...counts, ...patch };
        setState({ step: "ingest", phase, counts });
      };
      update("reading", {});
      try {
        const parsed = await parseChatGptExport(file, (progress) => {
          update("reading", progress);
        });
        update("writing", {
          conversationsFound: parsed.conversations.length,
          memoryItemsFound: parsed.memoryItems.length,
          workingThroughYear: null,
          redactions: parsed.redactions,
        });

        // Conversations, chunked. The route dedupes on sourceKey.
        for (
          let start = 0;
          start < parsed.conversations.length;
          start += CONVERSATIONS_PER_CALL
        ) {
          const chunk = parsed.conversations.slice(
            start,
            start + CONVERSATIONS_PER_CALL,
          );
          const { data } = await conversationsImportPost({
            path: { assistant_id: assistantId },
            body: { conversations: chunk },
            throwOnError: true,
          });
          update("writing", {
            conversationsImported: counts.conversationsImported + data.imported,
            conversationsSkipped: counts.conversationsSkipped + data.skipped,
            messagesImported: counts.messagesImported + data.messages,
          });
        }

        // Memory material → a small number of concept pages with
        // `source: import:chatgpt` provenance frontmatter.
        const pages = buildConceptPages(parsed.memoryItems, new Date());
        if (pages.length > 0) {
          const { data } = await memoryIngestPost({
            path: { assistant_id: assistantId },
            body: {
              pages: pages.map(({ slug, content }) => ({ slug, content })),
            },
            throwOnError: true,
          });
          let kept = 0;
          let known = 0;
          let dropped = 0;
          for (const result of data.results) {
            const page = pages.find((p) => p.slug === result.slug);
            const itemCount = page?.itemCount ?? 0;
            if (result.action === "written") kept += itemCount;
            else if (result.action === "skipped_exists") known += itemCount;
            else dropped += itemCount;
          }
          update("writing", {
            memoriesKept: kept,
            memoriesAlreadyKnown: known,
            memoriesDropped: dropped,
          });
        }

        setState({ step: "done", counts });
      } catch (err) {
        captureError(err, { context: "memory_import" });
        setState({
          step: "error",
          message:
            err instanceof Error
              ? err.message
              : "Something went wrong reading the export.",
          counts: counts.conversationsFound > 0 ? counts : null,
        });
      } finally {
        busyRef.current = false;
      }
    },
    [assistantId],
  );

  return { state, importFile, reset };
}
