/**
 * A2A JSON-RPC method handler.
 *
 * Implements the authenticated data plane for the inbound A2A endpoint:
 *   - `message/send`  — authenticate, create a task (the agent run is driven
 *                       by the gateway inbound pipeline; the reply is delivered
 *                       later via the A2A push in `deliver.ts`).
 *   - `tasks/get`     — poll a task's state (OpenClaw's plugin and typical A2A
 *                       clients poll here since streaming is disabled).
 *   - `tasks/cancel`  — cancel a non-terminal task.
 *
 * Authentication (G1): every call must present `Authorization: Bearer
 * <peerToken>` that matches the per-connection token stored for the asserted
 * sender. The trusted-contact allowlist is a second, independent gate. Wire
 * format (G2): inbound params are parsed tolerantly (camelCase or snake_case);
 * outbound results are emitted in spec camelCase via `wire-format.ts`.
 *
 * This module is transport-agnostic and free of HTTP/DB-session assumptions
 * beyond the task store — it returns a plain `JsonRpcResponse` for every input
 * (including error cases), matching the JSON-RPC contract where transport
 * status stays 200 and errors live in the body.
 */

import { findContactByAddress } from "../contacts/contact-store.js";
import { getLogger } from "../util/logger.js";
import { parseBearer, verifyPeerToken } from "./peer-auth.js";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  makeJsonRpcError,
  makeJsonRpcSuccess,
  METHOD_NOT_FOUND,
  TASK_NOT_CANCELABLE,
  TASK_NOT_FOUND,
} from "./protocol-errors.js";
import type { A2AMessage, JsonRpcResponse } from "./protocol-types.js";
import * as taskStore from "./task-store.js";
import { TaskNotCancelableError, TaskNotFoundError } from "./task-store.js";
import {
  normalizeInboundMessage,
  normalizeSendConfiguration,
  normalizeTaskIdParam,
  toWireTask,
} from "./wire-format.js";

const log = getLogger("a2a-rpc");

// Authentication is signalled with the standard JSON-RPC "invalid request"
// code plus a descriptive message; the transport layer maps the presence of
// this error to an HTTP 401 for spec-compliant clients.
const AUTHENTICATION_REQUIRED = INVALID_REQUEST;

export interface A2ARpcAuthContext {
  /** Self-asserted sender id (from `params.metadata.senderId` or header). */
  senderAssistantId: string | null;
  /** Raw `Authorization` header value, if any. */
  authorization: string | null;
}

export interface A2ARpcResult {
  response: JsonRpcResponse;
  /**
   * Present only for a successful `message/send`: the created task id and the
   * inbound message, so the caller (gateway) can drive the agent run through
   * the inbound pipeline with a reply-callback bound to this task.
   */
  enqueue?: { taskId: string; message: A2AMessage; senderAssistantId: string };
}

