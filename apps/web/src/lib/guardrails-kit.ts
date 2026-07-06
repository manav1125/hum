/**
 * Guardrails shared kit — checkpoint-template metadata, scope helpers, and
 * the model-pin catalog.
 *
 * Shared by the Guardrails surface (`domains/guardrails`) and the approval
 * dialog's "Make this a rule" mini-sheet (`domains/chat`). Lives in `lib/`
 * so neither domain imports the other's internals (no-cross-domain-imports).
 *
 * Everything here mirrors the daemon's guardrails contract:
 *   - templates: send_message / spend_over / publish / delete / contact / custom
 *   - scope strings: 'everywhere' | 'agent:<agentId>' | 'mission:<missionId>'
 *   - model pin: a provider/model string on the agent (null = workspace default)
 *   - tool scopes: coarse skill/domain ids on the agent (null = unrestricted),
 *     enforced by the daemon on background work-item runs
 */

export type CheckpointTemplate =
  | "send_message"
  | "spend_over"
  | "publish"
  | "delete"
  | "contact"
  | "custom";

export const CHECKPOINT_TEMPLATES: ReadonlyArray<{
  template: CheckpointTemplate;
  /** Composer chip label (mock: "✉ Sending", "$ Spending", …). */
  chip: string;
  /** Row icon glyph. */
  glyph: string;
  /** Default rule name pre-filled into the composer. */
  defaultLabel: string;
}> = [
  {
    template: "send_message",
    chip: "Sending",
    glyph: "✉",
    defaultLabel: "Sending any email or message",
  },
  {
    template: "spend_over",
    chip: "Spending",
    glyph: "$",
    defaultLabel: "Spending over $10 in one action",
  },
  {
    template: "publish",
    chip: "Publishing",
    glyph: "◎",
    defaultLabel: "Posting or publishing publicly",
  },
  {
    template: "delete",
    chip: "Deleting",
    glyph: "✕",
    defaultLabel: "Deleting anything",
  },
  {
    template: "contact",
    chip: "Contacting",
    glyph: "☎",
    defaultLabel: "Contacting someone new",
  },
  {
    template: "custom",
    chip: "Custom pattern…",
    glyph: "⌘",
    defaultLabel: "",
  },
];

export function templateGlyph(template: string): string {
  return (
    CHECKPOINT_TEMPLATES.find((t) => t.template === template)?.glyph ?? "⌘"
  );
}

/**
 * Best-effort template inference from a live confirmation (SET 2 — "inferred
 * from this action"). The confirmation payload carries no autonomy class, so
 * we keyword-match the tool name + title; `custom` is the honest fallback.
 */
export function inferTemplateFromAction(
  toolName?: string,
  title?: string,
): CheckpointTemplate {
  const hay = `${toolName ?? ""} ${title ?? ""}`.toLowerCase();
  if (/(send|email|message|reply|sms|slack|telegram)/.test(hay))
    return "send_message";
  if (/(spend|pay|charge|purchase|order|checkout|transfer|refund)/.test(hay))
    return "spend_over";
  if (/(publish|post|tweet|deploy|share publicly|announce)/.test(hay))
    return "publish";
  if (/(delete|remove|drop|destroy|wipe|archive)/.test(hay)) return "delete";
  if (/(contact|call|reach out|outreach|invite)/.test(hay)) return "contact";
  return "custom";
}

/** A human rule name for an inferred checkpoint (editable in the sheet). */
export function inferredCheckpointLabel(
  template: CheckpointTemplate,
  title?: string,
): string {
  const preset = CHECKPOINT_TEMPLATES.find((t) => t.template === template);
  if (template === "custom") {
    return title ? `Doing this again: ${title}` : "Actions like this one";
  }
  return preset?.defaultLabel ?? "Actions like this one";
}

// ---------------------------------------------------------------------------
// Model pins — the visible "route by task/cost/policy" feature. Options and
// cost hints match the approved mock; the strings are what the daemon's
// background runs execute on (OpenRouter ids).
// ---------------------------------------------------------------------------

export const MODEL_PIN_BEST = "anthropic/claude-sonnet-4.5";
export const MODEL_PIN_FAST = "anthropic/claude-haiku-4.5";

export const MODEL_PIN_OPTIONS: ReadonlyArray<{
  id: "best" | "fast" | "custom";
  glyph: string;
  label: string;
  hint: string;
  model: string | null;
}> = [
  {
    id: "best",
    glyph: "◆",
    label: "Best · Sonnet 4.5",
    hint: "highest quality · ~4× cost",
    model: MODEL_PIN_BEST,
  },
  {
    id: "fast",
    glyph: "▸",
    label: "Fast · Haiku 4.5",
    hint: "most tasks · cheapest",
    model: MODEL_PIN_FAST,
  },
  {
    id: "custom",
    glyph: "⌘",
    label: "Custom…",
    hint: "route by task type",
    model: null,
  },
];

