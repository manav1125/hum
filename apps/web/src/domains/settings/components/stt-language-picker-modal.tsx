/**
 * Search-first listening-language picker for Settings → Voice, hosted in a
 * modal (the settings surface's dialog pattern — see `create-schedule-modal`).
 * Adapted from upstream vellum-assistant's shared `SttLanguagePicker`
 * (a386cf7dcf), trimmed to this fork's single surface and single
 * language-selectable provider (Deepgram): no provider scoping, no locale
 * suggestion row.
 *
 * Multilingual and English sit on top as peer rows — the two common intents,
 * follow-me-anywhere vs. pin-my-daily-driver — then the full roster A–Z.
 * While a query is active the groups collapse into one flat filtered list.
 *
 * Keyboard: combobox-with-listbox via `aria-activedescendant`. Focus stays
 * in the search input so typing always filters; ArrowDown/ArrowUp move the
 * highlight, Enter picks the highlighted option (or the first match while
 * filtering), Escape closes the modal. Options stay real buttons
 * (`role="option"`) so mouse picks work natively.
 *
 * A pick hot-applies from the next spoken turn (the daemon re-reads config
 * per exchange), so there is no Save: picking also closes the modal.
 */

import {
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Check, Search } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";

import {
  STT_LANGUAGE_OPTIONS,
  type SttLanguageOption,
  sttLanguageMatches,
} from "@/lib/stt/language-catalog";

export interface SttLanguagePickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The currently-selected catalog code, a pending pick included. */
  currentCode: string;
  /** Persist a pick; hot-applies from the next spoken turn. */
  onSelect: (code: string) => void;
  /** A write is in flight; the list dims but stays interactive. */
  selecting: boolean;
}

/** DOM id for an option, unique per picker instance and per code. */
function optionId(baseId: string, option: SttLanguageOption): string {
  return `${baseId}-option-${option.code}`;
}

// Multilingual + English lead the catalog by construction; the split here
// mirrors that so the group headers stay honest.
const FEATURED_COUNT = 2;
const FEATURED_OPTIONS = STT_LANGUAGE_OPTIONS.slice(0, FEATURED_COUNT);
const ROSTER_OPTIONS = STT_LANGUAGE_OPTIONS.slice(FEATURED_COUNT);

export function SttLanguagePickerModal({
  open,
  onOpenChange,
  currentCode,
  onSelect,
  selecting,
}: SttLanguagePickerModalProps) {
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        size="sm"
        // Radix autofocuses the first tabbable element on open; redirect it
        // to the search field so the first keystroke filters.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const container = event.target as HTMLElement | null;
          container
            ?.querySelector<HTMLInputElement>('input[role="combobox"]')
            ?.focus();
        }}
      >
        <Modal.Header>
          <Modal.Title>Listening language</Modal.Title>
          <Modal.Description>
            Applies from your next spoken turn.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <SttLanguagePickerContent
            currentCode={currentCode}
            selecting={selecting}
            onPick={(code) => {
              onSelect(code);
              onOpenChange(false);
            }}
          />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

