import { describe, expect, test } from "bun:test";

import { type AutonomyClass, classifyAutonomy } from "./autonomy-class.js";

describe("classifyAutonomy — core tools", () => {
  test("read/list/glob/grep/web_search/web_fetch → research", () => {
    for (const t of [
      "read",
      "list",
      "glob",
      "grep",
      "web_search",
      "web_fetch",
    ]) {
      expect(classifyAutonomy(t)).toBe<AutonomyClass>("research");
    }
  });

  test("write/edit/create_draft → draft", () => {
    for (const t of ["write", "edit", "create_draft"]) {
      expect(classifyAutonomy(t)).toBe<AutonomyClass>("draft");
    }
  });

  test("bash with no destructive verb → other", () => {
    expect(classifyAutonomy("bash", { command: "ls -la" })).toBe<AutonomyClass>(
      "other",
    );
    expect(classifyAutonomy("terminal", { command: "echo hi" })).toBe("other");
    expect(classifyAutonomy("bash")).toBe<AutonomyClass>("other");
  });
});

describe("classifyAutonomy — destructive bash", () => {
  test("rm and rm -rf → delete", () => {
    expect(classifyAutonomy("bash", { command: "rm foo.txt" })).toBe("delete");
    expect(classifyAutonomy("bash", { command: "rm -rf ./build" })).toBe(
      "delete",
    );
  });

  test("git push → delete", () => {
    expect(classifyAutonomy("bash", { command: "git push origin main" })).toBe(
      "delete",
    );
  });

  test("drop (SQL) → delete", () => {
    expect(
      classifyAutonomy("terminal", { command: "psql -c 'drop table users'" }),
    ).toBe("delete");
  });

  test("does not false-positive on substrings", () => {
    // "dropdown" / "formatting" contain "drop"/"rm" as substrings but not as
    // standalone verbs.
    expect(
      classifyAutonomy("bash", { command: "echo dropdown formatting" }),
    ).toBe("other");
  });
});

describe("classifyAutonomy — connector verbs", () => {
  test("get_/list_/search_/read_/query_ → research", () => {
    expect(classifyAutonomy("mcp__gmail__search_threads")).toBe("research");
    expect(classifyAutonomy("mcp__hubspot__get_crm_objects")).toBe("research");
    expect(classifyAutonomy("mcp__klaviyo__list_email_templates")).toBe(
      "research",
    );
    expect(classifyAutonomy("mcp__klaviyo__query_metric_aggregates")).toBe(
      "research",
    );
    expect(classifyAutonomy("mcp__drive__read_file_content")).toBe("research");
  });

  test("create_/update_/draft_ → draft", () => {
    expect(classifyAutonomy("mcp__klaviyo__create_email_template")).toBe(
      "draft",
    );
    expect(classifyAutonomy("mcp__klaviyo__update_profile")).toBe("draft");
    expect(classifyAutonomy("mcp__gmail__draft_reply")).toBe("draft");
  });

  test("send_/post_/email/message/subscribe_/unsubscribe_ → send", () => {
    expect(classifyAutonomy("mcp__slack__send_message")).toBe("send");
    expect(classifyAutonomy("mcp__x__post_tweet")).toBe("send");
    expect(
      classifyAutonomy("mcp__klaviyo__subscribe_profile_to_marketing"),
    ).toBe("send");
    expect(
      classifyAutonomy("mcp__klaviyo__unsubscribe_profile_from_marketing"),
    ).toBe("send");
  });

  test("delete_/remove_/unlabel_/archive_ → delete", () => {
    expect(classifyAutonomy("mcp__klaviyo__delete_email_template")).toBe(
      "delete",
    );
    expect(classifyAutonomy("mcp__ads__remove_custom_audience")).toBe("delete");
    expect(classifyAutonomy("mcp__gmail__unlabel_message")).toBe("delete");
    expect(classifyAutonomy("mcp__gmail__archive_thread")).toBe("delete");
  });

  test("money segments → money (highest priority)", () => {
    expect(classifyAutonomy("mcp__stripe__create_charge")).toBe("money");
    expect(classifyAutonomy("mcp__bank__transfer_funds")).toBe("money");
    expect(classifyAutonomy("mcp__shop__create_order")).toBe("money");
    expect(classifyAutonomy("mcp__stripe__issue_refund")).toBe("money");
    expect(classifyAutonomy("mcp__pay__checkout_session")).toBe("money");
    expect(classifyAutonomy("mcp__wallet__get_balance")).toBe("money");
    expect(classifyAutonomy("mcp__ledger__list_transactions")).toBe("money");
    // Plural segments and camelCase boundaries still match.
    expect(classifyAutonomy("mcp__shop__list_orders")).toBe("money");
    expect(classifyAutonomy("mcp__shop__createOrder")).toBe("money");
  });

  test("money terms embedded inside larger words do NOT match (segment, not substring)", () => {
    // Regression: substring matching classified "recorder" as money
    // ("rec-ORDER-er"), hard-denying screen-recorder tools from auto-run.
    expect(classifyAutonomy("recorder")).not.toBe("money");
    expect(classifyAutonomy("screen_recorder_start")).not.toBe("money");
    expect(classifyAutonomy("mcp__av__start_recorder")).not.toBe("money");
    // "payload" contains "pay", "unbalanced" contains "balance"… none of
    // these are money segments.
    expect(classifyAutonomy("set_payload")).not.toBe("money");
    expect(classifyAutonomy("mcp__queue__get_payload")).not.toBe("money");
    expect(classifyAutonomy("check_unbalanced_brackets")).not.toBe("money");
    expect(classifyAutonomy("mcp__git__reorder_commits")).not.toBe("money");
  });
});

