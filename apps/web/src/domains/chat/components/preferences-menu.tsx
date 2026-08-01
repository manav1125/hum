import { useQuery } from "@tanstack/react-query";
import {
  ChartColumn,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Gift,
  MessageSquareText,
  Settings as SettingsIcon,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  SunMoon,
} from "lucide-react";
import { lazy, useState } from "react";
import { useNavigate } from "react-router";

import {
  BottomSheet,
  PanelItem,
  Popover,
  SideMenu,
} from "@vellumai/design-library";

import { LazyBoundary } from "@/components/lazy-boundary";
import { ThemeToggle } from "@/components/theme-toggle";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { isElectron } from "@/runtime/is-electron";
import { useAuthStore, useIsAuthenticated } from "@/stores/auth-store";
import { openUrl } from "@/runtime/browser";
import { adminUrl, routes } from "@/utils/routes";
import { isPointerCoarse } from "@/utils/pointer";

import { CreditsCard } from "./credits-card";

// Modal only opens when the user clicks "Share Feedback" — defer loading
// until then to keep the modal's form deps (markdown editor, etc.) out of
// the initial bundle.
const ShareFeedbackModal = lazy(() =>
  import("@/components/share-feedback-modal").then((m) => ({
    default: m.ShareFeedbackModal,
  })),
);
const EarnCreditsModal = lazy(() =>
  import("@/components/earn-credits-modal").then((m) => ({
    default: m.EarnCreditsModal,
  })),
);

export interface PreferencesMenuProps {
  assistantId?: string | null;
  assistantVersion?: string | null;
  activeConversationId?: string | null;
}

export function PreferencesMenu({
  assistantId,
  assistantVersion,
  activeConversationId,
}: PreferencesMenuProps) {
  const isAuthenticated = useIsAuthenticated();
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [isEarnCreditsOpen, setIsEarnCreditsOpen] = useState(false);

  if (!isAuthenticated) {
    return null;
  }

  const closeMenu = () => setIsOpen(false);

  const trigger = (
    <SideMenu.Item
      icon={SlidersHorizontal}
      label="Preferences"
      trailingIcon={isOpen ? ChevronDown : ChevronUp}
      active={isOpen}
    />
  );

  const content = (
    <PreferencesMenuContent
      onClose={closeMenu}
      onShareFeedback={() => setIsFeedbackOpen(true)}
      onEarnCredits={() => setIsEarnCreditsOpen(true)}
    />
  );

  return (
    <>
      {isMobile ? (
        <BottomSheet.Root open={isOpen} onOpenChange={setIsOpen}>
          <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
          <BottomSheet.Content className="max-h-[85dvh]">
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>Preferences</BottomSheet.Title>
            </BottomSheet.Header>
            <BottomSheet.Body className="pt-0">{content}</BottomSheet.Body>
          </BottomSheet.Content>
        </BottomSheet.Root>
      ) : (
        <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            className="w-64 rounded-lg p-4"
          >
            {content}
          </Popover.Content>
        </Popover.Root>
      )}

      {isFeedbackOpen ? (
        <LazyBoundary>
          <ShareFeedbackModal
            open={isFeedbackOpen}
            onClose={() => setIsFeedbackOpen(false)}
            assistantId={assistantId}
            assistantVersion={assistantVersion}
            activeConversationId={activeConversationId}
          />
        </LazyBoundary>
      ) : null}

      {isEarnCreditsOpen ? (
        <LazyBoundary>
          <EarnCreditsModal
            open={isEarnCreditsOpen}
            onClose={() => setIsEarnCreditsOpen(false)}
          />
        </LazyBoundary>
      ) : null}
    </>
  );
}

interface PreferencesMenuContentProps {
  onClose: () => void;
  onShareFeedback: () => void;
  onEarnCredits: () => void;
}

