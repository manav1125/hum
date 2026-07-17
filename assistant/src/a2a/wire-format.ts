/**
 * A2A v1.0 wire-format (de)serialization — the single source of truth for
 * the JSON-RPC binding's casing rules.
 *
 * The A2A JSON-RPC binding requires **lowerCamelCase** field names on the
 * wire (`messageId`, `contextId`, `protocolVersion`, `defaultInputModes`,
 * …). Internally we model the protocol with the proto field names
 * (snake_case) in `protocol-types.ts`. This module converts between the two:
 *
 *  - `toWire*`   — internal (snake_case) → wire (camelCase). Used on every
 *                  outbound A2A payload (agent card, task, message, push
 *                  events).
 *  - `fromWire*` / `normalize*` — wire → internal, tolerant of BOTH casings
 *                  so existing Cue↔Cue peers that still emit snake_case keep
 *                  working during the rollout window.
 *
 * Keeping this in one module (imported by both the assistant and the gateway
 * card builders) prevents the two card serializers from drifting.
 */

import type {
  A2AMessage,
  A2ATask,
  AgentCard,
  Artifact,
  Part,
  SendMessageConfiguration,
  TaskPushNotificationConfig,
  TaskStatus,
  TaskStatusUpdateEvent,
} from "./protocol-types.js";

// ---------------------------------------------------------------------------
// Tolerant field readers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a field that may appear under either its camelCase or snake_case name.
 * camelCase wins when both are present (the canonical wire form).
 */
