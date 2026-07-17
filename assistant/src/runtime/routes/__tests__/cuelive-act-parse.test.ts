import { describe, expect, test } from "bun:test";

import { __testing } from "../cuelive-routes.js";

const { parseActJson } = __testing;

describe("parseActJson", () => {
  test("parses the documented shape", () => {
    expect(
      parseActJson(
        '{"say":"Opening Projects.","done":false,"action":{"type":"click","x":113,"y":216}}',
      ),
    ).toEqual({
      say: "Opening Projects.",
      done: false,
      action: { type: "click", x: 113, y: 216 },
    });
  });

  test("accepts a coordinate pair in x, which is how the vision model grounds", () => {
    // Verbatim reply from qwen2.5-vl on a real screenshot. Zod rejected it, the
    // failure became {done:true}, and take-control gave up on step 1 while
    // reporting success.
    const parsed = parseActJson(
      '{"say": "Navigating to Projects section.", "done": false, "action": {"type": "click", "x": [113, 216]}}',
    );
    expect(parsed.done).toBe(false);
    expect(parsed.action).toMatchObject({ type: "click", x: 113, y: 216 });
  });

  test("leaves an explicit y alone", () => {
    const parsed = parseActJson(
      '{"say":null,"done":false,"action":{"type":"click","x":[10,20],"y":99}}',
    );
    // Ambiguous: x is a pair but y was given. Not coerced, so it fails closed.
    expect(parsed).toEqual({ say: null, done: true, action: null });
  });

  test("unwraps a code fence", () => {
    const parsed = parseActJson(
      '```json\n{"say":null,"done":true,"action":null}\n```',
    );
    expect(parsed).toEqual({ say: null, done: true, action: null });
  });

  test("stops the run when the reply is not JSON", () => {
    expect(parseActJson("I think you should click the button")).toEqual({
      say: null,
      done: true,
      action: null,
    });
  });
});
