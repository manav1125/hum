/**
 * The memory-import card (v37 §2 / W4) — three steps, one card:
 *
 *   1. the drop — "Been somewhere else? Bring it with you." +
 *      "Nothing leaves your machine during import."
 *   2. the ingest — live counts as material is found;
 *   3. "You didn't start from zero." — the honest kept/dropped split and one
 *      button, "See what Cue learned", which opens the memory surface.
 *
 * Skippable everywhere it appears, never a gate: the card renders inside
 * its host (the onboarding connect step, the Memory page header) and holds
 * no navigation hostage. Parsing happens in the browser and writes go only
 * to the user's own daemon (see `chatgpt-export.ts`).
 */

import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

import {
  useMemoryImport,
  type ImportCounts,
  type MemoryImportState,
} from "./use-memory-import";

function CountLine({ done, children }: { done: boolean; children: string }) {
  return (
    <div className="flex items-baseline gap-2 text-body-small-default text-[var(--content-secondary)]">
      <span
        aria-hidden
        className={
          done
            ? "text-[var(--system-positive-strong)]"
            : "animate-pulse text-[var(--interactive-accent-default,#3D6EE8)]"
        }
      >
        {done ? "✓" : "●"}
      </span>
      <span>{children}</span>
    </div>
  );
}

function ingestLines(
  counts: ImportCounts,
  phase: "reading" | "writing",
): Array<{ key: string; done: boolean; text: string }> {
  const lines: Array<{ key: string; done: boolean; text: string }> = [];
  if (counts.memoryItemsFound > 0) {
    lines.push({
      key: "memories",
      done: true,
      text: `${counts.memoryItemsFound} things you told it about yourself`,
    });
  }
  if (phase === "reading") {
    if (counts.workingThroughYear != null) {
      lines.push({
        key: "year",
        done: false,
        text: `working through ${counts.workingThroughYear}…`,
      });
    }
  } else {
    lines.push({
      key: "writing",
      done: false,
      text: `writing ${counts.conversationsFound} conversations into memory…`,
    });
    if (counts.conversationsImported + counts.conversationsSkipped > 0) {
      lines.push({
        key: "written",
        done: true,
        text: `${counts.conversationsImported + counts.conversationsSkipped} in — ${counts.messagesImported} messages`,
      });
    }
  }
  return lines;
}

