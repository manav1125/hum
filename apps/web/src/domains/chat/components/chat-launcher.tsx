import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CalendarDays,
  FileText,
  Inbox,
  Mail,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { homeFeedGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { FeedItem } from "@vellumai/assistant-api";

/**
 * Chat launcher — the empty-state quick-start surface beneath the composer.
 *
 * Blends two things, per the product intent: a row of Cue capability CTAs
 * (what Cue can do for you) and your top open action-board items (pick up
 * where you left off). Both seed the composer (review-then-send) so free-text
 * stays the primary path and this stays uncluttered.
 *
 * Visible only on the empty state (the parent renders the starters slot there).
 */

const MODES: ReadonlyArray<{ icon: LucideIcon; label: string; seed: string }> = [
  { icon: Mail, label: "Draft a reply", seed: "Draft a reply to " },
  { icon: CalendarDays, label: "Plan my day", seed: "Plan my day from my calendar and inbox." },
  { icon: Inbox, label: "Triage inbox", seed: "Triage my inbox and flag anything that needs a reply." },
  { icon: Search, label: "Research", seed: "Research " },
  { icon: FileText, label: "Make a doc", seed: "Write a doc about " },
  { icon: Sparkles, label: "Brief me", seed: "Brief me on what's important right now." },
];

export function ChatLauncher({
  assistantId,
  onSeed,
}: {
  assistantId: string;
  onSeed: (text: string) => void;
}) {
  const { data } = useQuery({
    ...homeFeedGetOptions({
      path: { assistant_id: assistantId },
      query: { timeAwaySeconds: 0 },
    }),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  const openItems = ((data?.items ?? []) as FeedItem[])
    .filter(
      (i) =>
        i.id.startsWith("action-board:") &&
        !i.id.endsWith(":summary") &&
        i.title,
    )
    .slice(0, 3);

  return (
    <div className="mx-auto flex w-full max-w-[var(--chat-max-width)] flex-col gap-4 px-3 pt-2 sm:px-6">
      {/* capability CTAs */}
      <div className="flex flex-wrap justify-center gap-2">
        {MODES.map((m) => {
          const Icon = m.icon;
          return (
            <button
              key={m.label}
              type="button"
              onClick={() => onSeed(m.seed)}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-base)] bg-[var(--surface-overlay)] px-3 py-1.5 text-sm text-[var(--content-secondary)] transition-colors hover:border-[var(--border-active)] hover:text-[var(--content-default)]"
            >
              <Icon className="size-3.5" />
              {m.label}
            </button>
          );
        })}
      </div>

      {/* open action items — pick up where you left off */}
      {openItems.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-center font-[var(--font-mono)] text-[11px] uppercase tracking-wide text-[var(--content-tertiary)]">
            Pick up where you left off
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {openItems.map((it) => {
              const prompt =
                it.actions?.[0]?.prompt ?? `Help me with: ${it.title}`;
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => onSeed(prompt)}
                  className="group flex items-center justify-between gap-3 rounded-xl border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3 text-left transition-colors hover:border-[var(--border-active)]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[var(--content-default)]">
                      {it.title}
                    </div>
                    {it.summary && (
                      <div className="truncate text-xs text-[var(--content-tertiary)]">
                        {it.summary}
                      </div>
                    )}
                  </div>
                  <ArrowUpRight className="size-4 shrink-0 text-[var(--content-tertiary)] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
