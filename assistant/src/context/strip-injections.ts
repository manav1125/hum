/**
 * Runtime-injection stripping for compaction and overflow recovery.
 *
 * Runtime injections (turn context, memory, NOW.md, workspace, Slack
 * chronological, etc.) persist in message history to keep the conversation
 * prefix stable for Anthropic's prefix caching. They only need to be removed
 * when compaction rewrites the message array, so the compactor summarizes the
 * raw persistent messages rather than the ephemeral injected blocks.
 *
 * This module is the compaction-layer home for that strip so both the agent
 * loop (which drives the compaction pipeline) and the compactor can call it
 * without reaching up into the daemon orchestrator.
 */
import {
  MEMORY_SPOTLIGHT_PREFIX,
  MEMORY_SPOTLIGHT_SUFFIX,
} from "../memory/memory-marker.js";
import type { Message } from "../providers/types.js";

/**
 * A matcher for an injected text block. A plain string matches by prefix
 * (`startsWith`). A `{ prefix, suffix }` wrapper requires BOTH the opening
 * prefix and the closing suffix, so user-authored content that merely begins
 * with an injection-like opening tag (e.g. a message discussing `<info>`
 * markup) is not mistaken for an injected block and dropped. This mirrors
 * `countMemoryPrefixBlocks`, which only treats `<memory>…</memory>` /
 * `<info>…</info>` blocks as injected when the full wrapper is present.
 */
export type InjectionMatcher = string | { prefix: string; suffix: string };

/**
 * Remove text blocks from user messages that match any of the given matchers.
 * If stripping removes all content blocks from a message, the message itself
 * is dropped.
 *
 * This is the shared primitive behind the individual strip* functions and
 * the `stripInjectionsForCompaction` pipeline.
 */
export function stripUserTextBlocksByPrefix(
  messages: Message[],
  matchers: InjectionMatcher[],
): Message[] {
  return messages
    .map((message) => {
      if (message.role !== "user") return message;
      const nextContent = message.content.filter((block) => {
        if (block.type !== "text") return true;
        return !matchers.some((m) =>
          typeof m === "string"
            ? block.text.startsWith(m)
            : block.text.startsWith(m.prefix) && block.text.endsWith(m.suffix),
        );
      });
      if (nextContent.length === message.content.length) return message;
      if (nextContent.length === 0) return null;
      return { ...message, content: nextContent };
    })
    .filter(
      (message): message is NonNullable<typeof message> => message != null,
    );
}

/**
 * Full-wrapper matcher for the memory-v3 ephemeral `<memory_spotlight>` block.
 * Shared by the per-turn scoped strip ({@link stripSpotlightInjections}) and
 * the compaction pipeline below so both recognize exactly the same wrapper.
 */
const MEMORY_SPOTLIGHT_MATCHER: InjectionMatcher = {
  prefix: MEMORY_SPOTLIGHT_PREFIX,
  suffix: MEMORY_SPOTLIGHT_SUFFIX,
};

/**
 * Remove memory-v3 `<memory_spotlight>` blocks from every user message — and
 * ONLY those blocks. The spotlight is ephemeral by contract: runtime assembly
 * strip-and-replaces it each turn (the previous turn's spotlight is stale),
 * while the frozen `<memory>` card blocks stay byte-identical in history for
 * prompt caching. This is deliberately a scoped, single-id strip — the old
 * whole-layer `stripAllMemoryInjections` replace is gone.
 */
export function stripSpotlightInjections(messages: Message[]): Message[] {
  return stripUserTextBlocksByPrefix(messages, [MEMORY_SPOTLIGHT_MATCHER]);
}

/** `<NOW.md>` scratchpad prefixes (current tag, pre-line-limit variant, legacy `<now_scratchpad>`) — shared with `stripNowScratchpad` so the two strip paths can't drift. */
export const NOW_SCRATCHPAD_STRIP_PREFIXES: InjectionMatcher[] = [
  "<NOW.md Always keep this up to date",
  "<now_scratchpad>",
];

/**
 * Matchers stripped by the pipeline (order doesn't matter — single pass).
 * Exported for read-only reuse by classifiers that need to distinguish
 * user-authored text from runtime-injected blocks (e.g. the flash-tier
 * triviality classifier in `agent/flash-tier.ts`).
 */
