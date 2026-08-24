/**
 * The predicate that decides whether a failed HTTP bind aborts startup.
 *
 * Getting it wrong is expensive in both directions. Too eager and a daemon
 * refuses to start because something unrelated holds the port, when the
 * documented behaviour is to degrade to IPC-only. Too lax and two daemons run
 * against one workspace, each with its own scheduler, memory worker and
 * background wake, doing every side effect twice.
 *
 * So it is tested against real servers rather than a mocked fetch: the thing
 * being asked about is a socket.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { portHeldByAnotherDaemon } from "../lifecycle.js";

const servers: Array<{ stop: () => void }> = [];

function serve(handler: (req: Request) => Response): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  servers.push(server);
  const { port } = server;
  if (port === undefined) throw new Error("Test server did not bind a port");
  return port;
}

afterEach(() => {
  while (servers.length) servers.pop()?.stop();
});

describe("portHeldByAnotherDaemon", () => {
  test("a daemon answering /healthz is recognised", async () => {
    const port = serve(() => Response.json({ status: "ok" }));

    expect(await portHeldByAnotherDaemon("127.0.0.1", port)).toBe(true);
  });

  // Something else on the machine holding the port is not a duplicate daemon,
  // and must not stop this one from starting in its degraded mode.
  test("an unrelated server on the port is not a daemon", async () => {
    const port = serve(() => new Response("hello from something else"));

    expect(await portHeldByAnotherDaemon("127.0.0.1", port)).toBe(false);
  });

  test("a server that answers non-200 is not proof", async () => {
    const port = serve(() => new Response("nope", { status: 503 }));

    expect(await portHeldByAnotherDaemon("127.0.0.1", port)).toBe(false);
  });

  test("a JSON server with a different body is not proof", async () => {
    const port = serve(() => Response.json({ status: "degraded" }));

    expect(await portHeldByAnotherDaemon("127.0.0.1", port)).toBe(false);
  });

  test("nothing listening is not proof", async () => {
    const port = serve(() => Response.json({ status: "ok" }));
    servers.pop()?.stop();

    expect(await portHeldByAnotherDaemon("127.0.0.1", port)).toBe(false);
  });

  // A wildcard bind address is not dialable; the probe has to reach the
  // loopback the other daemon is also listening on.
  test("a wildcard hostname is probed on loopback", async () => {
    const port = serve(() => Response.json({ status: "ok" }));

    expect(await portHeldByAnotherDaemon("0.0.0.0", port)).toBe(true);
  });
});
