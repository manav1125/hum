import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  CalendarDays,
  FileText,
  Inbox,
  ListChecks,
  Loader2,
  Mail,
  MessageSquare,
  Search,
  ShieldAlert,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { toast } from "@vellumai/design-library/components/toast";

import { homeFeedByIdActionsByActionIdPost } from "@/generated/daemon/sdk.gen";
import {
  homeFeedGetOptions,
  homeFeedGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";
import type { FeedItem, FeedItemCategory } from "@vellumai/assistant-api";

/**
 * Channel-accurate icon for an open action-board item, mirroring the Home
 * queue's per-category iconography so the same item reads the same in both
 * places. Falls back to a neutral spark for uncategorised items.
 */
function categoryIcon(category: FeedItemCategory | undefined): LucideIcon {
  switch (category) {
    case "email":
      return Mail;
    case "scheduling":
      return CalendarDays;
    case "slack":
    case "telegram":
    case "whatsapp":
    case "chat":
      return MessageSquare;
    case "task":
      return ListChecks;
    case "security":
      return ShieldAlert;
    default:
      return Sparkles;
  }
}

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

const MODES: ReadonlyArray<{ icon: LucideIcon; label: string; seed: string }> =
  [
    { icon: Mail, label: "Draft a reply", seed: "Draft a reply to " },
    {
      icon: CalendarDays,
      label: "Plan my day",
      seed: "Plan my day from my calendar and inbox.",
    },
    {
      icon: Inbox,
      label: "Triage inbox",
      seed: "Triage my inbox and flag anything that needs a reply.",
    },
    { icon: Search, label: "Research", seed: "Research " },
    { icon: FileText, label: "Make a doc", seed: "Write a doc about " },
    {
      icon: Sparkles,
      label: "Brief me",
      seed: "Brief me on what's important right now.",
    },
  ];

export function ChatLauncher({
  assistantId,
  onSeed,
}: {
  assistantId: string;
  onSeed: (text: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [runningId, setRunningId] = useState<string | null>(null);

  const feedOpts = {
    path: { assistant_id: assistantId },
    query: { timeAwaySeconds: 0 },
  } as const;
  const { data } = useQuery({
    ...homeFeedGetOptions(feedOpts),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  const allOpen = ((data?.items ?? []) as FeedItem[]).filter(
    (i) =>
      i.id.startsWith("action-board:") &&
      !i.id.endsWith(":summary") &&
      i.title,
  );
  const openItems = allOpen.slice(0, 3);
  const openCount = allOpen.length;

  // Execute an open item's primary action directly, the same way Home's
  // next-move card does. `mode: "smart"` lets the daemon route off the
  // action's category + the autonomy policy: reversible work (draft, research)
  // runs autonomously in the background; consequential actions (send, pay,
  // approve, delete) are queued for approval rather than fired — so a single
  // tap here never sends or spends. Thread-routed actions open a foreground
  // conversation. Falls back to seeding the composer only when an action
  // carries a prompt but no id (defensive — older feed payloads).
  const triggerAction = useMutation({
    mutationFn: async (vars: { itemId: string; actionId: string }) => {
      const { data: result } = await homeFeedByIdActionsByActionIdPost({
        path: {
          assistant_id: assistantId,
          id: vars.itemId,
          actionId: vars.actionId,
        },
        body: { mode: "smart" },
        throwOnError: true,
      });
      return result;
    },
    onSettled: () => {
      setRunningId(null);
      void queryClient.invalidateQueries({
        queryKey: homeFeedGetQueryKey(feedOpts),
      });
    },
  });

  const runItem = (it: FeedItem) => {
    const action = it.actions?.[0];
    if (!action?.id) {
      onSeed(action?.prompt ?? `Help me with: ${it.title}`);
      return;
    }
    setRunningId(it.id);
    triggerAction.mutate(
      { itemId: it.id, actionId: action.id },
      {
        onSuccess: (result) => {
          const r = result as {
            mode?: string;
            conversationId?: string;
            workItemId?: string;
          } | null;
          if (r?.mode === "thread" && r.conversationId) {
            void navigate(routes.conversation(r.conversationId));
          } else if (r?.mode === "background") {
            toast.success("Running in the background — track it in Activity.", {
              action: {
                label: "View in Activity",
                onClick: () => void navigate(routes.activity),
              },
            });
          } else if (r?.mode === "needs_you") {
            toast.success("Queued — it'll wait for your approval in Activity.", {
              action: {
                label: "Review in Activity",
                onClick: () => void navigate(routes.activity),
              },
            });
          }
        },
        onError: () => {
          toast.error("I couldn't start that. Try again?");
        },
      },
    );
  };

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

      {/* open action items — your real work, surfaced as one-tap actions.
          Tapping a card runs its primary action via the daemon's autonomy
          policy (`mode: "smart"`): reversible work runs in the background,
          consequential actions queue for approval, thread-routed ones open a
          conversation. The labelled pill is the action Cue will take. */}
      {openItems.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <div className="text-center text-sm text-[var(--content-secondary)]">
            Before you start —{" "}
            <span className="font-medium text-[var(--content-default)]">
              {openCount} {openCount === 1 ? "thing needs" : "things need"} you
            </span>{" "}
            right now.
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {openItems.map((it) => {
              const action = it.actions?.[0];
              const Icon = categoryIcon(it.category);
              const urgent =
                it.urgency === "high" || it.urgency === "critical";
              const running = runningId === it.id;
              return (
                <button
                  key={it.id}
                  type="button"
                  disabled={running}
                  onClick={() => runItem(it)}
                  title={action ? action.label : undefined}
                  className={`group flex items-center gap-3 rounded-xl border bg-[var(--surface-overlay)] p-3 text-left transition-colors hover:border-[var(--border-active)] disabled:opacity-70 ${
                    urgent
                      ? "border-[var(--accent-cue)]"
                      : "border-[var(--border-base)]"
                  }`}
                >
                  <span
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      background:
                        "color-mix(in srgb, var(--accent-cue) 12%, transparent)",
                      color: "var(--accent-cue-strong)",
                    }}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--content-default)]">
                      {it.title}
                    </div>
                    {it.summary && (
                      <div className="truncate text-xs text-[var(--content-tertiary)]">
                        {it.summary}
                      </div>
                    )}
                  </div>
                  {action && (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-base)] px-2.5 py-1 text-xs font-medium text-[var(--content-inset)] transition-opacity group-hover:opacity-90">
                      {running && (
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                      )}
                      {running ? "Starting…" : action.label}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
