/**
 * Filing kit — the shared batch-add parsing + per-row project suggestion
 * used by BOTH batch-capture surfaces (mobile frame 43's Mv3AddTasksSheet and
 * desktop frame D1's AddTasksModal).
 *
 * Suggestions are a CHEAP CLIENT-SIDE HEURISTIC (title tokens vs. project
 * names). TODO(daemon-classifier): when the daemon grows a classify/preview
 * route for batch entry (the background auto-filer's scorer exposed at
 * capture time — none exists as of 2026-07-20; `work-items-routes.ts` has no
 * classify/suggest endpoint), replace `suggestProjectFor` call sites with a
 * debounced call to it and keep this as the offline fallback. The semantics
 * contract stays the same either way: confident → pre-filled chip, ambiguous
 * → open chip row, no signal → "Leave unfiled — Cue will sort it".
 */

export interface SuggestableProject {
  id: string;
  title: string;
}

export type ProjectSuggestion =
  | { kind: "confident"; projectId: string }
  | { kind: "ambiguous"; candidateIds: string[] }
  | { kind: "none" };

/** One task per non-empty line — the live-parse both surfaces share. */
export function parseTaskLines(draft: string): string[] {
  return draft
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "with",
  "by",
  "our",
  "my",
  "your",
  "from",
  "before",
  "after",
  "new",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Case-insensitive lexical match of a task line against project titles.
 * Whole-title substring = the strongest signal (2 points); shared distinctive
 * words score 1 each. A sole matching project (or a clear 2-point lead) is
 * "confident"; several matches are "ambiguous" (candidates strongest-first);
 * no overlap is "none".
 */
export function suggestProjectFor(
  line: string,
  projects: readonly SuggestableProject[],
): ProjectSuggestion {
  const lineLc = line.toLowerCase();
  const lineWords = new Set(tokens(line));

  const scored = projects
    .map((p) => {
      const titleLc = p.title.toLowerCase().trim();
      let score = 0;
      if (titleLc.length > 2 && lineLc.includes(titleLc)) score += 2;
      for (const w of tokens(p.title)) if (lineWords.has(w)) score += 1;
      return { id: p.id, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: "none" };
  if (scored.length === 1) return { kind: "confident", projectId: scored[0].id };
  if (scored[0].score >= scored[1].score + 2)
    return { kind: "confident", projectId: scored[0].id };
  return { kind: "ambiguous", candidateIds: scored.slice(0, 3).map((s) => s.id) };
}
