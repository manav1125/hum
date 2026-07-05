/**
 * Kit orchestrator — launches the background generations behind a Create Studio
 * fan-out kit. Given a persisted kit + its `pending` assets, it spawns ONE
 * background generation conversation per asset, each seeded with the SAME
 * shared brief + compiled design-contract + active brand so the whole set reads
 * as coordinated while each asset renders in the right Create surface.
 *
 * GENERATION PRIMITIVE — this reuses the exact primitive the work-item runner
 * uses under the hood (bootstrapConversation → getOrCreateConversation →
 * guardian-trusted, headless-locked processMessage), but WITHOUT the task /
 * work-item scaffolding: a fan-out asset is a one-off generation off a brief,
 * not a project task, so there is no task template to render. The seed prompt
 * is built here from the format's artifact instruction + the shared contract,
 * and the brain routes it to the right surface/skill (deck → app-builder,
 * one-pager/doc → document-editor, social → image) via its normal skill_load
 * routing — matching how the frontend's ?prompt= re-seed path works today.
 *
 * Output capture mirrors work-output-store: after a run's turn completes, the
 * first attachment linked to an ASSISTANT message of the run conversation is
 * the produced deliverable, recorded as the asset's `outputRef`.
 */

import { getOrCreateConversation } from "../daemon/conversation-store.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { firstRunProducedAttachmentId } from "./kit-output.js";
import {
  getKitWithAssets,
  type Kit,
  type KitAsset,
  updateKitAsset,
} from "./kit-store.js";

const log = getLogger("kit-orchestrator");

/**
 * A fan-out format: the Create mode it resolves to and the artifact phrasing
 * seeded into the brain so it routes to the right surface. Mirrors the
 * frontend `FANOUT_FORMATS` (create-remix.ts) — the daemon owns the mapping so
 * the kit endpoint takes format ids, not free-form prompts.
 */
interface FanoutFormatSpec {
  mode: string;
  /** Instruction fragment naming what to produce ("a slide deck", …). */
  produce: string;
}

const FANOUT_FORMAT_SPECS: Record<string, FanoutFormatSpec> = {
  slides: { mode: "slides", produce: "a slide deck" },
  one_pager: { mode: "docs", produce: "a one-page summary document" },
  social: { mode: "image", produce: "a set of 3 social images" },
  email: { mode: "docs", produce: "an email announcement" },
  landing: { mode: "canvas", produce: "a landing-page section" },
};

/** Resolve the Create mode for a fan-out format id (defaults to the id). */
export function resolveFormatMode(format: string): string {
  return FANOUT_FORMAT_SPECS[format]?.mode ?? format;
}

/** The artifact phrasing for a format, for the seed instruction. */
function producePhrase(format: string): string {
  return FANOUT_FORMAT_SPECS[format]?.produce ?? `a ${format}`;
}

/**
 * Build one asset's seed message: the shared design-contract preamble (so the
 * asset inherits the same palette/fonts/brand as every sibling) followed by the
 * brief and the format-specific artifact instruction. The contract goes first
 * so the brain reads the constraints before the ask, matching create-intent.ts.
 */
export function buildAssetSeedPrompt(kit: Kit, asset: KitAsset): string {
  const instruction =
    `From the brief below, make ${producePhrase(asset.format)}. ` +
    `Keep it in the same brand and on-message with the rest of the kit so the ` +
    `whole set reads as one coordinated launch.\n\n` +
    `BRIEF:\n${kit.brief}`;
  const contract = kit.contractPreamble?.trim();
  return contract ? `${contract}\n\n---\n\n${instruction}` : instruction;
}

/**
 * Run one asset's generation in a dedicated background conversation, updating
 * its status + output as it goes. Resolves when the turn completes (or fails);
 * never throws — a single asset failure is isolated to that asset's row.
 */
async function runAsset(kit: Kit, asset: KitAsset): Promise<void> {
  const conv = bootstrapConversation({
    conversationType: "background",
    source: "kit",
    groupId: "system:background",
    origin: "task",
    systemHint: `Kit asset: ${asset.format}`,
  });

  updateKitAsset(asset.id, { conversationId: conv.id, status: "running" });
  broadcastKitAsset(asset.id);

  try {
    const conversation = await getOrCreateConversation(conv.id);
    conversation.headlessLock = true;
    // A kit is launched from the owner's own Create surface, so the run carries
    // guardian trust — matching the work-item runner precedent. Without this
    // every side-effect tool hits the unverified-channel gate and the run
    // "completes" having produced nothing. Risk gates + trust rules still apply.
    conversation.setTrustContext({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });

    await conversation.processMessage({
      content: buildAssetSeedPrompt(kit, asset),
      attachments: [],
      onEvent: (event) => broadcastMessage(event),
      isInteractive: false,
    });

    conversation.headlessLock = false;

    // Capture the produced deliverable: the first attachment the run's tools
    // linked to an assistant message of this conversation.
    const outputRef = firstRunProducedAttachmentId(conv.id);
    updateKitAsset(asset.id, { status: "done", outputRef: outputRef ?? null });
  } catch (err) {
    log.error(
      { err, kitId: kit.id, assetId: asset.id, format: asset.format },
      "kit asset generation failed",
    );
    updateKitAsset(asset.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  broadcastKitAsset(asset.id);
}

/**
 * Launch every `pending` asset of a kit, each in its own background generation.
 * Fire-and-forget: returns immediately after kicking off the runs so the create
 * route can respond with the tracked set right away. Assets run concurrently —
 * they share no state beyond the persisted kit, so a slow deck never blocks the
 * social set.
 */
export function launchKit(kitId: string): void {
  const kit = getKitWithAssets(kitId);
  if (!kit) {
    log.warn({ kitId }, "launchKit called for a missing kit (ignored)");
    return;
  }
  for (const asset of kit.assets) {
    if (asset.status !== "pending") continue;
    void runAsset(kit, asset);
  }
}

/**
 * Re-run a single asset without touching the rest of the kit. Resets it to
 * `pending` and relaunches it in a fresh background conversation. Fire-and-
 * forget. No-op when the kit or asset is missing.
 */
export function regenerateAsset(kitId: string, assetId: string): boolean {
  const kit = getKitWithAssets(kitId);
  if (!kit) return false;
  const asset = kit.assets.find((a) => a.id === assetId);
  if (!asset) return false;
  // Clear the prior run's state so the status view reads honestly while it
  // re-runs; a fresh conversation is created inside runAsset.
  updateKitAsset(asset.id, {
    status: "pending",
    conversationId: null,
    outputRef: null,
    error: null,
  });
  const reset = { ...asset, status: "pending" as const };
  void runAsset(kit, reset);
  return true;
}

function broadcastKitAsset(assetId: string): void {
  // A lightweight "an asset in some kit changed" nudge so subscribed clients
  // refetch GET kits/{kid}. The kit event type is not yet in the ServerMessage
  // contract union (the frontend wiring is a separate workstream), so this is
  // cast through unknown until that lands — the status source of truth is the
  // GET route regardless of whether the nudge is delivered.
  broadcastMessage({
    type: "kit_asset_changed",
    assetId,
  } as unknown as ServerMessage);
}