function SttLanguagePickerContent({
  currentCode,
  selecting,
  onPick,
}: {
  currentCode: string;
  selecting: boolean;
  onPick: (code: string) => void;
}) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  // Index of the keyboard highlight across the *visible* options, -1 for
  // none. Reset on every query change (to the first match while filtering).
  const [activeIndex, setActiveIndex] = useState(-1);

  const filtering = query.trim().length > 0;
  const visibleOptions = useMemo(
    () =>
      filtering
        ? STT_LANGUAGE_OPTIONS.filter((option) =>
            sttLanguageMatches(option, query),
          )
        : STT_LANGUAGE_OPTIONS,
    [filtering, query],
  );

  // Focus lands in the search field so the first keystroke filters (the
  // modal host also redirects its open-autofocus here; running both is
  // idempotent).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The current selection starts visible: scroll it into view on mount
  // (focus stays in the search input, so no scroll comes for free).
  useEffect(() => {
    listRef.current
      ?.querySelector('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
    // Mount-only: later scrolls follow the keyboard highlight below.
  }, []);

  // Keep the keyboard highlight on screen as the arrows move it.
  useEffect(() => {
    if (activeIndex < 0) {
      return;
    }
    const option = visibleOptions[activeIndex];
    if (!option) {
      return;
    }
    document
      .getElementById(optionId(baseId, option))
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visibleOptions, baseId]);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visibleOptions.length === 0) {
        return;
      }
      setActiveIndex((index) =>
        event.key === "ArrowDown"
          ? Math.min(index + 1, visibleOptions.length - 1)
          : Math.max(index - 1, 0),
      );
      return;
    }
    if (event.key === "Enter") {
      // The highlighted option wins; while filtering with nothing
      // highlighted yet, the first match does (type "ta", Enter).
      const target =
        visibleOptions[activeIndex] ??
        (filtering ? visibleOptions[0] : undefined);
      if (target) {
        event.preventDefault();
        onPick(target.code);
      }
    }
  };

  const activeOption = activeIndex >= 0 ? visibleOptions[activeIndex] : null;

  const renderOption = (option: SttLanguageOption) => {
    const isSelected = option.code === currentCode;
    const isActive = option === activeOption;
    return (
      <button
        key={option.code}
        id={optionId(baseId, option)}
        type="button"
        role="option"
        aria-selected={isSelected}
        // Focus stays in the search input (aria-activedescendant pattern);
        // the buttons exist for the mouse and are skipped by Tab.
        tabIndex={-1}
        data-active={isActive || undefined}
        onClick={() => onPick(option.code)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left transition-colors",
          isSelected
            ? "bg-[var(--surface-active)]"
            : isActive
              ? "bg-[var(--surface-hover)]"
              : "hover:bg-[var(--surface-hover)]",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
          {option.label}
          {option.description && (
            <span className="block truncate text-label-small-default text-[var(--content-tertiary)]">
              {option.description}
            </span>
          )}
        </span>
        {isSelected && (
          <Check
            aria-hidden
            className="size-4 shrink-0 text-[var(--system-positive-strong)]"
          />
        )}
      </button>
    );
  };

  const groupHeader = (id: string, text: string) => (
    <div
      id={id}
      role="presentation"
      className="px-3 pt-2 pb-1 text-label-small-default text-[var(--content-tertiary)]"
    >
      {text}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded
        aria-controls={listboxId}
        aria-activedescendant={
          activeOption ? optionId(baseId, activeOption) : undefined
        }
        aria-autocomplete="list"
        aria-label="Search languages"
        placeholder="Search languages"
        leftIcon={<Search className="size-4" />}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          // Land the highlight on the first match so Enter's target is
          // visible; an empty query clears it (Enter must not pick blind).
          setActiveIndex(event.target.value.trim().length > 0 ? 0 : -1);
        }}
        onKeyDown={onSearchKeyDown}
        fullWidth
      />
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Languages"
        aria-busy={selecting}
        className={cn(
          "flex max-h-[50vh] flex-col overflow-y-auto",
          // The dim signals the in-flight write without blocking a
          // follow-up pick.
          selecting && "opacity-70",
        )}
      >
        {filtering ? (
          visibleOptions.length > 0 ? (
            visibleOptions.map(renderOption)
          ) : (
            <p className="px-3 py-2.5 text-body-medium-default text-[var(--content-tertiary)]">
              No languages match.
            </p>
          )
        ) : (
          <>
            <div role="group" aria-labelledby={`${baseId}-featured`}>
              {groupHeader(`${baseId}-featured`, "Featured")}
              {FEATURED_OPTIONS.map(renderOption)}
            </div>
            <div role="group" aria-labelledby={`${baseId}-all`}>
              {groupHeader(`${baseId}-all`, "All languages")}
              {ROSTER_OPTIONS.map(renderOption)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
