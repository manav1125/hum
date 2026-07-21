/**
 * Data layer for the Automations surfaces (WS-F) — watchers + playbooks.
 *
 * Uses raw `client.post` against the daemon `/v1/watchers/*` and
 * `/v1/playbooks/*` routes (these are global daemon routes, not part of the
 * generated per-assistant SDK). The playbook list carries the server-computed
 * effective autonomy + the global trust dial, so the UI never recomputes the
 * cap — it renders exactly what the server enforces.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { client } from "@/generated/daemon/client.gen";

export type GlobalDial = "observe" | "assist" | "autonomous";
export type Autonomy = "auto" | "draft" | "notify";
export type WatcherHealth = "ok" | "reauth" | "unknown";

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

async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const { data, response } = await client.post({ url, body });
  if (!response?.ok) {
    throw new Error(`${url} failed (${response?.status ?? "?"})`);
  }
  return data as T;
}

export function useWatchers() {
  return useQuery({
    queryKey: ["automations", "watchers"],
    queryFn: () => post<Watcher[]>("/v1/watchers/list", {}),
    staleTime: 15_000,
  });
}

export function usePlaybooks() {
  return useQuery({
    queryKey: ["automations", "playbooks"],
    queryFn: () =>
      post<{ globalDial: GlobalDial; playbooks: Playbook[] }>(
        "/v1/playbooks/list",
        {},
      ),
    staleTime: 15_000,
  });
}

export function useWatcherProviders() {
  return useQuery({
    queryKey: ["automations", "providers"],
    queryFn: () => post<WatcherProvider[]>("/v1/watchers/providers", {}),
    staleTime: 5 * 60_000,
  });
}

export function useToggleWatcher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      post("/v1/watchers/update", {
        watcher_id: vars.id,
        enabled: vars.enabled,
      }),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["automations", "watchers"] }),
  });
}

export function useCreateWatcher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      provider: string;
      poll_interval_ms?: number;
      config?: Record<string, unknown>;
    }) => post("/v1/watchers/create", { ...vars, intake_mode: "came_in" }),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["automations", "watchers"] }),
  });
}

export function useDeleteWatcher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      post("/v1/watchers/delete", { watcher_id: id }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["automations", "watchers"] });
      void qc.invalidateQueries({ queryKey: ["automations", "playbooks"] });
    },
  });
}

export function useCreatePlaybook() {
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
    }) => post("/v1/playbooks/create", vars),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["automations", "playbooks"] }),
  });
}

export function useTogglePlaybook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      post("/v1/playbooks/update", {
        playbook_id: vars.id,
        enabled: vars.enabled,
      }),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["automations", "playbooks"] }),
  });
}

export function useDeletePlaybook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      post("/v1/playbooks/delete", { playbook_id: id }),
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
