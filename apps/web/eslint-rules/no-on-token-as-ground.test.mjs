/**
 * Unit tests for the no-on-token-as-ground ESLint rule.
 *
 * Run with: `bun test eslint-rules/no-on-token-as-ground.test.mjs`
 *
 * The invalid cases are the two inversions design says actually shipped —
 * an `-on-fill` ink used as a control's background, and a ground-named muted
 * ink used as a surface. The valid cases are the four shapes an over-literal
 * reading of the ruling ("only color/fill/stroke") would have failed, which
 * is the whole reason the rule blocklists ground slots instead: a guard that
 * reports correct code is a guard someone switches off.
 */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { noOnTokenAsGround } from "./no-on-token-as-ground.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("no-on-token-as-ground", noOnTokenAsGround, {
  valid: [
    // Ink in an ink slot — the whole point of the token.
    { code: `const s = { color: "var(--blue-on-fill)" };` },
    { code: `const s = { fill: "var(--muted-on-dark)" };` },
    { code: `const s = { stroke: "var(--muted-on-paper)" };` },
    // Type-adjacent ink. An allowlist over properties would fail this.
    { code: `const s = { caretColor: "var(--muted-on-canvas)" };` },
    // A theme aliasing the invariant token. This is the INTENDED consumption
    // and the first thing an allowlist reading would have broken.
    {
      code: `const css = ':root{--gr-muted:var(--muted-on-dark);}';`,
    },
    // The `-fill` leg as a background is exactly right.
    { code: `const s = { background: "var(--blue-fill)" };` },
    { code: `const cls = "bg-[var(--violet-fill)] text-[var(--violet-on-fill)]";` },
    // A var() fallback nested inside another var().
    {
      code: `const s = { color: "var(--x, var(--blue-on-fill))" };`,
    },
    // Interpolated template — not statically readable, and guessing here is
    // how a rule earns its false positives.
    {
      code: "const s = { background: `var(${token})` };",
    },
    // A token with no `-on-` segment is none of this rule's business.
    { code: `const s = { background: "var(--mv1-composer-veil)" };` },
    // A CSS comment that DESCRIBES the rule is not a violation of it. This is
    // a real false positive the .css half of the guard produced on its first
    // run, inside the file that states the rule correctly.
    {
      code: `const css = '/* an -on-fill in a background: slot fails. --violet-on-fill */';`,
    },
  ],

  invalid: [
    // Shipped bug shape 1: the ink of a coloured control used as its ground.
    {
      code: `const s = { background: "var(--blue-on-fill)" };`,
      errors: [{ messageId: "inverted" }],
    },
    {
      code: `const s = { backgroundColor: "var(--amber-on-fill)" };`,
      errors: [{ messageId: "inverted" }],
    },
    // Shipped bug shape 2: ground-named muted ink painted as a surface.
    {
      code: `const s = { background: "var(--muted-on-dark)" };`,
      errors: [{ messageId: "inverted" }],
    },
    // CSS injected as a string — every HQ / guardrails surface does this.
    {
      code: `const css = '.chip{background:var(--violet-on-fill);}';`,
      errors: [{ messageId: "inverted" }],
    },
    // A semantic surface rebind is a ground too, indirection notwithstanding.
    {
      code: `const css = '.card{--surface-lift:var(--teal-on-fill);}';`,
      errors: [{ messageId: "inverted" }],
    },
    // Tailwind arbitrary value, including behind a variant.
    {
      code: `const cls = "bg-[var(--green-on-fill)]";`,
      errors: [{ messageId: "inverted" }],
    },
    {
      code: `const cls = "md:hover:bg-[var(--muted-on-paper)]";`,
      errors: [{ messageId: "inverted" }],
    },
    // Any prefix, not just the app-level names — mv3 tokens are the same rule.
    {
      code: `const s = { background: "var(--mv3-amber-on-fill)" };`,
      errors: [{ messageId: "inverted" }],
    },
    // A static template literal is as readable as a string, so it is read.
    {
      code: "const css = `.row{background-color:var(--red-on-fill)}`;",
      errors: [{ messageId: "inverted" }],
    },
    // Reported ONCE, not twice, when the property node and the string body
    // both describe the same mistake.
    {
      code: `const s = { background: "background: var(--blue-on-fill)" };`,
      errors: [{ messageId: "inverted" }],
    },
  ],
});