export const RUNTIME_INJECTION_PREFIXES: InjectionMatcher[] = [
  "<channel_capabilities>",
  "<channel_command_context>",
  "<disk_pressure_warning>",
  "<channel_turn_context>", // backward-compat: strip legacy separate channel blocks
  "<guardian_context>",
  "<inbound_actor_context>", // backward-compat: strip legacy separate actor blocks
  "<interface_turn_context>", // backward-compat: strip legacy separate interface blocks
  // NOTE: <turn_context> is intentionally NOT stripped — unified turn context
  // blocks persist in history so the assistant retains temporal/actor grounding.
  "<background_turn>",
  "<memory_context __injected>",
  "<memory_context>", // backward-compat: strip legacy blocks from pre-__injected history
  // The static `memory-v2-static` block (`<info>\n…</info>`) and the
  // dynamic activation block (`<memory>\n…</memory>`, plus legacy
  // `<memory __injected>…`) are both stripped so each compaction
  // re-injects the freshest essentials/threads/recent/buffer view and
  // re-runs the activation pipeline, matching the `<knowledge_base>`
  // cadence. The activation pipeline dedupes via `everInjected`, and
  // compaction handles aggregate growth, so accumulation does not cause
  // unbounded context growth. Both wrappers may appear in persisted rows.
  //
  // These two use the full `{ prefix, suffix }` wrapper shape (not a bare
  // prefix) so that user-authored text merely starting with `<memory>\n` or
  // `<info>\n` is never silently dropped during compaction/`/clean`. This
  // matches the full-wrapper requirement in `countMemoryPrefixBlocks`.
  { prefix: "<memory>\n", suffix: "\n</memory>" },
  { prefix: "<info>\n", suffix: "\n</info>" },
  // The memory-v3 ephemeral spotlight block. Normally strip-and-replaced every
  // turn by `stripSpotlightInjections`, but registered here too so compaction
  // and overflow recovery remove a stale spotlight along with the rest of the
  // runtime injections. Full-wrapper shape for the same reason as `<memory>`.
  MEMORY_SPOTLIGHT_MATCHER,
  // The `<spawned_work>` block is ephemeral (live statuses + run results) and
  // strip-and-replaced every turn; registered here too so compaction and
  // overflow recovery drop a stale copy along with the other injections.
  { prefix: "<spawned_work>", suffix: "</spawned_work>" },
  "<voice_call_control>",
  "<workspace_top_level>", // backward-compat: strip legacy workspace blocks
  // The `<workspace>` top-level block is stripped so each compaction re-injects
  // a fresh directory snapshot rather than carrying a stale listing into the
  // summary — matching the `<knowledge_base>`/`<NOW.md>` cadence and keeping the
  // `workspace-context` injector's presence detection in lockstep (the block is
  // present exactly when compaction would strip it). The full `{ prefix, suffix }`
  // wrapper shape ensures user-authored text merely starting with `<workspace>\n`
  // is never mistaken for an injected block.
  { prefix: "<workspace>\n", suffix: "\n</workspace>" },
  "<temporal_context>\nToday:", // backward-compat: strip legacy temporal blocks
  "<active_subagents>",
  "<active_workspace>",
  "<active_dynamic_page>",
  "<non_interactive_context>",
  ...NOW_SCRATCHPAD_STRIP_PREFIXES,
  "<knowledge_base>",
  "<pkb>", // backward-compat: strip legacy tag from pre-rename history
  "<system_reminder>",
  "<transport_hints>",
  // The Slack active-thread focus block is non-persisted and injected on
  // the FINAL user turn only. Strip it here so re-assembly during compaction
  // and overflow recovery does not duplicate it across turns.
  "<active_thread>",
  "<system_notice>One or more tool calls returned an error.",
];

/**
 * Matchers for the `<workspace>` top-level block (current wrapper shape plus
 * the legacy `<workspace_top_level>` tag). Shared by the per-turn
 * strip-and-replace ({@link stripWorkspaceInjections}) and the
 * `workspace-context` injector so the two sides recognize exactly the same
 * wrapper. Full `{ prefix, suffix }` shape so user-authored text merely
 * starting with `<workspace>\n` is never mistaken for an injection.
 */
export const WORKSPACE_BLOCK_MATCHERS: readonly InjectionMatcher[] = [
  { prefix: "<workspace>\n", suffix: "\n</workspace>" },
  "<workspace_top_level>",
];

/**
 * Remove `<workspace>` top-level blocks from every user message — and ONLY
 * those blocks. The workspace listing is ephemeral by contract: runtime
 * assembly strip-and-replaces it each turn at the message tail, so the
 * volatile directory snapshot never sits mid-history invalidating the
 * provider's prompt-cache prefix, and the model always sees exactly one
 * fresh copy on the current turn.
 */
export function stripWorkspaceInjections(messages: Message[]): Message[] {
  return stripUserTextBlocksByPrefix(messages, [...WORKSPACE_BLOCK_MATCHERS]);
}

/**
 * Full-wrapper matcher for the `<spawned_work>` block. Shared by the per-turn
 * strip-and-replace ({@link stripSpawnedWorkInjections}) and the compaction
 * pipeline so the two sides recognize exactly the same wrapper.
 */
export const SPAWNED_WORK_BLOCK_MATCHER: InjectionMatcher = {
  prefix: "<spawned_work>",
  suffix: "</spawned_work>",
};

/**
 * Remove `<spawned_work>` blocks from every user message — and ONLY those.
 *
 * This block is ephemeral by contract: it reports the LIVE status of the work
 * the conversation spawned ("running now", "finished — in the Review lane") and
 * the result text of anything finished. A copy left riding history from an
 * earlier turn would have the system asserting a state it can no longer back
 * up — the exact class of lie this product has had to fix three times. Runtime
 * assembly strips every copy whenever a fresh block is produced, so at most one
 * current view exists, on the current turn.
 */
export function stripSpawnedWorkInjections(messages: Message[]): Message[] {
  return stripUserTextBlocksByPrefix(messages, [SPAWNED_WORK_BLOCK_MATCHER]);
}

/**
 * Strip all runtime-injected context from message history in a single pass.
 *
 * Used only during compaction and overflow recovery — not on normal turns.
 * Runtime injections persist in history to keep the conversation prefix
 * stable for Anthropic's prefix caching. Stripping is only needed when
 * compaction rewrites the message array (cache miss is expected anyway).
 */
export function stripInjectionsForCompaction(messages: Message[]): Message[] {
  return stripUserTextBlocksByPrefix(messages, RUNTIME_INJECTION_PREFIXES);
}
