/**
 * CLI-side facade over the plugin registry's workspace-file access.
 *
 * The `assistant plugins` command is `transport: "local"` — it reads and
 * writes workspace files directly and must not import daemon-internal
 * modules (`plugins/registry/*`) itself; the `cli/no-daemon-internals`
 * ESLint rule enforces that boundary on any file that calls
 * `registerCommand`. Helper modules under `cli/lib/` are exempt (they are
 * not command entries), so this thin re-export module is the legitimate
 * seam through which the `local` command reaches the registry file-io.
 *
 * All three of these operate on workspace files only — no running daemon
 * required — so they stay on the `local` path. The one registry operation
 * that genuinely needs the daemon (seeding plugins into Qdrant) lives in
 * {@link ./plugin-embedding-client} and goes over IPC instead.
 *
 * Mirrors the existing `list-installed-plugins.ts` / `toggle-plugin.ts`
 * facades, which likewise wrap `<workspaceDir>/plugins/` access for the
 * CLI.
 */

export { reindexAllSources } from "../../plugins/registry/indexer.js";
export { findRegistryPlugin } from "../../plugins/registry/registry-file.js";
export {
  type PluginSearchCandidate,
  type RankedPluginResult,
  searchPluginRegistry,
} from "../../plugins/registry/search.js";
