/**
 * What counts as a CONSEQUENTIAL action, and how to describe one in plain
 * words — the classifier behind the autonomy ledger.
 *
 * The membership test is deliberately NOT a second opinion: it delegates to
 * `requiresHumanApprovalForAction` — the same load-bearing predicate the
 * approval gate uses — so the ledger records exactly the class of action the
 * gate treats as a hard checkpoint, and a newly connected connector is covered
 * by both at once. The only addition is **host file mutations**, which the gate
 * excludes on purpose (they are governed by the host/file approval gate and
 * must not park background self-maintenance) but which the owner still deserves
 * to see: "Cue wrote to a file on my Mac" is a consequential act.
 *
 * Nothing here changes behaviour. This module only READS the predicate and
 * derives a label, a class, and a target for display.
 *
 * Target extraction is typed and shallow by design — a fixed list of
 * recipient/URL/path keys, never free text — so a message body can never be
 * mistaken for a recipient and nothing unbounded is copied into the ledger.
 */

import { classifyAutonomy } from "../permissions/autonomy-class.js";
import {
  extractProxiedActionSlugs,
  requiresHumanApprovalForAction,
} from "../tools/outbound-send.js";

/** The consequence bucket a ledger row is filed under. */
export type ConsequentialActionClass =
  | "send"
  | "contact"
  | "money"
  | "publish"
  | "delete"
  | "purchase"
  | "host_file"
  | "network_egress"
  | "browser_submit"
  | "schedule_script"
  | "external_runner"
  | "other";

export interface ConsequentialAction {
  actionClass: ConsequentialActionClass;
  /** Verb phrase in the neutral infinitive — "send an email", "delete a record". */
  phrase: string;
  /** Recipient / URL / host / path reached, when the input names one. */
  target: string | null;
}

/**
 * Host tools that MUTATE the owner's real machine. Excluded from the approval
 * gate's high-consequence park by design (see `outbound-send.ts`
 * INTERNAL_INFRA_TOOLS) — included here because the ledger's job is to show
 * the owner what was touched, not to decide what may run. Host *reads* and
 * sandbox file tools are out: the sandbox is Cue's own scratch space.
 */
const HOST_FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "host_file_write",
  "host_file_edit",
  "host_file_transfer",
]);

/** Bare tool name (drop any `mcp__<server>__` / `connector.` namespace). */
function bareName(name: string): string {
  return name.split(/__|\./).pop() ?? name;
}

const NETWORK_EGRESS_SHELL_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "host_bash",
  "terminal",
]);

/** Keys that name a *destination*, in priority order. Never free text. */
const RECIPIENT_KEYS = [
  "to",
  "recipient",
  "recipients",
  "to_email",
  "email",
  "to_address",
  "phone_number",
  "to_number",
  "channel",
  "channel_id",
  "chat_id",
  "conversation_id",
  "user_id",
  "thread_id",
] as const;

const LOCATION_KEYS = [
  "url",
  "endpoint",
  "host",
  "domain",
  "repo",
  "repository",
  "bucket",
] as const;

const PATH_KEYS = ["dest_path", "file_path", "path", "source_path"] as const;

const SUBJECT_KEYS = [
  "subject",
  "title",
  "name",
  "summary",
  "label",
] as const;

const MAX_FIELD = 120;

function truncate(value: string, max = MAX_FIELD): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Read a string-ish value at one of `keys`. Arrays of strings are joined
 * (recipient lists), objects are skipped — a destination is never a blob.
 */
