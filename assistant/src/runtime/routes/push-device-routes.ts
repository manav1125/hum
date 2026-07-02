/**
 * Push-device registry routes — mobile clients register their APNs/FCM
 * device tokens here so the daemon's push dispatch (see
 * notifications/push-dispatch.ts) can page the phone when background work
 * finishes or an approval is needed.
 *
 * POST is an idempotent register-or-refresh: clients call it on every app
 * launch (and whenever iOS rotates the token). DELETE unregisters a token
 * (user disables push / signs out) and is also idempotent.
 */

import { z } from "zod";

import {
  registerPushDevice,
  removePushDevice,
} from "../../notifications/push-device-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const pushDeviceSchema = z.object({
  id: z.string(),
  platform: z.enum(["ios", "android"]),
  token: z.string(),
  deviceName: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastSeenAt: z.number().int(),
});

// APNs device tokens are hex; FCM tokens are URL-safe base64 with ":".
// Loose shared bound — the real validation is Apple accepting the token.
const MAX_TOKEN_LENGTH = 512;

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "registerPushDevice",
    endpoint: "push-devices",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Register a push device token",
    description:
      "Register (or refresh) a mobile device token for remote push notifications. Idempotent — re-registering a known token updates its metadata.",
    tags: ["push-devices"],
    requestBody: z.object({
      platform: z.enum(["ios", "android"]),
      token: z.string(),
      deviceName: z.string().optional(),
    }),
    responseBody: z.object({
      device: pushDeviceSchema,
    }),
    handler: ({ body }) => {
      const { platform, token, deviceName } = (body ?? {}) as {
        platform?: string;
        token?: string;
        deviceName?: string;
      };
      if (platform !== "ios" && platform !== "android") {
        throw new BadRequestError("platform must be 'ios' or 'android'");
      }
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        token.length > MAX_TOKEN_LENGTH
      ) {
        throw new BadRequestError("token must be a non-empty string");
      }
      const device = registerPushDevice({
        platform,
        token,
        ...(typeof deviceName === "string" && deviceName.length > 0
          ? { deviceName }
          : {}),
      });
      return { device };
    },
  },

  {
    operationId: "unregisterPushDevice",
    endpoint: "push-devices/:token",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Unregister a push device token",
    description:
      "Remove a device token from the push registry. Idempotent — deleting an unknown token succeeds with removed=false.",
    tags: ["push-devices"],
    pathParams: [
      { name: "token", description: "The device token to unregister" },
    ],
    responseBody: z.object({
      removed: z.boolean(),
    }),
    handler: ({ pathParams }) => {
      const removed = removePushDevice(pathParams!.token);
      return { removed };
    },
  },
];
