/**
 * Chat-domain MarkdownMessage that composes the design-library primitive
 * with OAuth-aware link handling for authorization URLs in chat responses.
 */

import type { AnchorHTMLAttributes } from "react";

import {
  openMarkdownOAuthLinkInPopup,
  shouldOpenMarkdownLinkInOAuthPopup,
} from "@/domains/chat/utils/oauth-popup-links";
import {
  MarkdownMessage,
  type MarkdownMessageProps,
} from "@vellumai/design-library";

/**
 * A model occasionally hallucinates a "link" to a sandbox app — e.g.
 * `preview://app/foo`, `vellumapp://…`, or a raw `/v1/apps/…` path. None of these
 * are navigable: apps only open via their `app_open` card → the in-app viewer.
 * Clicking such a link would fall back to navigating the SPA (the user lands on
 * the wrong page — usually the conversation). Detect these and make them inert
 * so a slipped-through bad link can't misroute. (The app-builder skill also
 * forbids writing them in the first place.)
 */
function isNonNavigableAppLink(href: string | undefined): boolean {
  if (!href) return false;
  const h = href.trim().toLowerCase();
  if (/^(preview|vellumapp|sandbox|app):\/\//.test(h)) return true;
  if (/(^|\/)(v1\/)?apps\//.test(h)) return true;
  return false;
}

function OAuthAwareLink({
  href,
  children,
}: Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) {
  const opensOAuthPopup = shouldOpenMarkdownLinkInOAuthPopup(href);
  const nonNavigable = isNonNavigableAppLink(href);

  return (
    <a
      href={nonNavigable ? undefined : href}
      target={nonNavigable ? undefined : "_blank"}
      rel={opensOAuthPopup ? undefined : "noopener noreferrer"}
      title={
        nonNavigable
          ? "Open this app from your Library — it has no shareable link."
          : undefined
      }
      onClick={(event) => {
        if (nonNavigable) {
          event.preventDefault();
          return;
        }
        if (openMarkdownOAuthLinkInPopup(href)) {
          event.preventDefault();
        }
      }}
      className="text-[var(--system-positive-strong)] underline hover:opacity-80"
    >
      {children}
    </a>
  );
}

export type ChatMarkdownMessageProps = Omit<
  MarkdownMessageProps,
  "linkComponent"
>;

export function ChatMarkdownMessage(props: ChatMarkdownMessageProps) {
  return <MarkdownMessage {...props} linkComponent={OAuthAwareLink} />;
}
