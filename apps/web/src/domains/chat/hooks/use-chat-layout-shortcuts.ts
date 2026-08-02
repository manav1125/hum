import { useEffect } from "react";

import { openCommandPaletteWindow } from "@/runtime/command-palette-window";
import { useAddTasksStore } from "@/stores/add-tasks-store";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

/** True when the focused element is somewhere the user is typing. */
export function isTypingInto(activeElement: Element | null): boolean {
  if (!activeElement) return false;
  const tag = activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return activeElement.getAttribute("contenteditable") === "true";
}

/**
 * Returns `true` when the keyboard event matches Ctrl/Cmd + one of the given
 * keys and the active element is not an input surface.
 */
function shouldHandleShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">,
  activeElement: Element | null,
  key: string | string[],
): boolean {
  const modifierPressed = event.metaKey || event.ctrlKey;
  if (!modifierPressed) {
    return false;
  }
  const keys = Array.isArray(key) ? key : [key];
  if (!keys.includes(event.key)) {
    return false;
  }
  return !isTypingInto(activeElement);
}

/**
 * The two openers design specifies for the palette: `/` and `⌘K` (v8 W1).
 *
 * They are deliberately NOT the same rule, because the two keys fail
 * differently:
 *
 *   · **`⌘K` fires wherever you are, composer included.** Nobody types `⌘K`
 *     into a message. Suppressing it while an input has focus is what made the
 *     palette unreachable in chat — the composer is auto-focused there, so the
 *     one shortcut the UI advertises did nothing on the surface where it is
 *     advertised most.
 *   · **`/` fires only when you are not typing.** It is a bare printable
 *     character. Opening a palette every time someone types a slash mid-word
 *     would be the same class of bug as a single-key verb firing while you
 *     write "Wednesday".
 *
 * Neither is `⌘F`. Find-in-page is a browser reflex older than this app and is
 * never intercepted — see `apps/macos/src/main/commands.ts` for the other half
 * of that promise, which is where it was actually being taken.
 */
export function isPaletteOpener(
  event: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  },
  activeElement: Element | null,
): boolean {
  if (event.altKey) return false;
  if (event.metaKey || event.ctrlKey) {
    return event.key === "k" || event.key === "K";
  }
  return event.key === "/" && !isTypingInto(activeElement);
}

/**
 * Registers global keyboard shortcuts for the chat layout:
 * - Ctrl/Cmd+\ → toggle sidebar
 * - Ctrl/Cmd+K, and `/` when not typing → open the command palette
 * - Ctrl/Cmd+[ → navigate back
 * - Ctrl/Cmd+] → navigate forward
 * - Ctrl/Cmd+Shift+A → toggle the "Add tasks" batch modal (frame D1)
 */
export function useChatLayoutShortcuts({
  toggleSidebar,
  onGoBack,
  onGoForward,
}: {
  toggleSidebar: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
}): void {
  useEffect(() => {
    const toggle = useCommandPaletteStore.getState().toggle;
    const openCommandPalette = () => {
      void openCommandPaletteWindow()
        .then((opened) => {
          if (!opened) toggle();
        })
        .catch(() => {
          toggle();
        });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘⇧A — batch "Add tasks" (event.key is "A" with shift held).
      if (
        event.shiftKey &&
        shouldHandleShortcut(event, document.activeElement, ["a", "A"])
      ) {
        event.preventDefault();
        useAddTasksStore.getState().toggle();
        return;
      }
      if (shouldHandleShortcut(event, document.activeElement, "\\")) {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (isPaletteOpener(event, document.activeElement)) {
        event.preventDefault();
        openCommandPalette();
        return;
      }
      if (shouldHandleShortcut(event, document.activeElement, ["[", "]"])) {
        event.preventDefault();
        if (event.key === "[") onGoBack();
        else if (event.key === "]") onGoForward();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [toggleSidebar, onGoBack, onGoForward]);
}
