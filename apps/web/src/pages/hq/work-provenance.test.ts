/**
 * Tests for work-item provenance — the vocabulary half.
 *
 * The rule these exist to defend is the one in the module's docblock: **never
 * assert provenance you do not have.** Everything else here (no raw enum, no
 * bare id, confidence as words, a glyph on every line) is guarded too, but the
 * null cases are the ones that would do real damage if they regressed, because
 * provenance is what a user checks when they already suspect something is
 * wrong. A confidently wrong "you added this" on an item the user never
 * touched is worse than a blank space.
 */

import { describe, expect, test } from "bun:test";

import {
  confidenceWords,
  describeFiling,
  describeOrigin,
  describeProvenance,
  describeRun,
  describeSender,
  type ProvenanceFields,
} from "@/pages/hq/work-provenance";

/* -------------------------------------------------------------------------- */
/* THE rule                                                                   */
/* -------------------------------------------------------------------------- */

describe("never assert provenance you do not have", () => {
  test("a null sourceType yields NO origin — not a guessed one", () => {
    expect(describeOrigin({ sourceType: null })).toBeNull();
  });

  test("an absent sourceType yields no origin", () => {
    expect(describeOrigin({})).toBeNull();
    expect(describeOrigin({ sourceType: undefined })).toBeNull();
  });

  test("a blank / whitespace sourceType yields no origin", () => {
    expect(describeOrigin({ sourceType: "" })).toBeNull();
    expect(describeOrigin({ sourceType: "   " })).toBeNull();
  });

  test("an item that knows nothing produces an EMPTY trace", () => {
    const trace = describeProvenance({});
    expect(trace.origin).toBeNull();
    expect(trace.filing).toBeNull();
    expect(trace.run).toBeNull();
    // Surfaces key off this: empty lines means render nothing at all.
    expect(trace.lines).toHaveLength(0);
  });

  test("a null-everywhere record still produces an empty trace", () => {
    const blank: ProvenanceFields = {
      sourceType: null,
      sourceContext: null,
      projectId: null,
      autoFiledBy: null,
      autoFileConfidence: null,
      ranProvenance: null,
      originConversationId: null,
      completedElsewhere: false,
    };
    expect(describeProvenance(blank).lines).toHaveLength(0);
  });

  test("having a project does NOT imply Cue filed it", () => {
    // A user-filed item: projectId set, autoFiledBy null. Cue made no
    // judgement here, so it must claim none.
    expect(
      describeFiling({ projectId: "p1", autoFiledBy: null }, "Seed raise"),
    ).toBeNull();
  });

  test("a run that has not happened says nothing about who ran it", () => {
    expect(describeRun({ ranProvenance: null })).toBeNull();
    expect(describeRun({})).toBeNull();
  });

  test("a sender is only claimed when the snapshot actually names one", () => {
    expect(describeSender({ sourceContext: null })).toBeNull();
    expect(describeSender({ sourceContext: "{}" })).toBeNull();
    expect(describeSender({ sourceContext: '{"sender":"   "}' })).toBeNull();
    // A malformed snapshot must not throw AND must not invent a sender.
    expect(describeSender({ sourceContext: "not json at all" })).toBeNull();
  });

  test("a sender never floats free of an origin", () => {
    // "Sent by Sarah" with no channel is a fact with nothing to attach to.
    const trace = describeProvenance({
      sourceType: null,
      sourceContext: '{"sender":"Sarah"}',
    });
    expect(trace.sender).toBeNull();
    expect(trace.lines).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Origin in user words                                                       */
/* -------------------------------------------------------------------------- */

describe("describeOrigin — user words, never the stored token", () => {
  test("a watcher says a watcher picked it up, and names the channel", () => {
    const line = describeOrigin({ sourceType: "gmail_watcher" });
    expect(line?.text).toBe("A watcher picked this up from Gmail");
  });

  test("a plain channel says where it came in from", () => {
    expect(describeOrigin({ sourceType: "gmail" })?.text).toBe(
      "Came in from Gmail",
    );
    expect(describeOrigin({ sourceType: "slack" })?.text).toBe(
      "Came in from Slack",
    );
    expect(describeOrigin({ sourceType: "calendar" })?.text).toBe(
      "Came in from your calendar",
    );
  });

  test("a conversation-born item credits Cue, not the user", () => {
    expect(describeOrigin({ sourceType: "conversation" })?.text).toBe(
      "Cue created this from a conversation",
    );
  });

  test("a user-captured item says you added it", () => {
    expect(describeOrigin({ sourceType: "user" })?.text).toBe("You added this");
    expect(describeOrigin({ sourceType: "quick_add" })?.text).toBe(
      "You added this",
    );
  });

  test("a schedule and a heartbeat are distinguishable", () => {
    expect(describeOrigin({ sourceType: "cron" })?.text).toBe(
      "A schedule you set up created this",
    );
    expect(describeOrigin({ sourceType: "heartbeat" })?.text).toBe(
      "Cue raised this on its own, checking in on your work",
    );
  });

  test("an unmapped source is humanised, never rendered raw", () => {
    const line = describeOrigin({ sourceType: "some_new_channel" });
    expect(line?.text).toBe("Came in from Some new channel");
    expect(line?.text).not.toContain("_");
    expect(line?.short).not.toContain("_");
  });

  test("no origin label ever leaks enum casing or underscores", () => {
    const tokens = [
      "gmail_watcher",
      "slack",
      "calendar_event",
      "voicemail",
      "cron_schedule",
      "sub_agent",
      "chat",
      "manual_capture",
      "totally_unknown_thing",
    ];
    for (const t of tokens) {
      const line = describeOrigin({ sourceType: t })!;
      expect(line.text).not.toContain("_");
      expect(line.text).not.toBe(line.text.toUpperCase());
      // Colour is never the only carrier.
      expect(line.glyph.length).toBeGreaterThan(0);
    }
  });

  test("a bare id is never part of any line", () => {
    const trace = describeProvenance({
      sourceType: "gmail",
      // Ids the record carries. None of them may appear as text.
      originConversationId: "conv_0193abcd",
      projectId: "proj_77",
      autoFiledBy: "cue",
      autoFileConfidence: 0.8,
      ranProvenance: "auto",
    });
    const allText = trace.lines.map((l) => `${l.text} ${l.short}`).join(" ");
    expect(allText).not.toContain("conv_0193abcd");
    expect(allText).not.toContain("proj_77");
    // The conversation id is carried for ROUTING only.
    expect(trace.originConversationId).toBe("conv_0193abcd");
  });
});

/* -------------------------------------------------------------------------- */
/* Judgement + confidence                                                     */
/* -------------------------------------------------------------------------- */

describe("confidenceWords — words, never a number", () => {
  test("maps the band, not the digits", () => {
    expect(confidenceWords(0.97)).toBe("almost certain");
    expect(confidenceWords(0.8)).toBe("confident");
    expect(confidenceWords(0.6)).toBe("fairly sure");
    expect(confidenceWords(0.2)).toBe("not very sure");
  });

  test("no score means NO phrase — never a hedged guess", () => {
    expect(confidenceWords(null)).toBeNull();
    expect(confidenceWords(undefined)).toBeNull();
    expect(confidenceWords(Number.NaN)).toBeNull();
  });

  test("a score off the 0-1 scale is treated as absent", () => {
    // 87 is not 87% on this scale — it is a value we do not understand, so we
    // say nothing rather than translating a misread.
    expect(confidenceWords(87)).toBeNull();
    expect(confidenceWords(-1)).toBeNull();
  });

  test("no phrase contains a digit or a percent sign", () => {
    for (const v of [0, 0.3, 0.55, 0.75, 0.9, 1]) {
      const w = confidenceWords(v)!;
      expect(w).not.toMatch(/[0-9%]/);
    }
  });
});

describe("describeFiling — the judgement Cue made, said out loud", () => {
  test("an auto-filed item names the destination and how sure Cue was", () => {
    const line = describeFiling(
      { projectId: "p1", autoFiledBy: "cue", autoFileConfidence: 0.62 },
      "Seed raise",
    )!;
    expect(line.text).toBe(
      "Cue filed this into Seed raise itself — it was fairly sure",
    );
    expect(line.glyph).toBe("✨");
  });

  test("an auto-filed item with NO score still states the filing, minus the claim", () => {
    const line = describeFiling(
      { projectId: "p1", autoFiledBy: "cue", autoFileConfidence: null },
      "Seed raise",
    )!;
    expect(line.text).toBe("Cue filed this into Seed raise itself");
    expect(line.text).not.toContain("sure");
    expect(line.text).not.toContain("confident");
  });

  test("without a project title it says less rather than showing an id", () => {
    const line = describeFiling({ projectId: "p1", autoFiledBy: "cue" })!;
    expect(line.text).toBe("Cue filed this into a project itself");
    expect(line.text).not.toContain("p1");
  });

  test("a deliberate unfile is not read as an auto-file", () => {
    const line = describeFiling({ autoFiledBy: "user_unfiled" })!;
    expect(line.text).toContain("You took this out");
    expect(line.glyph).not.toBe("✨");
  });

  test("scored but not filed says Cue was not sure, and does not pretend", () => {
    const line = describeFiling({
      projectId: null,
      autoFiledBy: null,
      autoFileConfidence: 0.3,
    })!;
    expect(line.text).toBe(
      "Cue was not sure where this belongs, so it left the filing to you",
    );
    expect(line.glyph).toBe("?");
    expect(line.tone).toBe("amber");
  });
});

describe("describeRun — Cue never takes credit it has not earned", () => {
  test("auto, approved and manual are three different sentences", () => {
    expect(describeRun({ ranProvenance: "auto" })?.text).toBe(
      "Cue ran this on its own",
    );
    expect(describeRun({ ranProvenance: "you_approved" })?.text).toBe(
      "Cue ran this after you approved it",
    );
    expect(describeRun({ ranProvenance: "manual" })?.text).toBe(
      "You did this yourself",
    );
  });

  test("done elsewhere is never credited to Cue", () => {
    const line = describeRun({
      ranProvenance: "manual",
      completedElsewhere: true,
    })!;
    expect(line.text).toBe("You did this yourself, outside Cue");
    expect(line.text).not.toContain("Cue ran");
  });

  test("the stored enum never reaches the sentence", () => {
    for (const p of ["auto", "you_approved", "manual"] as const) {
      const line = describeRun({ ranProvenance: p })!;
      expect(line.text).not.toContain("_");
      expect(line.text.toLowerCase()).not.toContain("you_approved");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The whole trace                                                            */
/* -------------------------------------------------------------------------- */

describe("describeProvenance", () => {
  test("assembles origin, sender, filing and run in reading order", () => {
    const trace = describeProvenance(
      {
        sourceType: "gmail_watcher",
        sourceContext: '{"sender":"Sarah Chen"}',
        projectId: "p1",
        autoFiledBy: "cue",
        autoFileConfidence: 0.93,
        ranProvenance: "you_approved",
      },
      "Seed raise",
    );
    expect(trace.lines.map((l) => l.id)).toEqual([
      "origin",
      "sender",
      "filing",
      "run",
    ]);
    expect(trace.lines[0]!.text).toBe("A watcher picked this up from Gmail");
    expect(trace.lines[1]!.text).toBe("Sent by Sarah Chen");
    expect(trace.lines[2]!.text).toContain("almost certain");
    expect(trace.lines[3]!.text).toBe("Cue ran this after you approved it");
  });

  test("every line carries a glyph — state is never colour alone", () => {
    const trace = describeProvenance(
      {
        sourceType: "slack",
        sourceContext: '{"sender":"Dev"}',
        projectId: "p1",
        autoFiledBy: "cue",
        autoFileConfidence: 0.5,
        ranProvenance: "auto",
      },
      "Launch",
    );
    expect(trace.lines.length).toBeGreaterThan(0);
    for (const line of trace.lines) {
      expect(line.glyph.trim().length).toBeGreaterThan(0);
      expect(line.text.trim().length).toBeGreaterThan(0);
    }
  });

  test("a blank originConversationId is not a link target", () => {
    expect(
      describeProvenance({ sourceType: "chat", originConversationId: "  " })
        .originConversationId,
    ).toBeNull();
  });
});
