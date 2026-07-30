import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { UsageTab } from "@/domains/logs/components/usage-tab";
import { Mv3UsagePage } from "@/domains/logs/pages/mobile-usage-page";
import { useMobileLayout } from "@/hooks/use-is-mobile";

export function UsagePage() {
  const assistantId = useActiveAssistantId();
  const isMobile = useMobileLayout();

  // MOBILE (round-4 frame 61): the phone renders the native v3 Usage & spend
  // screen; LogsLayout stands down its SidebarShell for this route on mobile.
  if (isMobile) {
    return <Mv3UsagePage />;
  }

  return <UsageTab assistantId={assistantId} />;
}
