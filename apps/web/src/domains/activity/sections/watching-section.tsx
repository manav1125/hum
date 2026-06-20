/**
 * Watching — the live watchers (Gmail / Calendar / GitHub / Linear / …).
 *
 * `watchersListPost` is a POST whose 200 body is typed `{ [key: string]:
 * unknown }` — opaque — and only a mutation is generated. We wrap the raw sdk
 * call in `useQuery` (queryFn → `watchersListPost({ throwOnError: true })`) and
 * narrow defensively: watchers may arrive as an array or under a `watchers`/
 * `items` key. Each row shows what it watches + last activity; a Digest action
 * (`watchersDigestPost({ watcher_id })`) runs when we have an id. Provenance is
 * honestly the watcher's source/type (e.g. "gmail", "github") read off the
 * payload, or omitted when absent. If the whole payload is unreadable we
 * degrade to an honest count line.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";

import { watchersDigestPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { watchersListPost } from "@/generated/daemon/sdk.gen";

import { ActivitySection } from "../activity-section";
import { ActivityRow, RowButton } from "../activity-row";
import { asRecord, bool, num, relativeTime, str } from "../theme";

interface WatcherView {
  id: string | null;
  label: string;
  watches: string | null;
  source: string | null;
  enabled: boolean;
  lastAt: number | null;
}

function narrow(raw: unknown): WatcherView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id =
    str(rec.id) ?? str(rec.watcher_id) ?? str(rec.watcherId) ?? str(rec.uuid);
  const source =
    str(rec.source) ?? str(rec.type) ?? str(rec.provider) ?? str(rec.kind);
  const label =
    str(rec.name) ?? str(rec.label) ?? source ?? str(rec.id) ?? "Watcher";
  const watches =
    str(rec.description) ??
    str(rec.query) ??
    str(rec.filter) ??
    str(rec.target) ??
    str(rec.watches) ??
    null;
  const lastAt =
    num(rec.lastActivityAt) ??
    num(rec.lastEventAt) ??
    num(rec.lastRunAt) ??
    num(rec.updatedAt) ??
    null;
  // Default to enabled when the field is absent — watchers in the list are
  // generally active; we only mark "paused" when the payload explicitly says so.
  const enabled = bool(rec.enabled) ?? bool(rec.active) ?? true;
  if (!label) return null;
  return { id, label, watches, source, enabled, lastAt };
}

/** Pull the watcher array out of whatever envelope the daemon returned. */
function extractWatchers(data: unknown): { rows: WatcherView[]; rawCount: number } {
  let list: unknown[] = [];
  if (Array.isArray(data)) {
    list = data;
  } else {
    const rec = asRecord(data);
    if (rec) {
      if (Array.isArray(rec.watchers)) list = rec.watchers;
      else if (Array.isArray(rec.items)) list = rec.items;
      else if (Array.isArray(rec.data)) list = rec.data;
      else {
        // Map-of-watchers fallback: object values that look like watcher records.
        list = Object.values(rec).filter((v) => asRecord(v) !== null);
      }
    }
  }
  const rows: WatcherView[] = [];
  for (const row of list) {
    const v = narrow(row);
    if (v) rows.push(v);
  }
  return { rows, rawCount: list.length };
}

export function WatchingSection({ assistantId }: { assistantId: string }) {
  const query = useQuery({
    queryKey: ["activity", "watchers", assistantId],
    queryFn: async () => {
      const res = await watchersListPost({
        path: { assistant_id: assistantId },
        body: {},
        throwOnError: true,
      });
      return res.data;
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const digest = useMutation({ ...watchersDigestPostMutation() });

  const { rows, rawCount } = extractWatchers(query.data);
  const empty = !query.isLoading && !query.isError && rawCount === 0;
  // Daemon returned data but nothing narrowed to a readable watcher.
  const opaque = rawCount > 0 && rows.length === 0;

  return (
    <ActivitySection
      icon={Eye}
      title="Watching"
      accent="#8C7225"
      count={rows.length}
      loading={query.isLoading}
      loadingLabel="Loading watchers…"
      error={query.isError}
      empty={empty}
      emptyLabel="No watchers yet — connect Gmail, Calendar, GitHub or Linear and Cue will watch them for you."
    >
      {opaque ? (
        <div style={{ padding: "14px 14px", fontSize: 13, color: "#5A6672" }}>
          {rawCount} watcher{rawCount === 1 ? "" : "s"} active — Cue is watching
          your connected sources in the background.
        </div>
      ) : (
        rows.map((w, i) => {
          const last = relativeTime(w.lastAt);
          return (
            <ActivityRow
              key={w.id ?? `${w.label}-${i}`}
              dotColor={w.enabled ? "#C98A1B" : "#8D99A5"}
              title={w.label}
              subtitle={w.watches}
              provenance={w.source}
              meta={last ? `last activity ${last}` : null}
              statusLabel={w.enabled ? "watching" : "paused"}
              statusTone={w.enabled ? "amber" : "neutral"}
              last={i === rows.length - 1}
              actions={
                w.id ? (
                  <RowButton
                    label={digest.isPending ? "…" : "Digest"}
                    disabled={digest.isPending}
                    onClick={() =>
                      digest.mutate({
                        path: { assistant_id: assistantId },
                        body: { watcher_id: w.id ?? undefined },
                      })
                    }
                  />
                ) : null
              }
            />
          );
        })
      )}
    </ActivitySection>
  );
}
