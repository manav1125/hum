/**
 * Unit tests for the rules that decide what Cue is willing to BELIEVE about a
 * message. The end-to-end behaviour is tested through the real intake path in
 * `watcher/__tests__/watcher-intake-comprehension.test.ts`; this file pins the
 * pure predicates that path depends on, because they are the ones a future
 * change could quietly widen.
 *
 * The load-bearing one is {@link isGroundedIn}. Every extracted fact — a
 * deadline, an amount, who is asking — is only accepted if the model quoted it
 * and that quote is findable in the message. Delete that check and a confident
 * invented due date lands on a real obligation.
 */
import { describe, expect, test } from "bun:test";

import {
  type ComprehensionCandidate,
  isGroundedIn,
  isUsableTaskTitle,
  parseComprehensionResponse,
  parseDueDate,
  validateComprehension,
} from "./arrival-comprehension.js";

const NOW = Date.UTC(2026, 7, 2);

function candidate(
  over: Partial<ComprehensionCandidate> = {},
): ComprehensionCandidate {
  return {
    workItemId: "wi-1",
    arrivalId: "a-1",
    title:
      "Email from CIPA <registrar@example.org>: 2026 Annual Return Due for Brinc Innovation Africa (First Reminder)",
    snippet:
      "The annual return for Brinc Innovation Africa must be filed by 30 September 2026. A late fee of BWP 250.00 applies after that date.",
    senderName: "CIPA",
    senderAddress: "registrar@example.org",
    ...over,
  };
}

describe("isGroundedIn — the never-invent check", () => {
  const source = candidate().snippet!;

  test("accepts a quote that is really in the message", () => {
    expect(isGroundedIn(source, "filed by 30 September 2026")).toBe(true);
  });

  test("is punctuation- and case-insensitive", () => {
    expect(isGroundedIn(source, "30 september, 2026")).toBe(true);
    expect(isGroundedIn(source, "BWP 250.00")).toBe(true);
  });

  test("rejects a quote the message never contained", () => {
    expect(isGroundedIn(source, "due by 31 December 2026")).toBe(false);
  });

  test("rejects a missing quote — a fact with no quote is a guess", () => {
    expect(isGroundedIn(source, null)).toBe(false);
    expect(isGroundedIn(source, "")).toBe(false);
  });

  test("rejects a quote too short to mean anything", () => {
    // "a" appears in every message ever written; grounding on it would ground
    // on nothing.
    expect(isGroundedIn(source, "a")).toBe(false);
  });
});

