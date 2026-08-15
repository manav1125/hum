import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  __resetBodyScrollLockForTesting,
  useBodyScrollLock,
} from "@/hooks/use-body-scroll-lock";

beforeEach(() => {
  __resetBodyScrollLockForTesting();
});

afterEach(() => {
  cleanup();
  __resetBodyScrollLockForTesting();
});

describe("useBodyScrollLock", () => {
  test("locks the body while held and restores on release", () => {
    const { unmount } = renderHook(() => useBodyScrollLock(true));
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  test("does nothing while `locked` is false", () => {
    const { rerender } = renderHook(
      ({ locked }: { locked: boolean }) => useBodyScrollLock(locked),
      { initialProps: { locked: false } },
    );
    expect(document.body.style.overflow).toBe("");
    rerender({ locked: true });
    expect(document.body.style.overflow).toBe("hidden");
    rerender({ locked: false });
    expect(document.body.style.overflow).toBe("");
  });

  // The defect this hook exists to prevent: two overlays open, and the one
  // that opened FIRST closes first. With per-overlay save/restore the second
  // overlay had captured "hidden" as the page's value and handed it back on
  // close, leaving the page unscrollable until a reload.
  test("stays locked until the last holder releases, whatever the close order", () => {
    const drawer = renderHook(() => useBodyScrollLock(true));
    const modal = renderHook(() => useBodyScrollLock(true));
    expect(document.body.style.overflow).toBe("hidden");

    drawer.unmount();
    expect(document.body.style.overflow).toBe("hidden");

    modal.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  test("restores the page's own overflow value, not a nested lock's", () => {
    document.body.style.overflow = "scroll";

    const drawer = renderHook(() => useBodyScrollLock(true));
    const modal = renderHook(() => useBodyScrollLock(true));
    drawer.unmount();
    modal.unmount();

    expect(document.body.style.overflow).toBe("scroll");
  });

  test("a release from an already-unlocked state cannot clobber the body", () => {
    const first = renderHook(() => useBodyScrollLock(true));
    first.unmount();
    // Re-lock, then confirm the stale count from the released holder did not
    // drive the refcount negative (which would make the next release a no-op
    // and strand the lock).
    const second = renderHook(() => useBodyScrollLock(true));
    expect(document.body.style.overflow).toBe("hidden");
    second.unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
