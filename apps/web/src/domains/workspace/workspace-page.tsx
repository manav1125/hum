import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { WorkspaceBrowser } from "@/domains/workspace/components/workspace-browser";

/**
 * Workspace — a faithful translation of surfaces/Workspace.dc.html onto the
 * assistant's real sandboxed file store.
 *
 * The mock's far-left dark nav and the "Identity / Connectors / … / Workspace"
 * tab bar are app chrome supplied by `IntelligenceLayout` — this page renders
 * only the Workspace TAB CONTENT: the stat cards, the file tree, and the rich
 * file preview with its Send / Ask Cue to revise actions.
 *
 * Routed under `<ActiveAssistantGate>`, so `useActiveAssistantId()` is safe.
 */
export function WorkspacePage() {
  const assistantId = useActiveAssistantId();
  return <WorkspaceBrowser assistantId={assistantId} />;
}