describe("parseDueDate", () => {
  test("resolves an ISO date to the END of that day, so it is not instantly overdue", () => {
    const at = parseDueDate("2026-09-30", NOW);
    expect(at).not.toBeNull();
    const d = new Date(at!);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(8);
    expect(d.getUTCDate()).toBe(30);
    expect(d.getUTCHours()).toBe(23);
  });

  test("end of day means end of day WHERE THE OWNER IS", () => {
    // The bug this pins: anchoring to UTC puts a Hong Kong deadline at 07:59
    // the following morning, so every extracted date renders a day late — and
    // late in the direction that reads as an extra day on a real obligation.
    const at = parseDueDate("2026-09-30", NOW, "Asia/Hong_Kong");
    expect(at).not.toBeNull();
    const local = new Date(at!).toLocaleString("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    expect(local.startsWith("2026-09-30")).toBe(true);
    expect(local).toContain("23");
  });

  test("a zone behind UTC lands on the right day too", () => {
    const at = parseDueDate("2026-09-30", NOW, "America/Los_Angeles");
    const local = new Date(at!).toLocaleString("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    expect(local).toBe("2026-09-30");
  });

  test("an unknown zone degrades to UTC rather than throwing", () => {
    // A malformed zone must not cost the deadline entirely — a slightly-off
    // date beats dropping a real obligation on the floor.
    const at = parseDueDate("2026-09-30", NOW, "Mars/Olympus_Mons");
    expect(at).toBe(parseDueDate("2026-09-30", NOW));
  });

  test("rejects anything that is not an ISO date", () => {
    expect(parseDueDate("next Tuesday", NOW)).toBeNull();
    expect(parseDueDate("30/09/2026", NOW)).toBeNull();
    expect(parseDueDate(null, NOW)).toBeNull();
  });

  test("rejects a date that does not exist rather than rolling it over", () => {
    // Date.UTC would happily turn this into 2 March.
    expect(parseDueDate("2026-02-31", NOW)).toBeNull();
  });

  test("rejects implausible dates — a confident artefact is the worst case", () => {
    expect(parseDueDate("1970-01-01", NOW)).toBeNull();
    expect(parseDueDate("2190-01-01", NOW)).toBeNull();
  });
});

describe("isUsableTaskTitle", () => {
  const original = candidate().title;

  test("accepts a verb phrase naming the action", () => {
    expect(
      isUsableTaskTitle(
        "Renew Brinc Innovation Africa's annual return",
        original,
      ),
    ).toBe(true);
  });

  test("rejects a title that is still describing the envelope", () => {
    expect(
      isUsableTaskTitle("Email from CIPA about the annual return", original),
    ).toBe(false);
    expect(isUsableTaskTitle("Re: 2026 Annual Return", original)).toBe(false);
    expect(isUsableTaskTitle("Notification from CIPA", original)).toBe(false);
  });

  test("rejects a restatement of the subject line", () => {
    expect(
      isUsableTaskTitle(
        "2026 Annual Return Due for Brinc Innovation Africa",
        original,
      ),
    ).toBe(false);
  });

  test("rejects titles that cannot fit on a card", () => {
    expect(isUsableTaskTitle("Do", original)).toBe(false);
    expect(isUsableTaskTitle("Pay ".repeat(60), original)).toBe(false);
  });
});

describe("parseComprehensionResponse", () => {
  const valid = new Set(["wi-1"]);

  test("drops entries for ids that were never sent", () => {
    const parsed = parseComprehensionResponse(
      '[{"id":"wi-1","task":"Pay it"},{"id":"wi-hallucinated","task":"Do something"}]',
      valid,
    );
    expect(parsed?.map((p) => p.workItemId)).toEqual(["wi-1"]);
  });

  test("returns null when there is nothing parseable", () => {
    expect(parseComprehensionResponse("I could not do that", valid)).toBeNull();
    expect(parseComprehensionResponse("[not json", valid)).toBeNull();
  });

  test("clamps confidence into 0-1", () => {
    const parsed = parseComprehensionResponse(
      '[{"id":"wi-1","task":"Pay it","confidence":7}]',
      valid,
    );
    expect(parsed?.[0].confidence).toBe(1);
  });
});

describe("validateComprehension", () => {
  const opts = { now: NOW, confidenceThreshold: 0.6 };

  test("a grounded deadline is kept, with the words it was read from", () => {
    const result = validateComprehension(
      candidate(),
      {
        workItemId: "wi-1",
        task: "Renew Brinc Innovation Africa's annual return",
        confidence: 0.9,
        dueDate: "2026-09-30",
        dueQuote: "filed by 30 September 2026",
        amount: "BWP 250.00",
        amountQuote: "BWP 250.00",
        askedBy: "CIPA",
      },
      opts,
    );
    expect(result.status).toBe("comprehended");
    expect(result.actionTitle).toBe(
      "Renew Brinc Innovation Africa's annual return",
    );
    expect(result.dueAt).not.toBeNull();
    expect(result.dueQuote).toBe("filed by 30 September 2026");
    expect(result.amountText).toBe("BWP 250.00");
    expect(result.askedBy).toBe("CIPA");
  });

  test("an UNGROUNDED deadline is dropped while the title still stands", () => {
    // This is the shape of the dangerous failure: a plausible, confident,
    // completely invented deadline on a real obligation.
    const result = validateComprehension(
      candidate(),
      {
        workItemId: "wi-1",
        task: "Renew Brinc Innovation Africa's annual return",
        confidence: 0.95,
        dueDate: "2026-12-31",
        dueQuote: "due by 31 December 2026",
      },
      opts,
    );
    expect(result.status).toBe("comprehended");
    expect(result.dueAt).toBeNull();
    expect(result.dueQuote).toBeNull();
  });

  test("a deadline with no quote at all is dropped", () => {
    const result = validateComprehension(
      candidate(),
      {
        workItemId: "wi-1",
        task: "Renew the annual return for Brinc Innovation Africa",
        confidence: 0.95,
        dueDate: "2026-09-30",
        dueQuote: null,
      },
      opts,
    );
    expect(result.dueAt).toBeNull();
  });

  test("no answer at all reads as 'failed', not as 'nothing to do'", () => {
    const result = validateComprehension(candidate(), undefined, opts);
    expect(result.status).toBe("failed");
    expect(result.actionTitle).toBeNull();
    expect(result.note).toBeTruthy();
  });

  test("a weak answer keeps the original title and says why", () => {
    const result = validateComprehension(
      candidate(),
      {
        workItemId: "wi-1",
        task: "Renew the annual return",
        confidence: 0.2,
      },
      opts,
    );
    expect(result.status).toBe("low_confidence");
    expect(result.actionTitle).toBeNull();
    expect(result.note).toContain("not sure enough");
  });

  test("a confident restatement of the subject line is still refused", () => {
    const result = validateComprehension(
      candidate(),
      {
        workItemId: "wi-1",
        task: "Email from CIPA: 2026 Annual Return",
        confidence: 0.99,
      },
      opts,
    );
    expect(result.status).toBe("low_confidence");
    expect(result.actionTitle).toBeNull();
  });

  test("who is asking may be grounded in the sender, not only the body", () => {
    const result = validateComprehension(
      candidate({ snippet: "Please action the attached." }),
      {
        workItemId: "wi-1",
        task: "File the attached return",
        confidence: 0.9,
        askedBy: "CIPA",
      },
      opts,
    );
    expect(result.askedBy).toBe("CIPA");
  });

  test("an invented asker is dropped", () => {
    const result = validateComprehension(
      candidate({ snippet: "Please action the attached." }),
      {
        workItemId: "wi-1",
        task: "File the attached return",
        confidence: 0.9,
        askedBy: "The Botswana High Court",
      },
      opts,
    );
    expect(result.askedBy).toBeNull();
  });
});
