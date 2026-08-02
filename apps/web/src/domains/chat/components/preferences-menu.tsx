import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Gift,
  MessageSquareText,
  Settings as SettingsIcon,
  Shield,
  SunMoon,
  User,
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
import { ownerLineText, useOwnerLine } from "./use-owner-line";

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
  const ownerLine = useOwnerLine(assistantId);

  if (!isAuthenticated) {
    return null;
  }

  const closeMenu = () => setIsOpen(false);

  // `👤 Manav · Autonomous · $4.10`. Design's footer is the owner's NAME, the
  // autonomy tier and the spend — the row that says whose workspace this is —
  // acting as the door to Trust / Preferences / Billing. It was labelled
  // "Preferences", which named the mechanism, and the owner read the settings
  // pages as having been removed. Segments that cannot be read are dropped
  // rather than defaulted; see `use-owner-line.ts`.
  const line = ownerLineText(ownerLine);

  const trigger = (
    <SideMenu.Item
      icon={User}
      label={line}
      // Collapsed, the rail suppresses the label and the icon is aria-hidden,
      // so the row had no accessible name at all.
      aria-label={`${line} — your account and Your Cue`}
      tooltip={line}
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

/**
 * Why the Profile row is disabled when it is. Stated once, shown on the row and
 * read out to screen readers — a disabled control that does not say why is just
 * a dead control with extra steps.
 */
export const NO_PROFILE_REASON =
  "Cue has no profile page. Your handle lives on the Cue platform, and this assistant isn't signed in to one.";

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
  const isAuthenticated = useIsAuthenticated();
  const platformGate = usePlatformGate();
  const billingPlatformGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isOrgReady = useIsOrgReady();
  const showBillingRows =
    billingPlatformGate === "full" && isPlatformHosted && isOrgReady;
  // The EXACT condition `general-page.tsx` renders the Profile card under. Both
  // read the same two values, so the row cannot offer a card that is not there
  // — the "row that renders but goes nowhere" failure, one layer up.
  const hasProfileSurface = isAuthenticated && platformGate === "full";
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
        Profile — and the straight answer about it.

        The owner asked for the footer to "go right into my profile (do we have
        that?)". **We do not have a profile page.** The search was for a surface
        about the OWNER's own identity, which is a different thing from
        `/assistant/identity` — that one is the ASSISTANT's identity (its name,
        voice and persona) and it is easy to mistake for this.

        What exists is a `Profile` card on Preferences → General
        (`components/profile-card.tsx`): it edits the user handle against
        `/v1/user/me/`, so it is genuinely the owner's own record — but it is a
        card with no door of its own, it holds only handles (no name, no email,
        no avatar), and it renders ONLY when there is a live Vellum platform
        session. On a self-hosted assistant it never appears at all.

        So this row does not pretend. When the card is actually there, the row
        deep-links to it. When it is not, the row is disabled and says why,
        rather than navigating somewhere that does not contain your profile —
        which is the same failure as a row that renders and does nothing.
      */}
      {hasProfileSurface ? (
        <PanelItem
          icon={User}
          label="Profile"
          onSelect={() => {
            onClose();
            navigate(`${routes.settings.general}#profile`);
          }}
        />
      ) : (
        <div
          aria-disabled="true"
          title={NO_PROFILE_REASON}
          className="flex cursor-default items-center gap-2 px-2 py-1.5 text-body-medium-default text-[var(--content-secondary)]"
        >
          {/* A glyph, not a dimmed tint — no state here is colour-only. */}
          <span aria-hidden>⊘</span>
          <span>Profile</span>
          <span className="sr-only"> — {NO_PROFILE_REASON}</span>
        </div>
      )}

      {/*
        Trust · Preferences · Billing collapsed into Your Cue.

        These were three rows here, on design's ruling that the footer line is
        the door to all three. The owner has since consolidated: *"the rest is
        my cue since we've consolidated everything under there now."* All three
        are leaves under Your Cue (Guardrails · Preferences · Preferences →
        Billing), so every one of them is still reachable and every route still
        resolves — they are one click further from a row you open by clicking
        your own name, which is where configuration belongs.
      */}
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
        Your Cue is intentionally last: the popover anchors side="top", so the
        final item sits closest to the Preferences trigger. Item-level ordering
        can't be asserted by the SSR test harness (open={false}).

        This is the same door as the rail's ⚙ Your Cue row, deliberately: it is
        the account cluster's way back to configuration and it lands on the
        identical destination, so it is one path rendered in the two places a
        cursor already is — not two destinations.
      */}
      <PanelItem
        icon={SettingsIcon}
        label="Your Cue"
        onSelect={() => {
          onClose();
          navigate(routes.yourCue);
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
