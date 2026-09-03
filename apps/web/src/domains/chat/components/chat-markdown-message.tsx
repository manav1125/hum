/**
 * Chat-domain MarkdownMessage that composes the design-library primitive
 * with OAuth-aware link handling for authorization URLs in chat responses.
 */

import type { AnchorHTMLAttributes } from "react";
import { useInRouterContext, useNavigate } from "react-router";

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
  // Hallucinated app-address schemes, in single- or double-slash form
  // (`sandbox:/preview/…`, `preview://app/…`, `vellumapp://…`, `app://…`).
  if (/^(preview|vellumapp|sandbox|app):\/+/.test(h)) return true;
  // Bare sandbox/preview paths a model may emit as a relative URL.
  if (/(^|\/)(v1\/)?apps\//.test(h)) return true;
  if (/(^|\/)preview\/[0-9a-f-]{8,}/.test(h)) return true;
  return false;
}

/**
 * Internal app routes the brain may link to (today: the Cue Design handoff,
 * `/assistant/design?project=…`). These should glide via the SPA router in the
 * same tab — not open a new tab (`target="_blank"`) or full-reload the app.
 * Matches only same-origin `/assistant/…` paths; anything with a scheme or a
 * different first segment is treated as external.
 */
function internalAppPath(href: string | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h.startsWith("/assistant/")) return null;
  // Reject protocol-relative (`//host/…`) and any embedded scheme.
  if (h.startsWith("//") || /^[a-z]+:/i.test(h)) return null;
  return h;
}

function OAuthAwareLink({
  href,
  children,
}: Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) {
  // Same-tab SPA navigation for internal routes only works inside the router;
  // `useNavigate` throws otherwise (SSR / bare test renders), so split so the
  // hook is only ever called when a router is present.
  return useInRouterContext() ? (
    <RouterAwareAnchor href={href}>{children}</RouterAwareAnchor>
  ) : (
    <AnchorImpl href={href} navigate={null}>
      {children}
    </AnchorImpl>
  );
}

function RouterAwareAnchor({
  href,
  children,
}: Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) {
  const navigate = useNavigate();
  return (
    <AnchorImpl href={href} navigate={navigate}>
      {children}
    </AnchorImpl>
  );
}

function AnchorImpl({
  href,
  children,
  navigate,
}: Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children"> & {
  navigate: ((to: string) => void) | null;
}) {
  const opensOAuthPopup = shouldOpenMarkdownLinkInOAuthPopup(href);
  const nonNavigable = isNonNavigableAppLink(href);
  const internalPath = navigate ? internalAppPath(href) : null;

  return (
    <a
      // Internal app routes navigate in the same tab via the SPA router, so a
      // handoff link (Open in Cue Design →) glides in place instead of opening
      // a fresh tab that reloads the whole app.
      href={nonNavigable ? undefined : href}
      target={nonNavigable || internalPath ? undefined : "_blank"}
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
        if (internalPath && navigate) {
          // Let modified clicks (⌘/ctrl/middle → new tab) keep default behavior.
          if (
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            event.button !== 0
          ) {
            return;
          }
          event.preventDefault();
          navigate(internalPath);
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