/** Compact display for the closed picker chip. */
export function modelPinDisplay(model: string | null): {
  glyph: string;
  label: string;
  pinned: boolean;
} {
  if (!model) {
    // No pin — background runs ride the workspace default profile.
    return { glyph: "◆", label: "Default · balanced", pinned: false };
  }
  const lower = model.toLowerCase();
  if (lower.includes("sonnet"))
    return { glyph: "◆", label: "Best · Sonnet 4.5", pinned: true };
  if (lower.includes("haiku"))
    return { glyph: "▸", label: "Fast · Haiku 4.5", pinned: true };
  // Custom pin — show the tail of the model id verbatim.
  const tail = model.split("/").pop() ?? model;
  return { glyph: "⌘", label: tail, pinned: true };
}

// ---------------------------------------------------------------------------
// Tool scopes — the daemon's known coarse skill/domain ids. An agent's
// `toolScopes` allowlist draws from this set; null = unrestricted. Enforced
// on background work-item runs (out-of-scope extension tools are dropped).
// ---------------------------------------------------------------------------

export const TOOL_SCOPE_IDS = [
  "email",
  "calendar",
  "research",
  "files",
  "code",
  "docs",
  "design",
  "outreach",
  "social",
  "ads",
] as const;

export type ToolScopeId = (typeof TOOL_SCOPE_IDS)[number];

/**
 * Normalize an edited scope selection for PATCH: everything on (or nothing
 * deselectable left) collapses to null = unrestricted, matching the daemon's
 * contract that null — not the full list — means "no restriction".
 */
export function normalizeToolScopeSelection(
  selected: ReadonlySet<string>,
): string[] | null {
  if (TOOL_SCOPE_IDS.every((id) => selected.has(id))) return null;
  return TOOL_SCOPE_IDS.filter((id) => selected.has(id));
}

// ---------------------------------------------------------------------------
// Formatting + scope helpers
// ---------------------------------------------------------------------------

/** Held-approval age: ms → "22 min" / "3 h" / "2 d" (mock's held-row meta). */
export function heldAgeLabel(ageMs: number): string {
  const min = Math.round(ageMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/**
 * Pull the daemon's structured conflict code out of a thrown SDK error.
 * `POST acts/:id/reverse` 409s with `{error:{details:{code}}}` when nothing
 * concrete can be undone — never a fake success.
 */
export function reverseConflictCode(
  error: unknown,
): "no_undo" | "already_reversed" | null {
  if (typeof error !== "object" || error === null) return null;
  const envelope = (error as { error?: unknown }).error;
  if (typeof envelope !== "object" || envelope === null) return null;
  const details = (envelope as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const code = (details as { code?: unknown }).code;
  return code === "no_undo" || code === "already_reversed" ? code : null;
}

/** $ formatting: cents → "$4.12" (whole dollars stay clean: "$20"). */
export function dollars(cents: number): string {
  const d = cents / 100;
  if (Number.isInteger(d)) return `$${d}`;
  return `$${d.toFixed(2)}`;
}

/**
 * Pull a "$25"/"$3.50" out of a spend rule's name so an enabled spend_over
 * checkpoint records the dollar line the user actually typed.
 */
export function parseThresholdCents(label: string): number | undefined {
  const m = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(label);
  if (!m) return undefined;
  const cents = Math.round(parseFloat(m[1]) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : undefined;
}

/** Scope string → display chip ("EVERYWHERE" / "✦ GROWTH ONLY" / "ONE MISSION"). */
export function scopeDisplay(
  scope: string,
  agents: ReadonlyArray<{ id: string; name: string; emoji?: string | null }>,
): { label: string; kind: "everywhere" | "agent" | "mission" } {
  if (scope.startsWith("agent:")) {
    const id = scope.slice("agent:".length);
    const agent = agents.find((a) => a.id === id || a.name === id);
    const glyph = agent ? agentGlyph(agent.name, agent.emoji) : "✦";
    return {
      label: `${glyph} ${(agent?.name ?? id).toUpperCase()} ONLY`,
      kind: "agent",
    };
  }
  if (scope.startsWith("mission:")) {
    return { label: "ONE MISSION", kind: "mission" };
  }
  return { label: "EVERYWHERE", kind: "everywhere" };
}

/**
 * Agent glyph — the mock's house set (Ops ⚙ / Builder ▲ / Growth ✦ / cue c),
 * with the registry emoji as the first choice when one is set.
 */
export function agentGlyph(
  name: string,
  emoji?: string | null,
): string {
  if (emoji) return emoji;
  const n = name.toLowerCase();
  if (n.includes("ops")) return "⚙";
  if (n.includes("build")) return "▲";
  if (n.includes("growth")) return "✦";
  if (n === "cue") return "c";
  return "◆";
}

/** Tier ('1'..'4') → the mock's descriptor line. */
export function tierDescriptor(tier: string): string {
  switch (tier) {
    case "1":
      return "observes & suggests";
    case "2":
      return "drafts, you approve";
    case "3":
      return "acts in budget";
    case "4":
      return "acts autonomously";
    default:
      return "drafts, you approve";
  }
}
