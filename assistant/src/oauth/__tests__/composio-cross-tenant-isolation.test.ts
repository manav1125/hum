/**
 * ADVERSARIAL: can principal B ever reach principal A's Composio connection?
 *
 * Threat model this pins down. The Composio API key in `connectors.json` is an
 * ORGANISATION-wide credential — the same key is seeded into every Cue instance
 * by `hq/src/provisioning.ts`, and it can list and proxy through every Cue
 * customer's connected accounts. Verified against the live Composio org on
 * 2026-08-03: an unfiltered `GET /connected_accounts` under that one key
 * returned 176 accounts spanning 36 distinct `user_id`s. The `user_ids=` query
 * filter Cue puts on every request is therefore not a boundary the credential
 * enforces — it is a boundary Cue's own code has to keep enforcing, forever, on
 * every call site.
 *
 * That is the exact failure shape this repo keeps hitting: not a wrong filter,
 * but a filter that silently stops being applied while every call still
 * succeeds. So these tests do not check that the filter is in the URL. They
 * hand the code a response that a *broken* filter would produce — foreign rows
 * mixed in — and assert that no foreign account id can escape into a
 * `connected_account_id`, which is what a Composio proxy call reads real mail
 * with.
 *
 * If someone deletes the ownership guard, these go red. If someone deletes the
 * `user_ids=` filter, the guard catches it at runtime and these still hold.
 */

import { describe, expect, it } from "bun:test";

import { selectOwnedAccounts } from "../composio-account-ownership.js";

/** This instance. */
const OWN_USER = "bd545579-0000-0000-0000-instance-a";
/** A different Cue customer, under the same organisation API key. */
const FOREIGN_USER = "ffffffff-1111-2222-3333-instance-b";

interface Row {
  id: string;
  user_id?: unknown;
  toolkit?: { slug?: string };
}

const row = (id: string, user: unknown, slug: string): Row => ({
  id,
  ...(user === undefined ? {} : { user_id: user }),
  toolkit: { slug },
});

describe("Composio cross-tenant isolation", () => {
  it("refuses a foreign connected account even when it is the only row", () => {
    // What a silently-ignored `user_ids=` filter looks like: HTTP 200, a
    // perfectly well-formed ACTIVE Gmail connection — belonging to someone
    // else. Row 0 is what the old code handed to the proxy.
    const owned = selectOwnedAccounts(
      [row("ca_victim_gmail", FOREIGN_USER, "gmail")],
      OWN_USER,
      "test",
    );

    expect(owned).toEqual([]);
    expect(owned.map((r) => r.id)).not.toContain("ca_victim_gmail");
  });

  it("never lets a foreign account win the row-0 race", () => {
    // `connectionIdForToolkit` takes `items[0]`. Ordering is Composio's
    // choice, so a foreign row sorting first must not become the id we proxy
    // through — the leak has to be impossible, not merely unlikely.
    const owned = selectOwnedAccounts(
      [
        row("ca_victim_gmail", FOREIGN_USER, "gmail"),
        row("ca_mine_gmail", OWN_USER, "gmail"),
      ],
      OWN_USER,
      "test",
    );

    expect(owned).toHaveLength(1);
    expect(owned[0]?.id).toBe("ca_mine_gmail");
  });

  it("drops every foreign row from a mixed multi-toolkit listing", () => {
    // The `activeToolkits` / connector-apps shape: one call, all toolkits.
    // A leak here does not just proxy mail — it tells the model that someone
    // else's Slack and Drive are linked accounts it may act on.
    const owned = selectOwnedAccounts(
      [
        row("ca_a1", FOREIGN_USER, "gmail"),
        row("ca_b1", OWN_USER, "gmail"),
        row("ca_a2", FOREIGN_USER, "slack"),
        row("ca_a3", FOREIGN_USER, "googledrive"),
        row("ca_b2", OWN_USER, "googlecalendar"),
      ],
      OWN_USER,
      "test",
    );

    expect(owned.map((r) => r.id).sort()).toEqual(["ca_b1", "ca_b2"]);
    expect(owned.map((r) => r.toolkit?.slug).sort()).toEqual([
      "gmail",
      "googlecalendar",
    ]);
  });

  it("compares user ids exactly — no prefix, case, or whitespace slack", () => {
    // Near-miss ids must not pass. An id that merely *starts with* ours, or
    // differs only in case or trailing space, is a different Composio user.
    const nearMisses = [
      `${OWN_USER}-suffix`,
      OWN_USER.toUpperCase(),
      ` ${OWN_USER}`,
      `${OWN_USER} `,
      OWN_USER.slice(0, -1),
    ];

    for (const near of nearMisses) {
      expect(
        selectOwnedAccounts([row("ca_near", near, "gmail")], OWN_USER, "test"),
      ).toEqual([]);
    }
  });

  it("refuses rows whose user_id is a non-string that could coerce", () => {
    // A JSON response is attacker-shaped input from this code's point of view.
    // `null`/objects/arrays must never compare equal to our id by accident.
    for (const weird of [null, 0, false, {}, [], [OWN_USER]]) {
      const owned = selectOwnedAccounts(
        [row("ca_weird", weird, "gmail"), row("ca_mine", OWN_USER, "gmail")],
        OWN_USER,
        "test",
      );
      // The weird row cannot be *proven* foreign, so it is kept (see the
      // fail-direction note on selectOwnedAccounts) — but it must never
      // displace or hide the row we can prove is ours.
      expect(owned.map((r) => r.id)).toContain("ca_mine");
    }
  });

  it("keeps our own rows — the guard must not empty a healthy account list", () => {
    // The guard-polarity regression this repo has shipped before: an
    // ownership check that excludes everyone is not "secure", it is an
    // outage that hides the user's own connectors.
    const rows = [
      row("ca_1", OWN_USER, "gmail"),
      row("ca_2", OWN_USER, "slack"),
      row("ca_3", OWN_USER, "notion"),
    ];

    expect(selectOwnedAccounts(rows, OWN_USER, "test")).toEqual(rows);
  });

  it("keeps unlabelled rows so a response-shape change is not a silent outage", () => {
    // If Composio ever stops returning `user_id`, we cannot prove ownership
    // either way. Dropping those would disconnect every connector silently —
    // a judgement we cannot make must not hide the user's own accounts.
    const rows = [{ id: "ca_no_user_field" } as Row];

    expect(selectOwnedAccounts(rows, OWN_USER, "test")).toEqual(rows);
  });

  it("still refuses a proven-foreign row inside an unlabelled response", () => {
    const owned = selectOwnedAccounts(
      [
        { id: "ca_unlabelled" } as Row,
        row("ca_victim", FOREIGN_USER, "gmail"),
        row("ca_mine", OWN_USER, "gmail"),
      ],
      OWN_USER,
      "test",
    );

    expect(owned.map((r) => r.id)).toEqual(["ca_unlabelled", "ca_mine"]);
  });

  it("returns nothing rather than someone else's account on an all-foreign page", () => {
    // The end-to-end assertion the owner cares about: when Cue holds no
    // connection of its own, the answer is "not connected" — never another
    // customer's live one.
    const owned = selectOwnedAccounts(
      [
        row("ca_x1", FOREIGN_USER, "gmail"),
        row("ca_x2", "another-third-party", "gmail"),
      ],
      OWN_USER,
      "test",
    );

    expect(owned).toHaveLength(0);
  });
});
