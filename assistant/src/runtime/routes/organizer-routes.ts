/**
 * Desktop-organizer remote-view routes.
 *
 * The organize run executes on the paired Mac (via the `host_bash` proxy); the
 * phone / web is the remote that approves the plan and mirrors progress. This
 * read route exposes the two things the daemon can honestly report to a remote:
 *
 * - **session**: the plan / progress / done state of an organize run, from the
 *   in-memory recorder (`organizer-session.ts`). See that module's header for
 *   the emission gap — nothing populates it today, so `active` is honestly
 *   `false` until the skill wires progress back.
 * - **targets**: which Macs are connected right now (host_bash-capable hub
 *   subscribers, scoped to the calling actor). This powers the honest
 *   "RUNNING ON YOUR MAC · <machine>" attribution and the which-Mac picker.
 *   `GET /v1/clients` is excluded from the gateway-proxied web SDK, so the
 *   remote gets its connected-Mac list from here instead.
 *
 * Read-only and side-effect-free (RFC 9110 safe method).
 */

import { z } from "zod";

import { isHttpAuthDisabled } from "../../config/env.js";
import { datesToISO } from "../../util/json.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { getOrganizerView } from "./organizer-session.js";
import type { RouteDefinition } from "./types.js";

const OrganizerCategory = z.object({
  key: z.string(),
  label: z.string(),
  icon: z.string(),
  count: z.number(),
  destination: z.string(),
  included: z.boolean(),
});

const OrganizerPlan = z.object({
  root: z.string(),
  scannedCount: z.number(),
  archiveBase: z.string(),
  categories: z.array(OrganizerCategory),
  protectedNote: z.string(),
});

const OrganizerProgress = z.object({
  movedCount: z.number(),
  totalCount: z.number(),
  currentCategory: z.string().nullable(),
  perCategory: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      moved: z.number(),
      total: z.number(),
      done: z.boolean(),
    }),
  ),
});

const OrganizerDone = z.object({
  movedTotal: z.number(),
  archivePath: z.string(),
  undoAvailable: z.boolean(),
});

const OrganizerSessionView = z.object({
  active: z.boolean(),
  machineName: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  sessionStartedAt: z.string().nullable(),
  plan: OrganizerPlan.nullable(),
  progress: OrganizerProgress.nullable(),
  done: OrganizerDone.nullable(),
});

const OrganizerTarget = z.object({
  clientId: z.string(),
  machineName: z.string().nullable(),
  interfaceId: z.string(),
  connectedAt: z.string().nullable(),
  /** Last time the client was seen active. */
  lastSeenAt: z.string().nullable(),
  /** Connected clients are, by definition, online right now. */
  online: z.boolean(),
});

const OrganizerSessionResponse = z.object({
  session: OrganizerSessionView,
  targets: z.array(OrganizerTarget),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "organizer_session",
    endpoint: "organizer/session",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Remote view of the desktop-organizer run on the Mac",
    description:
      "What the daemon genuinely knows about a desktop-organizer run: the " +
      "approvable plan, move progress, and done tally (execution runs on the " +
      "paired Mac via host_bash — nothing is deleted, everything moves into " +
      "Cue Archive/<date>), plus the list of connected Macs the run can " +
      "target. The plan/progress fields stay inactive until the skill reports " +
      "back; the connected-Mac targets are live.",
    tags: ["organizer"],
    responseBody: OrganizerSessionResponse,
    logging: { silenceSuccessAfter: 5 },
    handler: ({ headers }) => {
      // Connected Macs = host_bash-capable hub subscribers, scoped to the
      // calling actor (same defense-in-depth as list_clients: fail closed for
      // subscribers with no stored principal unless auth is disabled).
      const clients = assistantEventHub.listClientsByCapability("host_bash");
      const callerPrincipalId = headers?.["x-vellum-actor-principal-id"];
      const owned = isHttpAuthDisabled()
        ? clients
        : clients.filter(
            (c) =>
              c.actorPrincipalId !== undefined &&
              c.actorPrincipalId === callerPrincipalId,
          );

      const targets = owned.map((c) =>
        datesToISO({
          clientId: c.clientId,
          machineName: c.machineName ?? null,
          interfaceId: c.interfaceId,
          connectedAt: c.connectedAt,
          lastSeenAt: c.lastActiveAt,
          online: true,
        }),
      );

      const session = getOrganizerView();
      // Honest attribution: if the run never reported its machine name, fall
      // back to the most-recently-active connected Mac so the remote can still
      // truthfully name where execution happens.
      if (!session.machineName && owned.length > 0) {
        session.machineName = owned[0].machineName ?? null;
      }

      return { session, targets };
    },
  },
];
