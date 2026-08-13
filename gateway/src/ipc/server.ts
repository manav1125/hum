/**
 * Gateway IPC server — exposes gateway data to the assistant daemon over a
 * Unix domain socket.
 *
 * Protocol: newline-delimited JSON over a Unix domain socket.
 * - Request:  { "id": string, "method": string, "params"?: Record<string, unknown> }
 * - Response: { "id": string, "result"?: unknown, "error"?: string }
 * - Event:    { "event": string, "data"?: unknown }  (server → client push, no id)
 *
 * The preferred socket path is `{workspaceDir}/gateway.sock` on the shared
 * volume. On platforms with strict AF_UNIX path limits, the server falls back
 * to a shorter deterministic path.
 *
 * Resilience: a {@link SocketWatchdog} re-binds the listening socket when its
 * on-disk path entry is removed (e.g. by a tmpfs sweep or rogue cleanup of
 * `/run/*`). Existing connected sockets survive the re-bind because the
 * kernel keeps connection inodes alive independently of the listener path;
 * only new `connect()` calls require the path to exist.
 *
 * Reachability: when the gateway and the daemon run as different uids,
 * `GATEWAY_IPC_SOCKET_GID` group-shares the socket with the daemon — see
 * {@link GatewayIpcServer.applySocketPermissions}.
 */

