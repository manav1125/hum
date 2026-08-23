import type { AssistantConfig } from "../../config/schema.js";

/**
 * Where recall may look.
 *
 * `notes`, `email` and `work` were added for R2 ("ask your notes"), and the
 * name of that feature is a little misleading on purpose: scoping an answer
 * to one store is how it becomes wrong by omission. "What have we promised
 * Acme?" is answered out of notes AND mail AND the work already queued, or
 * it is answered badly.
 */
export type RecallSource =
  | "memory"
  | "conversations"
  | "workspace"
  | "notes"
  | "email"
  | "work";

export type RecallDepth = "fast" | "standard" | "deep";

export interface RecallInput {
  query: string;
  sources?: RecallSource[];
  max_results?: number;
  depth?: RecallDepth;
}

export interface RecallEvidence {
  id: string;
  source: RecallSource;
  title: string;
  locator: string;
  excerpt: string;
  timestampMs?: number;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface RecallSearchContext {
  workingDir: string;
  conversationId: string;
  config: AssistantConfig;
  signal?: AbortSignal;
}

export interface RecallSearchResult {
  evidence: RecallEvidence[];
}

export interface RecallAnswer {
  answer: string;
  evidence: RecallEvidence[];
}

export interface RecallSourceAdapter {
  source: RecallSource;
  search(
    query: string,
    context: RecallSearchContext,
    limit: number,
  ): Promise<RecallSearchResult>;
}
