/**
 * v28 · the four states that were missing.
 *
 * Design read the whole mobile set end to end and found that "what's missing
 * isn't a feature, it's the states around the features". These are those four,
 * plus the two rules that cut across every screen (swipe-back, and the reach
 * and haptic conventions each component honours at its own call sites).
 */
export {
  OfflineState,
  useOfflineQueue,
} from "./offline-state";
export {
  clearOfflineQueue,
  enqueueOfflineAction,
  flushOfflineQueue,
  hasOfflineReplay,
  offlineQueueSnapshot,
  queuedAgo,
  readOfflineQueue,
  registerOfflineReplay,
  subscribeOfflineQueue,
  undoOfflineAction,
  type FlushReport,
  type OfflineVerb,
  type QueuedAction,
} from "./offline-queue";
export {
  budgetLine,
  decideAndRecordPush,
  decidePush,
  dayKey,
  DEFAULT_QUIET_HOURS,
  isQuietHour,
  PUSH_DAILY_CEILING,
  readPushLedger,
  tierFor,
  writePushLedger,
  type PushDecision,
  type PushIntent,
  type PushLedger,
  type PushTier,
  type QuietHours,
} from "./push-budget";
export { DayOneState, DAY_ONE_CHIPS, type DayOneChip } from "./day-one-state";
export {
  isPullDownForSearch,
  Mv3PullSearch,
  PULL_SEARCH_THRESHOLD_PX,
  SearchOverlay,
} from "./pull-search";
export {
  DECISIONS_NOT_INDEXED,
  looksLikeQuestion,
  searchFromPhone,
  SEARCHABLE_CATEGORIES,
  type SearchOutcome,
  type SearchResult,
  type SearchResultKind,
} from "./search-source";
export {
  isSwipeBack,
  SWIPE_BACK_COMMIT_PX,
  SWIPE_BACK_EDGE_PX,
  useSwipeBack,
  type SwipeSample,
} from "./swipe-back";
