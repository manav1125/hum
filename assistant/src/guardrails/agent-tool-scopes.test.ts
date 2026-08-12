/**
 * Tests for the agent tool-scope filter: core plumbing is never filtered,
 * extension-owned tools are gated by lexical domain matching against the
 * agent's scopes, and unknown domains fail open toward availability.
 */
import { describe, expect, test } from "bun:test";

import type { OwnerInfo } from "../tools/types.js";
import {
  buildAgentToolScopeFilter,
  KNOWN_AGENT_TOOL_SCOPES,
  toolScopeDomains,
} from "./agent-tool-scopes.js";

/** Ownership stub: any name in the map is extension-owned; others are core. */
function ownerLookup(
  owners: Record<string, OwnerInfo>,
): (name: string) => OwnerInfo | undefined {
  return (name) => owners[name];
}

const OWNERS: Record<string, OwnerInfo> = {
  // skill-owned
  messaging_send: { kind: "skill", id: "messaging" },
  call_start: { kind: "skill", id: "phone-calls" },
  document_open: { kind: "skill", id: "document-editor" },
  app_create: { kind: "skill", id: "app-builder" },
  media_generate_image: { kind: "skill", id: "image-studio" },
  task_list_add: { kind: "skill", id: "tasks" },
  subagent_spawn: { kind: "skill", id: "subagent" },
  // mcp-owned
  mcp__gmail__send_email: { kind: "mcp", id: "gmail" },
  mcp__gcal__list_calendar_events: { kind: "mcp", id: "gcal" },
  mcp__meta__ads_create_campaign: { kind: "mcp", id: "meta-ads" },
  mcp__x__post_tweet: { kind: "mcp", id: "twitter" },
};

describe("toolScopeDomains", () => {
  test("maps tools into domains from name and owner id segments", () => {
    expect(toolScopeDomains("mcp__gmail__send_email", "gmail")).toEqual([
      "email",
    ]);
    expect(toolScopeDomains("document_open", "document-editor")).toEqual([
      "docs",
    ]);
    expect(toolScopeDomains("call_start", "phone-calls")).toEqual(["outreach"]);
    expect(toolScopeDomains("media_generate_image", "image-studio")).toEqual([
      "design",
    ]);
    expect(
      toolScopeDomains("mcp__meta__ads_create_campaign", "meta-ads"),
    ).toEqual(["ads"]);
  });

  test("segment matching, not substring matching", () => {
    // "additional" is not "ad"; "adsync" is not "ads".
    expect(toolScopeDomains("get_additional_info", "misc")).toEqual([]);
    // "mailer" is not "mail".
    expect(toolScopeDomains("run_mailer_job", "misc")).toEqual([]);
  });

  test("tools matching no known domain are shared plumbing (empty)", () => {
    expect(toolScopeDomains("subagent_spawn", "subagent")).toEqual([]);
    expect(toolScopeDomains("task_list_add", "tasks")).toEqual([]);
  });

  test("the known scope ids match the R1 chip vocabulary", () => {
    expect([...KNOWN_AGENT_TOOL_SCOPES].sort()).toEqual([
      "ads",
      "calendar",
      "code",
      "design",
      "docs",
      "email",
      "files",
      "messaging",
      "outreach",
      "research",
      "social",
    ]);
  });
});

describe("buildAgentToolScopeFilter", () => {
  const getOwner = ownerLookup(OWNERS);

  test("core tools (no registry owner) are always available", () => {
    const filter = buildAgentToolScopeFilter([], { getOwner });
    for (const name of ["bash", "file_read", "file_write", "web_search"]) {
      expect(filter(name)).toBe(true);
    }
  });

  test("extension tools matching no known domain are always available", () => {
    const filter = buildAgentToolScopeFilter(["email"], { getOwner });
    expect(filter("subagent_spawn")).toBe(true);
    expect(filter("task_list_add")).toBe(true);
  });

  test("domain tools are gated by the agent's scopes", () => {
    // An Ops-style agent: email/calendar/research/files.
    const ops = buildAgentToolScopeFilter(
      ["email", "calendar", "research", "files"],
      { getOwner },
    );
    expect(ops("mcp__gmail__send_email")).toBe(true);
    expect(ops("mcp__gcal__list_calendar_events")).toBe(true);
    expect(ops("document_open")).toBe(false); // docs
    expect(ops("app_create")).toBe(false); // code
    expect(ops("mcp__meta__ads_create_campaign")).toBe(false); // ads
    expect(ops("call_start")).toBe(false); // outreach

    // A Growth-style agent: outreach/social/ads.
    const growth = buildAgentToolScopeFilter(["outreach", "social", "ads"], {
      getOwner,
    });
    expect(growth("call_start")).toBe(true);
    expect(growth("messaging_send")).toBe(true);
    expect(growth("mcp__x__post_tweet")).toBe(true); // social (twitter owner)
    expect(growth("mcp__meta__ads_create_campaign")).toBe(true);
    expect(growth("mcp__gmail__send_email")).toBe(false); // email
    expect(growth("media_generate_image")).toBe(false); // design
  });

  test("scopes are normalized (trim/case) and unknown scope ids match nothing", () => {
    const filter = buildAgentToolScopeFilter(["  EMAIL  ", "bogus-scope"], {
      getOwner,
    });
    expect(filter("mcp__gmail__send_email")).toBe(true);
    expect(filter("document_open")).toBe(false);
  });

  test("empty scopes block all domain-mapped extension tools but nothing else", () => {
    const filter = buildAgentToolScopeFilter([], { getOwner });
    expect(filter("mcp__gmail__send_email")).toBe(false);
    expect(filter("document_open")).toBe(false);
    expect(filter("bash")).toBe(true);
    expect(filter("subagent_spawn")).toBe(true);
  });
});
