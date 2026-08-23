/**
 * Bringing an existing pile in — the screen that makes Notes worth something
 * on night one instead of month six.
 *
 * Someone arriving with two years of Apple Notes should be able to ask
 * questions of them immediately, rather than waiting to accumulate a pile
 * they already have.
 *
 * ## The one thing it asks
 *
 * Imported notes are **searchable immediately, always**. The only question is
 * what gets *proposed as work*, and "only the last month" is the default for
 * a reason worth showing rather than hiding: proposing 73 tasks out of two
 * years of archive makes someone's HQ unusable on their first day, and a
 * two-year-old "call the dentist" is not a live commitment.
 *
 * The count is shown **before** anything is proposed, so "only the last
 * month" is a promise the owner can check rather than one they have to trust.
 *
 * ## Nothing leaves the machine
 *
 * Files are read here, in the browser, and posted to the local daemon. There
 * is no upload and no third-party parser — which is the same promise the
 * memory import makes, and the reason anyone is willing to hand over a decade
 * of private writing at all.
 */

import { useCallback, useRef, useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { FileDown, Loader2 } from "lucide-react";

import { notesImportPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useInvalidateNotes } from "@/hooks/use-invalidate-notes";

const C = {
  card: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blueS: "var(--mv1-blue-strong)",
  green: "var(--mv1-green)",
} as const;

type Window = "last_month" | "all" | "none";

interface ParsedNote {
  title?: string;
  body: string;
  occurredAt?: number;
}

interface ImportSummary {
  imported: number;
  skipped: number;
  queuedForReading: number;
  window: Window;
}

/**
 * Read a dropped export into notes.
 *
 * One file is one note, which is how every tool in the list exports. The
 * file's own modified time becomes the note's date — without it every
 * imported note would date from the import, which puts a decade of writing at
 * the top of today's list AND makes the window meaningless, since everything
 * would look like it happened this minute.
 */
async function parseFiles(files: FileList): Promise<ParsedNote[]> {
  const parsed: ParsedNote[] = [];
  for (const file of Array.from(files)) {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) continue;
    const content = (await file.text()).trim();
    if (!content) continue;

    const firstLine = content.split("\n")[0]?.trim() ?? "";
    const heading = /^#{1,3}\s+(.*)$/.exec(firstLine);
    parsed.push({
      title: heading?.[1]?.trim() || firstLine || file.name,
      body: heading ? content.split("\n").slice(1).join("\n").trim() : content,
      ...(file.lastModified ? { occurredAt: file.lastModified } : {}),
    });
  }
  return parsed;
}

const WINDOW_LABEL: Record<Window, string> = {
  last_month: "Only the last month",
  all: "All of them",
  none: "None",
};

export function NoteImportPanel({
  assistantId,
  onDone,
}: {
  assistantId: string;
  onDone: () => void;
}) {
  const invalidate = useInvalidateNotes();
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedNote[] | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [reading, setReading] = useState(false);

  const importNotes = useMutation(notesImportPostMutation()) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string };
      body: { notes: ParsedNote[]; tool?: string; window?: Window };
    }) => Promise<ImportSummary>;
    isPending: boolean;
  };

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setReading(true);
    try {
      setParsed(await parseFiles(files));
    } finally {
      setReading(false);
    }
  }, []);

  const run = useCallback(
    async (window: Window) => {
      if (!parsed?.length) return;
      const result = await importNotes.mutateAsync({
        path: { assistant_id: assistantId },
        body: { notes: parsed, tool: "markdown", window },
      });
      setSummary(result);
      invalidate();
    },
    [assistantId, importNotes, invalidate, parsed],
  );

  if (summary) {
    return (
      <Frame>
        <p className="text-[13px] font-medium" style={{ color: C.t1 }}>
          Read {summary.imported} {summary.imported === 1 ? "note" : "notes"}.
        </p>
        <p className="mt-1 text-[12px] leading-relaxed" style={{ color: C.t2 }}>
          All of them are searchable now — you can ask questions of them
          straight away.{" "}
          {summary.queuedForReading > 0
            ? `I'll look for things to do in ${summary.queuedForReading} of them.`
            : "I won't propose anything from them."}
        </p>
        <button
          type="button"
          onClick={onDone}
          className="mt-3 rounded-full px-3 py-1.5 text-[12px] font-medium text-white"
          style={{ background: C.blueS }}
        >
          Done
        </button>
      </Frame>
    );
  }

  return (
    <Frame>
      <p className="text-[13px] font-medium" style={{ color: C.t1 }}>
        Already keeping notes somewhere?
      </p>
      <p className="mt-1 text-[12px] leading-relaxed" style={{ color: C.t2 }}>
        Apple Notes · Notion · Obsidian · Mem · a folder of markdown. Drop the
        export here and Cue reads all of it — then you can ask it questions on
        night one instead of waiting six months to build a pile.
      </p>
      <p className="mt-1 text-[11px]" style={{ color: C.t3 }}>
        Nothing leaves your machine during import.
      </p>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".md,.markdown,.txt"
        className="hidden"
        onChange={(e) => void onFiles(e.target.files)}
      />

      {!parsed ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={reading}
          className="mt-3 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px]"
          style={{ borderColor: C.line2, color: C.t1 }}
        >
          {reading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <FileDown size={13} />
          )}
          Choose files ›
        </button>
      ) : (
        <div className="mt-3">
          <p
            className="text-[10.5px] font-semibold tracking-wide uppercase"
            style={{ color: C.t3 }}
          >
            One thing to decide
          </p>
          <p className="mt-1 text-[13px]" style={{ color: C.t1 }}>
            {parsed.length} {parsed.length === 1 ? "note" : "notes"} ready.
            Should I propose things to do from them, or leave the past alone?
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {(["last_month", "all", "none"] as const).map((window) => (
              <button
                key={window}
                type="button"
                disabled={importNotes.isPending}
                onClick={() => void run(window)}
                className="rounded-full px-2.5 py-1 text-[12px] font-medium"
                style={
                  // The safe default leads and is the only filled button:
                  // proposing two years of archive is the failure mode, so
                  // the other two have to be chosen deliberately.
                  window === "last_month"
                    ? { background: C.green, color: "#fff" }
                    : {
                        border: `1px solid ${C.line2}`,
                        color: C.t1,
                      }
                }
              >
                {WINDOW_LABEL[window]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px]" style={{ color: C.t3 }}>
            Either way all {parsed.length} are searchable immediately — this
            only decides what I suggest as work.
          </p>
        </div>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: C.line, background: C.sunken }}
    >
      {children}
    </div>
  );
}
