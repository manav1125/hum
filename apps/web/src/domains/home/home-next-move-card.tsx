import { ArrowRight } from "lucide-react";

import type { FeedItem } from "@vellumai/assistant-api";
import { Chip, FocusCard } from "@vellumai/design-library";

interface HomeNextMoveCardProps {
  item: FeedItem;
  onSelect: (item: FeedItem) => void;
}

/**
 * The Home "Next move" hero — Cue's most-urgent surface. Renders the top
 * high/critical-urgency feed item (picked by `selectNextMove`) as the ink
 * FocusCard from the design book ("Next: review the Acme follow-up"). These
 * items are excluded from the recap feed, so this is the only place they show.
 */
export function HomeNextMoveCard({ item, onSelect }: HomeNextMoveCardProps) {
  const title = item.title ?? item.summary;
  const supporting = item.title ? item.summary : undefined;

  return (
    <FocusCard
      eyebrow="Next move"
      title={title}
      actions={
        <Chip rightIcon={<ArrowRight />} onClick={() => onSelect(item)}>
          Open
        </Chip>
      }
    >
      {supporting}
    </FocusCard>
  );
}
