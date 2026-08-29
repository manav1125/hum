/**
 * The People/Services split, driven through the real classifier.
 *
 * The cases that matter are the false positives: this decides which half of a
 * page someone lands on, and a person filed as a mailing list is a person you
 * stop seeing.
 */

import { describe, expect, test } from "bun:test";

import { classifyContact, splitContacts } from "./contact-kind";

const withEmail = (address: string) => ({ channels: [{ type: "email", address }] });

describe("classifyContact", () => {
  test("role and machine addresses are services", () => {
    for (const address of [
      "noreply@example.com",
      "no-reply@example.com",
      "do-not-reply@example.com",
      "notifications@example.com",
      "billing@example.com",
      "support@example.com",
      "newsletter@example.com",
      "notifications+cue@example.com",
      "noreply-marketing@example.com",
      "sales@example.com",
      "team@example.com",
      "info@example.com",
    ]) {
      expect(classifyContact(withEmail(address))).toBe("service");
    }
  });

  test("bulk-mail subdomains are services even with a human local-part", () => {
    // A person is you@example.com; a campaign is you@email.acme.com.
    // The rule under test IS the sending subdomain, so these fixtures have to
    // be a subdomain OF the example domain — a bare example.com cannot express
    // the case at all.
    // generic-examples:ignore-next-line — reason: bulk-sender subdomain under test
    expect(classifyContact(withEmail("sarah@email.example.com"))).toBe("service");
    // generic-examples:ignore-next-line — reason: bulk-sender subdomain under test
    expect(classifyContact(withEmail("j.chen@mktg.example.com"))).toBe("service");
  });

  test("REGRESSION: ordinary people are not swept up by the prefixes", () => {
    // Every one of these starts with a service word and is a person. The
    // first version allowed any separator after a role word, which filed
    // `sales_rodriguez@` with the mailing lists — a person you stop seeing,
    // which is the one failure this split may not have.
    for (const address of [
      "noreplacement@example.com",
      "helpman@example.com",
      "information@example.com",
      "teamaki@example.com",
      "infante@example.com",
      "sales_rodriguez@example.com",
      "info.chen@example.com",
      "team.nakamura@example.com",
      "autumn@example.com",
      "robertson@example.com",
      "newton@example.com",
      "bottomley@example.com",
    ]) {
      expect(classifyContact(withEmail(address))).toBe("person");
    }
  });

  test("REGRESSION: a bare domain is a person, not a campaign", () => {
    expect(classifyContact(withEmail("sarah@example.com"))).toBe("person");
    expect(classifyContact(withEmail("sarah@example.org"))).toBe("person");
  });

  test("a non-email channel never argues against a person", () => {
    // A Slack id or a phone number reaches a human by construction.
    expect(
      classifyContact({ channels: [{ type: "slack", address: "U024BE7LH" }] }),
    ).toBe("person");
    expect(
      classifyContact({ channels: [{ type: "phone", address: "+15550100" }] }),
    ).toBe("person");
  });

  test("no channels at all is a person — an absent fact proves nothing", () => {
    expect(classifyContact({ displayName: "Someone" })).toBe("person");
    expect(classifyContact({ channels: [] })).toBe("person");
  });

  test("one service address is enough, whichever channel carries it", () => {
    expect(
      classifyContact({
        channels: [
          { type: "slack", address: "U1" },
          { type: "email", address: "noreply@example.com" },
        ],
      }),
    ).toBe("service");
  });
});

describe("splitContacts", () => {
  test("both halves come back, in order, and nothing is dropped", () => {
    // The counts are the promise that nothing was thrown away, so the sum
    // has to hold.
    const list = [
      { displayName: "a", ...withEmail("sarah@example.com") },
      { displayName: "b", ...withEmail("noreply@example.com") },
      { displayName: "c", ...withEmail("tom@example.com") },
    ];
    const { people, services } = splitContacts(list);
    expect(people.map((c) => c.displayName)).toEqual(["a", "c"]);
    expect(services.map((c) => c.displayName)).toEqual(["b"]);
    expect(people.length + services.length).toBe(list.length);
  });
});
