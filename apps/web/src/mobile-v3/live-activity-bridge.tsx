/**
 * LiveActivityBridge — drives the iOS Live Activity / Dynamic Island (mobile-v3
 * spec frame 4) from the web layer.
 *
 * NATIVE iOS ONLY. Renders nothing and runs nothing unless BOTH hold:
 *   · we're inside the Capacitor shell (`isNativePlatform()`), and
 *   · the shell exposes the run-activity methods on
 *     `window.Capacitor.Plugins.CueNative` — builds older than 202607191624
 *     have the CueNative plugin (connect/load/signOut) WITHOUT
 *     `startRunActivity`, so the method itself is the feature gate. Never
 *     throws either way.
 *
 * Data source: the same `workitemsGet` query the mv3 surfaces already share
 * (`useHqWorkItems` in pages/hq/use-missions — identical generated query key,
 * so React Query dedupes with any mounted screen), refreshed two ways:
 *   · `useActivitySync` — the existing app-wide SSE bus signal; invalidates
 *     `workitemsGet` on `work_item_status_changed` / `work_item_completed`,
 *     so Island transitions ride the push, not the poll;
 *   · a 45s safety-net poll (foreground only — TQ's default
 *     `refetchIntervalInBackground: false` plus the focus manager gate it).
 *
 * Decision logic is the pure `planRunActivity` (live-activity-plan.ts);
 * commands are debounced (600ms of quiet) so rapid status flips collapse into
 * one native call — the plugin is a single slot, latest-run-wins — and then
 * serialized through a promise chain so start/update/end keep their order.
 */
import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { workitemsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { isNativePlatform } from "@/runtime/native-auth";

import {
  planRunActivity,
  type RunActivityCommand,
  type RunActivityItem,
  type TrackedActivity,
} from "./live-activity-plan";

/** Safety-net poll while the app is foregrounded (SSE is the fast path). */
const POLL_MS = 45_000;

/** Quiet window before a snapshot becomes a native call. */
const DEBOUNCE_MS = 600;

/** The run-activity surface of the CueNative Capacitor plugin (see
 *  apps/ios/App/App/CueNativePlugin.swift for the authoritative contract). */
interface CueNativeRunActivity {
  startRunActivity(options: {
    runId: string;
    title: string;
    status: string;
    progress?: number;
    state?: string;
  }): Promise<unknown>;
  updateRunActivity(options: {
    status?: string;
    progress?: number;
    state?: string;
  }): Promise<unknown>;
  endRunActivity(options: { status?: string; state?: string }): Promise<unknown>;
}

/**
 * Feature-detect the shipped plugin surface off the Capacitor global the
 * shell injects. Deliberately reads `window.Capacitor` (not the npm import)
 * so an old native build — where the injected CueNative object simply lacks
 * these methods — cleanly returns null instead of rejecting at call time.
 */
function getRunActivityPlugin(): CueNativeRunActivity | null {
  if (!isNativePlatform()) return null;
  const w = window as unknown as {
    Capacitor?: { Plugins?: Record<string, unknown> };
  };
  const plugin = w.Capacitor?.Plugins?.CueNative as
    | Partial<CueNativeRunActivity>
    | undefined;
  if (
    !plugin ||
    typeof plugin.startRunActivity !== "function" ||
    typeof plugin.updateRunActivity !== "function" ||
    typeof plugin.endRunActivity !== "function"
  ) {
    return null;
  }
  return plugin as CueNativeRunActivity;
}

/** Issue one planned command. Swallows every failure — the plugin rejects
 *  legitimately on iOS < 16.2 or when the user disabled Live Activities. */
async function dispatch(
  plugin: CueNativeRunActivity,
  command: RunActivityCommand,
): Promise<void> {
  try {
    if (command.kind === "start") {
      await plugin.startRunActivity({
        runId: command.runId,
        title: command.title,
        status: command.status,
        state: command.state,
      });
    } else if (command.kind === "update") {
      await plugin.updateRunActivity({
        status: command.status,
        state: command.state,
      });
    } else if (command.kind === "end") {
      await plugin.endRunActivity({
        status: command.status,
        state: command.state,
      });
    }
  } catch {
    // Live Activities unavailable/denied — the app must never notice.
  }
}

function LiveActivityBridgeInner({
  assistantId,
  isAssistantActive,
}: {
  assistantId: string | null;
  isAssistantActive: boolean;
}) {
  // Constant for the WebView's lifetime — resolved once.
  const plugin = useMemo(() => getRunActivityPlugin(), []);

  // Existing SSE fan-in: invalidates workitemsGet the instant the daemon
  // broadcasts a work-item event (harmless to co-mount; TQ dedupes).
  useActivitySync(assistantId, isAssistantActive);

  const enabled = Boolean(plugin && assistantId && isAssistantActive);
  const query = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: {},
    }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 15_000,
  });
  const items = enabled ? query.data?.items : undefined;

  const trackedRef = useRef<TrackedActivity | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!plugin || !items) return;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const { command, tracked } = planRunActivity(
        trackedRef.current,
        items as RunActivityItem[],
      );
      trackedRef.current = tracked;
      if (command.kind === "none") return;
      chainRef.current = chainRef.current.then(() =>
        dispatch(plugin, command),
      );
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [plugin, items]);

  return null;
}

/**
 * Headless mount for the app shell (root-layout). The native gate lives in
 * this hook-free wrapper so desktop/web renders null without ever mounting
 * the query or bus subscription — byte-zero effect off the iOS shell.
 */
export function LiveActivityBridge(props: {
  assistantId: string | null;
  isAssistantActive: boolean;
}) {
  if (!getRunActivityPlugin()) return null;
  return <LiveActivityBridgeInner {...props} />;
}