function pick(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return truncate(value);
    if (Array.isArray(value)) {
      const parts = value.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
      if (parts.length > 0) return truncate(parts.join(", "));
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

/**
 * The nested payload a generic proxy/execute meta-tool carries the REAL call
 * in (`COMPOSIO_EXECUTE_TOOL({ tool_slug, arguments: {...} })`). One level
 * deep only, matching how `extractProxiedActionSlugs` reads the slug.
 */
function proxiedArguments(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  for (const key of ["arguments", "input", "params", "payload"]) {
    const value = input[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

/** First external host/URL a shell command reaches, when one is spellable. */
function shellEgressTarget(command: string): string | null {
  const url = command.match(/\bhttps?:\/\/[^\s'"`|;)]+/i);
  if (url) return truncate(url[0]);
  const hostish = command.match(
    /\b(?:scp|sftp|rsync|ssh)\s+[^\s]*?([\w.-]+@[\w.-]+|[\w-]+\.[\w.-]+)/i,
  );
  if (hostish) return truncate(hostish[1]);
  const mail = command.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return mail ? truncate(mail[0]) : null;
}

const CLASS_PHRASES: Record<ConsequentialActionClass, string> = {
  send: "send a message",
  contact: "place a call",
  money: "move money",
  publish: "publish something",
  delete: "delete something",
  purchase: "make a purchase",
  host_file: "change a file on your computer",
  network_egress: "reach the network from a shell",
  browser_submit: "click a send/submit control in a browser",
  schedule_script: "install a script-mode schedule",
  external_runner: "run third-party code",
  other: "take a consequential action",
};

/**
 * Map the tool (and any connector action slug it carries) onto a ledger
 * class. Mirrors the shape of the gate's own checks so a row's class always
 * explains why the gate cared.
 */
function resolveClass(
  name: string,
  input: Record<string, unknown>,
): ConsequentialActionClass {
  const bare = bareName(name);

  if (HOST_FILE_MUTATION_TOOLS.has(bare)) return "host_file";

  if (NETWORK_EGRESS_SHELL_TOOLS.has(bare)) return "network_egress";

  if (
    /^browser_(click|fill|drag|type|press_key)$/.test(bare) ||
    bare.startsWith("computer_use_") ||
    bare.startsWith("host_cu")
  ) {
    return "browser_submit";
  }

  if (bare === "schedule_create" || bare === "schedule_update") {
    return "schedule_script";
  }

  if (bare === "apify_run_actor") return "external_runner";

  // Purchase reads lexically (classifyAutonomy has no "purchase" bucket, but
  // outbound-send's HIGH_CONSEQUENCE_CLASSES names one, so honour the intent).
  const lower = name.toLowerCase();
  if (/\b(buy|purchase|checkout|place[_.-]?order)\b/.test(lower)) {
    return "purchase";
  }

  const own = classifyAutonomy(name, input);
  if (
    own === "send" ||
    own === "contact" ||
    own === "money" ||
    own === "publish" ||
    own === "delete"
  ) {
    return own;
  }

  // Proxy/execute meta-tools: the real action lives in the input slug.
  for (const slug of extractProxiedActionSlugs(input)) {
    const slugClass = classifyAutonomy(slug, {});
    if (
      slugClass === "send" ||
      slugClass === "contact" ||
      slugClass === "money" ||
      slugClass === "publish" ||
      slugClass === "delete"
    ) {
      return slugClass;
    }
  }

  return "other";
}

/** The destination the action reaches, when the input names one. */
function resolveTarget(
  actionClass: ConsequentialActionClass,
  name: string,
  input: Record<string, unknown>,
): string | null {
  if (actionClass === "network_egress") {
    const command =
      typeof input.command === "string"
        ? input.command
        : typeof input.script === "string"
          ? input.script
          : "";
    return shellEgressTarget(command);
  }

  if (actionClass === "host_file") {
    const bare = bareName(name);
    if (bare === "host_file_transfer") {
      const direction =
        typeof input.direction === "string" ? input.direction : "";
      return direction === "to_sandbox"
        ? pick(input, ["source_path"])
        : pick(input, ["dest_path"]);
    }
    return pick(input, PATH_KEYS);
  }

  if (actionClass === "browser_submit") {
    return pick(input, ["url", "selector", "element", "label", "aria_label"]);
  }

  if (actionClass === "external_runner") {
    return pick(input, ["actor_id", "actor"]);
  }

  const nested = proxiedArguments(input);
  const scopes = nested ? [input, nested] : [input];
  for (const scope of scopes) {
    const recipient = pick(scope, RECIPIENT_KEYS);
    if (recipient) return recipient;
  }
  for (const scope of scopes) {
    const location = pick(scope, LOCATION_KEYS);
    if (location) return location;
  }
  for (const scope of scopes) {
    const path = pick(scope, PATH_KEYS);
    if (path) return path;
  }
  return null;
}

/** A short "about what" hint (an email subject, a record title). */
function resolveSubject(input: Record<string, unknown>): string | null {
  const nested = proxiedArguments(input);
  return pick(input, SUBJECT_KEYS) ?? (nested ? pick(nested, SUBJECT_KEYS) : null);
}

/**
 * Classify one tool invocation for the ledger, or return null when it is not
 * consequential (the overwhelmingly common case — reads, drafts, internal
 * bookkeeping — which the ledger must stay silent about).
 *
 * Never throws: a malformed input yields `null` rather than an exception, so
 * the executor's ledger hook can never surface an error into the tool path.
 */
export function classifyConsequentialAction(
  name: string,
  input: Record<string, unknown>,
): ConsequentialAction | null {
  try {
    const gated = requiresHumanApprovalForAction(name, input);
    const hostMutation = HOST_FILE_MUTATION_TOOLS.has(bareName(name));
    if (!gated && !hostMutation) return null;

    const actionClass = resolveClass(name, input);
    const target = resolveTarget(actionClass, name, input);
    const subject = resolveSubject(input);

    let phrase = CLASS_PHRASES[actionClass];
    if (actionClass === "send" && /mail/i.test(name)) {
      phrase = "send an email";
    }
    if (subject && (actionClass === "send" || actionClass === "publish")) {
      phrase = `${phrase} — “${truncate(subject, 60)}”`;
    }

    return { actionClass, phrase, target };
  } catch {
    // Classification is observation-only; a failure means "no ledger row",
    // never a failed tool call.
    return null;
  }
}

/** Outcome of a consequential attempt, as recorded. */
export type LedgerOutcome = "executed" | "parked" | "denied" | "failed";

/**
 * Classes whose target is a *thing acted on* rather than a *destination sent
 * to* — "changed a file — /etc/hosts" reads correctly where "changed a file to
 * /etc/hosts" does not.
 */
const NON_DESTINATION_CLASSES: ReadonlySet<ConsequentialActionClass> = new Set([
  "host_file",
  "browser_submit",
  "external_runner",
  "schedule_script",
  "delete",
]);

/**
 * The one human sentence stored on the row. Combines outcome + phrase +
 * target + whether anyone was watching, so a bare `SELECT summary` already
 * answers "what did Cue do on my behalf while I wasn't watching?".
 */
export function describeLedgerEntry(opts: {
  action: ConsequentialAction;
  outcome: LedgerOutcome;
  attended: boolean;
}): string {
  const { action, outcome, attended } = opts;
  const where = !action.target
    ? ""
    : NON_DESTINATION_CLASSES.has(action.actionClass)
      ? ` — ${action.target}`
      : ` to ${action.target}`;
  const watch = attended ? "you were here" : "unattended";

  switch (outcome) {
    case "executed":
      return `Cue ${pastTense(action.phrase)}${where} (${watch}).`;
    case "parked":
      return `Cue parked a request to ${action.phrase}${where} — it needs your approval (${watch}).`;
    case "denied":
      return `Cue was blocked from ${gerund(action.phrase)}${where} (${watch}).`;
    case "failed":
      return `Cue tried to ${action.phrase}${where} and it failed (${watch}).`;
  }
}

/**
 * Crude but deterministic past tense for the fixed CLASS_PHRASES verbs. Only
 * the leading verb is inflected; the rest of the phrase is left alone.
 */
function pastTense(phrase: string): string {
  const [verb, ...rest] = phrase.split(" ");
  const map: Record<string, string> = {
    send: "sent",
    place: "placed",
    move: "moved",
    publish: "published",
    delete: "deleted",
    make: "made",
    change: "changed",
    reach: "reached",
    click: "clicked",
    install: "installed",
    run: "ran",
    take: "took",
  };
  return [map[verb] ?? `${verb}ed`, ...rest].join(" ");
}

/** Matching -ing form, for the "was blocked from …" phrasing. */
function gerund(phrase: string): string {
  const [verb, ...rest] = phrase.split(" ");
  const map: Record<string, string> = {
    send: "sending",
    place: "placing",
    move: "moving",
    publish: "publishing",
    delete: "deleting",
    make: "making",
    change: "changing",
    reach: "reaching",
    click: "clicking",
    install: "installing",
    run: "running",
    take: "taking",
  };
  return [map[verb] ?? `${verb}ing`, ...rest].join(" ");
}

/** Exposed for tests and for callers that need the host-mutation set. */
export const HOST_FILE_MUTATION_TOOL_NAMES = HOST_FILE_MUTATION_TOOLS;
