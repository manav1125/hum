/**
 * Data layer for the Automations surfaces (WS-F) — watchers + playbooks.
 *
 * Every call goes to the per-assistant route (`/v1/assistants/{id}/watchers/*`,
 * `/v1/playbooks/*`), which is what the generated SDK exposes and — critically —
 * the ONLY shape the self-hosted auth interceptor recognises: it matches
 * `/v1/assistants/{id}/…` and attaches the bearer token. These hooks used to
 * post to bare `/v1/watchers/list`, which slipped past that matcher, went out
 * with NO Authorization header, and came back 401 — so on a self-hosted
 * instance every watcher and playbook read, create, update and delete failed
 * silently and the surface rendered a confident "0 watchers".
 *
 * The playbook list carries the server-computed effective autonomy + the global
 * trust dial, so the UI never recomputes the cap — it renders exactly what the
 * server enforces.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { client } from "@/generated/daemon/client.gen";

export type GlobalDial = "observe" | "assist" | "autonomous";
export type Autonomy = "auto" | "draft" | "notify";
/**
 * `not_connected` is deliberately distinct from `reauth`: "reconnect to
 * resume" is the wrong sentence for an account that was never connected.
 *
 * `not_watching` is distinct from both: the daemon reports it when a provider
 * says its config cannot produce, and connecting an account would not fix it.
 * It outranks every credential answer including 'ok', because a green dot on a
 * watcher that can never hit is the exact lie the state exists to stop.
 */
export type WatcherHealth =
  | "ok"
  | "reauth"
  | "unknown"
  | "not_connected"
  | "not_watching";

/** What a watcher is pointed at, as the daemon's provider describes it. */
export interface WatcherScope {
  watching: boolean;
  summary: string;
  fix?: string;
}

export interface Watcher {
  id: string;
  name: string;
  providerId: string;
  enabled: boolean;
  pollIntervalMs: number;
  intakeMode: string;
  watermark: string | null;
  status: string;
  lastPollAt: number | null;
  lastError: string | null;
  configJson: string | null;
  credentialService: string;
  health: WatcherHealth;
  /**
   * What the watcher is pointed at, and what it has actually produced.
   *
   * Optional because a client can be newer than the daemon it is talking to,
   * and a card must degrade to saying less rather than to guessing. `scope` is
   * the target; `hitCount`/`lastHitAt` are the output. Every surface had to
   * substitute `lastPollAt` for these before the daemon sent them — which is
   * how an account-wide GitHub watcher with zero events read as "hit 2m ago"
   * for a day and a half.
   */
  scope?: WatcherScope;
  hitCount?: number;
  lastHitAt?: number | null;
  createdAt?: number;
}

export interface Playbook {
  id: string;
  name: string;
  triggerText: string;
  channel: string;
  watcherId: string | null;
  action: string;
  autonomyLevel: Autonomy;
  priority: number;
  enabled: boolean;
  lastFiredAt: number | null;
  effectiveAutonomy: Autonomy;
  autonomyCeiling: Autonomy;
  autonomyCapped: boolean;
  globalDial: GlobalDial;
}

export interface WatcherProvider {
  id: string;
  displayName: string;
  requiredCredentialService: string;
}

/**
 * POST a daemon automations route for one assistant.
 *
 * `path` is the route tail ("watchers/list"); the assistant prefix is added
 * here so no call site can reintroduce the unauthenticated bare form.
 */
async function post<T>(
  assistantId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `/v1/assistants/${assistantId}/${path}`;
  const { data, response } = await client.post({ url, body });
  if (!response?.ok) {
    throw new Error(`${path} failed (${response?.status ?? "?"})`);
  }
  return data as T;
}

export function useWatchers() {
  const assistantId = useActiveAssistantId();
  return useQuery({
    queryKey: ["automations", "watchers", assistantId],
    queryFn: () => post<Watcher[]>(assistantId!, "watchers/list", {}),
    enabled: Boolean(assistantId),
    staleTime: 15_000,
  });
}

export function usePlaybooks() {
  const assistantId = useActiveAssistantId();
  return useQuery({
    queryKey: ["automations", "playbooks", assistantId],
    queryFn: () =>
      post<{ globalDial: GlobalDial; playbooks: Playbook[] }>(
        assistantId!,
        "playbooks/list",
        {},
      ),
    enabled: Boolean(assistantId),
    staleTime: 15_000,
  });
}

export function useWatcherProviders() {
  const assistantId = useActiveAssistantId();
  return useQuery({
    queryKey: ["automations", "providers", assistantId],
    queryFn: () =>
      post<WatcherProvider[]>(assistantId!, "watchers/providers", {}),
    enabled: Boolean(assistantId),
    staleTime: 5 * 60_000,
  });
}

export function useToggleWatcher() {
  const assistantId = useActiveAssistantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      post(assistantId!, "watchers/update", {
        watcher_id: vars.id,
        enabled: vars.enabled,
      }),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["automations", "watchers"] }),
  });
}

export function useCreateWatcher() {
  const assistantId = useActiveAssistantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      provider: string;
      poll_interval_ms?: number;
      config?: Record<string, unknown>;
    }) =>
      post(assistantId!, "watchers/create", {
        ...vars,
        intake_mode: "came_in",
      }),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["automations", "watchers"] }),
  });
}

export function useDeleteWatcher() {
  const assistantId = useActiveAssistantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      post(assistantId!, "watchers/delete", { watcher_id: id }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["automations", "watchers"] });
      void qc.invalidateQueries({ queryKey: ["automations", "playbooks"] });
    },
  });
}

