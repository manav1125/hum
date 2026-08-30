/**
 * Gateway log redaction must not fall behind the canonical secret list.
 *
 * It did. This module kept its own copy of the patterns, and while the shared
 * list grew — OpenRouter, Fireworks, Slack app tokens, Linear, Notion, PyPI,
 * Perplexity, Tavily, PEM private keys — the copy did not. None of those were
 * redacted in gateway logs. OpenRouter is this product's production brain
 * credential, so the drift was silently leaking the most important one.
 *
 * The list is now shared. This pins that it stays shared: a pattern added to
 * the canonical source has to be redacted here without anyone remembering to
 * come back.
 */

import { describe, expect, test } from "bun:test";
import { PREFIX_PATTERNS } from "@vellumai/service-contracts/secret-patterns";

import { redactSecretsInString } from "../log-redact.js";

/** A value that matches each pattern, for the formats we actually hold. */
const SAMPLES: Record<string, string> = {
  "OpenRouter API Key": `sk-or-v1-${"a".repeat(48)}`,
  "Fireworks API Key": `fw_${"b".repeat(36)}`,
  "AWS Access Key": "AKIA1234567890ABCDEF",
  "Linear API Key": `lin_api_${"c".repeat(36)}`,
  "Notion Integration Token": `ntn_${"d".repeat(44)}`,
  "Perplexity API Key": `pplx-${"e".repeat(44)}`,
  "Tavily API Key": `tvly-${"f".repeat(24)}`,
  "PyPI API Token": `pypi-${"g".repeat(54)}`,
};

describe("gateway log redaction covers the shared list", () => {
  test("every sampled secret format is redacted out of a log line", () => {
    for (const [label, sample] of Object.entries(SAMPLES)) {
      const line = `calling provider with key=${sample} done`;
      const out = redactSecretsInString(line);
      expect(
        out,
        `${label} leaked through gateway log redaction`,
      ).not.toContain(sample);
    }
  });

  test("a private key block is redacted", () => {
    const line = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n";
    expect(redactSecretsInString(line)).not.toContain(
      "-----BEGIN RSA PRIVATE KEY-----",
    );
  });

  test("the samples cover formats the canonical list actually defines", () => {
    // Guards the test itself: a renamed label would otherwise silently stop
    // testing anything.
    const labels = new Set(PREFIX_PATTERNS.map((p) => p.label));
    for (const label of Object.keys(SAMPLES)) {
      expect(labels.has(label), `no canonical pattern named "${label}"`).toBe(
        true,
      );
    }
  });

  test("ordinary text is left alone", () => {
    const line = "conversation 12345 finished in 42ms";
    expect(redactSecretsInString(line)).toBe(line);
  });
});
