import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import type { FeedItem } from "@vellumai/assistant-api";
import { Chip, FocusCard, Nudge } from "@vellumai/design-library";
import { HomeNextMoveCard } from "./home-next-move-card";

function RailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <h4 className="mb-[var(--app-spacing-sm)] font-mono text-label-medium-default uppercase tracking-[0.08em] text-[var(--content-tertiary)]">
        {title}
      </h4>
      {children}
    </section>
  );
}

export interface HomeNowRailProps {
  nextMove: FeedItem | null;
  noticed: FeedItem[];
  onSelect: (item: FeedItem) => void;
}

/**
 * The Home "Now rail" (design book / CUE-SPEC §3, the right 312px column):
 * the focus FocusCard, what Cue noticed, and tasks from your last meeting.
 *
 * Focus + noticed are the high-urgency items excluded from the recap feed, so
 * they surface here without duplicating the feed. The meeting section is an
 * honest empty state until meeting capture (v0.3) lands. Hidden below the
 * three-column breakpoint — the mobile layout drops the rail.
 */
export function HomeNowRail({ nextMove, noticed, onSelect }: HomeNowRailProps) {
  return (
    <aside className="hidden w-[312px] shrink-0 flex-col gap-[var(--app-spacing-xl)] overflow-y-auto border-l border-[var(--border-base)] bg-[var(--surface-base)] px-[var(--app-spacing-lg)] py-[var(--app-spacing-lg)] lg:flex">
      <RailSection title="Now · focus">
        {nextMove ? (
          <HomeNextMoveCard item={nextMove} onSelect={onSelect} />
        ) : (
          <FocusCard eyebrow="Next move" title="Nothing due">
            You&apos;re all caught up — I&apos;ll surface the next move the moment
            something comes in.
          </FocusCard>
        )}
      </RailSection>

      {noticed.length > 0 ? (
        <RailSection title="Cue noticed">
          <div className="flex flex-col gap-[var(--app-spacing-sm)]">
            {noticed.map((item) => (
              <Nudge
                key={item.id}
                tone="info"
                title={item.title ?? item.summary}
                actions={
                  <Chip
                    size="sm"
                    rightIcon={<ArrowRight />}
                    onClick={() => onSelect(item)}
                  >
                    Open
                  </Chip>
                }
              />
            ))}
          </div>
        </RailSection>
      ) : null}

      <RailSection title="From your last meeting">
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          No meeting captured yet. Take Cue into a meeting and the action items
          land here.
        </p>
      </RailSection>
    </aside>
  );
}
