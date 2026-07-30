import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { IdentityTab } from "@/domains/intelligence/components/identity-tab";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { Mv3IdentityPage } from "@/mobile-v3/you/identity-page";

interface IdentityPageProps {
  onOpenThread?: (message: string) => void;
}

export function IdentityPage({ onOpenThread }: IdentityPageProps) {
  const assistantId = useActiveAssistantId();
  const isMobile = useMobileLayout();

  // Mobile (round-4 frame 53): the v3 You-cluster Identity leaf. Desktop
  // keeps the existing IdentityTab untouched.
  if (isMobile) {
    return <Mv3IdentityPage assistantId={assistantId} />;
  }

  return <IdentityTab assistantId={assistantId} onOpenThread={onOpenThread} />;
}
