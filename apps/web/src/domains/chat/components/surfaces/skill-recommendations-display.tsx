/**
 * `skill_recommendations` card template — the visual answer to "what can you
 * do for me?".
 *
 * The model composes the rows (real skills, strongest first, one Try-me
 * prompt each — see the `ui_show` tool description in
 * `assistant/src/tools/ui-surface/definitions.ts`); this renderer only
 * displays them. There is deliberately NO client-side skill catalog here: a
 * hardcoded mock would drift from the bundled skills the daemon actually
 * ships.
 *
 * Interaction: collapsed rows show icon + title + one-liner + chevron; a tap
 * expands the detail (description, requirement pills, capability bullets)
 * with a primary "Let's do it" button that submits the row's `prompt`
 * through the composer as a real, user-visible message (same path as the
 * conversation-starter chips — see `surface-prompt-submit.ts`).
 *
 * The data shape is React-free on purpose, modeled on upstream's
 * thread-suggestion types (clients/web/src/domains/chat/suggestions/types.ts
 * on upstream/main): rows carry a string `iconKey` resolved to a lucide
 * component here, never a component reference.
 */
import { useState, type ReactNode } from "react";
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FileText,
  GitPullRequest,
  Globe,
  Inbox,
  Mail,
  MessageSquare,
  Plug,
  Search,
  Sparkles,
  Sun,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@vellumai/design-library";
import { submitPromptFromSurface } from "@/domains/chat/components/surfaces/surface-prompt-submit";

// ---------------------------------------------------------------------------
// Data shape (React-free) + parsing
// ---------------------------------------------------------------------------

export interface SkillRequirement {
  label: string;
  /** "ready" = already satisfied; "connect" = needs setup/connection. */
  status: "ready" | "connect";
  hint?: string;
}

export interface SkillRecommendationRow {
  id: string;
  title: string;
  /** Stable key resolved to a lucide icon below; unknown keys → sparkles. */
  iconKey: string;
  description: string;
  /** Prompt submitted as a user message when "Let's do it" is pressed. */
  prompt: string;
  capabilities: string[];
  requirements: SkillRequirement[];
}

export interface SkillRecommendationsData {
  intro?: string;
  skills: SkillRecommendationRow[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRequirement(value: unknown): SkillRequirement | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const label = asString(rec.label);
  if (!label) return null;
  return {
    label,
    status: rec.status === "ready" ? "ready" : "connect",
    hint: asString(rec.hint),
  };
}

function parseRow(value: unknown, index: number): SkillRecommendationRow | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const title = asString(rec.title);
  const prompt = asString(rec.prompt);
  // A row without a title or a Try-me prompt cannot do its job; drop it
  // rather than rendering a dead card.
  if (!title || !prompt) return null;
  return {
    id: asString(rec.id) ?? `skill-${index}`,
    title,
    iconKey: asString(rec.iconKey) ?? "sparkles",
    description: asString(rec.description) ?? "",
    prompt,
    capabilities: Array.isArray(rec.capabilities)
      ? rec.capabilities.filter((c): c is string => typeof c === "string")
      : [],
    requirements: Array.isArray(rec.requirements)
      ? rec.requirements
          .map(parseRequirement)
          .filter((r): r is SkillRequirement => r !== null)
      : [],
  };
}

/**
 * Never-throw parse: malformed template data returns `null` and the card
 * degrades to its plain prose body (same contract as the weather template).
 */
export function parseSkillRecommendations(
  templateData: Record<string, unknown>,
): SkillRecommendationsData | null {
  const rawSkills = templateData.skills;
  if (!Array.isArray(rawSkills)) return null;
  const skills = rawSkills
    .map((row, i) => parseRow(row, i))
    .filter((row): row is SkillRecommendationRow => row !== null);
  if (skills.length === 0) return null;
  return { intro: asString(templateData.intro), skills };
}

// ---------------------------------------------------------------------------
// Icon resolution
// ---------------------------------------------------------------------------

