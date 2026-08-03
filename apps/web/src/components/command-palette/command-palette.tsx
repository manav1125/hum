import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Loader2, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  type FC,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useMobileLayout } from "@/hooks/use-is-mobile";
import { Button, Typography } from "@vellumai/design-library";

import { CommandPaletteItem } from "@/components/command-palette/command-palette-item";
import { MIN_QUERY_LENGTH } from "@/components/command-palette/use-command-palette";
import type { GlobalSearchOutcome } from "@/domains/chat/api/global-search";
import {
  emptyResultsMessage,
  searchNoticeFor,
} from "@/domains/chat/hooks/command-palette-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandPaletteItemData {
  id: string;
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  shortcutHint?: ReactNode;
}

export interface CommandPaletteSection {
  id: string;
  label: string;
  items: CommandPaletteItemData[];
}

export interface CommandPaletteProps {
  /** Whether the palette is currently visible. */
  isOpen: boolean;
  /** Close the palette. */
  onClose: () => void;
  /** Current search query. */
  query: string;
  /** Update the search query. */
  onQueryChange: (value: string) => void;
  /** Currently selected index (flat across all sections). */
  selectedIndex: number;
  /** Sections of results to display. */
  sections: CommandPaletteSection[];
  /** Whether a server search is currently in-flight. */
  isSearching?: boolean;
  /**
   * What the last server search produced. Passed whole rather than pre-reduced
   * to a boolean so this component renders WHICH outcome it got: a failure gets
   * Cue's own words in red, an empty result gets a sentence saying why it is
   * empty, and the two can never collapse into the same "No results".
   */
  searchOutcome?: GlobalSearchOutcome | null;
  /** Called when an item is selected (clicked or Enter pressed). */
  onItemSelect?: (item: CommandPaletteItemData, index: number) => void;
  /** Key-down handler from useCommandPalette for keyboard navigation. */
  onKeyDown: (e: KeyboardEvent) => void;
  /** Render without the main-app backdrop/portal inside a floating window. */
  surface?: "overlay" | "window";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * macOS Spotlight-style command palette overlay on desktop, swapping to a
 * full-area inline overlay on a phone. Dismissable by Escape or backdrop
 * click. Keyboard-shortcut hints (per-item and the ⌘K badge) are suppressed
 * on the phone branch since there is no physical keyboard to invoke them —
 * which is exactly why the gate is `useMobileLayout()` and not a raw width
 * test: every narrow Electron window still has a real keyboard.
 *
 * Accepts items/sections as props — no data fetching is performed internally.
 */
export const CommandPalette: FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  query,
  onQueryChange,
  selectedIndex,
  sections,
  isSearching = false,
  searchOutcome = null,
  onItemSelect,
  onKeyDown,
  surface = "overlay",
}) => {
  const isMobile = useMobileLayout();
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus the search input when the palette opens.
  useEffect(() => {
    if (isOpen) {
      // Small timeout to ensure the element is mounted before focusing.
      const id = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  // Scroll the selected item into view when keyboard-navigating.
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const selected = listRef.current.querySelector("[aria-current='page']");
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, selectedIndex]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  if (!isOpen) {
    return null;
  }

  // Flatten all items to compute the global index for each item.
  let flatIndex = 0;
  const isWindowSurface = surface === "window";
  // `isWindowSurface` was a hand-rolled platform guard for ONE Electron
  // surface: the standalone 584px Spotlight panel (`command-palette-window.ts`)
  // trips the 767px breakpoint. `useMobileLayout()` now covers every Electron
  // window — including the 720px chat pop-out and Cmd+ zoom, which this clause
  // never caught — so the check remains only for the browser-hosted window page.
  const isPhoneLayout = isMobile && !isWindowSurface;

  const searchInputRow = (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-4 py-3">
      {isSearching ? (
        <Loader2
          size={16}
          aria-hidden
          className="shrink-0 animate-spin text-[var(--content-tertiary)]"
        />
      ) : (
        <Search
          size={16}
          aria-hidden
          className="shrink-0 text-[var(--content-tertiary)]"
        />
      )}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search conversations, memories…"
        className={
          isWindowSurface
            ? "min-w-0 flex-1 bg-transparent text-sm font-medium text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none"
            : "min-w-0 flex-1 bg-transparent text-body-medium-lighter text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none"
        }
        aria-label="Search"
      />
      {query ? (
        isPhoneLayout ? (
          <button
            type="button"
            className="shrink-0 text-body-medium-lighter text-[var(--content-tertiary)]"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
          >
            Clear
          </button>
        ) : isWindowSurface ? (
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-overlay)] hover:text-[var(--content-default)]"
            aria-label="Clear search"
            onClick={() => onQueryChange("")}
          >
            <X size={16} aria-hidden />
          </button>
        ) : (
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<X />}
            aria-label="Clear search"
            onClick={() => onQueryChange("")}
            tintColor="var(--content-tertiary)"
          />
        )
      ) : isPhoneLayout ? null : (
        <kbd
          className={
            isWindowSurface
              ? "shrink-0 rounded-md border border-[var(--border-base)] bg-[var(--surface-active)] px-1.5 py-0.5 text-xs font-medium text-[var(--content-secondary)]"
              : "shrink-0 rounded-md border border-[var(--border-base)] bg-[var(--surface-active)] px-1.5 py-0.5 text-label-small-default text-[var(--content-tertiary)]"
          }
        >
          ⌘K
        </kbd>
      )}
      {isPhoneLayout ? (
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          expandOnMobile={false}
          aria-label="Close search"
          onClick={onClose}
          tintColor="var(--content-tertiary)"
        />
      ) : null}
    </div>
  );

  // Cue reports its own errors first, verbatim, first person — above the list,
  // before anything the user might otherwise read as a complete answer.
  const notice = searchNoticeFor(searchOutcome);
  const emptyMessage =
    sections.length === 0
      ? emptyResultsMessage({
          query,
          isSearching,
          outcome: searchOutcome,
          minQueryLength: MIN_QUERY_LENGTH,
        })
      : null;

  // Red is reserved for Cue reporting its own failure, and it never carries the
  // meaning alone — the glyph and the sentence do too (see the design library's
  // note on `--state-failure`). `--state-failure-text` rather than the fill leg
  // because this copy sits below 16px.
  const noticeRow = notice ? (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={
        notice.tone === "error"
          ? "mx-2 mt-2 flex shrink-0 items-start gap-2 rounded-lg border border-[var(--state-failure)] bg-[var(--state-failure-weak)] px-3 py-2"
          : "mx-2 mt-2 flex shrink-0 items-start gap-2 rounded-lg px-3 py-2"
      }
    >
      {notice.tone === "error" ? (
        <AlertTriangle
          size={14}
          aria-hidden
          className="mt-0.5 shrink-0 text-[var(--state-failure-text)]"
        />
      ) : null}
      <Typography
        variant="body-medium-lighter"
        className={
          notice.tone === "error"
            ? "text-[var(--state-failure-text)]"
            : "text-[var(--content-tertiary)]"
        }
      >
        {notice.message}
      </Typography>
    </div>
  ) : null;

  const resultsList = (
    <div
      ref={listRef}
      className={
        isPhoneLayout
          ? "flex-1 overflow-y-auto overscroll-contain p-2"
          : "max-h-[360px] overflow-y-auto overscroll-contain p-2"
      }
      role="listbox"
    >
      {sections.length === 0 ? (
        emptyMessage ? (
          <div className="px-3 py-6 text-center">
            <Typography
              variant="body-medium-lighter"
              className="text-[var(--content-tertiary)]"
            >
              {emptyMessage}
            </Typography>
          </div>
        ) : null
      ) : (
        sections.map((section) => (
          <div key={section.id} role="group" aria-label={section.label}>
            <Typography
              variant="label-small-default"
              as="div"
              className={
                isWindowSurface
                  ? "px-3 pb-1 pt-2 text-xs font-semibold text-[var(--content-tertiary)]"
                  : "px-3 pb-1 pt-2 text-[var(--content-tertiary)]"
              }
            >
              {section.label}
            </Typography>
            {section.items.map((item) => {
              const currentIndex = flatIndex++;
              return (
                <CommandPaletteItem
                  key={item.id}
                  icon={item.icon}
                  title={item.title}
                  subtitle={item.subtitle}
                  shortcutHint={isPhoneLayout ? undefined : item.shortcutHint}
                  isSelected={currentIndex === selectedIndex}
                  onClick={() => onItemSelect?.(item, currentIndex)}
                  surface={surface}
                />
              );
            })}
          </div>
        ))
      )}
    </div>
  );

  if (isPhoneLayout) {
    return (
      <div
        className="absolute inset-0 z-30 flex flex-col bg-[var(--surface-lift)]"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onKeyDown}
        style={{
          paddingTop:
            "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
          paddingBottom:
            "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
          paddingLeft:
            "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
          paddingRight:
            "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
        }}
      >
        {searchInputRow}
        {noticeRow}
        {resultsList}
      </div>
    );
  }

  const desktopPalette = (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className={
        surface === "window"
          ? "flex h-full w-full items-start justify-center bg-transparent p-3"
          : "fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      }
      onClick={handleBackdropClick}
      onKeyDown={onKeyDown}
    >
      <div className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] shadow-xl">
        {searchInputRow}
        {noticeRow}
        {resultsList}
      </div>
    </div>
  );

  if (surface === "window") {
    return desktopPalette;
  }

  return createPortal(desktopPalette, document.body);
};
