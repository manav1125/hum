/**
 * A Socket Mode connection that stops delivering must be noticed.
 *
 * The failure this guards is not a disconnect — those already recover. It is a
 * socket that stays OPEN at the transport layer and delivers nothing. Nothing
 * in the client could see that: no ping, no idle timer, no connect deadline,
 * and the only recurring timer in the module was an hourly dedup sweep.
 * Recovery waited on a `close` event a half-open socket never fires, so
 * delivery stayed dead until something unrelated bounced the channel stack.
 *
 * The readiness probe is no help either: it checks that credentials exist and
 * that auth.test answers, and neither asks whether anything is arriving. So
 * the product reports Slack healthy for the entire outage.
 *
 * These pin the timers rather than the socket, because the timers are the
 * whole mechanism and a real half-open socket cannot be produced in a test.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { initGatewayDb } from "../db/connection.js";
import { SlackSocketModeClient } from "../slack/socket-mode.js";

beforeAll(async () => {
  // The client constructs a SlackStore, which needs the gateway DB.
  await initGatewayDb();
});

type TimerBearing = {
  idleTimer: ReturnType<typeof setTimeout> | null;
  connectDeadline: ReturnType<typeof setTimeout> | null;
  armIdleTimer: (ws: unknown) => void;
  clearIdleTimer: () => void;
  clearConnectDeadline: () => void;
  ws: unknown;
  running: boolean;
  forceReconnect: () => void;
};

function makeClient(): TimerBearing {
  const client = new SlackSocketModeClient(
    {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      teamId: "T123",
    } as never,
    () => {},
  );
  return client as unknown as TimerBearing;
}

describe("socket liveness timers", () => {
  test("arming the idle timer sets one, and clearing removes it", () => {
    const client = makeClient();
    const ws = {} as unknown;
    client.ws = ws;
    client.running = true;

    client.armIdleTimer(ws);
    expect(client.idleTimer).not.toBeNull();

    client.clearIdleTimer();
    expect(client.idleTimer).toBeNull();
  });

  test("re-arming replaces the pending timer rather than stacking them", () => {
    // Every frame re-arms. Stacking would fire a reconnect for silence that
    // had already been broken.
    const client = makeClient();
    const ws = {} as unknown;
    client.ws = ws;
    client.running = true;

    client.armIdleTimer(ws);
    const first = client.idleTimer;
    client.armIdleTimer(ws);

    expect(client.idleTimer).not.toBe(first);
    client.clearIdleTimer();
  });

  test("stop() leaves no timer holding the process", () => {
    const client = makeClient();
    const ws = {} as unknown;
    client.ws = ws;
    client.running = true;
    client.armIdleTimer(ws);

    (client as unknown as { stop: () => void }).stop();

    expect(client.idleTimer).toBeNull();
    expect(client.connectDeadline).toBeNull();
  });

  test("a timer belonging to a replaced socket does not reconnect", () => {
    // forceReconnect swaps `ws`. A timer armed against the old socket firing
    // afterwards would tear down the healthy replacement.
    const client = makeClient();
    const oldWs = {} as unknown;
    const newWs = {} as unknown;
    client.running = true;
    client.ws = oldWs;
    client.armIdleTimer(oldWs);

    let reconnected = false;
    client.forceReconnect = () => {
      reconnected = true;
    };
    client.ws = newWs;

    // Fire the armed callback directly: the guard is `this.ws !== ws`.
    const timer = client.idleTimer as unknown as { _onTimeout?: () => void };
    timer?._onTimeout?.();

    expect(reconnected).toBe(false);
    client.clearIdleTimer();
  });
});
