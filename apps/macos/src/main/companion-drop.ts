import type { CompanionCaught } from "@vellumai/ipc-contract";

/**
 * Drops on the creature — design `C10`, and the only thing here that a
 * floating presence can do and a window cannot.
 *
 * **Nothing is stored until a choice is made.** That is the rule the whole
 * gesture rests on: dropping a contract on Cue is not filing it, and a drop
 * nobody answers has to end with the file exactly where it was. So a caught
 * item lives here, in memory, for ten seconds — and then it is let go,
 * unkept, with nothing written anywhere.
 *
 * **The three choices never send or spend.** Read it, file it, or keep it as
 * a note. `C9`'s protocol holds even for something the user themselves put
 * in Cue's hands: the companion talks, and the app acts.
 */

/** How long a caught item waits for an answer before it is let go. */
export const CAUGHT_LET_GO_MS = 10_000;

/** What can be done with a drop. None of these sends or spends. */
export type DropChoice = "read" | "file" | "note";

export interface DropHost {
  /** Show the caught item, or take it away. */
  present(caught: CompanionCaught | null): void;
  /**
   * Act on it — in the app, never here.
   *
   * `payload` is what actually arrived: a path for a file, the text for a
   * selection. It is passed through untouched so the app is the only place
   * that has to know what any of it means.
   */
  hand(choice: DropChoice, caught: CompanionCaught, payload: string): void;
}

interface Held {
  caught: CompanionCaught;
  payload: string;
}

export class CompanionDrops {
  private held: Held | null = null;
  private letGo: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: DropHost,
    /** Injectable so the ten seconds is not ten seconds in a test. */
    private readonly letGoMs: number = CAUGHT_LET_GO_MS,
  ) {}

  /**
   * Something landed.
   *
   * A second drop replaces the first rather than queueing: two things held at
   * once means a chip that names one of them, and a chip that does not name
   * exactly what arrived is the one thing this gesture cannot afford.
   */
  catch(caught: CompanionCaught, payload: string): void {
    this.disarm();
    this.held = { caught, payload };
    this.host.present(caught);
    this.letGo = setTimeout(() => this.release(), this.letGoMs);
  }

  /**
   * Ten seconds of silence, or `✕`.
   *
   * Nothing was stored, so there is nothing to undo — which is exactly why
   * letting go is safe enough to be the default.
   */
  release(): void {
    this.disarm();
    if (!this.held) return;
    this.held = null;
    this.host.present(null);
  }

  /** Read it · File it · Note. The app does all three. */
  choose(choice: DropChoice): boolean {
    const held = this.held;
    if (!held) return false;
    this.disarm();
    this.held = null;
    this.host.present(null);
    this.host.hand(choice, held.caught, held.payload);
    return true;
  }

  current(): CompanionCaught | null {
    return this.held?.caught ?? null;
  }

  private disarm(): void {
    if (!this.letGo) return;
    clearTimeout(this.letGo);
    this.letGo = null;
  }

  /** Teardown. A window going away lets go of anything it was holding. */
  stop(): void {
    this.disarm();
    this.held = null;
  }
}

/**
 * Name what arrived, exactly.
 *
 * A wrong drop has to be obvious before anything happens to it, which means
 * the chip says the actual filename or the actual first words — never "1
 * item" or "text". The truncation keeps the extension visible for the same
 * reason: `acme-msa-v4.pdf` and `acme-msa-v4.pages` are a different mistake.
 */
export function describeDrop(input: {
  kind: CompanionCaught["kind"];
  value: string;
}): CompanionCaught {
  const { kind, value } = input;
  if (kind === "file" || kind === "image") {
    const name = value.split("/").pop() ?? value;
    return { kind, label: shortenFilename(name) };
  }
  if (kind === "url") {
    return { kind, label: shorten(value.replace(/^https?:\/\//, ""), 44) };
  }
  return { kind, label: shorten(value.replace(/\s+/g, " ").trim(), 44) };
}

const shorten = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const shortenFilename = (name: string, max = 34): string => {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return shorten(name, max);
  const ext = name.slice(dot);
  const stem = name.slice(0, dot);
  return `${stem.slice(0, Math.max(1, max - ext.length - 1))}…${ext}`;
};
