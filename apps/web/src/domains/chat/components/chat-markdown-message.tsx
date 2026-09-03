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

/**
 * A Learn course deep link (`…/assistant/learn?p=/classroom/<id>`) renders as
 * a course chip — the cover grammar's smallest size class — instead of a bare
 * text link: ink tile with the violet ◆, the course title in the display
 * face, a mono COURSE label, and the whole chip as one ≥44px tap target.
 * Absolute links are chipped only when they point at THIS origin; a link to
 * some other instance's Learn stays an ordinary external link.
 */
function learnCoursePath(href: string | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  try {
    const isRelative = h.startsWith("/");
    if (!isRelative && typeof window !== "undefined") {
      const u = new URL(h);
      if (u.host !== window.location.host) return null;
    } else if (!isRelative) {
      return null;
    }
    const u = new URL(h, "http://relative.local");
    if (!u.pathname.endsWith("/assistant/learn")) return null;
    const p = u.searchParams.get("p") ?? "";
    if (!/^\/classroom\/[A-Za-z0-9_-]+$/.test(p)) return null;
    return `/assistant/learn?p=${encodeURIComponent(p)}`;
  } catch {
    return null;
  }
}

function CourseChip({
  path,
  children,
  navigate,
}: {
  path: string;
  children: React.ReactNode;
  navigate: ((to: string) => void) | null;
}) {
  return (
    <a
      href={path}
      onClick={(event) => {
        if (!navigate) return;
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
        navigate(path);
      }}
      className="no-underline"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        padding: "6px 14px 6px 6px",
        margin: "2px 0",
        borderRadius: 12,
        border: "1px solid color-mix(in oklab, #7f77dd 40%, transparent)",
        background: "color-mix(in oklab, #7f77dd 7%, transparent)",
        color: "inherit",
        maxWidth: "100%",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 34,
          height: 34,
          borderRadius: 9,
          background: "#1a2230",
          color: "#7f77dd",
          fontSize: 15,
          flexShrink: 0,
        }}
      >
        ◆
      </span>
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontSize: 15.5,
            lineHeight: 1.2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {children}
        </span>
        <span
          style={{
            fontFamily: "'DM Mono', ui-monospace, monospace",
            fontSize: 8.5,
            letterSpacing: "0.14em",
            color: "#7f77dd",
          }}
        >
          COURSE
        </span>
      </span>
    </a>
  );
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
  const coursePath = learnCoursePath(href);

  if (coursePath) {
    return (
      <CourseChip path={coursePath} navigate={navigate}>
        {children}
      </CourseChip>
    );
  }

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
