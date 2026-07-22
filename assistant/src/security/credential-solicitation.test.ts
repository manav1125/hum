import { describe, expect, test } from "bun:test";

import {
  findCredentialSolicitation,
  findCredentialSolicitations,
  formatCredentialSolicitationRefusal,
} from "./credential-solicitation.js";

describe("findCredentialSolicitation", () => {
  // The two option labels Cue actually rendered on prod (2026-07-22) when
  // asked to set up a Netlify deploy. Both must be caught verbatim.
  test("catches the live Netlify option labels", () => {
    const a = findCredentialSolicitation(
      "Log in with email (I'll provide credentials)",
      "options[0].label",
    );
    expect(a).not.toBeNull();
    expect(a!.secretTerm).toBe("credential");

    const b = findCredentialSolicitation(
      "Use Netlify CLI instead — I'll give you an access token",
      "options[1].label",
    );
    expect(b).not.toBeNull();
    expect(b!.secretTerm).toBe("access token");
  });

  test.each([
    "What's your password?",
    "Paste your API key here and I'll set it up",
    "Reply with the verification code from your email",
    "Just give me your GitHub personal access token",
    "Send me the client secret in chat",
    "Type your password below",
    "I’ll provide credentials for the login", // curly apostrophe
  ])("refuses to accept a secret in chat: %s", (text) => {
    expect(findCredentialSolicitation(text, "f")).not.toBeNull();
  });

  test.each([
    "Which Netlify team should I deploy to?",
    "I'll read the API key from the credential store — nothing for you to do",
    "Sign in to Netlify in your browser, then tell me when you're done",
    "Should I store the token you added under `netlify`?",
    "Give me the name of the site to deploy",
    "What's your Netlify username?",
  ])("does not fire on legitimate text: %s", (text) => {
    expect(findCredentialSolicitation(text, "f")).toBeNull();
  });

  test("a secret noun with no hand-it-over cue is not a solicitation", () => {
    expect(
      findCredentialSolicitation(
        "Netlify needs an access token to deploy.",
        "f",
      ),
    ).toBeNull();
  });

  test("a hand-it-over cue with no secret noun is not a solicitation", () => {
    expect(
      findCredentialSolicitation("Paste the URL of the site here", "f"),
    ).toBeNull();
  });

  test("empty and missing text are safe", () => {
    expect(findCredentialSolicitation("", "f")).toBeNull();
    expect(findCredentialSolicitation(undefined, "f")).toBeNull();
    expect(findCredentialSolicitation(null, "f")).toBeNull();
  });

  test("reports the originating field and clips long text", () => {
    const long = `${"x".repeat(400)} paste your password`;
    const match = findCredentialSolicitation(long, "questions[2].question");
    expect(match!.field).toBe("questions[2].question");
    expect(match!.text.length).toBeLessThanOrEqual(161);
    expect(match!.text.endsWith("…")).toBe(true);
  });
});

describe("findCredentialSolicitations", () => {
  test("collects every offending field", () => {
    const matches = findCredentialSolicitations([
      { field: "a", text: "Which team?" },
      { field: "b", text: "Paste your password" },
      { field: "c", text: undefined },
      { field: "d", text: "I'll give you an access token" },
    ]);
    expect(matches.map((m) => m.field)).toEqual(["b", "d"]);
  });
});

describe("formatCredentialSolicitationRefusal", () => {
  test("names the offending text and both allowed routes", () => {
    const message = formatCredentialSolicitationRefusal(
      findCredentialSolicitations([
        { field: "options[0].label", text: "Log in (I'll provide credentials)" },
      ]),
    );
    expect(message).toContain("Refused");
    expect(message).toContain("options[0].label");
    expect(message).toContain("I'll provide credentials");
    // Route 1: user signs in themselves.
    expect(message).toContain("signs in themselves");
    // Route 2: credential_store secure prompt.
    expect(message).toContain("credential_store");
    expect(message).toContain('action: "prompt"');
  });
});
