/**
 * The autonomy-cap enforcement point — pure clamp logic. A playbook may never
 * run more autonomously than the global trust dial allows.
 */
import { describe, expect, test } from "bun:test";

import { capAutonomy } from "../autonomy-cap.js";

describe("capAutonomy", () => {
  test("observe holds everything at notify", () => {
    expect(capAutonomy("auto", "observe").effective).toBe("notify");
    expect(capAutonomy("draft", "observe").effective).toBe("notify");
    expect(capAutonomy("notify", "observe").effective).toBe("notify");
  });

  test("assist holds auto down to draft, leaves draft/notify", () => {
    expect(capAutonomy("auto", "assist").effective).toBe("draft");
    expect(capAutonomy("draft", "assist").effective).toBe("draft");
    expect(capAutonomy("notify", "assist").effective).toBe("notify");
  });

  test("autonomous permits the full requested autonomy", () => {
    expect(capAutonomy("auto", "autonomous").effective).toBe("auto");
    expect(capAutonomy("draft", "autonomous").effective).toBe("draft");
    expect(capAutonomy("notify", "autonomous").effective).toBe("notify");
  });

  test("never elevates above the request", () => {
    // A conservative request stays conservative even under a permissive dial.
    expect(capAutonomy("notify", "autonomous").effective).toBe("notify");
    expect(capAutonomy("draft", "autonomous").effective).toBe("draft");
  });

  test("capped flag is true only when the dial lowered the request", () => {
    expect(capAutonomy("auto", "observe").capped).toBe(true);
    expect(capAutonomy("auto", "assist").capped).toBe(true);
    expect(capAutonomy("auto", "autonomous").capped).toBe(false);
    expect(capAutonomy("draft", "assist").capped).toBe(false);
    expect(capAutonomy("notify", "observe").capped).toBe(false);
  });

  test("reports the ceiling + dial it applied", () => {
    const r = capAutonomy("auto", "assist");
    expect(r.ceiling).toBe("draft");
    expect(r.dial).toBe("assist");
    expect(r.requested).toBe("auto");
  });
});
