/**
 * IPC route definitions for auto-approve threshold reads/writes.
 *
 * Exposes gateway-owned threshold data to the assistant daemon over
 * the IPC socket.
 */

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getGatewayDb } from "../db/connection.js";
import { resolveAutonomyPolicies } from "../http/routes/autonomy-policies.js";
import { resolveBudgetConfig } from "../http/routes/budget.js";
import {
  autoApproveThresholds,
  conversationThresholdOverrides,
} from "../db/schema.js";
import type { IpcRoute } from "./server.js";

/**
 * What every instance auto-approves up to when nobody has configured a
 * threshold — i.e. when `auto_approve_thresholds` holds no row, which is the
 * state a fresh instance is in and the state Manav's production instance is
 * still in.
 *
 * Exported because "an unset threshold means Strict" is a mistake that has
 * already been made in writing and shipped (see the correction in
 * `assistant/src/workspace/migrations/106-*`). It does not mean Strict. Only
 * `headless` is. Tests that reason about what a given risk level will do
 * should read these values rather than restate them.
 */
export const GLOBAL_DEFAULTS = {
  interactive: "medium",
  autonomous: "low",
  headless: "none",
};

const GetConversationThresholdSchema = z.object({
  conversationId: z.string().min(1),
});

const SetConversationThresholdSchema = z.object({
  conversationId: z.string().min(1),
  threshold: z.enum(["none", "low", "medium", "high"]),
});

export const thresholdRoutes: IpcRoute[] = [
  {
    method: "get_global_thresholds",
    handler: () => {
      const db = getGatewayDb();
      const row = db
        .select()
        .from(autoApproveThresholds)
        .where(eq(autoApproveThresholds.id, 1))
        .get();

      if (!row) return GLOBAL_DEFAULTS;

      return {
        interactive: row.interactive,
        autonomous: row.autonomous,
        headless: row.headless,
      };
    },
  },
  {
    method: "get_conversation_threshold",
    schema: GetConversationThresholdSchema,
    handler: (params?: Record<string, unknown>) => {
      const conversationId = params?.conversationId as string;
      const db = getGatewayDb();
      const row = db
        .select()
        .from(conversationThresholdOverrides)
        .where(
          eq(conversationThresholdOverrides.conversationId, conversationId),
        )
        .get();

      if (!row) return null;
      return { threshold: row.threshold };
    },
  },
  {
    method: "set_conversation_threshold",
    schema: SetConversationThresholdSchema,
    handler: (params?: Record<string, unknown>) => {
      const parsed = SetConversationThresholdSchema.parse(params ?? {});
      const db = getGatewayDb();
      db.insert(conversationThresholdOverrides)
        .values({
          conversationId: parsed.conversationId,
          threshold: parsed.threshold,
        })
        .onConflictDoUpdate({
          target: conversationThresholdOverrides.conversationId,
          set: {
            threshold: parsed.threshold,
            updatedAt: sql`datetime('now')`,
          },
        })
        .run();
      return {
        conversationId: parsed.conversationId,
        threshold: parsed.threshold,
      };
    },
  },
  {
    // Returns the full per-category autonomy policy map with SAFE DEFAULTS
    // already baked in (research/draft → auto, send/money/delete/other → ask).
    // The daemon reader relies on this map being complete.
    method: "get_autonomy_policies",
    handler: () => {
      return { policies: resolveAutonomyPolicies() };
    },
  },
  {
    // Returns the budget config singleton with DEFAULTS already baked in
    // (caps null = off, killSwitch false, alertThresholdPct 80). The daemon's
    // budget-cap provider relies on this shape being complete.
    method: "get_budget_config",
    handler: () => {
      return resolveBudgetConfig();
    },
  },
];
