import { Blocks, CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { useState } from "react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import {
  defaultManagedOAuthConnectClient,
  type ManagedOAuthConnectClient,
} from "@/domains/chat/api/managed-oauth";
import type { Surface } from "@/domains/chat/types/types";

/** One recommended connector row. `connected` comes from the capability
 *  snapshot the model has when it emits the surface. */
interface ConnectorRecommendation {
  providerKey: string;
  displayName?: string;
  description?: string;
  connected?: boolean;
  logoUrl?: string | null;
}

interface ConnectorRecommendSurfaceData {
  intro?: string;
  connectors?: ConnectorRecommendation[];
  /** Route to the full connectors catalog; defaults to the Intelligence
   *  connectors page. */
  browseAllHref?: string;
}

interface ConnectorRecommendSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
  assistantId?: string | null;
  oauthClient?: ManagedOAuthConnectClient;
}

function titleize(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

type RowState = "idle" | "connecting" | "connected" | "error";

/**
 * In-thread "connectors that could help" card. When a task needs data or
 * capabilities the assistant doesn't have yet, the model emits this surface
 * listing the relevant connectors. Each row is either:
 *   - already connected → a "Use" action that tells the model to proceed with
 *     it, or
 *   - not connected → a "Connect" action that runs the SAME managed-OAuth flow
 *     as {@link OAuthConnectSurface} and reports success back to the model.
 * Plus "None of these" (dismiss) and "Browse all connectors".
 */
export function ConnectorRecommendSurface({
  surface,
  onAction,
  assistantId,
  oauthClient = defaultManagedOAuthConnectClient,
}: ConnectorRecommendSurfaceProps) {
  const data = surface.data as ConnectorRecommendSurfaceData;
  const connectors = Array.isArray(data.connectors) ? data.connectors : [];

  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  // Rows connected during this session start showing "Use".
  const [locallyConnected, setLocallyConnected] = useState<
    Record<string, boolean>
  >({});

  const label = (c: ConnectorRecommendation) =>
    c.displayName || titleize(c.providerKey);

  const handleConnect = async (c: ConnectorRecommendation) => {
    if (!assistantId || rowState[c.providerKey] === "connecting") return;
    setRowState((s) => ({ ...s, [c.providerKey]: "connecting" }));
    setRowError((e) => ({ ...e, [c.providerKey]: "" }));

    const result = await oauthClient.connect({
      assistantId,
      providerKey: c.providerKey,
      providerLabel: label(c),
    });

    if (result.status === "connected") {
      setRowState((s) => ({ ...s, [c.providerKey]: "connected" }));
      setLocallyConnected((m) => ({ ...m, [c.providerKey]: true }));
      void onAction(surface.surfaceId, "connect", {
        providerKey: c.providerKey,
        providerLabel: label(c),
        connectionId: result.connection?.id,
        accountLabel: result.connection?.account_label,
      });
      return;
    }
    if (result.status === "cancelled") {
      setRowState((s) => ({ ...s, [c.providerKey]: "idle" }));
      return;
    }
    setRowState((s) => ({ ...s, [c.providerKey]: "error" }));
    setRowError((e) => ({ ...e, [c.providerKey]: result.message }));
  };

  const handleUse = (c: ConnectorRecommendation) => {
    void onAction(surface.surfaceId, "use", {
      providerKey: c.providerKey,
      providerLabel: label(c),
    });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border-element)] bg-[var(--surface-lift)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <Blocks className="h-4 w-4 text-[var(--content-secondary)]" />
        <span className="flex-1 text-title-small text-[var(--content-strong)]">
          {surface.title ?? "Connectors that could help"}
        </span>
        <span className="rounded-full bg-[var(--tag-bg-neutral)] px-2 py-0.5 text-[var(--content-tertiary)] text-label-small-default">
          Beta
        </span>
      </div>

      {data.intro ? (
        <p className="px-4 pt-3 text-body-medium-lighter text-[var(--content-quiet)]">
          {data.intro}
        </p>
      ) : null}

      <div className="flex flex-col divide-y divide-[var(--border-subtle)]">
        {connectors.map((c) => {
          const state = rowState[c.providerKey] ?? "idle";
          const isConnected = c.connected || locallyConnected[c.providerKey];
          return (
            <div
              key={c.providerKey}
              className="flex items-center gap-3 px-4 py-3"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)]">
                <IntegrationIcon
                  providerKey={c.providerKey}
                  displayName={label(c)}
                  logoUrl={c.logoUrl ?? null}
                  size={24}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-body-medium-default text-[var(--content-strong)]">
                  {label(c)}
                </div>
                {isConnected ? (
                  <div className="flex items-center gap-1 text-body-small-default text-[var(--system-positive-strong)]">
                    <CheckCircle2 className="h-3 w-3" /> Connected
                  </div>
                ) : c.description ? (
                  <div className="truncate text-body-small-default text-[var(--content-quiet)]">
                    {c.description}
                  </div>
                ) : null}
                {state === "error" && rowError[c.providerKey] ? (
                  <div className="mt-0.5 flex items-center gap-1 text-body-small-default text-[var(--system-negative-strong)]">
                    <XCircle className="h-3 w-3 shrink-0" />
                    {rowError[c.providerKey]}
                  </div>
                ) : null}
              </div>
              {isConnected ? (
                <button
                  type="button"
                  onClick={() => handleUse(c)}
                  className="shrink-0 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-3 py-1.5 text-body-medium-default text-[var(--content-strong)] transition-colors hover:bg-[var(--surface-hover)]"
                >
                  Use
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleConnect(c)}
                  disabled={!assistantId || state === "connecting"}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-3 py-1.5 text-body-medium-default text-[var(--content-strong)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
                >
                  {state === "connecting" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ExternalLink className="h-3.5 w-3.5" />
                  )}
                  {state === "connecting" ? "Waiting…" : "Connect"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-4 py-2.5">
        <a
          href={data.browseAllHref ?? "/assistant/intelligence/connectors"}
          className="text-body-small-default text-[var(--primary-base)] hover:underline"
        >
          Browse all connectors
        </a>
        <button
          type="button"
          onClick={() => void onAction(surface.surfaceId, "dismiss", {})}
          className="rounded-md px-3 py-1.5 text-body-medium-default text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-hover)]"
        >
          None of these
        </button>
      </div>
    </div>
  );
}
