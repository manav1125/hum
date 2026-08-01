/**
 * On-demand revalidation for LLM-generated home page content.
 *
 * The personalized greeting and assistant-generated suggestion prompts
 * are served from caches (see `home-greeting-cache.ts` and
 * `suggested-prompts.ts`). The GET handler stays read-only; when a
 * client fetches the home feed it calls `revalidateHomeContentInBackground()`
 * fire-and-forget, which regenerates whichever caches are stale and
 * publishes a `home_feed_updated` event when fresh content lands so
 * connected clients refetch and the personalized content swaps in.
 *
 * This keeps LLM cost proportional to actual Home usage: nothing
 * generates at daemon startup or on a timer, and the per-cache TTLs
 * (4 hours each) bound how often a regeneration can happen.
 */

import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { maybeBuildActionBoardForToday } from "./action-board.js";
import { refreshPersonalizedGreeting } from "./home-greeting.js";
import { refreshAssistantSuggestedPrompts } from "./suggested-prompts.js";

const log = getLogger("home-content-refresh");

let inFlight: Promise<void> | null = null;

// In-memory safety net, independent of the DB-backed per-cache TTLs. The
// greeting/prompt caches persist their "generated at" timestamp in
// `memory_checkpoints`; if that write ever fails (e.g. SQLite "database is
// locked" under contention), the TTL check always reads "stale" and EVERY
// home-feed fetch would trigger a fresh LLM generation — turning a few
// regenerations a day into hundreds. This floor caps regeneration frequency
// process-wide regardless of cache health, so a broken cache degrades to
// "regenerates at most every 30 min" instead of "regenerates on every poll".
const REVALIDATE_COOLDOWN_MS = 30 * 60_000;
let lastRevalidateStartedAt = 0;

/**
 * Clear the process-wide cooldown. Tests only.
 *
 * The floor above is deliberately module-level state with no injected clock, so
 * a test that wants to observe a second revalidation has no other way to get
 * past it. Exposing this beats the alternative the tests previously relied on,
 * which was the cooldown not existing yet.
 */
export function resetRevalidateCooldownForTests(): void {
  lastRevalidateStartedAt = 0;
}

async function revalidateAll(): Promise<void> {
  const [greetingRefreshed, promptsRefreshed] = await Promise.all([
    refreshPersonalizedGreeting(),
    refreshAssistantSuggestedPrompts(),
  ]);

  if (!greetingRefreshed && !promptsRefreshed) {
    return;
  }

  await assistantEventHub.publish(
    buildAssistantEvent({
      type: "home_feed_updated",
      updatedAt: new Date().toISOString(),
      newItemCount: 0,
    }),
  );
}

/**
 * Regenerate stale home content in the background. Returns immediately;
 * callers (the home feed GET handler) must not await generation. Both
 * refreshers no-op when their cache is fresh, so calling this on every
 * feed fetch is cheap — at most one generation per cache TTL window.
 * Concurrent calls share a single in-flight revalidation.
 */
export function revalidateHomeContentInBackground(): void {
  // The daily action board has its own once-per-day + in-flight guards, so
  // kick it off independently of the greeting/prompts revalidation. It builds
  // at most once per local day (the board's summary card on disk gates it),
  // so calling it on every feed fetch is cheap after the first build.
  void maybeBuildActionBoardForToday().catch((err) => {
    log.warn({ err }, "Action board background build failed");
  });

  if (inFlight) {
    return;
  }
  // Cooldown floor: skip if a revalidation started within the window. Guards
  // against a failed persistent cache regenerating on every feed fetch.
  if (Date.now() - lastRevalidateStartedAt < REVALIDATE_COOLDOWN_MS) {
    return;
  }
  lastRevalidateStartedAt = Date.now();
  inFlight = revalidateAll()
    .catch((err) => {
      log.warn({ err }, "Home content revalidation failed");
    })
    .finally(() => {
      inFlight = null;
    });
}