/** iconKey → lucide component. Unknown keys fall back to Sparkles. */
const SKILL_ICON: Record<string, LucideIcon> = {
  inbox: Inbox,
  sun: Sun,
  // lucide-react dropped its brand icons (no Github export in this
  // version); a pull-request glyph is the closest neutral stand-in.
  github: GitPullRequest,
  search: Search,
  calendar: Calendar,
  mail: Mail,
  globe: Globe,
  "file-text": FileText,
  "message-square": MessageSquare,
  sparkles: Sparkles,
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RequirementPill({ requirement }: { requirement: SkillRequirement }) {
  const ready = requirement.status === "ready";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-body-small-default ${
        ready
          ? "text-[var(--system-positive-strong)]"
          : "text-[var(--system-mid-strong)]"
      }`}
      style={{
        backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)",
      }}
      title={requirement.hint}
    >
      {ready ? (
        <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : (
        <Plug className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      {requirement.label}
    </span>
  );
}

function SkillDetail({ row }: { row: SkillRecommendationRow }) {
  return (
    <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
      {row.description && (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {row.description}
        </p>
      )}

      {row.requirements.length > 0 && (
        <div className="mt-3">
          <div className="text-body-small-default text-[var(--content-quiet)]">
            Here&apos;s what we&apos;ll need
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {row.requirements.map((req) => (
              <RequirementPill key={req.label} requirement={req} />
            ))}
          </div>
        </div>
      )}

      {row.capabilities.length > 0 && (
        <div className="mt-3">
          <div className="text-body-small-default text-[var(--content-quiet)]">
            Things we can do
          </div>
          <ul className="mt-1.5 space-y-1">
            {row.capabilities.map((cap) => (
              <li
                key={cap}
                className="flex items-start gap-2 text-body-medium-lighter text-[var(--content-tertiary)]"
              >
                <span
                  aria-hidden
                  className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--content-quiet)]"
                />
                {cap}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <Button
          variant="primary"
          onClick={() => submitPromptFromSurface(row.prompt)}
        >
          Let&apos;s do it
        </Button>
      </div>
    </div>
  );
}

function SkillRow({
  row,
  expanded,
  onToggle,
}: {
  row: SkillRecommendationRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Direct map lookup (not a function call) so react-hooks/static-components
  // can see the element type is a static import, same as CHANNEL_GLYPH usage.
  const Icon = SKILL_ICON[row.iconKey] ?? Sparkles;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 text-left"
      >
        {/* TODO(design): placeholder icon chip — needs the real per-skill
            brand treatment (colored tile like the connectors grid). */}
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--tag-bg-neutral)] text-[var(--content-strong)]">
          <Icon className="h-4.5 w-4.5" size={18} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-medium-default text-[var(--content-strong)]">
            {row.title}
          </span>
          {row.description && (
            <span className="block truncate text-body-small-default text-[var(--content-quiet)]">
              {row.description}
            </span>
          )}
        </span>
        <Chevron
          className="h-4 w-4 shrink-0 text-[var(--content-quiet)]"
          aria-hidden
        />
      </button>
      {expanded && <SkillDetail row={row} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SkillRecommendationsDisplay({
  templateData,
  fallback,
}: {
  templateData: Record<string, unknown>;
  fallback: ReactNode;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const data = parseSkillRecommendations(templateData);
  if (!data) return <>{fallback}</>;

  return (
    <div className="mt-2">
      {data.intro && (
        <p className="mb-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          {data.intro}
        </p>
      )}
      {/* TODO(design): single-column stack for now; revisit a 2-up grid on
          wide viewports once design weighs in. */}
      <div className="flex flex-col gap-2">
        {data.skills.map((row) => (
          <SkillRow
            key={row.id}
            row={row}
            expanded={expandedId === row.id}
            onToggle={() =>
              setExpandedId((current) => (current === row.id ? null : row.id))
            }
          />
        ))}
      </div>
    </div>
  );
}
