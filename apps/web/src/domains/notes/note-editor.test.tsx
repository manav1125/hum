/**
 * The note itself — design `1a`.
 *
 * What is worth pinning is the handful of things that make this a writing
 * surface rather than a form, because they are exactly what a later tidy-up
 * quietly reverses: the serif title, the stated privacy, and the absence of a
 * box around the writing.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NoteEditor, noteStamp } from "./note-editor";

const props = (patch: Record<string, unknown> = {}) => ({
  title: "Acme renewal call — Dana & Rachel",
  body: "Dana wants the 24-month term.",
  occurredAt: Date.now(),
  saved: true,
  onTitleChange: mock(() => undefined),
  onBodyChange: mock(() => undefined),
  onRecordInstead: mock(() => undefined),
  ...patch,
});

afterEach(() => {
  cleanup();
});

describe("it reads as something written, not something logged", () => {
  test("the title is set in the serif HQ uses", () => {
    render(<NoteEditor {...props()} />);
    const title = screen.getByLabelText("Note title") as HTMLInputElement;
    expect(title.style.fontFamily).toContain("Instrument Serif");
    expect(title.value).toBe("Acme renewal call — Dana & Rachel");
  });

  test("REGRESSION: there is no box around the writing", () => {
    // The editor is the page. A bordered field is a form, and people write
    // differently into a form.
    render(<NoteEditor {...props()} />);
    const body = screen.getByLabelText("Note") as HTMLTextAreaElement;
    expect(body.style.border).toBe("0px");
    expect(body.style.background).toBe("transparent");
  });

  test("both facts are stated, every time", () => {
    // People do not write honestly in a box they are not sure about.
    render(<NoteEditor {...props()} />);
    expect(screen.getByText("Private · autosaved")).toBeTruthy();
  });

  test("an in-flight save says so rather than claiming to be saved", () => {
    render(<NoteEditor {...props({ saved: false })} />);
    expect(screen.getByText("Private · saving…")).toBeTruthy();
  });
});

describe("where the note already belongs", () => {
  test("a filed note wears its project", () => {
    const { container } = render(
      <NoteEditor {...props({ projectName: "Renew Acme" })} />,
    );
    expect(container.querySelector("[data-note-project]")?.textContent).toContain(
      "Renew Acme",
    );
  });

  test("an unfiled note wears nothing — unfiled is a resting state", () => {
    // Not a backlog to shame. The walking-to-work thought will never have a
    // project and is still the best note in the system.
    const { container } = render(<NoteEditor {...props()} />);
    expect(container.querySelector("[data-note-project]")).toBeNull();
  });
});

describe("recording is an offer, not a mode switch", () => {
  test("it sits in the footer beside the other ways to put something in", () => {
    const onRecordInstead = mock(() => undefined);
    render(<NoteEditor {...props({ onRecordInstead })} />);

    fireEvent.click(screen.getByText("Record instead"));
    expect(onRecordInstead).toHaveBeenCalledTimes(1);
  });

  test("the formatting hints are there without being a toolbar", () => {
    render(<NoteEditor {...props()} />);
    expect(screen.getByText(/to format/)).toBeTruthy();
    expect(screen.getByText(/for a person/)).toBeTruthy();
  });
});

describe("when the thought happened", () => {
  const at = (iso: string) => Date.parse(iso);

  test("today and yesterday are named, because that is how people refer to their week", () => {
    const now = at("2026-08-25T18:00:00");
    expect(noteStamp(at("2026-08-25T14:22:00"), now)).toBe("TODAY 14:22");
    expect(noteStamp(at("2026-08-24T09:05:00"), now)).toBe("YESTERDAY 09:05");
  });

  test("anything older carries its date", () => {
    const now = at("2026-08-25T18:00:00");
    expect(noteStamp(at("2026-08-19T09:05:00"), now)).toContain("09:05");
    expect(noteStamp(at("2026-08-19T09:05:00"), now)).not.toContain("TODAY");
  });

  test("REGRESSION: 'today' is the calendar day, not twenty-four hours", () => {
    // A note written at 23:50 is not "today" when read at 00:10.
    const now = at("2026-08-25T00:10:00");
    expect(noteStamp(at("2026-08-24T23:50:00"), now)).toBe("YESTERDAY 23:50");
  });
});
