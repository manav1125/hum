import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import type { GlobalSearchOutcome } from "@/domains/chat/api/global-search";
import {
  searchFailureMessage,
  searchGlobal,
  SEARCH_UNAVAILABLE_MESSAGE,
} from "@/domains/chat/api/global-search";
import { PALETTE_SEARCH_CATEGORIES } from "@/domains/chat/hooks/command-palette-utils";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

export interface UseCommandPaletteOptions {
  /** Total number of items in the results list, for bounds clamping. Can be a number or a getter function for lazy evaluation to avoid stale closure issues. */
  itemCount: number | (() => number);
  /** Called when Enter is pressed on the selected item. */
  onSelect?: (index: number) => void;
  /** Assistant ID for server-side global search. If omitted, search is disabled. */
  assistantId?: string | null;
  /** Controlled open state for standalone hosts such as the floating window. */
  isOpen?: boolean;
  /** Called when the palette closes, after local state has reset. */
  onClose?: () => void;
}

export interface UseCommandPaletteReturn {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  /** Whether a server search is currently in-flight. */
  isSearching: boolean;
  /**
   * What the last server search actually produced — results, a failure, or a
   * reason it could not run. `null` before the first search of a session.
   *
   * This replaced a bare `GlobalSearchResponse | null`, under which a 500 and a
   * genuine no-match were the same value and the palette rendered both as
   * "No results". Consumers must narrow on `status`.
   */
  searchOutcome: GlobalSearchOutcome | null;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (value: string) => void;
  /** Key-down handler to attach to the palette container or input. */
  handleKeyDown: (e: KeyboardEvent) => void;
}

const DEBOUNCE_MS = 150;
/** Exported so the empty-state sentence can name the same threshold. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Hook managing the command palette state: open/close toggle, search query,
 * keyboard navigation (arrow up/down, Enter, Escape), and debounced server
 * search via the daemon's global search API.
 */
export function useCommandPalette({
  itemCount: itemCountProp,
  onSelect,
  assistantId,
  isOpen: controlledIsOpen,
  onClose,
}: UseCommandPaletteOptions): UseCommandPaletteReturn {
  const storeIsOpen = useCommandPaletteStore.use.isOpen();
  const isOpen = controlledIsOpen ?? storeIsOpen;
  const storeOpen = useCommandPaletteStore.use.open();
  const storeClose = useCommandPaletteStore.use.close();

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [searchOutcome, setSearchOutcome] =
    useState<GlobalSearchOutcome | null>(null);

  const itemCountGetterRef = useRef<() => number>(() => 0);
  useLayoutEffect(() => {
    itemCountGetterRef.current =
      typeof itemCountProp === "function" ? itemCountProp : () => itemCountProp;
  });

  // Refs for debounce + abort management.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelSearch = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const open = useCallback(() => {
    storeOpen();
    setSelectedIndex(0);
  }, [storeOpen]);

  const close = useCallback(() => {
    storeClose();
    setQuery("");
    setSelectedIndex(0);
    setIsSearching(false);
    setSearchOutcome(null);
    cancelSearch();
    onClose?.();
  }, [storeClose, cancelSearch, onClose]);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }, [isOpen, close, open]);

  // Reset local state when palette is closed externally (e.g. via the
  // store's toggle called from the layout-level search button).
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setIsSearching(false);
      setSearchOutcome(null);
      cancelSearch();
    }
  }, [isOpen, cancelSearch]);

  /**
   * Trigger a debounced search for the given query value. Immediately clears
   * results if the query is below the minimum length threshold.
   */
  const triggerSearch = useCallback(
    (q: string) => {
      cancelSearch();

      const trimmed = q.trim();
      if (trimmed.length < MIN_QUERY_LENGTH) {
        setIsSearching(false);
        setSearchOutcome(null);
        return;
      }

      // No assistant resolved yet: say so rather than showing a short local
      // list and letting it read as "that's everything you have".
      if (!assistantId) {
        setIsSearching(false);
        setSearchOutcome({
          status: "unavailable",
          query: trimmed,
          message: SEARCH_UNAVAILABLE_MESSAGE,
        });
        return;
      }

      setIsSearching(true);

      debounceTimerRef.current = setTimeout(() => {
        const controller = new AbortController();
        abortControllerRef.current = controller;

        searchGlobal(assistantId, trimmed, {
          signal: controller.signal,
          categories: PALETTE_SEARCH_CATEGORIES,
        })
          .then((outcome) => {
            if (abortControllerRef.current !== controller) return;
            // A superseded keystroke never searched — leave the previous
            // outcome alone rather than replacing it with a blank.
            if (outcome.status === "cancelled") return;
            setSearchOutcome(outcome);
            setIsSearching(false);
          })
          .catch((err: unknown) => {
            // `searchGlobal` does not reject; a throw here would be a bug in
            // this hook's own callback, and swallowing it silently is how a
            // broken palette looks like an empty one.
            if (abortControllerRef.current !== controller) return;
            console.error("[command-palette] search callback threw", err);
            setSearchOutcome({
              status: "error",
              query: trimmed,
              message: searchFailureMessage(),
            });
            setIsSearching(false);
          });
      }, DEBOUNCE_MS);
    },
    [cancelSearch, assistantId],
  );

  const handleSetQuery = useCallback(
    (value: string) => {
      setQuery(value);
      setSelectedIndex(0);
      triggerSearch(value);
    },
    [triggerSearch],
  );

  // If the assistant resolves AFTER the user has already typed, search now.
  // Without this, "I'm not connected to your Cue yet" would stay on screen
  // after it stopped being true, waiting for a keystroke to disprove it — a
  // stale explanation is only marginally better than a silent one.
  const queryRef = useRef(query);
  useLayoutEffect(() => {
    queryRef.current = query;
  });
  const hadAssistantRef = useRef(assistantId);
  useEffect(() => {
    const had = hadAssistantRef.current;
    hadAssistantRef.current = assistantId;
    if (had || !assistantId || !isOpen) return;
    if (queryRef.current.trim().length < MIN_QUERY_LENGTH) return;
    triggerSearch(queryRef.current);
  }, [assistantId, isOpen, triggerSearch]);

  // Cleanup on unmount — cancel in-flight searches.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // A standalone host (the floating Electron palette window) controls `isOpen`
  // itself and has no chat layout above it, so it is the only owner of ⌘K there.
  const isStandaloneHost = controlledIsOpen !== undefined;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      /**
       * ⌘K closes the palette — but only in a standalone host.
       *
       * In-page, the layout-level opener (`use-chat-layout-shortcuts`) fires ⌘K
       * from anywhere including a focused input, which is what makes the
       * shortcut work in chat at all. The palette is portaled to `document.body`
       * so its keydown still reaches `window` afterwards: handling ⌘K here as
       * well would close the palette and let the layout re-open it in the same
       * keystroke, and ⌘K would look inert while doing two things. One key, one
       * owner.
       */
      if (isStandaloneHost && e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        close();
        return;
      }

      const count = itemCountGetterRef.current();
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (count > 0) {
            setSelectedIndex((prev) => Math.min(prev + 1, count - 1));
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (count > 0) {
            onSelect?.(selectedIndex);
          }
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
      }
    },
    [onSelect, selectedIndex, close, isStandaloneHost],
  );

  return {
    isOpen,
    query,
    selectedIndex,
    isSearching,
    searchOutcome,
    open,
    close,
    toggle,
    setQuery: handleSetQuery,
    handleKeyDown,
  };
}
