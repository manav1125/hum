/**
 * The primitive's contract, with the emphasis on the failure side.
 *
 * The load-bearing property is negative: there must be no path through
 * `sendExportToDestination` that reports a delivery which did not happen. Most
 * of these tests exist to prove that a destination which throws, returns
 * nothing, or is never reached at all comes back as a failure.
 */

import { describe, expect, it, mock } from "bun:test";

import { getDestination, listDestinations } from "../registry.js";
import { sendExportToDestination } from "../send-export.js";
import type { Destination, ExportPayload } from "../types.js";
import { isTextPayload, notSent, payloadText, sent } from "../types.js";

function textPayload(overrides: Partial<ExportPayload> = {}): ExportPayload {
  return {
    bytes: Buffer.from("# Title\n\nBody text.\n", "utf8"),
    filename: "report.md",
    mimeType: "text/markdown",
    title: "Report",
    ...overrides,
  };
}

function binaryPayload(bytes = 1024): ExportPayload {
  return {
    bytes: Buffer.alloc(bytes, 7),
    filename: "report.pdf",
    mimeType: "application/pdf",
    title: "Report",
  };
}

/** Install a fake destination for the duration of one test. */
async function withFakeDestination<T>(
  fake: Destination,
  run: () => Promise<T>,
): Promise<T> {
  const actual = await import("../registry.js");
  // Capture the real lookup by value. `actual` is a live module namespace, so
  // reading `actual.getDestination` *after* the mock is installed returns the
  // mock — and the fallback below would call itself forever.
  const realGetDestination = actual.getDestination;
  mock.module("../registry.js", () => ({
    ...actual,
    getDestination: (id: string) =>
      id === fake.id ? fake : realGetDestination(id),
  }));
  try {
    return await run();
  } finally {
    mock.module("../registry.js", () => ({ ...actual }));
  }
}

const fakeBase = {
  label: "Fake",
  toolkit: null,
  accepts: { binary: true, text: true },
  maxBytes: 10 * 1024 * 1024,
  targetHelp: "anything",
} as const;

