/**
 * Shared vocabulary for playbooks.
 *
 * The record itself lives in `playbook-store.ts` (the `playbooks` table) —
 * that is the one representation the runtime fires from and the Automations
 * surface renders.
 */

/** How much the assistant does on its own when a playbook matches. */
export type PlaybookAutonomyLevel = "auto" | "draft" | "notify";

/** Increasing autonomy: notify (surface only) < draft (prepare) < auto (act). */
export const PLAYBOOK_AUTONOMY_LEVELS: readonly PlaybookAutonomyLevel[] = [
  "notify",
  "draft",
  "auto",
];
