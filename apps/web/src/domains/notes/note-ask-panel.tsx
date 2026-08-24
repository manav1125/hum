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

import {
  notesAskCommitmentsPostMutation,
  notesAskPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";

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

/** Something the answer says the owner still owes. R2's "Add them ›". */
interface Commitment {
  title: string;
  inHq: boolean;
}

interface AskResponse {
  status: "answered" | "nothing_found" | "failed";
  answer: string | null;
  citations: Citation[];
  commitments: Commitment[];
  followUps: string[];
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
  /** Titles already filed from this answer, so the offer stops offering them. */
  const [filed, setFiled] = useState<string[]>([]);

  const ask = useMutation(notesAskPostMutation()) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string };
      body: { question: string };
    }) => Promise<AskResponse>;
    isPending: boolean;
  };

  const fileCommitments = useMutation(
    notesAskCommitmentsPostMutation(),
  ) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string };
      body: { titles: string[] };
    }) => Promise<{ created: number }>;
    isPending: boolean;
  };

  const submitQuestion = useCallback(
    async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setResult(null);
    setFiled([]);
    try {
      setResult(
        await ask.mutateAsync({
          path: { assistant_id: assistantId },
          body: { question: trimmed },
        }),
      );
    } catch {
      setResult({
        status: "failed",
        answer: null,
        citations: [],
        commitments: [],
        followUps: [],
      });
    }
    },
    [ask, assistantId],
  );

  const submit = useCallback(
    () => submitQuestion(question),
    [submitQuestion, question],
  );

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

      {result ? (
        <AskResult
          result={result}
          filed={filed}
          busy={fileCommitments.isPending}
          onFile={async (titles) => {
            try {
              await fileCommitments.mutateAsync({
                path: { assistant_id: assistantId },
                body: { titles },
              });
              setFiled((prev) => [...prev, ...titles]);
            } catch {
              // Left unfiled and still offered: a failed write must never
              // look like a successful one, and the retry is one click.
            }
          }}
          onAsk={(q) => {
            setQuestion(q);
            void submitQuestion(q);
          }}
        />
      ) : null}
    </div>
  );
}

function AskResult({
  result,
  filed,
  busy,
  onFile,
  onAsk,
}: {
  result: AskResponse;
  /** Already filed from this answer, so the offer stops offering them. */
  filed: string[];
  busy: boolean;
  onFile: (titles: string[]) => void | Promise<void>;
  onAsk: (question: string) => void;
}) {
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

      {/* R2: "2 aren't in HQ as tasks → Add them ›". An answer that tells you
          what you promised and leaves you to retype it is a worse answer —
          but filing them for you would be the silent write this whole
          feature refuses. So it counts them, and waits to be asked. */}
      <Owed
        commitments={result.commitments.filter((c) => !filed.includes(c.title))}
        busy={busy}
        onFile={onFile}
      />

      {result.followUps.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {result.followUps.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onAsk(q)}
              className="rounded-full border px-2.5 py-1 text-[11.5px]"
              style={{ borderColor: C.line2, color: C.t2 }}
            >
              {q}
            </button>
          ))}
        </div>
      ) : null}

      <p className="mt-3 text-[11px]" style={{ color: C.t3 }}>
        An answer, not a note — nothing was saved.
      </p>
    </Frame>
  );
}

/**
 * What the answer says you still owe, and what HQ already has.
 *
 * The count leads because it is the fact: "2 of these aren't tracked anywhere"
 * is the reason to look. Filing is one deliberate click and files only what is
 * missing — the ones already in HQ are shown as such and never re-added,
 * because a second copy of a task you already have is worse than no button.
 */
function Owed({
  commitments,
  busy,
  onFile,
}: {
  commitments: Commitment[];
  busy: boolean;
  onFile: (titles: string[]) => void | Promise<void>;
}): React.ReactElement | null {
  if (commitments.length === 0) return null;
  const missing = commitments.filter((c) => !c.inHq);

  return (
    <div
      className="mt-3 rounded-lg border px-3 py-2.5"
      style={{ borderColor: C.line2, background: C.sunken }}
    >
      <ul className="flex flex-col gap-1">
        {commitments.map((c) => (
          <li key={c.title} className="flex gap-2 text-[12.5px]">
            <span aria-hidden style={{ color: c.inHq ? C.t3 : C.amberText }}>
              {c.inHq ? "✓" : "○"}
            </span>
            <span style={{ color: C.t1 }}>
              {c.title}
              {c.inHq ? (
                <span style={{ color: C.t3 }}> · already in HQ</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {missing.length > 0 ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onFile(missing.map((c) => c.title))}
          className="mt-2 text-[11.5px] font-medium"
          style={{ color: busy ? C.t3 : C.blueS }}
        >
          {busy
            ? "Adding…"
            : `${missing.length} ${
                missing.length === 1 ? "isn’t" : "aren’t"
              } in HQ as ${missing.length === 1 ? "a task" : "tasks"} · Add ${
                missing.length === 1 ? "it" : "them"
              } ›`}
        </button>
      ) : null}
    </div>
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
