/**
 * Custom ESLint rule: no-on-token-as-ground.
 *
 * A design token whose name contains `-on-` states the GROUND it belongs on,
 * or the ground it is the INK for:
 *
 *   --muted-on-dark    muted type, on a dark ground
 *   --blue-on-fill     the ink that rides `--blue-fill`
 *
 * Either way it names TYPE. It may appear where type is painted — `color`,
 * `fill`, `stroke` — and nowhere else. Putting one in a `background` inverts
 * the pair: the ink becomes the ground, and whatever ink lands on it is
 * chosen against a colour that was never meant to be one.
 *
 * Design asked for this as a lint rather than a convention, and gave the
 * reason plainly: **two shipped bugs were exactly this inversion**, inside a
 * class they have now logged eleven times across eleven careful design passes.
 *
 *   "Eleven recurrences across eleven careful passes is not a discipline
 *    problem. Until a name carries its ground, the wrong value stays typeable
 *    into the right slot."
 *
 * ── Why a BLOCKLIST of ground slots, not an allowlist of ink slots ─────────
 *
 * The literal reading of the ruling — "only `color`/`fill`/`stroke`" — as an
 * allowlist over every property would fail three things that are correct:
 *
 *   · `--gr-muted: var(--muted-on-dark)`  a theme aliasing the invariant token,
 *                                         which is the intended consumption
 *   · `caret-color: var(--muted-on-dark)` type-adjacent ink
 *   · `var(--blue-on-fill, #fff)`         a fallback inside another var()
 *
 * A guard that reports those is a guard someone switches off, and a switched-
 * off guard is how this class survived eleven rounds. So the rule fails on the
 * slots that PAINT A GROUND, which is what the ruling is actually about, and
 * is silent everywhere else.
 *
 * ── What it reads ─────────────────────────────────────────────────────────
 *
 * Three shapes, because the same inversion is spellable three ways here:
 *
 *   1. style objects        `style={{ background: "var(--blue-on-fill)" }}`
 *   2. CSS in strings       `":root{background:var(--blue-on-fill)}"` — the
 *                            `dangerouslySetInnerHTML` blocks every HQ and
 *                            guardrails surface injects
 *   3. Tailwind arbitrary   `className="bg-[var(--blue-on-fill)]"`
 *
 * `.css` files are not visible to ESLint. Their half of the same rule — plus
 * the values behind the names — lives in `src/lib/ground-role-tokens.test.ts`.
 */

/** `--x-on-y` in any prefix: `--muted-on-dark`, `--mv3-amber-on-fill`. */
const ON_TOKEN = /--[a-z0-9]+(?:-[a-z0-9]+)*-on-[a-z0-9]+(?:-[a-z0-9]+)*/gi;

/**
 * Properties that paint a GROUND.
 *
 * The semantic surface vars are here for the same reason they are in the mv3
 * guard: rebinding `--surface-lift` paints a ground just as surely as writing
 * `background`, and that indirection is where a token guard usually loses the
 * thread.
 */
const GROUND_PROPS = new Set([
  "background",
  "backgroundcolor",
  "background-color",
  "backgroundimage",
  "background-image",
  "--surface-base",
  "--surface-lift",
  "--surface-overlay",
  "--primary-base",
]);

/** CSS text: `background: var(--x-on-y)` — property and value in one string. */
const CSS_GROUND_DECL =
  /(background(?:-color|-image)?|--surface-(?:base|lift|overlay)|--primary-base)\s*:\s*([^;{}"'`]*)/gi;

/** Tailwind arbitrary background: `bg-[var(--x-on-y)]`, incl. variants. */
const TW_BG_ARBITRARY = /\b(?:[a-z-]+:)*bg-\[([^\]]*)\]/gi;

/** Every `-on-` token inside a chunk of CSS value text. */
function onTokensIn(text) {
  return [...String(text).matchAll(ON_TOKEN)].map((m) => m[0]);
}

/**
 * CSS comments, removed before scanning.
 *
 * The `.css` half of this guard read a comment as code on its first run:
 * `mv3.css` documents the rule in prose — "an `-on-fill` in a `background:`
 * slot fails the guard" — and the declaration match ran straight on across the
 * following comment lines. Two false positives, in the file that states the
 * rule correctly. A guard that cries wolf gets switched off, and a switched-off
 * guard is how this class survived eleven rounds.
 */
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** The static text of a Literal or a TemplateLiteral, or null. */
function staticText(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral") {
    // Quasis only. An interpolated expression is not statically readable, and
    // guessing at one would produce exactly the false positive that gets a
    // rule switched off.
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
  }
  return null;
}

/** The property name exactly as it was written in source, or null. */
function sourceName(node) {
  const key = node.key;
  if (!key) return null;
  if (key.type === "Identifier" && !node.computed) return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

/** The property name of an object `Property`, normalised, or null. */
function propertyName(node) {
  const key = node.key;
  if (!key) return null;
  if (key.type === "Identifier" && !node.computed) return key.name.toLowerCase();
  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value.toLowerCase();
  }
  return null;
}

export const noOnTokenAsGround = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A `-on-` token names ink. It may be painted as type (color/fill/stroke), never as a ground (background).",
    },
    schema: [],
    messages: {
      inverted:
        "`{{token}}` is INK — its name states the ground it sits on. It may only " +
        "be painted as type (color / fill / stroke); `{{prop}}` paints a GROUND, " +
        "which inverts the pair. Use the matching `-fill` leg as the background " +
        "and keep `{{token}}` as the ink on it. See the ground/role block in " +
        "src/index.css.",
    },
  },
  create(context) {
    /** Report every `-on-` token found in `text` as landing in `prop`. */
    function reportTokens(node, prop, text) {
      for (const token of onTokensIn(text)) {
        context.report({
          node,
          messageId: "inverted",
          data: { token, prop },
        });
      }
    }

    /** Shape 2 + 3: scan a static string for CSS decls and Tailwind classes. */
    function scanText(node, raw) {
      if (!raw) return;
      const text = stripCssComments(raw);
      for (const [, prop, value] of text.matchAll(CSS_GROUND_DECL)) {
        reportTokens(node, prop.toLowerCase(), value);
      }
      for (const [, value] of text.matchAll(TW_BG_ARBITRARY)) {
        reportTokens(node, "bg-[…]", value);
      }
    }

    return {
      // Shape 1: `{ background: "var(--x-on-y)" }` — style objects, theme
      // maps, and the `C`-palette-style constant objects. The property name
      // is on the node, so this catches the case where the value carries no
      // `background:` text of its own.
      Property(node) {
        const prop = propertyName(node);
        if (!prop || !GROUND_PROPS.has(prop)) return;
        const text = staticText(node.value);
        // Report the property as it was written (`backgroundColor`), not the
        // normalised lookup key — the message is read at the call site.
        if (text) reportTokens(node, sourceName(node) ?? prop, text);
      },

      // Shapes 2 and 3 live inside string and template literals. Skip the
      // literals already handled as a Property value above, so one mistake is
      // reported once rather than twice.
      Literal(node) {
        if (typeof node.value !== "string") return;
        const parent = node.parent;
        if (parent?.type === "Property" && parent.value === node) {
          const prop = propertyName(parent);
          if (prop && GROUND_PROPS.has(prop)) return;
        }
        scanText(node, node.value);
      },

      TemplateLiteral(node) {
        const parent = node.parent;
        if (parent?.type === "Property" && parent.value === node) {
          const prop = propertyName(parent);
          if (prop && GROUND_PROPS.has(prop)) return;
        }
        scanText(node, staticText(node));
      },
    };
  },
};
