/**
 * Execution-layer send/submit control guard.
 *
 * The pre-execution hard checkpoint (`requiresHumanApprovalForAction` in
 * `../outbound-send.ts`, enforced at the top of
 * `ToolApprovalHandler.checkPreExecutionGates`) classifies a tool call from its
 * NAME and INPUT. That is enough for connector sends and for a labeled DOM
 * selector, but it is structurally blind to three UI-driven send paths:
 *
 *   · a coordinate-only click (`x`/`y`, no label anywhere in the input)
 *   · a click by opaque handle (`element_id: "e14"` / `[17]` — the id has no
 *     meaning outside the snapshot that produced it)
 *   · a keyboard send (⌘/Ctrl+Enter, or Enter in an Enter-sends composer)
 *
 * In all three the agent can drive a real UI into sending an email or a DM with
 * the gate seeing nothing but "a click happened". This module closes that at
 * the layer where the target IS known — after the element has been resolved to
 * a DOM node / accessibility row, before the input event is dispatched.
 *
 * ── Design constraints ────────────────────────────────────────────────────
 *
 * 1. **One keyword set.** {@link BROWSER_SUBMIT_KEYWORDS} is imported from
 *    `outbound-send.ts`, never re-spelled here. A second copy would drift and
 *    silently change what "a send control" means depending on which layer
 *    caught it.
 *
 * 2. **Same enforcement mechanisms as the pre-execution gate.** Unattended runs
 *    park the action as a needs-you work item via `parkExternalSendForConversation`
 *    and never dispatch; attended runs are routed back through the pre-execution
 *    gate rather than being blocked forever (see {@link gateResolvedSendControl}).
 *
 * 3. **Precision over recall.** Navigation, reading, scrolling, typing, and
 *    ordinary link/button clicks must stay completely free — a false positive
 *    here makes the browser useless. Every predicate below fails OPEN when the
 *    target cannot be resolved, and only fires on a short, control-shaped
 *    accessible name.
 */

import {
  BROWSER_SUBMIT_KEYWORDS,
  requiresHumanApprovalForAction,
} from "../outbound-send.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

// ── Resolved-target description ───────────────────────────────────────

/**
 * What the execution layer managed to learn about the thing it is about to
 * click / send a key to. Produced from CDP for browser tools and from the
 * cached macOS accessibility snapshot for computer-use tools, so the two
 * backends share one predicate.
 *
 * Everything is optional: an unresolvable target yields `null` and the guard
 * fails open.
 */
export interface ResolvedControl {
  /** Lowercased tag/role name of the resolved node, e.g. `button`, `text area`. */
  tag?: string;
  /**
   * Short accessible-name candidates: aria-label, title, alt, value, name,
   * data-testid/data-qa, AX title. Long strings are ignored by the predicate.
   */
  labels?: string[];
  /** Visible text of the control, whitespace-collapsed. */
  text?: string;
  /** True when the node is an activatable control (button-ish), not a link or a div. */
  isControl?: boolean;
  /** True when the node accepts typed text (input / textarea / contenteditable). */
  isTextEntry?: boolean;
  /** True when the text entry accepts newlines (textarea / contenteditable). */
  isMultiline?: boolean;
  /** True when the text entry is a search box (never treated as a composer). */
  isSearch?: boolean;
  /** True when the control is disabled / aria-disabled. */
  isDisabled?: boolean;
}

/**
 * A button label is short. Anything longer is prose — a paragraph that happens
 * to contain the word "send", a table row, an entire email body — and matching
 * keywords against it is how a guard like this starts blocking normal browsing.
 */
const MAX_CONTROL_NAME_LENGTH = 64;

function nameCandidates(control: ResolvedControl): string[] {
  const out: string[] = [];
  for (const label of control.labels ?? []) {
    if (typeof label === "string") out.push(label);
  }
  if (typeof control.text === "string") out.push(control.text);
  return out;
}

/**
 * True when the resolved target is a send / submit / pay control.
 *
 * Deliberately narrow:
 *   · only activatable controls (`isControl`) — a link or a plain div is not a
 *     send control even if its text says "Send feedback"
 *   · only short names — see {@link MAX_CONTROL_NAME_LENGTH}
 *   · disabled controls can't act, so they never gate
 */
