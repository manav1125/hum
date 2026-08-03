/**
 * Feedback has to reach somebody, and the form has to be honest about how.
 *
 * The bug this replaces: the modal POSTed to `/v1/feedback/` relative to the
 * app origin. That route exists on the upstream fork's Django server; on Cue
 * the origin is the Fly daemon, which 404s. Every report anyone filed reached
 * nobody, and the form reported success. A submit button that resolves against
 * a 404 is the same defect as a job that completes and writes nothing — the
 * failure is an absence, and the interface asserts the opposite.
 *
 * These tests hold the replacement to the two things that make it honest: it
 * addresses a real inbox, and it never claims to carry an attachment a
 * `mailto:` cannot carry.
 */

import { describe, expect, test } from "bun:test";

import { buildFeedbackMailto, FEEDBACK_EMAIL } from "./feedback-delivery";

const base = {
  message: "The approve button did nothing",
  classification: "bug_report",
  client: "web",
};

function parse(url: string): { to: string; params: URLSearchParams } {
  const [scheme, query] = url.split("?");
  return {
    to: scheme.replace(/^mailto:/, ""),
    params: new URLSearchParams(query),
  };
}

describe("buildFeedbackMailto", () => {
  test("addresses the inbox we actually read", () => {
    // Verified against site/legal.html rather than invented. The links this
    // form used to carry pointed at the upstream fork's Discord and roadmap.
    // Asserting the REAL destination is the whole point: an example.com
    // address here would let the constant drift back to nowhere, green.
    // generic-examples:ignore-next-line — reason: real destination, not a fixture
    expect(FEEDBACK_EMAIL).toBe("hello@justcue.ai");
    expect(parse(buildFeedbackMailto(base)).to).toBe(FEEDBACK_EMAIL);
  });

  test("carries the report itself", () => {
    const { params } = parse(buildFeedbackMailto(base));
    expect(params.get("body")).toContain("The approve button did nothing");
    expect(params.get("subject")).toContain("bug report");
  });

  test("names the bundle when one was saved, so it can be attached", () => {
    // A mailto cannot attach. If the reader is not told they are holding the
    // file, the toggles they ticked are decorative — which is the exact
    // failure mode this change exists to remove.
    const { params } = parse(
      buildFeedbackMailto({ ...base, bundleFilename: "cue-logs-1234.tar.gz" }),
    );
    const body = params.get("body") ?? "";
    expect(body).toContain("cue-logs-1234.tar.gz");
    expect(body.toLowerCase()).toContain("attach");
  });

  test("says nothing about attachments when there is no bundle", () => {
    const body = parse(buildFeedbackMailto(base)).params.get("body") ?? "";
    expect(body.toLowerCase()).not.toContain("attach");
  });

  test("includes the triage fields that save a round trip", () => {
    const body =
      parse(
        buildFeedbackMailto({
          ...base,
          clientVersion: "1.2.3",
          assistantId: "asst-1",
          assistantVersion: "9.9.9",
        }),
      ).params.get("body") ?? "";
    expect(body).toContain("1.2.3");
    expect(body).toContain("asst-1");
    expect(body).toContain("9.9.9");
  });

  test("carries no credential-shaped field", () => {
    // A mailto is handed to whatever handler the OS registered and may be
    // logged by it. The report goes; nothing that would be a credential or a
    // private identifier if it leaked does.
    const url = buildFeedbackMailto({
      ...base,
      clientVersion: "1.2.3",
      assistantId: "asst-1",
    });
    for (const forbidden of [
      "token",
      "cueToken",
      "authorization",
      "bearer",
      "session",
      "conversationId",
      "password",
      "apiKey",
    ]) {
      expect(url.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test("escapes a report that would otherwise break the URL", () => {
    // Ampersands and newlines in a bug report are ordinary; a report that
    // truncates itself at the first `&` loses the half that mattered.
    const { params } = parse(
      buildFeedbackMailto({
        ...base,
        message: "Filing & triage both broke\nsecond line #2",
      }),
    );
    const body = params.get("body") ?? "";
    expect(body).toContain("Filing & triage both broke");
    expect(body).toContain("second line #2");
  });
});
