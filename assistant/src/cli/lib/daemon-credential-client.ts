import { cliIpcCall } from "../../ipc/cli-client.js";
import type { DeleteResult } from "../../security/credential-backend.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getActiveBackendName,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("daemon-credential-client");

/**
 * Detect IPC transport failures that mean the daemon isn't reachable, so the
 * caller can fall back to a direct credential-store write.
 *
 * `cliIpcCall` surfaces connect/close failures as one of a few stable strings
 * (see `src/ipc/cli-client.ts`). The dominant one is the connect-refused /
 * socket-error message `"Could not connect to the assistant at <socket>..."`,
 * which fires during the boot window when the daemon has bound the socket file
 * but its IPC server isn't yet accepting — exactly when the Docker entrypoint
 * seeds provider keys. We also treat the connect/first-byte timeouts and the
 * "connection closed before response" case as unreachable: in all of these the
 * write never reached the daemon, so a direct store write is the correct
 * recovery rather than reporting a hard failure.
 */
function isDaemonUnreachable(error: string): boolean {
  return (
    error.startsWith("Could not connect to the assistant at ") ||
    error.startsWith("Connection error:") ||
    error === "Connection closed before response" ||
    error === "Request timed out" ||
    error === "Stream timed out waiting for first byte"
  );
}

// ---------------------------------------------------------------------------
// Result types — include error context so the CLI can surface it
// ---------------------------------------------------------------------------

export interface SetSecureKeyResult {
  ok: boolean;
  /** Human-readable error reason when ok=false. */
  error?: string;
}

export interface DeleteSecureKeyResult {
  result: DeleteResult;
  /** Human-readable error reason when result="error". */
  error?: string;
}

// ---------------------------------------------------------------------------
// Set
// ---------------------------------------------------------------------------

/**
 * Store a secret via the daemon IPC socket (so daemon-side singletons
 * stay in sync). Falls back to direct `setSecureKeyAsync()` when the
 * daemon is not running.
 */
export async function setSecureKeyViaDaemon(
  type: string,
  name: string,
  value: string,
): Promise<SetSecureKeyResult> {
  const ipc = await cliIpcCall<{ success: boolean; error?: string }>(
    "secrets_add",
    { body: { type, name, value } },
  );

  if (ipc.ok && ipc.result?.success) {
    return { ok: true };
  }

  // Daemon returned an IPC-level error (thrown InternalError, etc.)
  if (ipc.error && !isDaemonUnreachable(ipc.error)) {
    log.warn({ type, name, error: ipc.error }, "Daemon secret write failed");
    return { ok: false, error: ipc.error };
  }

  // Daemon returned success=false (e.g. validation error, backend failure)
  if (ipc.ok && ipc.result && !ipc.result.success) {
    return {
      ok: false,
      error: ipc.result.error || "Credential write rejected by assistant",
    };
  }

  // Daemon unreachable — fall back to direct write.
  let account: string;
  if (type === "api_key") {
    account = credentialKey(name, "api_key");
  } else if (type === "credential" && !name.startsWith("credential/")) {
    const colonIdx = name.lastIndexOf(":");
    if (colonIdx > 0 && colonIdx < name.length - 1) {
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      account = credentialKey(service, field);
    } else {
      account = name;
    }
  } else {
    account = name;
  }

  const ok = await setSecureKeyAsync(account, value);
  if (!ok) {
    return {
      ok: false,
      error: `Failed to store credential (backend: ${getActiveBackendName()})`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a secret via the daemon IPC socket. Falls back to direct
 * `deleteSecureKeyAsync()` when the daemon is not running.
 */
export async function deleteSecureKeyViaDaemon(
  type: string,
  name: string,
): Promise<DeleteSecureKeyResult> {
  const ipc = await cliIpcCall<{ success: boolean }>("secrets_delete", {
    body: { type, name },
  });

  if (ipc.ok && ipc.result?.success) {
    return { result: "deleted" };
  }

  // Daemon returned an IPC-level error
  if (ipc.error && !isDaemonUnreachable(ipc.error)) {
    if (ipc.error.includes("not found") || ipc.error.includes("404")) {
      return { result: "not-found" };
    }
    return { result: "error", error: ipc.error };
  }

  // Daemon returned success=false
  if (ipc.ok && ipc.result && !ipc.result.success) {
    return {
      result: "error",
      error: "Credential delete rejected by assistant",
    };
  }

  // Daemon unreachable — fall back to direct delete.
  if (type === "api_key") {
    // Delete from both locations; during migration overlap both may exist.
    const credResult = await deleteSecureKeyAsync(
      credentialKey(name, "api_key"),
    );
    if (credResult === "error") {
      return {
        result: "error",
        error: `Failed to delete credential (backend: ${getActiveBackendName()})`,
      };
    }
    const bareResult = await deleteSecureKeyAsync(name);
    if (bareResult === "error") {
      return {
        result: "error",
        error: `Failed to delete credential (backend: ${getActiveBackendName()})`,
      };
    }
    return {
      result:
        credResult === "deleted" || bareResult === "deleted"
          ? "deleted"
          : "not-found",
    };
  }

  let account: string;
  if (type === "credential" && !name.startsWith("credential/")) {
    const colonIdx = name.lastIndexOf(":");
    if (colonIdx > 0 && colonIdx < name.length - 1) {
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      account = credentialKey(service, field);
    } else {
      account = name;
    }
  } else {
    account = name;
  }

  const result = await deleteSecureKeyAsync(account);
  if (result === "error") {
    return {
      result: "error",
      error: `Failed to delete credential (backend: ${getActiveBackendName()})`,
    };
  }
  return { result };
}
