/**
 * Filing kit — the shared batch-add parsing + per-row project suggestion
 * used by BOTH batch-capture surfaces (mobile frame 43's Mv3AddTasksSheet and
 * desktop frame D1's AddTasksModal).
 *
 * Suggestions are LAYERED:
 *   1. The cheap client-side heuristic (title tokens vs. project names) paints
 *      instantly on every keystroke and is the offline fallback.
 *   2. `useServerSuggestions` debounces (600ms) a call to the daemon's
 *      `POST work-items/classify-preview` — the background auto-filer's flash
 *      scorer exposed at capture time (no persistence, no side effects). Its
 *      answers override the heuristic per title via `resolveSuggestionFor`.
 *      Feature-detected: a 404 (older daemon) disables the calls for the
 *      session and the heuristic keeps the wheel.
 *
 * The semantics contract is the same either way: confident → pre-filled chip,
 * ambiguous → open chip row, no signal → "Leave unfiled — Cue will sort it".
 */
import { useEffect, useRef, useState } from "react";

import { client } from "@/generated/daemon/client.gen";

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

/* -------------------------------------------------------------------------- */
/* Daemon classifier (classify-preview) — debounced, feature-detected         */
/* -------------------------------------------------------------------------- */

/** One scored title off the daemon's classify-preview route. */
export interface ServerSuggestion {
  projectId: string | null;
  /** The auto-filer scorer's 0–1 confidence for that project. */
  confidence: number;
}

/** ≥ this → confident pre-fill ("X ✓"); mirrors the auto-filer's default. */
export const SERVER_CONFIDENT_MIN = 0.7;
/** ≥ this (but below confident) → ambiguous candidate chips. */
export const SERVER_AMBIGUOUS_MIN = 0.4;

const CLASSIFY_DEBOUNCE_MS = 600;
/** The daemon caps the batch at 30 titles — don't send more. */
const CLASSIFY_MAX_TITLES = 30;
const CLASSIFY_PREVIEW_URL =
  "/v1/assistants/{assistant_id}/work-items/classify-preview";

/**
 * Session-wide feature detect: an older daemon 404s the route; once seen,
 * stop asking and let the heuristic keep the wheel.
 */
let classifyPreviewUnavailable = false;

const EMPTY_SUGGESTIONS: ReadonlyMap<string, ServerSuggestion> = new Map();

/**
 * Debounced (600ms) daemon classification of the parsed lines. Returns a map
 * keyed by title (the lines are already trimmed by `parseTaskLines`, matching
 * the daemon's trim). Both batch-add surfaces feed the result into
 * `resolveSuggestionFor`, so the heuristic still paints instantly and the
 * server's judgment lands a beat later. Network failures and 404s are silent
 * — suggestions are a nicety, never an error state.
 */
export function useServerSuggestions(
  assistantId: string,
  lines: readonly string[],
  projects: readonly SuggestableProject[],
): ReadonlyMap<string, ServerSuggestion> {
  const [suggestions, setSuggestions] =
    useState<ReadonlyMap<string, ServerSuggestion>>(EMPTY_SUGGESTIONS);
  /** Monotonic request id so a slow stale response never wins over a newer one. */
  const generation = useRef(0);

  // Value-stable deps: the arrays are rebuilt every render upstream.
  const linesKey = lines.join("\n");
  const haveProjects = projects.length > 0;

  useEffect(() => {
    if (classifyPreviewUnavailable || !assistantId || !haveProjects) return;
    const titles = linesKey
      .split("\n")
      .filter(Boolean)
      .slice(0, CLASSIFY_MAX_TITLES);
    if (titles.length === 0) return;

    const gen = ++generation.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          // TData is hey-api's per-status map; 200 carries the route's body.
          const res = await client.post<
            { 200: { suggestions?: unknown } },
            unknown,
            false
          >({
            url: CLASSIFY_PREVIEW_URL,
            path: { assistant_id: assistantId },
            body: { titles },
          });
          if (res.response?.status === 404) {
            classifyPreviewUnavailable = true;
            return;
          }
          if (gen !== generation.current) return; // superseded
          const raw = res.data?.suggestions;
          if (!Array.isArray(raw)) return;
          const next = new Map<string, ServerSuggestion>();
          for (const entry of raw) {
            const s = entry as {
              title?: unknown;
              projectId?: unknown;
              confidence?: unknown;
            };
            if (typeof s?.title !== "string") continue;
            next.set(s.title, {
              projectId: typeof s.projectId === "string" ? s.projectId : null,
              confidence:
                typeof s.confidence === "number" ? s.confidence : 0,
            });
          }
          setSuggestions(next);
        } catch {
          // Offline / transport failure — the heuristic keeps working.
        }
      })();
    }, CLASSIFY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [assistantId, linesKey, haveProjects]);

  return suggestions;
}

/**
 * The per-row suggestion both surfaces render: the daemon's judgment when it
 * has one (confidence mapped onto the frame-43/D1 grammar), the client
 * heuristic otherwise (instant first paint + offline fallback).
 *
 *   · ≥ {@link SERVER_CONFIDENT_MIN} → confident pre-fill ("X ✓")
 *   · ≥ {@link SERVER_AMBIGUOUS_MIN} → ambiguous chips, server's pick first
 *     (heuristic candidates fill the remaining slots)
 *   · below / no fit → none ("Leave unfiled — Cue will sort it")
 */
export function resolveSuggestionFor(
  line: string,
  projects: readonly SuggestableProject[],
  server?: ReadonlyMap<string, ServerSuggestion>,
): ProjectSuggestion {
  const scored = server?.get(line);
  if (scored) {
    const projectId =
      scored.projectId != null &&
      projects.some((p) => p.id === scored.projectId)
        ? scored.projectId
        : null;
    if (projectId != null && scored.confidence >= SERVER_CONFIDENT_MIN) {
      return { kind: "confident", projectId };
    }
    if (projectId != null && scored.confidence >= SERVER_AMBIGUOUS_MIN) {
      const heuristic = suggestProjectFor(line, projects);
      const alsoPlausible =
        heuristic.kind === "ambiguous"
          ? heuristic.candidateIds
          : heuristic.kind === "confident"
            ? [heuristic.projectId]
            : [];
      return {
        kind: "ambiguous",
        candidateIds: [
          projectId,
          ...alsoPlausible.filter((id) => id !== projectId),
        ].slice(0, 3),
      };
    }
    // The daemon scored it and found no clear home — honest "none" beats a
    // lexical guess (leaving unfiled hands it to the auto-file sweep).
    return { kind: "none" };
  }
  return suggestProjectFor(line, projects);
}
