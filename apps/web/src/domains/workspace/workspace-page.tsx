import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { Mv3FilesPage } from "@/domains/workspace/mobile/mv3-files-page";
import { WorkspaceBrowser } from "@/domains/workspace/components/workspace-browser";
import { useIsMobile } from "@/hooks/use-is-mobile";

/**
 * Workspace — a faithful translation of surfaces/Workspace.dc.html onto the
 * assistant's real sandboxed file store.
 *
 * The mock's far-left dark nav and the "Identity / Connectors / … / Workspace"
 * tab bar are app chrome supplied by `IntelligenceLayout` — this page renders
 * only the Workspace TAB CONTENT: the stat cards, the file tree, and the rich
 * file preview with its Send / Ask Cue to revise actions.
 *
 * MOBILE (round-4 frame 64): the phone renders the "Files" gallery instead —
 * what Cue made, newest-50, read-only. `IntelligenceLayout` treats the route
 * as full-bleed on mobile; the desktop browser below is untouched.
 *
 * Routed under `<ActiveAssistantGate>`, so `useActiveAssistantId()` is safe.
 */
export function WorkspacePage() {
  const assistantId = useActiveAssistantId();
  const isMobile = useIsMobile();
  if (isMobile) {
    return <Mv3FilesPage assistantId={assistantId} />;
  }
  return <WorkspaceBrowser assistantId={assistantId} />;
}