export function MemoryImportCard({
  assistantId,
  onDone,
}: {
  assistantId: string | null;
  /**
   * Called when "See what Cue learned" is pressed, instead of the default
   * navigation to the Memory surface — the onboarding host uses this to
   * keep its own flow in charge.
   */
  onDone?: () => void;
}) {
  const navigate = useNavigate();
  const { state, importFile, reset } = useMemoryImport(assistantId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (file) void importFile(file);
    },
    [importFile],
  );

  const seeWhatCueLearned = useCallback(() => {
    if (onDone) onDone();
    else void navigate(routes.memory);
  }, [onDone, navigate]);

  return (
    <div
      data-slot="memory-import-card"
      className="w-full rounded-2xl border border-[var(--border-base)] bg-[var(--surface-base)] p-4 text-left"
    >
      <ImportCardBody
        state={state}
        dragOver={dragOver}
        onPickFile={() => inputRef.current?.click()}
        onDragOver={(over) => setDragOver(over)}
        onDrop={(file) => {
          setDragOver(false);
          handleFile(file);
        }}
        onRetry={reset}
        onSeeWhatCueLearned={seeWhatCueLearned}
      />
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        className="hidden"
        aria-label="Choose a ChatGPT export to import"
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function ImportCardBody({
  state,
  dragOver,
  onPickFile,
  onDragOver,
  onDrop,
  onRetry,
  onSeeWhatCueLearned,
}: {
  state: MemoryImportState;
  dragOver: boolean;
  onPickFile: () => void;
  onDragOver: (over: boolean) => void;
  onDrop: (file: File | undefined) => void;
  onRetry: () => void;
  onSeeWhatCueLearned: () => void;
}) {
  if (state.step === "drop") {
    return (
      <>
        <button
          type="button"
          onClick={onPickFile}
          onDragOver={(e) => {
            e.preventDefault();
            onDragOver(true);
          }}
          onDragLeave={() => onDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            onDrop(e.dataTransfer.files?.[0]);
          }}
          className={`w-full cursor-pointer rounded-xl border-[1.5px] border-dashed px-4 py-6 text-center transition-colors ${
            dragOver
              ? "border-[var(--interactive-accent-default,#3D6EE8)] bg-[var(--surface-active)]"
              : "border-[var(--border-base)] hover:bg-[var(--surface-hover)]"
          }`}
        >
          <div aria-hidden className="text-xl leading-none">
            ⤓
          </div>
          <div className="mt-2 text-body-medium-default font-semibold text-[var(--content-default)]">
            Been somewhere else?
            <br />
            Bring it with you.
          </div>
          <div className="mt-1.5 text-body-small-default text-[var(--content-tertiary)]">
            Drop a ChatGPT export or another assistant’s memory file — Cue reads
            it and starts where they left off.
          </div>
        </button>
        <p className="mt-2 text-center text-body-small-default text-[var(--content-tertiary)]">
          Nothing leaves your machine during import.
        </p>
      </>
    );
  }

  if (state.step === "ingest") {
    return (
      <div aria-live="polite">
        <div className="text-body-medium-default text-[var(--content-default)]">
          {state.phase === "reading"
            ? state.counts.conversationsFound > 0
              ? `Reading ${state.counts.conversationsFound} conversations…`
              : "Reading the export…"
            : "Cue is taking it in…"}
        </div>
        <div className="mt-2.5 h-[5px] overflow-hidden rounded-full bg-[var(--surface-active)]">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-[var(--interactive-accent-default,#3D6EE8)]" />
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {ingestLines(state.counts, state.phase).map((line) => (
            <CountLine key={line.key} done={line.done}>
              {line.text}
            </CountLine>
          ))}
        </div>
      </div>
    );
  }

  if (state.step === "error") {
    return (
      <div>
        <div className="text-body-medium-default text-[var(--content-default)]">
          That import didn’t finish.
        </div>
        <p className="mt-1 text-body-small-default text-[var(--content-secondary)]">
          {state.message} Nothing was half-written: conversations already
          accepted stay, and re-dropping the same export skips them instead of
          duplicating.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 cursor-pointer rounded-lg border border-[var(--border-base)] px-3 py-1.5 text-body-small-default text-[var(--content-default)] hover:bg-[var(--surface-hover)]"
        >
          Try again
        </button>
      </div>
    );
  }

  const { counts } = state;
  const conversationsIn =
    counts.conversationsImported + counts.conversationsSkipped;
  return (
    <div>
      <div className="text-body-medium-default font-semibold text-[var(--content-default)]">
        You didn’t start from zero.
      </div>
      <div className="mt-2 flex flex-col gap-1 text-body-small-default text-[var(--content-secondary)]">
        {counts.memoriesKept > 0 ? (
          <div>
            · {counts.memoriesKept} kept —{" "}
            <span className="text-[var(--content-tertiary)]">
              the rest was chat, not you
            </span>
          </div>
        ) : counts.memoriesAlreadyKnown > 0 ? (
          <div>
            · {counts.memoriesAlreadyKnown} already known — this export was
            imported before
          </div>
        ) : (
          <div>
            · no saved memories in this export — the conversations are in,
            though
          </div>
        )}
        {counts.memoriesDropped > 0 ? (
          <div>· {counts.memoriesDropped} couldn’t be written</div>
        ) : null}
        {conversationsIn > 0 ? (
          <div>
            · {conversationsIn} conversations searchable
            {counts.conversationsSkipped > 0
              ? ` (${counts.conversationsSkipped} already here)`
              : ""}
          </div>
        ) : null}
        {counts.redactions > 0 ? (
          <div>· {counts.redactions} secret-shaped values redacted</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onSeeWhatCueLearned}
        className="mt-3 w-full cursor-pointer rounded-xl bg-[var(--interactive-accent-default,#3D6EE8)] px-3 py-2 text-body-small-default font-semibold text-white hover:opacity-90"
      >
        See what Cue learned
      </button>
    </div>
  );
}
