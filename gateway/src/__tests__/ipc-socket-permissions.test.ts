/**
 * Regression cover for the daemon→gateway IPC socket's reachability.
 *
 * `connect(2)` on an AF_UNIX socket requires WRITE permission on the path
 * entry. When the privilege drop (`CUE_DROP_DAEMON_PRIVILEGES=1`) puts the
 * daemon on uid 1001 while the gateway stays root, the default 0755 socket
 * leaves the daemon with r-x and every daemon→gateway RPC fails — which
 * denies every tool call, because risk classification rides this socket.
 * `GATEWAY_IPC_SOCKET_GID` is what makes the socket group-reachable.
 *
 * The gid used here is the *test process's own* gid so the chown is
 * permitted without root; what is under test is the mode and the group
 * being applied at all, not the specific number.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";

import { GatewayIpcServer } from "../ipc/server.js";
import { testWorkspaceDir } from "./test-preload.js";

let server: GatewayIpcServer | null = null;
const originalGid = process.env.GATEWAY_IPC_SOCKET_GID;

/**
 * Start a server and return the path it actually bound. The resolver falls
 * back to a hashed tmp path when the workspace path exceeds the AF_UNIX
 * limit — which the test workspace does on macOS — so the path has to come
 * from the server rather than be assumed.
 */
async function startAndAwaitSocket(): Promise<string> {
  server = new GatewayIpcServer([], { watchdogIntervalMs: 0 });
  const socketPath = server.getSocketPath();
  server.start();
  for (let i = 0; i < 200; i++) {
    if (existsSync(socketPath)) {
      // The chmod runs in the listen callback, which can land a tick after
      // the path itself appears.
      await new Promise((r) => setTimeout(r, 50));
      return socketPath;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`socket never appeared at ${socketPath}`);
}

beforeEach(() => {
  mkdirSync(testWorkspaceDir, { recursive: true });
});

afterEach(() => {
  const socketPath = server?.getSocketPath();
  server?.stop();
  server = null;
  if (originalGid === undefined) {
    delete process.env.GATEWAY_IPC_SOCKET_GID;
  } else {
    process.env.GATEWAY_IPC_SOCKET_GID = originalGid;
  }
  if (socketPath && existsSync(socketPath)) {
    rmSync(socketPath, { force: true });
  }
});

describe("gateway IPC socket permissions", () => {
  test("group-shares the socket 0660 when GATEWAY_IPC_SOCKET_GID is set", async () => {
    const gid = process.getgid?.();
    // Platforms without getgid (Windows) have no story here and no daemon
    // privilege drop either.
    if (gid === undefined) return;

    process.env.GATEWAY_IPC_SOCKET_GID = String(gid);
    const socketPath = await startAndAwaitSocket();

    const stats = statSync(socketPath);
    expect(stats.gid).toBe(gid);
    // Group must have WRITE — that is the bit connect(2) actually needs, and
    // the bit whose absence caused the 2026-08-13 incident.
    expect(stats.mode & 0o020).toBe(0o020);
    expect(stats.mode & 0o777).toBe(0o660);
    // ...and the world must not have it.
    expect(stats.mode & 0o007).toBe(0);
  });

  test("leaves the socket untouched when GATEWAY_IPC_SOCKET_GID is unset", async () => {
    delete process.env.GATEWAY_IPC_SOCKET_GID;
    const socketPath = await startAndAwaitSocket();

    // Whatever the umask produced, we must not have narrowed it to 0660 —
    // the unset path is the every-other-deployment path and has to stay
    // byte-for-byte the previous behaviour.
    const stats = statSync(socketPath);
    expect(stats.mode & 0o777).not.toBe(0o660);
  });

  test("ignores a non-numeric GATEWAY_IPC_SOCKET_GID rather than throwing", async () => {
    process.env.GATEWAY_IPC_SOCKET_GID = "assistant";
    // A bad value must not take the gateway down; it logs and carries on,
    // and the socket still binds.
    const socketPath = await startAndAwaitSocket();
    expect(existsSync(socketPath)).toBe(true);
  });
});
