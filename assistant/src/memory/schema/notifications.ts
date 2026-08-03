import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations.js";

export const notificationEvents = sqliteTable("notification_events", {
  id: text("id").primaryKey(),
  sourceEventName: text("source_event_name").notNull(),
  sourceChannel: text("source_channel").notNull(),
  sourceContextId: text("source_context_id").notNull(),
  attentionHintsJson: text("attention_hints_json").notNull().default("{}"),
  payloadJson: text("payload_json").notNull().default("{}"),
  dedupeKey: text("dedupe_key"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const notificationDecisions = sqliteTable("notification_decisions", {
  id: text("id").primaryKey(),
  notificationEventId: text("notification_event_id")
    .notNull()
    .references(() => notificationEvents.id, { onDelete: "cascade" }),
  shouldNotify: integer("should_notify").notNull(),
  selectedChannels: text("selected_channels").notNull().default("[]"),
  reasoningSummary: text("reasoning_summary").notNull(),
  confidence: real("confidence").notNull(),
  fallbackUsed: integer("fallback_used").notNull().default(0),
  promptVersion: text("prompt_version"),
  validationResults: text("validation_results"),
  createdAt: integer("created_at").notNull(),
});

export const notificationPreferences = sqliteTable("notification_preferences", {
  id: text("id").primaryKey(),
  preferenceText: text("preference_text").notNull(),
  appliesWhenJson: text("applies_when_json").notNull().default("{}"),
  priority: integer("priority").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sequences = sqliteTable("sequences", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  channel: text("channel").notNull(),
  steps: text("steps").notNull(), // JSON array of SequenceStep
  exitOnReply: integer("exit_on_reply", { mode: "boolean" })
    .notNull()
    .default(true),
  status: text("status").notNull().default("active"), // active | paused | archived
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sequenceEnrollments = sqliteTable(
  "sequence_enrollments",
  {
    id: text("id").primaryKey(),
    sequenceId: text("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    contactEmail: text("contact_email").notNull(),
    contactName: text("contact_name"),
    currentStep: integer("current_step").notNull().default(0),
    status: text("status").notNull().default("active"), // active | paused | completed | replied | cancelled | failed
    conversationId: text("conversation_id"),
    nextStepAt: integer("next_step_at"), // epoch ms
    context: text("context"), // JSON
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_seq_enrollments_status_next_step").on(
      table.status,
      table.nextStepAt,
    ),
    index("idx_seq_enrollments_sequence_id").on(table.sequenceId),
    index("idx_seq_enrollments_contact_email").on(table.contactEmail),
  ],
);

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    notificationDecisionId: text("notification_decision_id")
      .notNull()
      .references(() => notificationDecisions.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    destination: text("destination").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    renderedTitle: text("rendered_title"),
    renderedBody: text("rendered_body"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    sentAt: integer("sent_at"),
    conversationId: text("conversation_id"),
    messageId: text("message_id"),
    conversationStrategy: text("conversation_strategy"),
    conversationAction: text("conversation_action"),
    conversationTargetId: text("conversation_target_id"),
    conversationFallbackUsed: integer("conversation_fallback_used"),
    clientDeliveryStatus: text("client_delivery_status"),
    clientDeliveryError: text("client_delivery_error"),
    clientDeliveryAt: integer("client_delivery_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_notification_deliveries_decision_channel").on(
      table.notificationDecisionId,
      table.channel,
    ),
  ],
);

export const conversationAttentionEvents = sqliteTable(
  "conversation_attention_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceChannel: text("source_channel").notNull(),
    signalType: text("signal_type").notNull(),
    confidence: text("confidence").notNull(),
    source: text("source").notNull(),
    evidenceText: text("evidence_text"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    observedAt: integer("observed_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_conv_attn_events_conv_observed").on(
      table.conversationId,
      table.observedAt,
    ),
    index("idx_conv_attn_events_observed").on(table.observedAt),
    index("idx_conv_attn_events_channel_observed").on(
      table.sourceChannel,
      table.observedAt,
    ),
  ],
);

export const conversationAssistantAttentionState = sqliteTable(
  "conversation_assistant_attention_state",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    latestAssistantMessageId: text("latest_assistant_message_id"),
    latestAssistantMessageAt: integer("latest_assistant_message_at"),
    lastSeenAssistantMessageId: text("last_seen_assistant_message_id"),
    lastSeenAssistantMessageAt: integer("last_seen_assistant_message_at"),
    lastSeenEventAt: integer("last_seen_event_at"),
    lastSeenConfidence: text("last_seen_confidence"),
    lastSeenSignalType: text("last_seen_signal_type"),
    lastSeenSourceChannel: text("last_seen_source_channel"),
    lastSeenSource: text("last_seen_source"),
    lastSeenEvidenceText: text("last_seen_evidence_text"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_conv_attn_state_latest_msg").on(table.latestAssistantMessageAt),
    index("idx_conv_attn_state_last_seen").on(table.lastSeenAssistantMessageAt),
  ],
);

/**
 * Mobile devices registered for remote push (APNs today, FCM later).
 * One row per device token; re-registering an existing token refreshes
 * its metadata (`push-device-store.registerPushDevice`). Rows are pruned
 * when APNs reports the token invalid (410 Unregistered / BadDeviceToken).
 */
export const pushDevices = sqliteTable(
  "push_devices",
  {
    id: text("id").primaryKey(),
    /** "ios" | "android" */
    platform: text("platform").notNull(),
    token: text("token").notNull(),
    deviceName: text("device_name"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("push_devices_token_unique").on(table.token),
    index("push_devices_platform_idx").on(table.platform),
  ],
);

/**
 * One row per remote-push decision — delivered or suppressed — so the daily
 * interruption ceiling (`notifications/push-budget.ts`) is enforced against a
 * count that survives a daemon restart, and so "how noisy was I today" is
 * answerable from real rows rather than a guess.
 *
 * Deliberately content-free: the event name, the tier and a throttle key, and
 * nothing a device token, an address or a message body could be read out of.
 * Rows older than the retention window are pruned on write.
 */
export const pushBudgetLedger = sqliteTable(
  "push_budget_ledger",
  {
    id: text("id").primaryKey(),
    /** Local calendar day `YYYY-MM-DD` in the effective push timezone. */
    dayKey: text("day_key").notNull(),
    /** "correction" | "time_critical" | "ambient" */
    tier: text("tier").notNull(),
    sourceEventName: text("source_event_name").notNull(),
    /** Throttle/collapse key, e.g. `wi:<id>`. Never message content. */
    subjectKey: text("subject_key"),
    /** 1 = delivered to at least one device, 0 = suppressed. */
    delivered: integer("delivered").notNull(),
    /** One line, from the decision. Null for delivered rows is not allowed. */
    reason: text("reason").notNull(),
    /** Set only when a correction was delivered inside quiet hours. */
    brokeQuietHours: integer("broke_quiet_hours").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_push_budget_ledger_day").on(table.dayKey),
    index("idx_push_budget_ledger_day_delivered").on(
      table.dayKey,
      table.delivered,
    ),
    index("idx_push_budget_ledger_created").on(table.createdAt),
  ],
);
