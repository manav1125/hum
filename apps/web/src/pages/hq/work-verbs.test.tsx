/**
 * Tests for the verb layer (§4).
 *
 * These pin the two rules that would fail silently and expensively:
 *
 *   · a verb key must NEVER fire while the user is typing — `D` is "Done
 *     elsewhere" and also a letter, and a global handler without a focus check
 *     completes someone's task mid-sentence
 *   · undo must survive leaving the surface — that is the whole promise that
 *     makes the other seven verbs safe to press
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WorkVerbBar, useWorkVerbKeys, verbIdForEvent } from "./work-verbs";
import {
  clearUndoStack,
  peekUndo,
  pushUndo,
  undoDepth,
  undoLast,
} from "./work-undo";

afterEach(() => {
  cleanup();
  clearUndoStack();
});

describe("verbIdForEvent", () => {
  test("binds the documented keys", () => {
    expect(verbIdForEvent({ key: "Enter" })).toBe("approve");
    expect(verbIdForEvent({ key: "Backspace" })).toBe("archive");
    expect(verbIdForEvent({ key: "o" })).toBe("open");
    expect(verbIdForEvent({ key: "l" })).toBe("later");
    expect(verbIdForEvent({ key: "d" })).toBe("done_elsewhere");
    expect(verbIdForEvent({ key: "f" })).toBe("file");
    expect(verbIdForEvent({ key: "h" })).toBe("hand_off");
  });

  test("is case-insensitive — shift-D is still done elsewhere", () => {
    expect(verbIdForEvent({ key: "D" })).toBe("done_elsewhere");
  });

  test("ignores keys that are not verbs", () => {
    expect(verbIdForEvent({ key: "q" })).toBeNull();
    expect(verbIdForEvent({ key: "Tab" })).toBeNull();
  });
});

function Harness({
  onDone,
  enabled,
}: {
  onDone: () => void;
  enabled?: boolean;
}) {
  useWorkVerbKeys({ done_elsewhere: onDone }, { enabled });
  return (
    <div>
      <input aria-label="note" />
      <textarea aria-label="body" />
      <div contentEditable aria-label="rich" suppressContentEditableWarning />
      <span>plain</span>
    </div>
  );
}

describe("useWorkVerbKeys — never fires while typing", () => {
  test("fires on a bare keypress", () => {
    const onDone = mock(() => {});
    render(<Harness onDone={onDone} />);
    fireEvent.keyDown(document.body, { key: "d" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("does NOT fire when an input is the target", () => {
    // The bug this guards: typing "Wednesday" into a note completes the task.
    const onDone = mock(() => {});
    render(<Harness onDone={onDone} />);
    fireEvent.keyDown(screen.getByLabelText("note"), { key: "d" });
    expect(onDone).not.toHaveBeenCalled();
  });

  test("does NOT fire in a textarea", () => {
    const onDone = mock(() => {});
    render(<Harness onDone={onDone} />);
    fireEvent.keyDown(screen.getByLabelText("body"), { key: "d" });
    expect(onDone).not.toHaveBeenCalled();
  });

  test("does NOT fire in a contenteditable", () => {
    const onDone = mock(() => {});
    render(<Harness onDone={onDone} />);
    fireEvent.keyDown(screen.getByLabelText("rich"), { key: "d" });
    expect(onDone).not.toHaveBeenCalled();
  });

  test("does NOT fire while a modifier is held", () => {
    // ⌘D is a browser bookmark; stealing it would be rude and surprising.
    const onDone = mock(() => {});
    render(<Harness onDone={onDone} />);
    fireEvent.keyDown(document.body, { key: "d", metaKey: true });
    expect(onDone).not.toHaveBeenCalled();
  });

  test("stands down when disabled, so an open sheet is not undercut", () => {
    const onDone = mock(() => {});
    render(<Harness onDone={onDone} enabled={false} />);
    fireEvent.keyDown(document.body, { key: "d" });
    expect(onDone).not.toHaveBeenCalled();
  });

  test("unbinds on unmount", () => {
    const onDone = mock(() => {});
    const { unmount } = render(<Harness onDone={onDone} />);
    unmount();
    fireEvent.keyDown(document.body, { key: "d" });
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("undo stack — the promise that makes the other verbs safe", () => {
  test("⌘Z reverses the last action even with no item selected", async () => {
    const reverse = mock(async () => {});
    render(<Harness onDone={() => {}} />);
    pushUndo({ label: "Archived “Acme”", undo: reverse });

    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(reverse).toHaveBeenCalledTimes(1);
  });

  test("survives the surface unmounting — it is session state, not view state", async () => {
    // Archive on the review pager, walk to HQ, press ⌘Z. Same session, same
    // mistake. A React-state stack would have dropped this.
    const reverse = mock(async () => {});
    const { unmount } = render(<Harness onDone={() => {}} />);
    pushUndo({ label: "Archived “Acme”", undo: reverse });
    unmount();

    expect(peekUndo()?.label).toBe("Archived “Acme”");
    await undoLast();
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  test("pops before running, so a slow undo cannot fire twice", async () => {
    let resolve!: () => void;
    const reverse = mock(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    pushUndo({ label: "Archived “Acme”", undo: reverse });

    const first = undoLast();
    expect(undoDepth()).toBe(0); // already gone — a second ⌘Z finds nothing
    expect(await undoLast()).toBeNull();

    resolve();
    await first;
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  test("a failed undo goes back on the stack so it can be retried", async () => {
    const reverse = mock(async () => {
      throw new Error("network");
    });
    pushUndo({ label: "Archived “Acme”", undo: reverse });

    await expect(undoLast()).rejects.toThrow("network");
    expect(peekUndo()?.label).toBe("Archived “Acme”");
  });

  test("reverses in reverse order", async () => {
    const order: string[] = [];
    pushUndo({ label: "a", undo: async () => void order.push("a") });
    pushUndo({ label: "b", undo: async () => void order.push("b") });
    await undoLast();
    await undoLast();
    expect(order).toEqual(["b", "a"]);
  });

  test("an empty stack is a no-op, not a throw", async () => {
    expect(await undoLast()).toBeNull();
  });
});

describe("WorkVerbBar", () => {
  test("renders only verbs the surface actually handles", () => {
    // An inert button teaches the wrong shortcut.
    const { container } = render(
      <WorkVerbBar handlers={{ approve: () => {}, archive: () => {} }} />,
    );
    expect(container.querySelector("[data-verb='approve']")).not.toBeNull();
    expect(container.querySelector("[data-verb='archive']")).not.toBeNull();
    expect(container.querySelector("[data-verb='hand_off']")).toBeNull();
  });

  test("renders nothing when the surface handles no verbs", () => {
    const { container } = render(<WorkVerbBar handlers={{}} />);
    expect(container.querySelector("[data-slot='work-verb-bar']")).toBeNull();
  });

  test("shows each key, because the bar is how they get learned", () => {
    const { container } = render(<WorkVerbBar handlers={{ later: () => {} }} />);
    expect(container.textContent).toContain("Later");
    expect(container.textContent).toContain("L");
  });

  test("states the consequence of Archive rather than the mechanism", () => {
    const { container } = render(
      <WorkVerbBar handlers={{ archive: () => {} }} />,
    );
    const btn = container.querySelector("[data-verb='archive']");
    expect(btn?.getAttribute("title")).toContain("Never deletes");
  });

  test("a verb in flight locks the rest of the set", () => {
    const { container } = render(
      <WorkVerbBar
        handlers={{ approve: () => {}, archive: () => {} }}
        busy="approve"
      />,
    );
    const archive = container.querySelector(
      "[data-verb='archive']",
    ) as HTMLButtonElement;
    expect(archive.disabled).toBe(true);
  });

  test("clicking runs the verb", () => {
    const onLater = mock(() => {});
    const { container } = render(<WorkVerbBar handlers={{ later: onLater }} />);
    fireEvent.click(container.querySelector("[data-verb='later']")!);
    expect(onLater).toHaveBeenCalledTimes(1);
  });
});
