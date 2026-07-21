/**
 * Capability-restricted view of the assistant event hub handed to workspace
 * plugins through `@vellumai/plugin-api`.
 *
 * Plugins receive this facade instead of the raw {@link AssistantEventHub}
 * singleton. It exposes only the operations a plugin legitimately needs —
 * subscribing to runtime events, publishing non-host events, and checking for
 * subscribers — each delegated to the one daemon hub instance so subscriptions
 * and reads observe the same shared state.
 *
 * The critical guard: a workspace plugin could otherwise
 * `import { assistantEventHub } from "@vellumai/plugin-api"` and publish a
 * forged `host_bash_request` (or any `host_*` control event) directly to the
 * desktop client, which runs `/bin/bash -c` — bypassing the host proxies' risk
 * classification, user approval, same-actor binding, and pending-interaction
 * registration. The facade's `publish` rejects `host_*` control events so an
 * in-process plugin cannot reach the host machine outside the sandbox.
 *
 * Hardening (each backs a regression in the sibling test):
 * - `subscribe` registers the plugin as an in-process (`process`) consumer
 *   only — never a device "client" — so it cannot impersonate/evict a real
 *   client by id or receive host-capability-targeted events. Its filter is
 *   snapshotted to inert JSON and its callback receives a deep-frozen snapshot
 *   so it cannot mutate an in-flight event a real client receives later in the
 *   same fanout.
 * - `publish` canonicalizes the event (and options) through a JSON round-trip
 *   to exactly the wire form the client receives, then deep-freezes that
 *   snapshot before checking `message.type` and forwarding it. Canonicalization
 *   collapses getters/Proxies to inert values and coerces boxed values
 *   (`new String("host_bash_request")`) to primitives, closing the
 *   time-of-check/time-of-use gap. `JSON.stringify`/`JSON.parse` and
 *   `String.prototype.startsWith` are pinned at module load — before any plugin
 *   loads — so a plugin cannot swap them.
 * - methods returning live subscriber callbacks or mutating hub state
 *   (`listClients*`, `getClientById`, …) are withheld entirely.
 */

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  type AssistantEventFilter,
  type AssistantEventHub,
  assistantEventHub,
} from "../runtime/assistant-event-hub.js";

/**
 * The subset of {@link AssistantEventHub} workspace plugins may use. Picking
 * method signatures off the class keeps the facade in sync with the hub while
 * statically withholding everything else.
 */
export type PluginEventHub = Pick<
  AssistantEventHub,
  "subscribe" | "publish" | "hasSubscribersForEvent"
>;

/**
 * Type prefix shared by every daemon-to-client host-proxy control event
 * (`host_bash_request`, `host_file_cancel`, `host_cu_request`,
 * `host_browser_request`, `host_app_control_request`, …), so a prefix test
 * covers all current and future host-proxy kinds.
 */
const HOST_CONTROL_EVENT_TYPE_PREFIX = "host_";

/**
 * JSON primitives pinned at module-load time — before any user plugin loads and
 * could swap the globals. A JSON round-trip canonicalizes a published event to
 * exactly the wire form the client receives, so the guard checks the same
 * representation the client will act on.
 */
const jsonStringify: typeof JSON.stringify = JSON.stringify;
const jsonParse: typeof JSON.parse = JSON.parse;

/** Canonicalize a value to its JSON wire form. Throws if not serializable. */
function wireSnapshot<T>(value: T): T {
  return jsonParse(jsonStringify(value)) as T;
}

/**
 * Recursively freeze a value (cycle-safe). The hub fans one event object out to
 * every subscriber in turn; freezing the snapshot stops a malicious subscriber
 * — e.g. a plugin that subscribed and then calls `publish` — from mutating the
 * in-flight event into a host request before a later host-capable client
 * receives it.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/**
 * `String.prototype.startsWith` bound at module-load time — before any user
 * plugin loads and could monkey-patch the prototype — so the host-prefix check
 * cannot be neutralized by a patched method.
 */
const startsWith = Function.prototype.call.bind(
  String.prototype.startsWith,
) as (str: string, search: string) => boolean;

/** The blocked type if `event` is a host-proxy control event, else undefined. */
function hostControlEventType(event: AssistantEvent): string | undefined {
  const type: unknown = (event.message as { type?: unknown } | undefined)?.type;
  return typeof type === "string" &&
    startsWith(type, HOST_CONTROL_EVENT_TYPE_PREFIX)
    ? type
    : undefined;
}

type SubscribeInput = Parameters<AssistantEventHub["subscribe"]>[0];
type PublishOptions = Parameters<AssistantEventHub["publish"]>[1];

/** The plugin-facing event hub. See module docs. */
export const pluginAssistantEventHub: PluginEventHub = Object.freeze({
  subscribe: (subscriber: SubscribeInput) => {
    // Snapshot the filter to inert data so the hub never invokes a
    // plugin-defined getter while reading `entry.filter` during fanout, and
    // hand the callback an isolated, frozen snapshot so it cannot mutate an
    // in-flight event a real client receives later in the same fanout.
    let filter: AssistantEventFilter | undefined;
    try {
      filter = subscriber.filter ? wireSnapshot(subscriber.filter) : undefined;
    } catch {
      filter = undefined;
    }
    return assistantEventHub.subscribe({
      type: "process",
      filter,
      callback: (event) => {
        let isolated: AssistantEvent;
        try {
          isolated = deepFreeze(wireSnapshot(event));
        } catch {
          return;
        }
        return subscriber.callback(isolated);
      },
    });
  },

  publish: async (event: AssistantEvent, options?: PublishOptions) => {
    let snapshot: AssistantEvent;
    let snapshotOptions: PublishOptions;
    try {
      snapshot = deepFreeze(wireSnapshot(event));
      snapshotOptions = options ? wireSnapshot(options) : undefined;
    } catch {
      throw new Error("Plugins may not publish a non-serializable event.");
    }
    const blockedType = hostControlEventType(snapshot);
    if (blockedType !== undefined) {
      throw new Error(
        `Plugins may not publish daemon-to-client host-proxy control events (type "${blockedType}").`,
      );
    }
    return assistantEventHub.publish(snapshot, snapshotOptions);
  },

  hasSubscribersForEvent: (event: Pick<AssistantEvent, "conversationId">) =>
    // Read the caller's `conversationId` once and pass an inert object, so the
    // hub never reads a plugin-defined getter.
    assistantEventHub.hasSubscribersForEvent({
      conversationId: event?.conversationId,
    }),
});
