import { Button } from "@vellumai/design-library";
import {
  ChevronLeft,
  ChevronRight,
  Menu as MenuIcon,
  PanelLeft,
  Search,
} from "lucide-react";
import { useCallback, useEffect, type ReactNode } from "react";

import { railToggleLabel } from "@/components/nav/rail-collapse";
import { isElectron } from "@/runtime/is-electron";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useTitleBarStore } from "@/stores/title-bar-store";

// On macOS the native window controls (traffic lights) overlay the top-left of
// the renderer. In the Electron shell the header renders as a unified title bar
// sitting *inline* with those controls (the desktop app centres the cluster
// vertically via `MAIN_TRAFFIC_LIGHT_POSITION`), so the left icon row is inset
// to start clear of the ~71px-wide cluster with a comfortable gap after it.
// The header's own `px-4` supplies the first 16px; this adds the remainder
// (≈ button left edge at 96px, leaving a ~25px gap past the green control).
// Off Electron the inset is 0.
const ELECTRON_TRAFFIC_LIGHT_CLEARANCE = 80;

export interface ChatLayoutHeaderProps {
  isMobile: boolean;
  drawerOpen: boolean;
  collapsed: boolean;
  /**
   * True while a transcript is on screen — where `◧` / `⌘\` means *pin the
   * rail open* rather than *collapse it*. See `rail-collapse.ts`.
   */
  inConversation?: boolean;
  sidebarWidth?: number;
  toggleSidebar: () => void;
  topBarCenter?: ReactNode;
  topBarRightSlot?: ReactNode;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
}

export function ChatLayoutHeader({
  isMobile,
  drawerOpen,
  collapsed,
  inConversation = false,
  sidebarWidth,
  toggleSidebar,
  topBarCenter,
  topBarRightSlot,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: ChatLayoutHeaderProps) {
  const toggleCommandPalette = useCommandPaletteStore.use.toggle();
  const handleSearchClick = useCallback(() => {
    toggleCommandPalette();
  }, [toggleCommandPalette]);

  // In the Electron shell the header doubles as the macOS title bar: it sits
  // inline with the traffic lights and drives window dragging
  // (`-webkit-app-region: drag`), with its interactive children opting back
  // out via `no-drag`. While mounted it claims the title bar so the global
  // `WindowDragRegion` fallback strip yields (see `useTitleBarStore`) —
  // otherwise that strip, living outside `.app-shell`'s `isolation: isolate`
  // context, would out-stack and swallow clicks on the header's buttons.
  // Gated to Electron so the web/iOS layouts are byte-for-byte unchanged.
  const electron = isElectron();

  const setInlineTitleBarActive =
    useTitleBarStore.use.setInlineTitleBarActive();
  useEffect(() => {
    if (!electron) return;
    setInlineTitleBarActive(true);
    return () => setInlineTitleBarActive(false);
  }, [electron, setInlineTitleBarActive]);

  return (
    <header
      data-slot="chat-layout-header"
      className={`flex w-full shrink-0 items-center gap-4 px-4 pt-4${isMobile ? " pb-4" : ""}${
        electron
          ? " select-none [-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag]"
          : ""
      }`}
      style={{
        background: "var(--surface-base)",
        minHeight: electron
          ? "44px"
          : "calc(40px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
        paddingTop: electron
          ? 0
          : "calc(16px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
      }}
    >
      <div
        className="flex items-center gap-2 transition-[min-width] duration-150 ease-in-out max-md:min-w-0 max-md:flex-1"
        style={{
          // `minWidth` reserves the sidebar column on desktop only. The Electron
          // inset clears the inline traffic lights regardless of `isMobile` —
          // they stay put even in the narrow mobile layout.
          ...(isMobile
            ? {}
            : { minWidth: collapsed ? 48 : (sidebarWidth ?? 230) }),
          ...(electron
            ? { paddingLeft: ELECTRON_TRAFFIC_LIGHT_CLEARANCE }
            : {}),
        }}
      >
        {isMobile ? (
          <Button
            variant="ghost"
            iconOnly={<MenuIcon />}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="chat-side-menu"
            tooltip="Open navigation"
            onClick={toggleSidebar}
          />
        ) : (
          // "Toggle sidebar" named the mechanism, not the effect, and never
          // mentioned the shortcut — so the one control that undoes the
          // auto-collapse was something you had to already know about. Both
          // this and the rail's own `◧` read the same label helper.
          <Button
            variant="ghost"
            iconOnly={<PanelLeft />}
            aria-label={railToggleLabel(collapsed, inConversation)}
            aria-expanded={!collapsed}
            aria-controls="chat-side-menu"
            tooltip={railToggleLabel(collapsed, inConversation)}
            onClick={toggleSidebar}
          />
        )}
        {/* No Home button here: it duplicated the sidebar's HQ item on desktop
            and the Today tab on mobile, and its unread dot read a retired feed
            (so it could show while you were already looking at HQ). The single
            "something needs you" signal now lives on those two nav items,
            sourced from `useNeedsYouBadge`. */}
        {!isMobile ? (
          <>
            <Button
              variant="ghost"
              iconOnly={<Search />}
              aria-label="Search (Ctrl+K)"
              tooltip="Search (Ctrl+K)"
              onClick={handleSearchClick}
            />
            <Button
              variant="ghost"
              iconOnly={<ChevronLeft />}
              aria-label="Back (Ctrl+[)"
              tooltip="Back (Ctrl+[)"
              disabled={!canGoBack}
              className={!canGoBack ? "opacity-35" : undefined}
              onClick={onGoBack}
            />
            <Button
              variant="ghost"
              iconOnly={<ChevronRight />}
              aria-label="Forward (Ctrl+])"
              tooltip="Forward (Ctrl+])"
              disabled={!canGoForward}
              className={!canGoForward ? "opacity-35" : undefined}
              onClick={onGoForward}
            />
          </>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center">
        {topBarCenter}
      </div>

      <div className="flex items-center gap-2 max-md:flex-1 max-md:justify-end">
        {isMobile ? (
          <Button
            variant="ghost"
            iconOnly={<Search />}
            aria-label="Search (Ctrl+K)"
            tooltip="Search (Ctrl+K)"
            onClick={handleSearchClick}
          />
        ) : null}
        {topBarRightSlot}
      </div>
    </header>
  );
}
