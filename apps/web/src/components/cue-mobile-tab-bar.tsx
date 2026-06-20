/**
 * Cue mobile tab bar.
 *
 * On mobile the three-column desktop layout collapses, so primary navigation
 * moves to a persistent bottom tab bar reconciled to the design's clean rail:
 * Home · Chat · Voice · Contacts. Voice (the emphasized center mic) routes to
 * the full-bleed Voice mode screen (which owns the live-voice session); Chat
 * starts a fresh conversation. Memory and Tasks are no longer tabs — they stay
 * reachable in-app (Memory via Intelligence, Tasks/Next moves via Home).
 * Rendered only at the mobile breakpoint, as a flex-shrink-0 footer inside the
 * root layout (so it sits above the safe-area inset the shell pads).
 */

import { Home, Mic, MessageSquare, Users } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { navigateToNewConversation } from "@/domains/chat/utils/conversation-navigation";
import { routes } from "@/utils/routes";

interface NavTab {
  key: string;
  label: string;
  to: string;
  /** Match the active route by pathname suffix. */
  match: (pathname: string) => boolean;
}

const HOME_TAB: NavTab = {
  key: "home",
  label: "Home",
  to: routes.home,
  match: (p) => p.endsWith("/home"),
};

const CONTACTS_TAB: NavTab = {
  key: "contacts",
  label: "Contacts",
  to: routes.contacts.root,
  match: (p) => p.startsWith(routes.contacts.root),
};

export function CueMobileTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // A conversation route is "Chat" — `/assistant/conversations/:id` and the
  // bare `/assistant` index both resolve to the chat surface.
  const isChatActive =
    pathname === routes.assistant ||
    pathname === `${routes.assistant}/` ||
    pathname.startsWith(`${routes.conversations}/`);

  return (
    <nav
      data-slot="cue-mobile-tab-bar"
      aria-label="Primary"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "space-around",
        gap: 2,
        height: 58,
        padding: "0 6px",
        background: "var(--surface-raised, var(--surface-base))",
        borderTop: "1px solid var(--border-element)",
      }}
    >
      <TabButton
        label={HOME_TAB.label}
        active={HOME_TAB.match(pathname)}
        onClick={() => navigate(HOME_TAB.to)}
        icon={<Home size={20} strokeWidth={2} />}
      />

      <TabButton
        label="Chat"
        active={isChatActive}
        onClick={() => navigateToNewConversation(navigate)}
        icon={<MessageSquare size={20} strokeWidth={2} />}
      />

      <TabButton
        label="Voice"
        active={pathname.endsWith("/voice")}
        onClick={() => navigate(routes.voice)}
        icon={<Mic size={22} strokeWidth={2} />}
        emphasized
      />

      <TabButton
        label={CONTACTS_TAB.label}
        active={CONTACTS_TAB.match(pathname)}
        onClick={() => navigate(CONTACTS_TAB.to)}
        icon={<Users size={20} strokeWidth={2} />}
      />
    </nav>
  );
}

function TabButton({
  label,
  icon,
  active,
  busy = false,
  emphasized = false,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  busy?: boolean;
  emphasized?: boolean;
  onClick: () => void;
}) {
  const color = active
    ? "var(--accent-cue)"
    : "var(--content-secondary)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-busy={busy || undefined}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        border: "none",
        background: "transparent",
        color,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        opacity: busy ? 0.6 : 1,
      }}
    >
      <span
        style={
          emphasized
            ? {
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 38,
                height: 38,
                borderRadius: "26%",
                background: active ? "var(--accent-cue)" : "var(--surface-ink)",
                color: "var(--content-on-ink)",
              }
            : { display: "flex" }
        }
      >
        {icon}
      </span>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 500,
          letterSpacing: "0.01em",
        }}
      >
        {label}
      </span>
    </button>
  );
}
