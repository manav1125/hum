import { loopbackSafeFetch } from "./loopback-fetch.js";

/**
 * Build the base URL for the daemon HTTP server.
 */
export function buildDaemonUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Perform an HTTP health check against the daemon's `/healthz` endpoint.
 * Returns true if the daemon responds with HTTP 200, false otherwise.
 */
export async function httpHealthCheck(
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const url = `${buildDaemonUrl(port)}/healthz`;
    const response = await loopbackSafeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Whether a gateway is answering at all, regardless of what it answers.
 *
 * This is deliberately weaker than {@link httpHealthCheck}: any HTTP response
 * means the gateway is *there*, including a 4xx or 5xx. The question it exists
 * to answer is "is there a server at this URL", so that a failure to obtain a
 * token can be reported as an outage rather than as a rejected credential.
 * Only the absence of a response — connection refused, DNS failure, timeout —
 * counts as unreachable.
 */
export async function gatewayReachable(
  gatewayUrl: string,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    await loopbackSafeFetch(`${gatewayUrl.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll the daemon's `/healthz` endpoint until it responds with 200 or the
 * timeout is reached.
 *
 * Returns true if the daemon became healthy within the timeout, false otherwise.
 */
export async function waitForDaemonReady(
  port: number,
  timeoutMs = 60000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await httpHealthCheck(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