describe("classifyAutonomy — publish", () => {
  test("publish/deploy segments → publish", () => {
    expect(classifyAutonomy("publish_website")).toBe("publish");
    expect(classifyAutonomy("mcp__site__publish_website")).toBe("publish");
    expect(classifyAutonomy("mcp__game__publish_game")).toBe("publish");
    expect(classifyAutonomy("mcp__game__deploy_game")).toBe("publish");
    expect(classifyAutonomy("mcp__site__deploy_website")).toBe("publish");
    expect(classifyAutonomy("unpublish_page")).toBe("publish");
    expect(classifyAutonomy("app_publish")).toBe("publish");
    // camelCase boundaries still match.
    expect(classifyAutonomy("mcp__site__deployWebsite")).toBe("publish");
  });

  test("publish terms embedded inside larger words do NOT match", () => {
    expect(classifyAutonomy("get_publisher_info")).not.toBe("publish");
    expect(classifyAutonomy("list_deployments")).not.toBe("publish");
  });

  test("send/delete/money keep priority over publish", () => {
    // A posting verb keeps its send class — the send checkpoint covers it.
    expect(classifyAutonomy("mcp__x__post_tweet")).toBe("send");
    expect(classifyAutonomy("mcp__site__delete_deploy_target")).toBe("delete");
    expect(classifyAutonomy("mcp__shop__deploy_checkout")).toBe("money");
  });
});

describe("classifyAutonomy — contact", () => {
  test("call/phone initiation tools → contact", () => {
    expect(classifyAutonomy("call_start")).toBe("contact");
    expect(classifyAutonomy("mcp__twilio__create_call")).toBe("contact");
    expect(classifyAutonomy("mcp__twilio__make_phone_call")).toBe("contact");
    expect(classifyAutonomy("start_call")).toBe("contact");
    expect(classifyAutonomy("dial_number")).toBe("contact");
  });

  test("non-initiating call tools are NOT contact", () => {
    expect(classifyAutonomy("call_status")).toBe("other");
    expect(classifyAutonomy("call_end")).toBe("other");
    expect(classifyAutonomy("list_calls")).toBe("research");
    // "call" without an initiation verb (e.g. RPC-ish names).
    expect(classifyAutonomy("call_api")).toBe("other");
  });

  test("message/email sends stay send (contact checkpoint matches them coarsely)", () => {
    expect(classifyAutonomy("messaging_send")).toBe("send");
    expect(classifyAutonomy("mcp__gmail__send_email")).toBe("send");
  });
});

describe("classifyAutonomy — fallthrough", () => {
  test("unknown tool with no recognizable verb → other", () => {
    expect(classifyAutonomy("mcp__weird__frobnicate_widget")).toBe("other");
    expect(classifyAutonomy("some_random_tool")).toBe("other");
  });
});
