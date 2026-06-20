/**
 * Sequences — active drip enrollments (`sequencesListPost`, body `{ status }`).
 *
 * The 200 body is typed `unknown` (see SequencesListPostResponses) and only a
 * mutation is generated, so we wrap the raw sdk call in `useQuery` and narrow
 * defensively (array, or under a `sequences`/`enrollments`/`items` key). Steer:
 * Pause (`sequencesPausePost`) / Resume (`sequencesResumePost`), both bodied
 * `{ id }`. Provenance is honestly "drip sequence". When nothing narrows we
 * render nothing (this section is hidden unless there are active sequences) —
 * but if the daemon returns opaque rows we degrade to a count line.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";

import {
  sequencesPausePostMutation,
  sequencesResumePostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { sequencesListPost } from "@/generated/daemon/sdk.gen";

import { ActivitySection } from "../activity-section";
import { ActivityRow, RowButton } from "../activity-row";
import { asRecord, num, str } from "../theme";

interface SequenceView {
  id: string;
  label: string;
  detail: string | null;
  status: string;
  count: number | null;
}

function narrow(raw: unknown): SequenceView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = str(rec.id) ?? str(rec.sequenceId) ?? str(rec.enrollmentId);
  if (!id) return null;
  const label =
    str(rec.name) ?? str(rec.title) ?? str(rec.sequenceName) ?? "Sequence";
  const detail =
    str(rec.description) ?? str(rec.contact) ?? str(rec.target) ?? null;
  const status = str(rec.status) ?? "active";
  const count =
    num(rec.enrolledCount) ?? num(rec.activeCount) ?? num(rec.count) ?? null;
  return { id, label, detail, status, count };
}

function extract(data: unknown): { rows: SequenceView[]; rawCount: number } {
  let list: unknown[] = [];
  if (Array.isArray(data)) {
    list = data;
  } else {
    const rec = asRecord(data);
    if (rec) {
      if (Array.isArray(rec.sequences)) list = rec.sequences;
      else if (Array.isArray(rec.enrollments)) list = rec.enrollments;
      else if (Array.isArray(rec.items)) list = rec.items;
      else if (Array.isArray(rec.data)) list = rec.data;
    }
  }
  const rows: SequenceView[] = [];
  for (const row of list) {
    const v = narrow(row);
    if (v) rows.push(v);
  }
  return { rows, rawCount: list.length };
}

export function SequencesSection({ assistantId }: { assistantId: string }) {
  const query = useQuery({
    queryKey: ["activity", "sequences", assistantId],
    queryFn: async () => {
      const res = await sequencesListPost({
        path: { assistant_id: assistantId },
        body: { status: "active" },
        throwOnError: true,
      });
      return res.data;
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const pause = useMutation({
    ...sequencesPausePostMutation(),
    onSuccess: () => query.refetch(),
  });
  const resume = useMutation({
    ...sequencesResumePostMutation(),
    onSuccess: () => query.refetch(),
  });
  const mutating = pause.isPending || resume.isPending;

  const { rows, rawCount } = extract(query.data);

  // Hidden surface: with no active sequences and no error, render nothing so
  // the page stays focused. (Empty drip programs are the common case.)
  if (!query.isLoading && !query.isError && rawCount === 0) return null;

  const opaque = rawCount > 0 && rows.length === 0;

  return (
    <ActivitySection
      icon={Workflow}
      title="Sequences"
      accent="#534AB7"
      count={rows.length}
      loading={query.isLoading}
      loadingLabel="Loading sequences…"
      error={query.isError}
      empty={false}
      emptyLabel="No active sequences."
    >
      {opaque ? (
        <div style={{ padding: "14px 14px", fontSize: 13, color: "#5A6672" }}>
          {rawCount} active sequence{rawCount === 1 ? "" : "s"} running.
        </div>
      ) : (
        rows.map((s, i) => {
          const paused = s.status.toLowerCase() === "paused";
          return (
            <ActivityRow
              key={s.id}
              dotColor={paused ? "#8D99A5" : "#7F77DD"}
              title={s.label}
              subtitle={s.detail}
              provenance="drip sequence"
              meta={s.count != null ? `${s.count} enrolled` : null}
              statusLabel={paused ? "paused" : "active"}
              statusTone={paused ? "neutral" : "violet"}
              last={i === rows.length - 1}
              actions={
                paused ? (
                  <RowButton
                    label="Resume"
                    variant="primary"
                    disabled={mutating}
                    onClick={() =>
                      resume.mutate({
                        path: { assistant_id: assistantId },
                        body: { id: s.id },
                      })
                    }
                  />
                ) : (
                  <RowButton
                    label="Pause"
                    disabled={mutating}
                    onClick={() =>
                      pause.mutate({
                        path: { assistant_id: assistantId },
                        body: { id: s.id },
                      })
                    }
                  />
                )
              }
            />
          );
        })
      )}
    </ActivitySection>
  );
}
