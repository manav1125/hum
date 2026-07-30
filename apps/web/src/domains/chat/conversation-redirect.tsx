/**
 * Handles the `/assistant` index route. Redirects legacy `?conversationId=`
 * / `?conversationKey=` search params to canonical path-based URLs.
 * Otherwise renders `ChatPage` (new/default conversation).
 */
import { Navigate, useSearchParams } from "react-router";

import { ChatPage } from "@/domains/chat/chat-page";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";

export function ConversationRedirect() {
  const isMobile = useMobileLayout();
  const [searchParams] = useSearchParams();
  // Both params are checked intentionally: `conversationKey` predates the
  // `conversationId` cutover. Ancient saved/shared URLs only have `conversationKey`.
  const target =
    searchParams.get("conversationId") ?? searchParams.get("conversationKey");

  if (target) {
    const remaining = new URLSearchParams(searchParams);
    remaining.delete("conversationId");
    remaining.delete("conversationKey");
    const qs = remaining.toString();
    return (
      <Navigate
        to={`${routes.conversation(target)}${qs ? `?${qs}` : ""}`}
        replace
      />
    );
  }
  // On mobile (the design's primary surface), the default tab is Today — land
  // there instead of opening a fresh chat. Desktop keeps the chat-first index.
  if (isMobile) {
    return <Navigate to={routes.home} replace />;
  }
  return <ChatPage />;
}
