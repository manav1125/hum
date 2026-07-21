/**
 * Shared base for host-proxy executors that delegate a single daemon request
 * to a native mac-helper JSON-RPC method (computer-use, app-control).
 *
 * Both concrete executors follow the identical shape:
 *   1. translate the SSE `*_request` message into helper call params,
 *   2. `helper.call(method, params)` (the helper owns the real work),
 *   3. zod-parse the helper's result,
 *   4. post the result (or a structured error) back to the daemon.
 *
 * Cancellation is best-effort: the helper runs one action per request and the
 * daemon's own request timeout is the real deadline, so a `*_cancel` just marks
 * the requestId so a late helper result that arrives after cancel is dropped
 * rather than posted. The mark is TTL-evicted so the set can't grow unbounded.
 */

import type { HostProxyExecutor } from "../host-proxy-router";
import type { HostProxySseMessage } from "../host-proxy-sse";
import type { HostProxyPoster } from "../host-proxy-poster";
import type { MacHelperClient } from "../sidecar/mac-helper";
import log from "../logger";
import type { z } from "zod";

/** The slice of MacHelperClient these executors use. */
export type CuHelperClient = Pick<MacHelperClient, "call">;

export interface HostHelperProxyConfig<T> {
  /** Log label, e.g. "host-cu-executor". */
  label: string;
  /** The helper JSON-RPC method, e.g. "computeruse.perform". */
  method: string;
  /** Resolve the helper client (lazy — spawns on first use). */
  resolveHelper: () => CuHelperClient;
  /** Validates the helper's result payload. */
  schema: z.ZodType<T>;
  /**
   * Translate the SSE message into call params. Return `{ error }` to fail the
   * request without calling the helper (e.g. a malformed request).
   */
  buildParams: (
    message: HostProxySseMessage,
    requestId: string,
  ) => { params: Record<string, unknown> } | { error: string };
  /** Post the validated result back to the daemon. */
  postSuccess: (poster: HostProxyPoster, requestId: string, result: T) => void;
  /** Post a structured error back to the daemon. */
  postError: (
    poster: HostProxyPoster,
    requestId: string,
    message: string,
  ) => void;
}

/** How long a cancelled requestId is remembered so a late result is dropped. */
const CANCEL_TTL_MS = 30_000;

export class HostHelperProxyExecutor<T> implements HostProxyExecutor {
  private readonly config: HostHelperProxyConfig<T>;
  private readonly cancelled = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: HostHelperProxyConfig<T>) {
    this.config = config;
  }

  handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void {
    const requestId = message.requestId as string | undefined;
    if (!requestId) {
      log.warn(`[${this.config.label}] message missing requestId`);
      return;
    }

    // A cancel may have raced ahead of the request — honor it.
    if (this.cancelled.has(requestId)) {
      this.clearCancel(requestId);
      return;
    }

    const built = this.config.buildParams(message, requestId);
    if ("error" in built) {
      this.config.postError(poster, requestId, built.error);
      return;
    }

    void this.run(requestId, built.params, poster);
  }

  handleCancel(message: HostProxySseMessage, _poster: HostProxyPoster): void {
    const requestId = message.requestId as string | undefined;
    if (!requestId) return;
    // The helper action is a single in-flight call we can't interrupt; mark the
    // id so a result arriving after cancel is discarded. TTL-evict the mark.
    this.clearCancel(requestId);
    const timer = setTimeout(() => this.cancelled.delete(requestId), CANCEL_TTL_MS);
    timer.unref?.();
    this.cancelled.set(requestId, timer);
  }

  private async run(
    requestId: string,
    params: Record<string, unknown>,
    poster: HostProxyPoster,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.config.resolveHelper().call(this.config.method, params);
    } catch (err) {
      if (this.cancelled.has(requestId)) {
        this.clearCancel(requestId);
        return;
      }
      const messageText = err instanceof Error ? err.message : String(err);
      log.warn(`[${this.config.label}] helper call failed: ${messageText}`);
      this.config.postError(poster, requestId, messageText);
      return;
    }

    // Dropped if a cancel landed while the helper was working.
    if (this.cancelled.has(requestId)) {
      this.clearCancel(requestId);
      return;
    }

    const parsed = this.config.schema.safeParse(raw);
    if (!parsed.success) {
      log.warn(
        `[${this.config.label}] helper returned invalid result: ${parsed.error.message}`,
      );
      this.config.postError(
        poster,
        requestId,
        "mac helper returned an invalid result",
      );
      return;
    }

    this.config.postSuccess(poster, requestId, parsed.data);
  }

  private clearCancel(requestId: string): void {
    const timer = this.cancelled.get(requestId);
    if (timer) clearTimeout(timer);
    this.cancelled.delete(requestId);
  }

  /** Test seam. */
  get __cancelledSize(): number {
    return this.cancelled.size;
  }
}
