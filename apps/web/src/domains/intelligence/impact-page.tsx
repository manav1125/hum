import { useQuery } from "@tanstack/react-query";
import { Mail, Phone, Sparkles, TrendingUp } from "lucide-react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { homeImpactGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * Impact — "your week with Cue".
 *
 * The weekly recap: hours saved, tasks handled, where the time went, and a few
 * concrete things Cue did. Wired to GET /v1/home/impact (real recorded events),
 * so the numbers reflect actual work — drafts composed, emails triaged, etc.
 *
 * Placement note: the design treats Impact as a Core surface reached from
 * Home's "Recap" button. It's mounted under the Intelligence tabs for now so
 * it's discoverable; the final entry point is the Home recap link.
 */

const CATEGORY_LABEL: Record<string, string> = {
  email: "Email triage",
  meetings: "Meetings captured",
  scheduling: "Scheduling",
  calls: "Calls & errands",
  research: "Research",
  other: "Other",
};

function categoryIcon(category: string) {
  if (category === "calls") return Phone;
  if (category === "email") return Mail;
  return Sparkles;
}

export function ImpactPage() {
  const assistantId = useActiveAssistantId();
  const { data, isLoading } = useQuery({
    ...homeImpactGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { rangeDays: 7 },
    }),
    enabled: !!assistantId,
  });

  const hoursSaved = data?.hoursSaved ?? 0;
  const taskCount = data?.taskCount ?? 0;
  const byCategory = data?.byCategory ?? [];
  const recent = data?.recent ?? [];
  const maxHours = Math.max(0.1, ...byCategory.map((c) => c.hours));
  const empty = !isLoading && taskCount === 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      {/* Ink hero */}
      <header className="flex flex-col gap-3 rounded-2xl bg-[var(--surface-ink)] p-7 text-white">
        <span className="font-mono text-xs uppercase tracking-wide text-white/55">
          Your week with Cue
        </span>
        {empty ? (
          <>
            <h1 className="text-3xl font-semibold leading-tight">
              No time saved yet this week
            </h1>
            <p className="max-w-md text-base leading-relaxed text-white/70">
              As Cue drafts replies, triages your inbox, and handles tasks on
              your behalf, the hours it gives back show up here.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-semibold leading-tight">
              This week, Cue gave you back{" "}
              <span className="text-[var(--accent-cue-weak)]">
                {hoursSaved} {hoursSaved === 1 ? "hour" : "hours"}
              </span>
            </h1>
            <p className="max-w-md text-base leading-relaxed text-white/70">
              Across <span className="text-white">{taskCount}</span>{" "}
              {taskCount === 1 ? "task" : "tasks"} handled on your behalf
              {hoursSaved >= 8 ? " — more than a full workday returned to you." : "."}
            </p>
          </>
        )}
      </header>

      {!empty && (
        <>
          {/* Where the time went */}
          {byCategory.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <TrendingUp className="size-3.5" /> Where the time went
              </h2>
              <div className="flex flex-col gap-2.5">
                {byCategory.map((c) => (
                  <div key={c.category} className="flex items-center gap-3">
                    <span className="w-36 shrink-0 truncate text-sm text-foreground">
                      {CATEGORY_LABEL[c.category] ?? c.category}
                    </span>
                    <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-sky-500"
                        style={{
                          width: `${Math.max(4, (c.hours / maxHours) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground">
                      {c.hours} hrs
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* A few things Cue handled */}
          {recent.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                A few things Cue handled
              </h2>
              <div className="flex flex-col gap-2">
                {recent.map((r, i) => {
                  const Icon = categoryIcon(r.category);
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-xl border border-border bg-background p-3.5"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {r.detail}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