export function useCreatePlaybook() {
  const assistantId = useActiveAssistantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      trigger_text: string;
      action: string;
      channel?: string;
      watcher_id?: string | null;
      autonomy_level: Autonomy;
      priority: number;
    }) => post(assistantId!, "playbooks/create", vars),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["automations", "playbooks"] }),
  });
}

export function useTogglePlaybook() {
  const assistantId = useActiveAssistantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      post(assistantId!, "playbooks/update", {
        playbook_id: vars.id,
        enabled: vars.enabled,
      }),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["automations", "playbooks"] }),
  });
}

export function useDeletePlaybook() {
  const assistantId = useActiveAssistantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      post(assistantId!, "playbooks/delete", { playbook_id: id }),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["automations", "playbooks"] }),
  });
}

// ── Presentation helpers ──────────────────────────────────────────────

export function intervalLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return `every ${Math.round(ms / 1000)}s`;
  if (min < 60) return `every ${min} min`;
  const hr = Math.round(min / 60);
  return `every ${hr}h`;
}

export function agoLabel(epoch: number | null): string | null {
  if (!epoch) return null;
  const s = Math.max(0, Math.round((Date.now() - epoch) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "3 days" / "7 hours" / "20 minutes" — an elapsed span, not a timestamp. */
export function durationLabel(since: number | null | undefined): string | null {
  if (!since) return null;
  const m = Math.max(0, Math.round((Date.now() - since) / 60_000));
  if (m < 60) return m <= 1 ? "the last minute" : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? "an hour" : `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/**
 * What a watcher has produced, said without ever calling a poll a hit.
 *
 * The old line read `Last hit ${agoLabel(lastPollAt)}` — the poll clock under a
 * hit's label. In production that rendered "Last hit 2m ago" on a watcher that
 * had recorded zero events in a day and a half of polling, on both the desktop
 * board and the mobile leaf. A poll and a hit are two separate clauses here,
 * and zero says zero. Shared so neither surface can drift back.
 */
export function activityLine(
  w: Pick<Watcher, "lastPollAt" | "hitCount" | "lastHitAt" | "createdAt">,
): string {
  const checked = agoLabel(w.lastPollAt);
  const hits = w.hitCount;

  // Older daemon: no hit counts at all. Say only what we can stand behind —
  // when it last checked — and never relabel that as a hit.
  if (hits === undefined) {
    return checked ? `Last checked ${checked}` : "Not checked yet";
  }

  if (hits > 0) {
    const last = agoLabel(w.lastHitAt ?? null);
    const arrived = last ? `, last ${last}` : "";
    return `${hits} ${hits === 1 ? "hit" : "hits"}${arrived} · checked ${
      checked ?? "not yet"
    }`;
  }

  if (!checked) return "Nothing yet — it hasn't run for the first time";

  // Zero hits with a healthy poll is genuinely ambiguous: a quiet source and a
  // broken one look identical from here. Say the two facts and let them be
  // compared, rather than picking one story and asserting it.
  const watchingFor = durationLabel(w.createdAt ?? null);
  const since = watchingFor ? ` in ${watchingFor} of watching` : "";
  return `Nothing has arrived${since} · last checked ${checked}`;
}

/**
 * The semantic half of the health chip: a glyph, a word and a tone — in that
 * order of importance. The glyph is not decoration; the states are otherwise
 * separated only by hue, which is no separation at all for a large share of
 * readers. Colour is left to the caller because the two surfaces draw from
 * different palettes (serif-HQ tokens vs. the mv3 vars) — but a `bad` tone must
 * never be drawn green on either.
 */
export type HealthTone = "good" | "warn" | "bad" | "neutral";

export interface WatcherHealthMeta {
  glyph: string;
  label: string;
  tone: HealthTone;
  /** Why it can't produce — null when there is nothing wrong to report. */
  note: string | null;
  /** What would fix it, when that is knowable. */
  fix: string | null;
}

export function watcherHealthMeta(
  w: Pick<Watcher, "health" | "credentialService" | "scope">,
): WatcherHealthMeta {
  // A watcher with nothing to poll is not "healthy" and is not a connection
  // problem — connecting an account would not make it start working.
  if (w.health === "not_watching") {
    return {
      glyph: "⊘",
      label: "not watching",
      tone: "bad",
      note:
        w.scope?.summary ??
        "This watcher isn't pointed at anything, so nothing can arrive.",
      fix: w.scope?.fix ?? "Remove it, or re-create it with a source to watch.",
    };
  }
  if (w.health === "not_connected") {
    return {
      glyph: "▲",
      label: "not connected",
      tone: "warn",
      note: `${w.credentialService} isn't connected — connect it to start`,
      fix: null,
    };
  }
  if (w.health === "reauth") {
    return {
      glyph: "▲",
      label: "reauth",
      tone: "warn",
      note: "Token expired — reconnect to resume",
      fix: null,
    };
  }
  if (w.health === "ok") {
    return { glyph: "✓", label: "healthy", tone: "good", note: null, fix: null };
  }
  return {
    glyph: "…",
    label: "checking",
    tone: "neutral",
    note: null,
    fix: null,
  };
}

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  auto: "AUTO",
  draft: "DRAFT",
  notify: "NOTIFY",
};

export const DIAL_LABEL: Record<GlobalDial, string> = {
  observe: "Observe",
  assist: "Assist",
  autonomous: "Autonomous",
};

/** The banner sentence shown above the board. */
export function dialBanner(dial: GlobalDial): string {
  switch (dial) {
    case "observe":
      return "Observe — playbooks can only notify, not draft or act";
    case "assist":
      return "Assist — playbooks can draft, not auto-send";
    case "autonomous":
      return "Autonomous — playbooks can act on their own";
  }
}
