import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Mail, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { homeImpactGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";
import { selectNextMove, selectNoticed } from "@/domains/home/utils";
import { routes } from "@/utils/routes";
import type { FeedItem } from "@vellumai/assistant-api";

/**
 * Home — the elevated, design-matched surface.
 *
 * The editorial "one move right now" lead, a drafted-for-you next-move card,
 * open commitments, and a "while you slept" recap that links to Impact. Wired
 * to the same proven data hooks as the classic Home (feed query + selectors)
 * plus the impact summary. Built to match `surfaces/Home.dc.html`.
 *
 * Mounted at the Home route; the previous Home lives on in `home-page.tsx` /
 * `home-page-route.tsx` as a one-line fallback if needed.
 */
export function HomeElevatedRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();
  const feedQuery = useHomeFeedQuery(assistantId);
  const impactQuery = useQuery({
    ...homeImpactGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { rangeDays: 7 },
    }),
    enabled: !!assistantId,
  });

  const items = feedQuery.data?.items ?? [];
  // Only the proactive action-board cards drive the "one move" + commitments.
  const boardItems = items.filter((i) => i.id.startsWith("action-board:"));
  const nextMove = selectNextMove(boardItems);
  const commitments = selectNoticed(boardItems, nextMove?.id ?? undefined, 4);
  const greeting = feedQuery.data?.contextBanner?.greeting ?? "Welcome back";
  const handledOvernight = impactQuery.data?.taskCount ?? 0;

  const seedChat = (prompt: string) => {
    useViewerStore.getState().setMainView("chat");
    const id = createDraftConversationId();
    useConversationStore.getState().setActiveConversationId(id);
    navigate(`${routes.conversation(id)}?prompt=${encodeURIComponent(prompt)}`);
    requestComposerFocus();
  };

  const primaryAction = (item: FeedItem): { label: string; prompt: string } | null => {
    const a = item.actions?.[0];
    return a ? { label: a.label, prompt: a.prompt } : null;
  };

  const isEmail = (item: FeedItem) => item.category === "email";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-8 py-10">
        {/* meta line */}
        <div className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          {greeting}
          {handledOvernight > 0 && (
            <>
              {" · "}
              <span className="text-foreground">
                {handledOvernight} handled
              </span>{" "}
              this week
            </>
          )}
        </div>

        {/* editorial one-move hero */}
        <h1
          className="text-3xl leading-tight text-foreground"
          style={{ fontFamily: '"Instrument Serif", Georgia, serif' }}
        >
          {nextMove ? (
            <>
              Your one move right now is{" "}
              <span className="text-sky-600">{nextMove.title}</span>.
            </>
          ) : (
            <>You&apos;re all caught up. Nothing needs you right now.</>
          )}
        </h1>

        {/* next-move card */}
        {nextMove && (
          <section className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
            <div className="flex flex-col gap-3 p-5">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-sky-600">
                  {isEmail(nextMove) ? (
                    <>
                      <Mail className="size-3" /> Drafted for you
                    </>
                  ) : (
                    <>Next move</>
                  )}
                </span>
                {nextMove.urgency && (
                  <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                    {nextMove.urgency}
                  </span>
                )}
              </div>
              <div>
                <div className="text-lg font-semibold text-foreground">
                  {nextMove.title}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {nextMove.summary}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {primaryAction(nextMove) && (
                  <button
                    type="button"
                    onClick={() => seedChat(primaryAction(nextMove)!.prompt)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-600"
                  >
                    {primaryAction(nextMove)!.label}
                    <ArrowRight className="size-4" />
                  </button>
                )}
                {nextMove.conversationId && (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(routes.conversation(nextMove.conversationId!))
                    }
                    className="rounded-lg border border-border px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Open
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {/* open commitments */}
        {commitments.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Open commitments
            </h2>
            <div className="flex flex-col gap-2">
              {commitments.map((item) => {
                const action = primaryAction(item);
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {item.title}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {item.summary}
                      </div>
                    </div>
                    {action && (
                      <button
                        type="button"
                        onClick={() => seedChat(action.prompt)}
                        className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/50"
                      >
                        {action.label}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* while you slept — recap -> Impact */}
        <button
          type="button"
          onClick={() => navigate(routes.impact)}
          className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--surface-ink)] p-5 text-left text-white transition-opacity hover:opacity-95"
        >
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10">
              <Sparkles className="size-4" />
            </span>
            <div>
              <div className="text-sm font-semibold">While you slept</div>
              <div className="text-xs text-white/70">
                {handledOvernight > 0
                  ? `Cue handled ${handledOvernight} ${handledOvernight === 1 ? "task" : "tasks"} for you this week`
                  : "Your weekly recap of everything Cue handled"}
              </div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-white/80">
            Full recap <ArrowRight className="size-4" />
          </span>
        </button>

        {boardItems.length === 0 && !feedQuery.isLoading && (
          <div className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
            <Check className="size-4 text-emerald-500" /> Nothing on the board
            yet today — Cue builds it each morning from your inbox and calendar.
          </div>
        )}
      </div>
    </div>
  );
}
