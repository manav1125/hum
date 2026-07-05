import { ConversationStarterChip } from "@/domains/chat/components/conversation-starter-chip";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import { MAX_CONVERSATION_STARTER_CHIPS } from "@/domains/chat/utils/empty-state-constants";

export interface ConversationStarterGridProps {
  /**
   * Starters to render. Server returns these in strongest-first order; we
   * preserve that order and drop any items beyond {@link maxVisible}.
   */
  starters: readonly ConversationStarter[];
  /** Invoked with the full starter object when a chip is clicked. */
  onSelect: (starter: ConversationStarter) => void;
  /**
   * Maximum number of chips rendered. Items beyond this cap are dropped.
   * Defaults to {@link MAX_CONVERSATION_STARTER_CHIPS}.
   */
  maxVisible?: number;
}

/**
 * Centered flex-wrap row of up to `maxVisible` conversation-starter pills for
 * the chat empty state (Cue-Surfaces S6). The strongest starter (server
 * returns these first) is emphasized as the filled "primary suggestion" pill.
 * Empty input renders nothing (returns `null`) so callers can drop the wrapper
 * unconditionally without producing an empty box.
 */
export function ConversationStarterGrid({
  starters,
  onSelect,
  maxVisible = MAX_CONVERSATION_STARTER_CHIPS,
}: ConversationStarterGridProps) {
  const visible = starters.slice(0, maxVisible);
  if (visible.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {visible.map((starter, i) => (
        <ConversationStarterChip
          key={starter.id}
          label={starter.label}
          emphasized={i === 0}
          onSelect={() => onSelect(starter)}
          aria-label={`Send: ${starter.label}`}
        />
      ))}
    </div>
  );
}