export function isSendControl(control: ResolvedControl | null): boolean {
  if (!control || !control.isControl || control.isDisabled) return false;
  for (const candidate of nameCandidates(control)) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > MAX_CONTROL_NAME_LENGTH) continue;
    if (BROWSER_SUBMIT_KEYWORDS.test(trimmed)) return true;
  }
  return false;
}

/** The human-facing name of a resolved control, for the block message. */
export function describeControl(control: ResolvedControl | null): string {
  if (!control) return "the target element";
  for (const candidate of nameCandidates(control)) {
    const trimmed = candidate.trim();
    if (trimmed && trimmed.length <= MAX_CONTROL_NAME_LENGTH) return trimmed;
  }
  return control.tag ?? "the target element";
}

// ── Keyboard sends ────────────────────────────────────────────────────

export interface KeyChord {
  enter: boolean;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

const ENTER_KEY_NAMES = new Set(["enter", "return", "numpadenter", "keyenter"]);

/**
 * Parse the key string every backend uses (`"Enter"`, `"cmd+enter"`,
 * `"Control+Enter"`, `"Meta+Return"`, …) into modifier flags.
 */
export function parseKeyChord(key: string): KeyChord {
  const parts = String(key ?? "")
    .toLowerCase()
    .split(/[+\-\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chord: KeyChord = {
    enter: false,
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
  };
  for (const part of parts) {
    if (ENTER_KEY_NAMES.has(part)) chord.enter = true;
    else if (part === "cmd" || part === "meta" || part === "command") {
      chord.meta = true;
    } else if (part === "ctrl" || part === "control") chord.ctrl = true;
    else if (part === "shift") chord.shift = true;
    else if (part === "alt" || part === "option" || part === "opt") {
      chord.alt = true;
    }
  }
  return chord;
}

/**
 * Hosts whose message composer sends on a bare Enter. Kept to messaging
 * surfaces where the ONLY multi-line composer is the message box, so "Enter in
 * a multi-line composer" is not a heuristic there — it is the documented
 * behaviour of the app. Shift+Enter (the newline key on all of them) is never
 * gated, so the escape hatch for legitimate multi-line typing is the key the
 * user would press anyway.
 *
 * Mail and social-posting hosts are deliberately ABSENT: in Gmail, Outlook, X,
 * and LinkedIn a bare Enter inserts a newline, so gating it there would block
 * ordinary typing. Their send key is ⌘/Ctrl+Enter, which is covered separately.
 */
const ENTER_SENDS_HOSTS: readonly string[] = [
  "slack.com",
  "discord.com",
  "whatsapp.com",
  "telegram.org",
  "messenger.com",
  "teams.microsoft.com",
  "teams.live.com",
  "chat.google.com",
  "instagram.com",
];

function hostSendsOnEnter(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase().replace(/^www\./, "");
  return ENTER_SENDS_HOSTS.some(
    (h) => normalized === h || normalized.endsWith(`.${h}`),
  );
}

/**
 * Decide whether a keypress about to be dispatched is a send.
 *
 * `focus` is what currently has focus (or the element the key is targeted at);
 * `host` is the page hostname when known. An unresolved focus never gates —
 * blind gating of Enter would break every search box and login form.
 *
 * Rules, in precision order:
 *   · Shift+Enter is a newline everywhere → never a send.
 *   · ⌘/Ctrl+Enter inside a text entry → send. This is the send chord in Gmail,
 *     Outlook Web, Slack, LinkedIn, X, Jira, GitHub and most webmail; it has
 *     essentially no benign meaning while typing into a message field.
 *   · Enter while a send-labeled BUTTON has focus → send (Enter activates it,
 *     which is the same act as clicking it).
 *   · Enter in a multi-line composer on an {@link ENTER_SENDS_HOSTS} host → send.
 *   · Everything else (Enter in a search box, a login form, a URL field, a
 *     Gmail compose body, an unknown target) → free.
 */
export function classifyKeySend(
  key: string,
  focus: ResolvedControl | null,
  host?: string,
): "send" | "free" {
  const chord = parseKeyChord(key);
  if (!chord.enter) return "free";
  if (chord.shift) return "free";

  if (chord.meta || chord.ctrl) {
    return focus?.isTextEntry ? "send" : "free";
  }

  // Bare Enter.
  if (isSendControl(focus)) return "send";
  if (
    focus?.isTextEntry &&
    focus.isMultiline &&
    !focus.isSearch &&
    hostSendsOnEnter(host)
  ) {
    return "send";
  }
  return "free";
}

// ── Enforcement ───────────────────────────────────────────────────────

export interface SendGateDecision {
  /** True when the caller must NOT dispatch the action. */
  blocked: boolean;
  /** The tool result to return when blocked. */
  result?: ToolExecutionResult;
}

const ALLOWED: SendGateDecision = { blocked: false };

/**
 * Enforce the high-consequence checkpoint for an action whose send-ness was
 * only discovered at execution time.
 *
 * The three outcomes mirror the pre-execution gate exactly:
 *
 * 1. **The pre-execution gate already saw this call**
 *    (`requiresHumanApprovalForAction(name, input)` is true, e.g. the input
 *    carries `label: "Send"`). Attended, that means the human was shown an
 *    un-auto-approvable confirmation prompt and approved it — otherwise
 *    execution would never have been reached. Allow.
 *
 * 2. **Unattended run** (`context.isInteractive === false`): park as a needs-you
 *    work item and never dispatch — identical to the pre-execution gate's
 *    unattended branch.
 *
 * 3. **Attended run the gate did not see**: block this attempt and tell the
 *    model to re-issue the identical call with `label: "<resolved name>"`.
 *    That input IS visible to `requiresHumanApprovalForAction`, so the retry
 *    goes through the normal forced-approval prompt and case 1 lets it
 *    through once the human says yes. This is why the execution layer does not
 *    need its own approval channel: it converts an opaque action into a
 *    gate-visible one and lets the prod-verified gate decide.
 *
 * Note that the label the model supplies is never trusted as evidence: this
 * guard re-resolves the real target every time, so a call re-issued with a
 * misleading `label: "Cancel"` is simply blocked again here.
 */
export function gateResolvedSendControl(params: {
  toolName: string;
  input: Record<string, unknown>;
  context: ToolContext;
  /** Resolved, human-readable name of the control (or the send chord). */
  controlLabel: string;
  /** How the agent addressed the target, e.g. `element_id "e14"` or `(431, 56)`. */
  targetDescription: string;
  /** Set for keyboard sends so the message says "press" rather than "click". */
  kind?: "click" | "key";
}): SendGateDecision {
  const { toolName, input, context, controlLabel, targetDescription } = params;
  const kind = params.kind ?? "click";
  const unattended = context.isInteractive === false;

  if (requiresHumanApprovalForAction(toolName, input) && !unattended) {
    // The pre-execution checkpoint already forced a fresh human approval for
    // this exact invocation. Honour it.
    return ALLOWED;
  }

  const act =
    kind === "key"
      ? `Sending "${controlLabel}" to ${targetDescription}`
      : `Clicking ${targetDescription}`;

  // The label we tell the model to re-issue with MUST itself trip
  // `requiresHumanApprovalForAction`, or the retry sails past the gate and this
  // guard blocks it again forever. A key chord ("cmd+enter") does not match the
  // keyword set, so it gets wrapped.
  const approvalLabel = BROWSER_SUBMIT_KEYWORDS.test(controlLabel)
    ? controlLabel
    : `Send (${controlLabel})`;

  if (unattended) {
    void import("../../work-items/work-item-approval-timeouts.js")
      .then((m) =>
        m.parkExternalSendForConversation(context.conversationId, toolName),
      )
      .catch(() => {});
    const reason =
      `Parked "${toolName}": ${act} activates a send/submit control ` +
      `(“${controlLabel}”). That reaches outside or can't be undone, so it ` +
      `needs a human and can't run unattended. I've saved it as a needs-you ` +
      `item — approve and re-run to do it. (Navigating, reading, and drafting ` +
      `in the page are unaffected; only the send itself waits.)`;
    return { blocked: true, result: { content: reason, isError: true } };
  }

  const reason =
    `Blocked "${toolName}": ${act} activates a send/submit control ` +
    `(“${controlLabel}”), and the way you addressed it (${targetDescription}) ` +
    `carries no label, so the human-approval gate could not see what this ` +
    `does. Nothing was dispatched.\n` +
    `To proceed, re-issue the exact same call with \`label: "${approvalLabel}"\` ` +
    `added — that routes it through the approval gate and the user gets a ` +
    `confirmation prompt. Retrying without the label will be blocked again.`;
  return { blocked: true, result: { content: reason, isError: true } };
}