export function PreferencesMenuContent({
  onClose,
  onShareFeedback,
  onEarnCredits,
}: PreferencesMenuContentProps) {
  const navigate = useNavigate();
  // A POINTER question, not a width or platform one — see the branch below.
  // Captured once (like `question-prompt-card`) so the menu can't swap its
  // theme control mid-interaction.
  const coarsePointer = useState(() => isPointerCoarse())[0];
  const user = useAuthStore.use.user();
  const platformGate = usePlatformGate();
  const billingPlatformGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isOrgReady = useIsOrgReady();
  const showBillingRows =
    billingPlatformGate === "full" && isPlatformHosted && isOrgReady;
  const { data: billingSummary } = useQuery({
    ...organizationsBillingSummaryRetrieveOptions(),
    enabled: showBillingRows,
  });
  const effectiveBalance = billingSummary?.effective_balance ?? null;

  return (
    <>
      {coarsePointer ? (
        // On touch, the inline System/Light/Dark segment is a footgun: a
        // single mis-tap (or stray arrow key) commits AND persists a theme
        // change from inside a transient sheet — the likely cause of "the
        // app spontaneously went light". Touch gets a quiet link into the
        // Appearance settings leaf instead; a mouse keeps the segment.
        //
        // Gated on POINTER, not width: the mis-tap risk comes from a fat
        // finger, not a narrow window. A width test took the segment away
        // from every narrow desktop window, which is mouse-driven and was
        // never at risk; a platform test would have kept the footgun on
        // mobile web.
        <PanelItem
          icon={SunMoon}
          label="Appearance"
          expandChevron={ChevronRight}
          onSelect={() => {
            onClose();
            navigate(routes.settings.general);
          }}
        />
      ) : (
        <ThemeToggle className="px-2 py-0" />
      )}

      <div className="my-2 border-t border-[var(--border-subtle)]" />

      {showBillingRows && effectiveBalance !== null ? (
        <div className="my-2">
          <CreditsCard
            balance={formatWholeCredits(effectiveBalance)}
            onAddCredits={() => {
              onClose();
              navigate(routes.settings.billing);
            }}
          />
        </div>
      ) : null}

      {showBillingRows ? (
        <PanelItem
          icon={Gift}
          label="Earn Free Credits"
          onSelect={() => {
            onClose();
            onEarnCredits();
          }}
        />
      ) : null}

      {/*
        Guardrails — checkpoints, agent scopes and the ACT LEDGER.
        Until now it had no entry in ANY persistent desktop navigation: the
        rail is deliberately surface-only (see assistant-side-menu's docblock),
        the Settings sidebar never listed it (it is not a /settings route), and
        the command palette does not carry it. It was reachable on desktop only
        from contextual cards — the automations board, "make it a rule", an
        agent's Adjust-scope — i.e. only if you already had a reason to be
        there. That fails the trust principle exactly where it matters most:
        the ledger is the surface a user goes looking for when they suspect Cue
        did something they did not sanction, and at that moment they are not on
        an agent card.

        It lands here rather than as an eighth rail row because this menu is
        the desktop counterpart of mobile's You screen, which already carries
        Guardrails + the ledger — one entry, in the matching place, instead of
        a second landing row of the kind this rail has had to clean up before.
        The desktop Guardrails page renders the ledger inline, so this single
        entry reaches it.
      */}
      <PanelItem
        icon={ShieldCheck}
        label="Guardrails"
        onSelect={() => {
          onClose();
          navigate(routes.guardrails);
        }}
      />

      <PanelItem
        icon={ChartColumn}
        label="Usage"
        onSelect={() => {
          onClose();
          navigate(routes.logs.usage);
        }}
      />

      {(platformGate === "full" || isElectron()) && (
        <PanelItem
          icon={MessageSquareText}
          label="Share Feedback"
          onSelect={() => {
            onClose();
            onShareFeedback();
          }}
        />
      )}

      {user?.isStaff ? (
        <PanelItem
          icon={Shield}
          label="Admin"
          onSelect={() => {
            onClose();
            void openUrl(adminUrl());
          }}
        />
      ) : null}

      {/*
        Settings is intentionally last: the popover anchors side="top", so
        the final item sits closest to the Preferences trigger. Item-level
        ordering can't be asserted by the SSR test harness (open={false}).
      */}
      <PanelItem
        icon={SettingsIcon}
        label="Settings"
        onSelect={() => {
          onClose();
          navigate(routes.settings.root);
        }}
      />
    </>
  );
}

function formatWholeCredits(value: string): string {
  const num = parseFloat(value);
  if (!Number.isFinite(num)) {
    return value;
  }
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