import { SocketWatchdog, ensureSocketDir } from "@vellumai/ipc-server-utils";
import {
  chmodSync,
  chownSync,
  existsSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type { z } from "zod";

import { getLogger } from "../logger.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("ipc-server");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IpcRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type IpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

export type IpcEvent = {
  event: string;
  data?: unknown;
};

export type IpcMethodHandler = (
  params?: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** A single IPC route definition — method name + handler function. */
export type IpcRoute = {
  method: string;
  schema?: z.ZodType;
  handler: IpcMethodHandler;
};

/** Optional configuration for {@link GatewayIpcServer}. */
export interface GatewayIpcServerOptions {
  /**
   * How often the socket-file watchdog stats the listening socket path.
   * Set to `0` to disable. Defaults to {@link SocketWatchdog}'s 5000ms.
   */
  watchdogIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class GatewayIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, IpcMethodHandler>();
  private schemas = new Map<string, z.ZodType>();
  private socketPath: string;
  private watchdog: SocketWatchdog;
  /**
   * Servers whose listener path has been replaced by a re-bind. Kept around
   * so that already-connected sockets continue to work; closed gracefully
   * once their accept loops drain.
   */
  private legacyServers = new Set<Server>();

  constructor(routes?: IpcRoute[], options?: GatewayIpcServerOptions) {
    const resolution = resolveIpcSocketPath("gateway");
    this.socketPath = resolution.path;
    log.info(
      { source: resolution.source, path: resolution.path },
      "Gateway IPC socket path resolved",
    );
    if (routes) {
      for (const route of routes) {
        this.methods.set(route.method, route.handler);
        if (route.schema) {
          this.schemas.set(route.method, route.schema);
        }
      }
    }

    this.watchdog = new SocketWatchdog({
      socketPath: this.socketPath,
      intervalMs: options?.watchdogIntervalMs,
      getServer: () => this.server,
      createServer: () => this.createListeningServer(),
      onRebind: (newServer, oldServer) => {
        this.server = newServer;
        // The watchdog re-created the path entry with default ownership, so
        // the group share has to be re-applied here too. Without this a
        // single rebind silently locks the daemon's uid back out — the same
        // failure as booting without the share, just later and rarer.
        this.applySocketPermissions();
        // Move the previous listener into the legacy set so already-
        // connected clients keep their accept loop alive. close() stops
        // accepting new connections (which the kernel already won't route
        // here anyway after the path moved) but lets in-flight sockets
        // drain.
        this.legacyServers.add(oldServer);
        oldServer.close(() => {
          this.legacyServers.delete(oldServer);
        });
      },
      log,
    });
  }

  /** Start listening on the Unix domain socket. */
  start(): void {
    // Ensure the parent directory exists — on a fresh hatch the workspace
    // dir may not have been created yet when the IPC server starts.
    // `ensureSocketDir` creates it 0700, which locks out any other uid, so
    // note whether this process is the one that created it: if so we own the
    // directory's policy and widen it to the shared group below.
    const socketDir = dirname(this.socketPath);
    const dirPreexisted = existsSync(socketDir);
    ensureSocketDir(this.socketPath);
    if (!dirPreexisted) {
      this.applySocketDirPermissions(socketDir);
    }

    // Clean up stale socket file from a previous run
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore — may already be gone
      }
    }

    this.server = this.createListeningServer();
    this.server.listen(this.socketPath, () => {
      log.info({ path: this.socketPath }, "IPC server listening");
      this.applySocketPermissions();
    });

    this.watchdog.start();
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    this.watchdog.stop();

    for (const socket of this.clients) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    this.clients.clear();

    for (const legacy of this.legacyServers) {
      legacy.close();
    }
    this.legacyServers.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Clean up socket file
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }
  }

  /** Push an event to all connected clients. */
  emit(event: string, data?: unknown): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({ event, data } satisfies IpcEvent) + "\n";
    for (const socket of this.clients) {
      if (!socket.destroyed) {
        socket.write(payload);
      }
    }
  }

  /** Get the socket path (for testing / diagnostics). */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Re-bind the listening socket if its path entry is missing on disk.
   *
   * Public for tests so the watchdog can be exercised deterministically
   * without waiting for the interval. Returns `true` when a re-bind was
   * performed, `false` otherwise.
   */
  async rebindIfMissing(): Promise<boolean> {
    return this.watchdog.rebindIfMissing();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * The gid to share the IPC socket with, or `null` when the deployment did
   * not ask for a share (every deployment where the gateway and the daemon
   * run as the same uid).
   */
  private sharedSocketGid(): number | null {
    const raw = process.env.GATEWAY_IPC_SOCKET_GID?.trim();
    if (!raw) return null;
    const gid = Number(raw);
    if (!Number.isInteger(gid) || gid < 0) {
      log.error(
        { value: raw },
        "GATEWAY_IPC_SOCKET_GID is not a non-negative integer — ignoring it; " +
          "an unprivileged daemon will NOT be able to reach the gateway",
      );
      return null;
    }
    return gid;
  }

  /**
   * Make the listening socket reachable by the daemon when the two processes
   * run as different uids (`CUE_DROP_DAEMON_PRIVILEGES=1`: gateway root,
   * daemon uid/gid 1001).
   *
   * `connect(2)` on an AF_UNIX socket requires **write** permission on the
   * path entry. Node binds it 0777 & ~umask — 0755 under root's usual 022 —
   * so an unprivileged daemon gets r-x and every daemon→gateway RPC fails
   * with EACCES. That is not a degraded mode: risk classification, autonomy
   * policy reads and capability-token verification all ride this socket, so
   * the assistant fails closed on *every* tool call ("The safety-check
   * service was briefly unavailable"). Enabling the privilege drop without
   * this took prod down on 2026-08-13.
   *
   * 0660 + the daemon's gid rather than 0666: the daemon is the process that
   * runs agent-authored shell commands, and this socket hands out and
   * verifies trust material. Naming one gid keeps it reachable by the one
   * process that must reach it, and keeps it out of reach of any other uid
   * that later shares this namespace — a per-skill sandbox user, a helper
   * added to the image — without that being a new decision to remember.
   * The container being a single trust domain today is a fact about today.
   *
   * Unset is the previous behaviour exactly, so the flag-off path (daemon as
   * root, which can connect regardless of mode) is untouched.
   */
  private applySocketPermissions(): void {
    const gid = this.sharedSocketGid();
    if (gid === null) return;

    try {
      // Keep the current owner; only the group and mode change. Reading the
      // uid back beats passing -1 — it keeps the call honest on any platform
      // whose chown() does not special-case it.
      const { uid } = statSync(this.socketPath);
      chownSync(this.socketPath, uid, gid);
      chmodSync(this.socketPath, 0o660);
      log.info(
        { path: this.socketPath, uid, gid, mode: "0660" },
        "IPC socket group-shared with the daemon",
      );
    } catch (err) {
      // Loud, not fatal: the gateway's HTTP surface is still worth serving,
      // and this is recoverable by a restart. But it means the daemon cannot
      // reach us, so it must never scroll by as a debug line.
      log.error(
        { err, path: this.socketPath, gid },
        "FAILED to group-share the IPC socket — an unprivileged daemon will " +
          "not be able to connect, and every tool call will be denied",
      );
    }
  }

  /**
   * Widen a socket directory this process just created (0700, see
   * {@link ensureSocketDir}) to the shared group, so the daemon's uid can
   * traverse into it. Only ever called for a directory we created ourselves —
   * a pre-existing directory (the workspace, a mounted volume) keeps whatever
   * policy its owner set.
   */
  private applySocketDirPermissions(socketDir: string): void {
    const gid = this.sharedSocketGid();
    if (gid === null) return;

    try {
      const { uid } = statSync(socketDir);
      chownSync(socketDir, uid, gid);
      // 0750: traverse and list for the group, nothing for the world.
      chmodSync(socketDir, 0o750);
      log.info(
        { path: socketDir, uid, gid, mode: "0750" },
        "IPC socket directory group-shared with the daemon",
      );
    } catch (err) {
      log.error(
        { err, path: socketDir, gid },
        "FAILED to group-share the IPC socket directory — an unprivileged " +
          "daemon will not be able to reach the socket inside it",
      );
    }
  }

  private createListeningServer(): Server {
    const server = createServer((socket) => this.handleConnection(socket));
    server.on("error", (err) => {
      log.error({ err }, "IPC server error");
    });
    return server;
  }

  private handleConnection(socket: Socket): void {
    // The assistant maintains a persistent connection for hot-path RPCs
    // (classify_risk) alongside short-lived one-shot connections for other
    // calls. Track all of them so a new one-shot connection does not tear
    // down the persistent socket and reject its in-flight requests.
    this.clients.add(socket);
    log.debug("IPC client connected");

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      // Process complete newline-delimited messages
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          this.handleMessage(socket, line);
        }
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      log.debug("IPC client disconnected");
    });

    socket.on("error", (err) => {
      log.warn({ err }, "IPC client socket error");
      this.clients.delete(socket);
    });
  }

  private handleMessage(socket: Socket, line: string): void {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      this.sendResponse(socket, {
        id: "unknown",
        error: "Invalid JSON",
      });
      return;
    }

    if (
      !req ||
      typeof req !== "object" ||
      Array.isArray(req) ||
      !req.id ||
      !req.method
    ) {
      const id =
        req &&
        typeof req === "object" &&
        !Array.isArray(req) &&
        typeof req.id === "string"
          ? req.id
          : "unknown";
      this.sendResponse(socket, {
        id,
        error: "Missing 'id' or 'method' field",
      });
      return;
    }

    const handler = this.methods.get(req.method);
    if (!handler) {
      this.sendResponse(socket, {
        id: req.id,
        error: `Unknown method: ${req.method}`,
      });
      return;
    }

    // Validate params against Zod schema if one was registered for this method.
    const schema = this.schemas.get(req.method);
    let parsedParams: Record<string, unknown> | undefined = req.params;
    if (schema) {
      const result = schema.safeParse(req.params);
      if (!result.success) {
        this.sendResponse(socket, {
          id: req.id,
          error: `Invalid params: ${result.error.message}`,
        });
        return;
      }
      parsedParams = result.data as Record<string, unknown>;
    }

    try {
      const result = handler(parsedParams);
      if (result instanceof Promise) {
        result
          .then((value) => {
            this.sendResponse(socket, { id: req.id, result: value });
          })
          .catch((err) => {
            log.warn({ err, method: req.method }, "IPC handler error");
            this.sendResponse(socket, {
              id: req.id,
              error: String(err),
            });
          });
      } else {
        this.sendResponse(socket, { id: req.id, result });
      }
    } catch (err) {
      log.warn({ err, method: req.method }, "IPC handler error");
      this.sendResponse(socket, {
        id: req.id,
        error: String(err),
      });
    }
  }

  private sendResponse(socket: Socket, response: IpcResponse): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getDefaultSocketPath(): string {
  return resolveIpcSocketPath("gateway").path;
}