describe("payload shape", () => {
  it("treats markdown and html as text and office formats as binary", () => {
    expect(isTextPayload(textPayload())).toBe(true);
    expect(isTextPayload(textPayload({ mimeType: "text/html" }))).toBe(true);
    expect(isTextPayload(binaryPayload())).toBe(false);
    expect(
      isTextPayload(
        textPayload({
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    ).toBe(false);
  });

  it("decodes text payloads and refuses to decode binary ones", () => {
    expect(payloadText(textPayload())).toContain("Body text.");
    expect(payloadText(binaryPayload())).toBeNull();
  });
});

describe("sendExportToDestination — refusals before any network call", () => {
  it("rejects an unknown destination", async () => {
    const outcome = await sendExportToDestination({
      payload: textPayload(),
      destinationId: "dropbox",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("unknown_destination");
  });

  it("rejects a binary payload at a text-only destination", async () => {
    const outcome = await sendExportToDestination({
      payload: binaryPayload(),
      destinationId: "notion",
      target: { id: "page_1" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("unsupported_payload");
  });

  it("rejects an empty payload", async () => {
    const outcome = await sendExportToDestination({
      payload: textPayload({ bytes: Buffer.alloc(0) }),
      destinationId: "notion",
      target: { id: "page_1" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("unsupported_payload");
  });

  it("rejects a payload over the destination's ceiling", async () => {
    const notion = getDestination("notion");
    expect(notion).toBeDefined();
    const outcome = await sendExportToDestination({
      payload: textPayload({
        bytes: Buffer.alloc((notion as Destination).maxBytes + 1, 0x61),
      }),
      destinationId: "notion",
      target: { id: "page_1" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("too_large");
  });

  it("asks for a target when the destination needs one", async () => {
    const outcome = await sendExportToDestination({
      payload: textPayload(),
      destinationId: "notion",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("bad_target");
  });
});

describe("sendExportToDestination — a failure never reads as a success", () => {
  it("turns a thrown destination error into a failure", async () => {
    const outcome = await withFakeDestination(
      {
        ...fakeBase,
        id: "fake_throws",
        async send() {
          throw new Error("socket hang up");
        },
      },
      () =>
        sendExportToDestination({
          payload: textPayload(),
          destinationId: "fake_throws",
        }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("destination_error");
      expect(outcome.summary).toContain("socket hang up");
    }
  });

  it("rejects a success that carries no confirmation from the destination", async () => {
    const outcome = await withFakeDestination(
      {
        ...fakeBase,
        id: "fake_hollow",
        async send() {
          // The shape a careless destination produces: it believes it worked
          // but has nothing from the far side to show for it.
          return sent("Sent!", {});
        },
      },
      () =>
        sendExportToDestination({
          payload: textPayload(),
          destinationId: "fake_hollow",
        }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("destination_error");
  });

  it("passes a destination's own refusal through unchanged", async () => {
    const outcome = await withFakeDestination(
      {
        ...fakeBase,
        id: "fake_refuses",
        async send() {
          return notSent("not_connected", "Connect it first.");
        },
      },
      () =>
        sendExportToDestination({
          payload: textPayload(),
          destinationId: "fake_refuses",
        }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("not_connected");
      expect(outcome.summary).toBe("Connect it first.");
    }
  });

  it("reports a confirmed send as a success, carrying the destination's evidence", async () => {
    const outcome = await withFakeDestination(
      {
        ...fakeBase,
        id: "fake_works",
        async send(payload) {
          return sent(`Sent ${payload.filename}.`, { fileId: "F123" });
        },
      },
      () =>
        sendExportToDestination({
          payload: textPayload(),
          destinationId: "fake_works",
        }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.confirmation.fileId).toBe("F123");
  });

  it("hands the destination exactly the payload and target it was given", async () => {
    let seen: unknown;
    await withFakeDestination(
      {
        ...fakeBase,
        id: "fake_echo",
        async send(payload, target) {
          seen = { filename: payload.filename, target };
          return sent("ok", { ok: true });
        },
      },
      () =>
        sendExportToDestination({
          payload: textPayload(),
          destinationId: "fake_echo",
          target: { id: "C1", threadTs: "1.2" },
        }),
    );
    expect(seen).toEqual({
      filename: "report.md",
      target: { id: "C1", threadTs: "1.2" },
    });
  });
});

describe("registry", () => {
  it("exposes the five shipped destinations, each uniquely identified", () => {
    const ids = listDestinations().map((d) => d.id);
    expect(ids).toEqual([
      "slack",
      "google_drive",
      "google_docs",
      "hubspot",
      "notion",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves case-insensitively and rejects unknown ids", () => {
    expect(getDestination("SLACK")?.id).toBe("slack");
    expect(getDestination("  notion  ".trim())?.id).toBe("notion");
    expect(getDestination("box")).toBeUndefined();
  });

  it("gives every destination a usable ceiling and at least one payload shape", () => {
    for (const d of listDestinations()) {
      expect(d.maxBytes).toBeGreaterThan(0);
      expect(d.accepts.binary || d.accepts.text).toBe(true);
      expect(d.targetHelp.length).toBeGreaterThan(0);
    }
  });

  it("marks the destinations that genuinely cannot take binary", () => {
    // Not a style preference: Notion stores blocks, HubSpot's Composio
    // toolkit has no file-upload action, and Docs needs markdown to produce
    // an editable document. Flipping these to `true` would ship a lie.
    for (const id of ["notion", "hubspot", "google_docs"]) {
      expect(getDestination(id)?.accepts.binary).toBe(false);
    }
    for (const id of ["slack", "google_drive"]) {
      expect(getDestination(id)?.accepts.binary).toBe(true);
    }
  });
});
