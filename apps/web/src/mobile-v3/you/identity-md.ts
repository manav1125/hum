/**
 * IDENTITY.md field editing — the real save path behind the mobile Identity
 * leaf (spec frame 53).
 *
 * The daemon's identity endpoint is read-only (`GET /v1/identity` parses
 * IDENTITY.md bullet fields); edits happen by rewriting the file through the
 * workspace routes (`GET /workspace/file/content` → modify → `POST
 * /workspace/write`). This module holds the pure rewrite so it can be tested
 * against the daemon's own parse rules (`parseIdentityFields` in
 * assistant/src/daemon/handlers/identity.ts):
 *   · fields live on bullet lines `- **Name:** value` (case-insensitive);
 *   · "personality" also answers to the legacy `- **Vibe:**` alias;
 *   · placeholder values `_(…)_` read as unset — overwriting them is the
 *     first-edit path.
 */

export interface IdentityEdits {
  name?: string;
  role?: string;
  personality?: string;
}

/** Bullet-line matcher per field — mirrors the daemon parser's prefixes. */
const FIELD_PATTERNS: Record<keyof IdentityEdits, RegExp> = {
  name: /^(\s*-\s+\*\*name:\*\*)(.*)$/i,
  role: /^(\s*-\s+\*\*role:\*\*)(.*)$/i,
  // The daemon reads personality from **Personality:** or **Vibe:**.
  personality: /^(\s*-\s+\*\*(?:personality|vibe):\*\*)(.*)$/i,
};

/** Canonical bullet used when a field line has to be created. */
const FIELD_BULLETS: Record<keyof IdentityEdits, string> = {
  name: "- **Name:**",
  role: "- **Role:**",
  personality: "- **Personality:**",
};

/** Any identity bullet — the anchor block new bullets append to. */
const ANY_IDENTITY_BULLET = /^\s*-\s+\*\*[a-z]+:\*\*/i;

/** Collapse an edit to a single safe line (the format is line-oriented). */
function sanitize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Apply identity edits to IDENTITY.md content.
 *
 * Existing bullet lines are rewritten in place (preserving everything else —
 * comments, the Avatar section, unknown fields). A missing field line is
 * inserted after the last identity bullet. Returns `null` when the file has
 * no identity-bullet anchor at all — the caller surfaces an honest error
 * instead of guessing at a structure.
 */
export function applyIdentityEdits(
  content: string,
  edits: IdentityEdits,
): string | null {
  const lines = content.split("\n");
  const pending = new Map<keyof IdentityEdits, string>();
  for (const key of Object.keys(FIELD_PATTERNS) as (keyof IdentityEdits)[]) {
    const value = edits[key];
    if (typeof value === "string") pending.set(key, sanitize(value));
  }
  if (pending.size === 0) return content;

  let lastBulletIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ANY_IDENTITY_BULLET.test(lines[i])) lastBulletIndex = i;
    for (const [key, value] of pending) {
      const match = lines[i].match(FIELD_PATTERNS[key]);
      if (match) {
        lines[i] = `${match[1]} ${value}`;
        pending.delete(key);
        break; // One field per line.
      }
    }
  }

  if (pending.size > 0) {
    if (lastBulletIndex === -1) return null;
    const inserts = [...pending].map(
      ([key, value]) => `${FIELD_BULLETS[key]} ${value}`,
    );
    lines.splice(lastBulletIndex + 1, 0, ...inserts);
  }

  return lines.join("\n");
}
