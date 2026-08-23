/**
 * Ask your notes — the answer, and where every part of it came from.
 *
 * This is what turns a pile of notes into something that compounds. Without
 * it Notes is a folder: things go in, and finding one again means remembering
 * you wrote it.
 *
 * Three things this component refuses to do, each of them a way the feature
 * could quietly become untrustworthy:
 *
 *  1. **It never renders an answer without its citations.** The daemon
 *     already deletes uncited sentences; this refuses to draw the result if
 *     the citation list came back empty, so a bug on either side of the wire
 *     shows up as a missing answer rather than an unsourced one.
 *  2. **"Nothing found" and "couldn't ask" are separate branches.** One is
 *     about the question, the other about the request — the same distinction
 *     the note rail draws, for the same reason.
 *  3. **It says the answer is not saved.** Asking a question must not quietly
 *     create a note, and the person reading needs to know that without having
 *     to trust it.
 *
 * Old evidence is marked rather than hidden. The five-month-old note nobody
 * would have gone looking for is the point of the feature; its age is
 * something the reader should weigh, not something to suppress.
 */

import { useCallback, useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";

import { notesAskPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";

const C = {
  card: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blueS: "var(--mv1-blue-strong)",
  amberText: "var(--mv1-amber-text)",
} as const;

interface Citation {
  n: number;
  source: string;
  title: string;
  locator: string;
  excerpt: string;
  timestampMs: number | null;
  stale: boolean;
}

interface AskResponse {
  status: "answered" | "nothing_found" | "failed";
  answer: string | null;
  citations: Citation[];
}

/** What each store is called on screen. The wire's names are not English. */
const SOURCE_LABEL: Record<string, string> = {
  notes: "your note",
  email: "email",
  work: "work",
  memory: "memory",
  conversations: "a conversation",
  workspace: "a file",
};

export function NoteAskPanel({ assistantId }: { assistantId: string }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResponse | null>(null);

  const ask = useMutation(notesAskPostMutation()) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string };
      body: { question: string };
    }) => Promise<AskResponse>;
    isPending: boolean;
  };

  const submit = useCallback(async () => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setResult(null);
    try {
      setResult(
        await ask.mutateAsync({
          path: { assistant_id: assistantId },
          body: { question: trimmed },
        }),
      );
    } catch {
      setResult({ status: "failed", answer: null, citations: [] });
    }
  }, [ask, assistantId, question]);

  return (
    <div className="mb-4">
      <div
        className="flex items-center gap-2 rounded-full border px-3 py-2"
        style={{ borderColor: C.line, background: C.card }}
      >
        <Search size={14} style={{ color: C.t3 }} />
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Search, or ask your notes a question"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          style={{ color: C.t1 }}
          aria-label="Ask your notes a question"
        />
        {ask.isPending ? (
          <Loader2 size={13} className="animate-spin" style={{ color: C.t3 }} />
        ) : null}
      </div>

      {result ? <AskResult result={result} /> : null}
    </div>
  );
}

function AskResult({ result }: { result: AskResponse }) {
  // The request failed. NOT the same as "I looked and found nothing", and
  // never shown as if it were.
  if (result.status === "failed") {
    return (
      <Frame>
        <p className="text-[13px]" style={{ color: C.amberText }}>
          I couldn&rsquo;t answer that just now — nothing was searched.
        </p>
      </Frame>
    );
  }

  if (result.status === "nothing_found") {
    return (
      <Frame>
        <p className="text-[13px]" style={{ color: C.t2 }}>
          I couldn&rsquo;t find anything about that in your notes, mail or work.
        </p>
      </Frame>
    );
  }

  // Belt to the daemon's braces: an answer whose citations went missing in
  // transit is not drawn at all. A bug on either side of the wire shows up as
  // a missing answer rather than an unsourced one.
  if (!result.answer || result.citations.length === 0) {
    return (
      <Frame>
        <p className="text-[13px]" style={{ color: C.t2 }}>
          I couldn&rsquo;t find anything I could show you the source for.
        </p>
      </Frame>
    );
  }

  return (
    <Frame>
      <p
        className="text-[14px] leading-relaxed"
        style={{ color: C.t1 }}
        data-testid="ask-answer"
      >
        {result.answer}
      </p>

      <p
        className="mt-3 mb-1.5 text-[10.5px] font-semibold tracking-wide uppercase"
        style={{ color: C.t3 }}
      >
        Where this came from · {result.citations.length}
      </p>
      <ol className="flex flex-col gap-1.5">
        {result.citations.map((citation) => (
          <li key={citation.n} className="flex gap-2 text-[12px]">
            <span
              className="shrink-0 font-semibold"
              style={{ color: C.blueS }}
              aria-hidden
            >
              {citation.n}
            </span>
            <span className="min-w-0">
              <span style={{ color: C.t1 }}>{citation.title}</span>
              <span style={{ color: C.t3 }}>
                {" · "}
                {SOURCE_LABEL[citation.source] ?? citation.source}
                {citation.timestampMs
                  ? ` · ${new Date(citation.timestampMs).toLocaleDateString()}`
                  : ""}
                {/* Marked, never hidden: the old note that answers the
                    question is the point, and its age is the reader's to
                    weigh rather than ours to suppress. */}
                {citation.stale ? " · old" : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-3 text-[11px]" style={{ color: C.t3 }}>
        An answer, not a note — nothing was saved.
      </p>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mt-2 rounded-lg border p-3"
      style={{ borderColor: C.line, background: C.card }}
    >
      {children}
    </div>
  );
}