interface JsonRpcLike {
  id: string | number | null;
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// Trust + auth gate
// ---------------------------------------------------------------------------

/** True when an active, allow-policy a2a channel exists for the sender. */
function isTrustedSender(senderAssistantId: string): boolean {
  const contact = findContactByAddress("a2a", senderAssistantId);
  if (!contact) return false;
  return contact.channels.some(
    (ch) => ch.type === "a2a" && ch.status === "active" && ch.policy !== "deny",
  );
}

type AuthOutcome = { ok: true } | { ok: false; response: JsonRpcResponse };

function authenticate(
  id: string | number | null,
  auth: A2ARpcAuthContext,
): AuthOutcome {
  const sender = auth.senderAssistantId?.trim();
  if (!sender) {
    return {
      ok: false,
      response: makeJsonRpcError(
        id,
        AUTHENTICATION_REQUIRED,
        "Missing sender identity",
      ),
    };
  }

  // Gate 1: per-peer bearer token.
  const presentedToken = parseBearer(auth.authorization);
  const tokenResult = verifyPeerToken({
    senderAssistantId: sender,
    presentedToken,
  });
  if (!tokenResult.ok) {
    log.warn(
      { senderAssistantId: sender, reason: tokenResult.reason },
      "A2A inbound authentication failed",
    );
    return {
      ok: false,
      response: makeJsonRpcError(
        id,
        AUTHENTICATION_REQUIRED,
        "Peer authentication failed",
      ),
    };
  }

  // Gate 2: trusted-contact allowlist (independent of the token).
  if (!isTrustedSender(sender)) {
    return {
      ok: false,
      response: makeJsonRpcError(
        id,
        AUTHENTICATION_REQUIRED,
        "Sender is not a trusted contact",
      ),
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

function handleMessageSend(
  id: string | number | null,
  params: unknown,
  senderAssistantId: string,
): A2ARpcResult {
  const paramsObj =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)
      : {};

  let message: A2AMessage;
  try {
    message = normalizeInboundMessage(paramsObj.message);
  } catch (err) {
    return {
      response: makeJsonRpcError(
        id,
        INVALID_PARAMS,
        err instanceof Error ? err.message : "Invalid message",
      ),
    };
  }

  const configuration = normalizeSendConfiguration(paramsObj.configuration);
  const pushUrl = configuration?.task_push_notification_config?.url;

  // Assign a stable context id when the peer omitted one. The same id is stored
  // on the task, echoed back in the wire response, and threaded into the
  // enqueue directive so the gateway's conversation binding (keyed on
  // contextId) and any peer follow-up (which reuses the returned contextId)
  // all resolve to the same conversation.
  const contextId = message.context_id ?? crypto.randomUUID();
  const requestMessage: A2AMessage = message.context_id
    ? message
    : { ...message, context_id: contextId };

  let task;
  try {
    task = taskStore.createTask({
      contextId,
      senderAssistantId,
      requestMessage,
      pushUrl,
    });
  } catch (err) {
    log.error(
      { senderAssistantId, error: String(err) },
      "Failed to create A2A task",
    );
    return {
      response: makeJsonRpcError(id, INTERNAL_ERROR, "Failed to create task"),
    };
  }

  return {
    response: makeJsonRpcSuccess(id, { task: toWireTask(task) }),
    enqueue: { taskId: task.id, message: requestMessage, senderAssistantId },
  };
}

function handleTasksGet(
  id: string | number | null,
  params: unknown,
): JsonRpcResponse {
  const taskId = normalizeTaskIdParam(params);
  if (!taskId) {
    return makeJsonRpcError(id, INVALID_PARAMS, "Missing task id");
  }
  const task = taskStore.getTask(taskId);
  if (!task) {
    return makeJsonRpcError(id, TASK_NOT_FOUND, `Task not found: ${taskId}`);
  }
  return makeJsonRpcSuccess(id, { task: toWireTask(task) });
}

function handleTasksCancel(
  id: string | number | null,
  params: unknown,
): JsonRpcResponse {
  const taskId = normalizeTaskIdParam(params);
  if (!taskId) {
    return makeJsonRpcError(id, INVALID_PARAMS, "Missing task id");
  }
  try {
    const task = taskStore.cancelTask(taskId);
    return makeJsonRpcSuccess(id, { task: toWireTask(task) });
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return makeJsonRpcError(id, TASK_NOT_FOUND, err.message);
    }
    if (err instanceof TaskNotCancelableError) {
      return makeJsonRpcError(id, TASK_NOT_CANCELABLE, err.message);
    }
    return makeJsonRpcError(id, INTERNAL_ERROR, "Failed to cancel task");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Handle a single parsed A2A JSON-RPC request. Always resolves to a
 * `JsonRpcResponse` (errors included). For a successful `message/send` the
 * returned `enqueue` directive tells the caller to drive the agent run.
 */
export function handleA2ARpc(
  request: JsonRpcLike,
  auth: A2ARpcAuthContext,
): A2ARpcResult {
  const { id, method } = request;

  const authOutcome = authenticate(id, auth);
  if (!authOutcome.ok) {
    return { response: authOutcome.response };
  }

  // Sender is guaranteed non-null after a successful authenticate().
  const senderAssistantId = auth.senderAssistantId!.trim();

  switch (method) {
    case "message/send":
    case "message:send":
      return handleMessageSend(id, request.params, senderAssistantId);
    case "tasks/get":
      return { response: handleTasksGet(id, request.params) };
    case "tasks/cancel":
      return { response: handleTasksCancel(id, request.params) };
    default:
      return {
        response: makeJsonRpcError(
          id,
          METHOD_NOT_FOUND,
          `Method not found: ${method}`,
        ),
      };
  }
}