function pick(obj: Raw, camel: string, snake: string): unknown {
  if (obj[camel] !== undefined) return obj[camel];
  return obj[snake];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Outbound: internal → wire (camelCase)
// ---------------------------------------------------------------------------

export function toWirePart(part: Part): Raw {
  switch (part.kind) {
    case "text":
      return { kind: "text", text: part.text };
    case "data":
      return {
        kind: "data",
        data: part.data,
        ...(part.media_type ? { mediaType: part.media_type } : {}),
      };
    case "file":
      return {
        kind: "file",
        ...(part.url ? { url: part.url } : {}),
        ...(part.raw ? { raw: part.raw } : {}),
        ...(part.filename ? { filename: part.filename } : {}),
        ...(part.media_type ? { mediaType: part.media_type } : {}),
      };
  }
}

export function toWireMessage(message: A2AMessage): Raw {
  return {
    kind: "message",
    messageId: message.message_id,
    role: message.role,
    parts: message.parts.map(toWirePart),
    ...(message.context_id ? { contextId: message.context_id } : {}),
    ...(message.task_id ? { taskId: message.task_id } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
  };
}

function toWireStatus(status: TaskStatus): Raw {
  return {
    state: status.state,
    timestamp: status.timestamp,
    ...(status.message ? { message: toWireMessage(status.message) } : {}),
  };
}

function toWireArtifact(artifact: Artifact): Raw {
  return {
    artifactId: artifact.artifact_id,
    parts: artifact.parts.map(toWirePart),
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
  };
}

export function toWireTask(task: A2ATask): Raw {
  return {
    kind: "task",
    id: task.id,
    status: toWireStatus(task.status),
    ...(task.context_id ? { contextId: task.context_id } : {}),
    ...(task.artifacts
      ? { artifacts: task.artifacts.map(toWireArtifact) }
      : {}),
    ...(task.history ? { history: task.history.map(toWireMessage) } : {}),
    ...(task.metadata ? { metadata: task.metadata } : {}),
  };
}

export function toWireStatusUpdateEvent(event: TaskStatusUpdateEvent): Raw {
  return {
    kind: "status-update",
    taskId: event.task_id,
    status: toWireStatus(event.status),
    final: event.final,
  };
}

/**
 * Serialize an agent card to its spec-conformant camelCase wire form.
 *
 * Emits `protocolVersion`, top-level `url` + `preferredTransport`, and
 * `securitySchemes` — the fields A2A clients (and OpenClaw's a2a-gateway)
 * require for discovery and authenticated calls.
 */
export function toWireCard(card: AgentCard): Raw {
  const primary = card.supported_interfaces[0];
  return {
    protocolVersion: card.protocol_version,
    name: card.name,
    description: card.description,
    version: card.version,
    ...(primary
      ? { url: primary.url, preferredTransport: primary.protocol_binding }
      : {}),
    additionalInterfaces: card.supported_interfaces.map((iface) => ({
      url: iface.url,
      transport: iface.protocol_binding,
    })),
    capabilities: {
      streaming: card.capabilities.streaming,
      pushNotifications: card.capabilities.push_notifications,
      extendedAgentCard: card.capabilities.extended_agent_card,
    },
    defaultInputModes: card.default_input_modes,
    defaultOutputModes: card.default_output_modes,
    skills: card.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
    })),
    ...(card.security_schemes
      ? { securitySchemes: card.security_schemes }
      : {}),
    ...(card.security_requirements
      ? { security: card.security_requirements }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Inbound: wire → internal (tolerant of both casings)
// ---------------------------------------------------------------------------

function normalizePart(raw: unknown): Part | null {
  if (!isRecord(raw)) return null;
  const kind = asString(raw.kind);
  if (kind === "text") {
    return { kind: "text", text: asString(raw.text) ?? "" };
  }
  if (kind === "data") {
    const data = raw.data;
    return {
      kind: "data",
      data: isRecord(data) ? data : {},
      ...(asString(pick(raw, "mediaType", "media_type"))
        ? { media_type: asString(pick(raw, "mediaType", "media_type")) }
        : {}),
    };
  }
  if (kind === "file") {
    return {
      kind: "file",
      ...(asString(raw.url) ? { url: asString(raw.url) } : {}),
      ...(asString(raw.raw) ? { raw: asString(raw.raw) } : {}),
      ...(asString(raw.filename) ? { filename: asString(raw.filename) } : {}),
      ...(asString(pick(raw, "mediaType", "media_type"))
        ? { media_type: asString(pick(raw, "mediaType", "media_type")) }
        : {}),
    };
  }
  return null;
}

/**
 * Parse an inbound A2A message, accepting either camelCase (spec) or
 * snake_case (legacy Cue↔Cue) field names. Throws on structurally invalid
 * input so the JSON-RPC layer can map it to INVALID_PARAMS.
 */
export function normalizeInboundMessage(raw: unknown): A2AMessage {
  if (!isRecord(raw)) {
    throw new Error("message must be an object");
  }

  const partsRaw = raw.parts;
  if (!Array.isArray(partsRaw)) {
    throw new Error("message.parts must be an array");
  }
  const parts = partsRaw
    .map(normalizePart)
    .filter((p): p is Part => p !== null);
  if (parts.length === 0) {
    throw new Error("message.parts must contain at least one valid part");
  }

  const role = asString(raw.role);
  if (role !== "user" && role !== "agent") {
    throw new Error("message.role must be 'user' or 'agent'");
  }

  const messageId =
    asString(pick(raw, "messageId", "message_id")) ?? crypto.randomUUID();

  const metadata = raw.metadata;

  return {
    message_id: messageId,
    role,
    parts,
    ...(asString(pick(raw, "contextId", "context_id"))
      ? { context_id: asString(pick(raw, "contextId", "context_id")) }
      : {}),
    ...(asString(pick(raw, "taskId", "task_id"))
      ? { task_id: asString(pick(raw, "taskId", "task_id")) }
      : {}),
    ...(isRecord(metadata) ? { metadata } : {}),
  };
}

function normalizePushConfig(
  raw: unknown,
): TaskPushNotificationConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const url = asString(raw.url);
  if (!url) return undefined;
  const authentication = raw.authentication;
  return {
    url,
    ...(isRecord(authentication) ? { authentication } : {}),
  };
}

/**
 * Parse an inbound send-message configuration block (tolerant of both
 * casings). Returns undefined when no configuration is present.
 */
export function normalizeSendConfiguration(
  raw: unknown,
): SendMessageConfiguration | undefined {
  if (!isRecord(raw)) return undefined;

  const acceptedOutputModes = pick(
    raw,
    "acceptedOutputModes",
    "accepted_output_modes",
  );
  const historyLength = pick(raw, "historyLength", "history_length");
  const returnImmediately = pick(
    raw,
    "returnImmediately",
    "return_immediately",
  );
  const pushConfig = normalizePushConfig(
    pick(raw, "pushNotificationConfig", "task_push_notification_config"),
  );

  return {
    ...(Array.isArray(acceptedOutputModes)
      ? {
          accepted_output_modes: acceptedOutputModes.filter(
            (m): m is string => typeof m === "string",
          ),
        }
      : {}),
    ...(typeof historyLength === "number"
      ? { history_length: historyLength }
      : {}),
    ...(typeof returnImmediately === "boolean"
      ? { return_immediately: returnImmediately }
      : {}),
    ...(pushConfig ? { task_push_notification_config: pushConfig } : {}),
  };
}

/**
 * Extract a task id from a `tasks/get` or `tasks/cancel` params block,
 * tolerating both `id` and `taskId`/`task_id` shapes used across A2A clients.
 */
export function normalizeTaskIdParam(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) return null;
  return asString(raw.id) ?? asString(pick(raw, "taskId", "task_id")) ?? null;
}
