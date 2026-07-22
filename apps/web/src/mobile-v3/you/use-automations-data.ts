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
 */
export type WatcherHealth = "ok" | "reauth" | "unknown" | "not_connected";

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
