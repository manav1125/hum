/**
 * Work arrives as an artefact, not prose.
 *
 * "Never make someone copy text out of a chat bubble." Anything sendable,
 * savable or schedulable renders as a card with its verb on it — a drafted
 * email is a card with Send on it, a proposed meeting is a card with a time on
 * it. This module is the pure half: read the daemon's surface payload, work out
 * what the artefact is, and — the part that matters — work out whether its verb
 * is one that can never fire without a human approving it in the moment.
 *
 * SAFETY. The gated classes mirror `assistant/src/tools/outbound-send.ts`
 * exactly: send · contact · money · publish · delete · purchase. That file is
 * the enforcement; this is only the label. The card cannot execute anything
 * itself — its verb button posts a surface action, the daemon runs the tool,
 * and the tool hits the hard checkpoint. Nothing here may ever grow a code path
 * that performs the act locally.
 */

import type { Surface } from "@/domains/chat/types/types";
import {
  filterRecords,
  rec,
  str,
} from "@/domains/chat/components/surfaces/surface-parse-helpers";

/**
 * The consequence class of an artefact's verb. `safe` is everything that stays
 * inside Cue and can be undone; the rest reach outside or cannot be undone.
 */
export type VerbClass =
  "send" | "contact" | "money" | "publish" | "delete" | "purchase" | "safe";

/** Verb classes that ALWAYS require a fresh human approval. */
const GATED_CLASSES: ReadonlySet<VerbClass> = new Set([
  "send",
  "contact",
  "money",
  "publish",
  "delete",
  "purchase",
]);

const CLASS_PATTERNS: ReadonlyArray<[VerbClass, RegExp]> = [
  ["send", /\b(send|email|reply|forward|dm|message|text|post)\b/i],
  ["contact", /\b(call|dial|ring|phone)\b/i],
  ["money", /\b(pay|transfer|refund|charge|invoice|wire|trade)\b/i],
  ["publish", /\b(publish|deploy|go live|ship|release|share publicly)\b/i],
  ["delete", /\b(delete|remove|erase|wipe|purge)\b/i],
  ["purchase", /\b(buy|purchase|order|checkout|book|subscribe)\b/i],
];

/**
 * Classify a verb phrase ("Send", "Send to Dana", "Save draft").
 *
 * Deliberately permissive on the gated side: an unrecognised verb is `safe`,
 * but the enforcement gate downstream does not care what we called it — a
 * misclassification here changes the label on the button, never whether the
 * checkpoint fires.
 */
export function classifyVerb(verb: string): VerbClass {
  const text = verb.trim();
  if (!text) return "safe";
  // "Save a draft" / "Draft a reply" prepare something; they do not send it.
  if (
    /\b(draft|save|file|schedule|snooze|later|copy|preview|open)\b/i.test(
      text,
    ) &&
    !/\bsend\b/i.test(text)
  ) {
    return "safe";
  }
  for (const [cls, pattern] of CLASS_PATTERNS) {
    if (pattern.test(text)) return cls;
  }
  return "safe";
}

/** Whether this verb may never fire without a human approving it in the moment. */
export function isGatedVerb(verb: string): boolean {
  return GATED_CLASSES.has(classifyVerb(verb));
}

/** One labelled fact about the artefact — "To · dana@northwind.com". */
export interface ArtefactField {
  label: string;
  value: string;
}

export interface ArtefactAction {
  id: string;
  label: string;
  /** True when this action's verb is in the hard-checkpoint class. */
  gated: boolean;
  primary: boolean;
}

export interface Artefact {
  /** What kind of thing this is — "Email", "Meeting", "Document". */
  kind?: string;
  title: string;
  /** The artefact's own words, shown in full. Optional. */
  body?: string;
  fields: ArtefactField[];
  actions: ArtefactAction[];
  /** True when any action on the card is gated. */
  hasGatedAction: boolean;
}

function parseFields(value: unknown): ArtefactField[] {
  return filterRecords(value).flatMap((field) => {
    const label = str(field.label)?.trim();
    const fieldValue = str(field.value)?.trim();
    return label && fieldValue ? [{ label, value: fieldValue }] : [];
  });
}

/**
 * Read a `Surface` into an `Artefact`, or null when there is not enough to
 * render honestly. A card with no title and no body is nothing; render nothing.
 */
export function parseArtefact(surface: Surface): Artefact | null {
  const data = rec(surface.data) ?? {};
  const title = str(data.title)?.trim() || surface.title?.trim();
  const body = str(data.body)?.trim();
  if (!title && !body) return null;

  const actions: ArtefactAction[] = (surface.actions ?? []).flatMap(
    (action) => {
      const id = str(action.id)?.trim();
      const label = str(action.label)?.trim();
      if (!id || !label) return [];
      return [
        {
          id,
          label,
          gated: isGatedVerb(label),
          primary: action.style === "primary",
        },
      ];
    },
  );

  return {
    ...(str(data.kind)?.trim() ? { kind: str(data.kind)!.trim() } : {}),
    title: title ?? body!.slice(0, 80),
    ...(body ? { body } : {}),
    fields: parseFields(data.fields),
    actions,
    hasGatedAction: actions.some((a) => a.gated),
  };
}
