import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Rewrite the Balanced Economy profile description so it names the trade-off
// the customer is choosing instead of the inference vendor behind it.
//
// A managed customer never picked, pays for, or administers the vendor, and
// the product does not name it. The seed template and migration 101 both used
// to write a description with the vendor and model in it, and that string is
// already sitting in `config.json` on every instance that ran 101 — on-platform
// workspaces keep the profile they were hatched with, so a reseed will not
// heal them.
//
// Only the two descriptions this codebase has ever written are replaced. A
// description the user edited is left alone: it is theirs, and a self-hoster
// naming their own model in it is entitled to.
const VENDOR_DESCRIPTIONS = new Set([
  "Strong open model (MiniMax M3) at a lower price point",
  "Strong open model (Kimi K2.6) at a lower price point",
]);

const NEW_DESCRIPTION =
  "Full-depth reasoning and longer answers, at a lower price";

export const devendorBalancedEconomyDescriptionMigration: WorkspaceMigration = {
  id: "104-devendor-balanced-economy-description",
  description:
    "Rewrite the Balanced Economy profile description to name the trade-off, not the vendor",

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = readObject(config.llm);
    if (llm === null) return;

    const profiles = readObject(llm.profiles);
    if (profiles === null) return;

    const profile = readObject(profiles["balanced-economy"]);
    if (profile === null) return;
    if (typeof profile.description !== "string") return;
    if (!VENDOR_DESCRIPTIONS.has(profile.description)) return;

    profile.description = NEW_DESCRIPTION;
    profiles["balanced-economy"] = profile;
    llm.profiles = profiles;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },

  down(_workspaceDir: string): void {
    // Forward-only: the previous text is the string this change exists to
    // remove, so there is nothing worth restoring.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
