/**
 * Execution-layer send/submit guard for computer-use (macOS) actions.
 *
 * Computer-use tools are proxy tools: the daemon forwards `{x, y}` or
 * `{element_id}` to the connected macOS client, which resolves the target and
 * clicks it. Nothing in the tool INPUT says what is being clicked, so the
 * pre-execution checkpoint (`requiresHumanApprovalForAction`) sees only
 * "a click at 431,56" — an agent can drive Mail or Slack into sending with the
 * gate seeing nothing.
 *
 * The label does exist, though: every computer-use response carries the current
 * accessibility snapshot, one line per interactive element:
 *
 *     [12] button "Send" at (431, 56) FOCUSED value: "…"
 *
 * That is the screen state AFTER the previous action, i.e. exactly the state
 * the next action will hit. This module caches the parsed snapshot per
 * conversation and resolves the next click / keypress against it, so the same
 * {@link gateResolvedSendControl} checkpoint the browser layer uses can fire.
 *
 * Failure modes are all fail-OPEN by design: no snapshot, an unparsed line, a
 * coordinate that matches nothing, or a stale cache means "unknown target", and
 * unknown never blocks. This guard adds gating on top of today's behaviour; it
 * must not be able to take normal computer use away.
 */

import {
  describeControl,
  gateResolvedSendControl,
  isSendControl,
  parseKeyChord,
  type ResolvedControl,
} from "../browser/send-control-guard.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

// ── Snapshot parsing ──────────────────────────────────────────────────

/** One interactive row of the macOS accessibility snapshot. */
export interface AxElement {
  id: number;
  /** Cleaned role, e.g. `button`, `text field`, `text area`, `menu item`. */
  role: string;
  title?: string;
  value?: string;
  placeholder?: string;
  /** Centre point in screen coordinates — what a coordinate click aims at. */
  x: number;
  y: number;
  focused: boolean;
  disabled: boolean;
}

/**
 * `[12] button "Send" at (431, 56) FOCUSED value: "…"`
 *
 * The head is greedy so a title containing ` at (…)` (unescaped by the client)
 * still binds the LAST coordinate pair, which is the real one.
 */
const AX_LINE = /^\s*\[(\d+)\]\s+(.*)\s+at \((-?\d+),\s*(-?\d+)\)\s*(.*)$/;
const AX_HEAD = /^([a-z][a-z ]*?)(?:\s+"([\s\S]*)")?$/;

/** Only the focused window's tree is actionable; other windows are context. */
const AX_TREE_BLOCK = /<ax-tree>([\s\S]*?)<\/ax-tree>/;

function extractQuoted(tail: string, key: string): string | undefined {
  const m = new RegExp(`${key}: "([\\s\\S]*?)"(?:\\s|$)`).exec(tail);
  return m?.[1];
}

/**
 * Parse the `<ax-tree>` block of a computer-use tool result into interactive
 * rows. Lines that do not match the expected shape are skipped silently — a
 * client-side format change must degrade to "no coverage", never to a throw.
 */
export function parseAxSnapshot(content: string): AxElement[] {
  if (typeof content !== "string") return [];
  const block = AX_TREE_BLOCK.exec(content);
  if (!block) return [];
  const out: AxElement[] = [];
  for (const line of block[1]!.split("\n")) {
    const m = AX_LINE.exec(line);
    if (!m) continue;
    const head = AX_HEAD.exec(m[2]!.trim());
    if (!head) continue;
    const tail = m[5] ?? "";
    out.push({
      id: Number(m[1]),
      role: head[1]!.trim(),
      title: head[2]?.trim() || undefined,
      x: Number(m[3]),
      y: Number(m[4]),
      focused: /(^|\s)FOCUSED(\s|$)/.test(tail),
      disabled: /(^|\s)disabled(\s|$)/.test(tail),
      value: extractQuoted(tail, "value"),
      placeholder: extractQuoted(tail, "placeholder"),
    });
  }
  return out;
}

const CONTROL_ROLE = /\bbutton\b/;
const TEXT_ENTRY_ROLES = new Set([
  "text field",
  "text area",
  "combo box",
  "search field",
  "secure text field",
]);

/** Project an accessibility row onto the shared {@link ResolvedControl} shape. */
export function axElementToControl(el: AxElement): ResolvedControl {
  const isSearch =
    el.role === "search field" ||
    /\bsearch\b/i.test(`${el.title ?? ""} ${el.placeholder ?? ""}`);
  return {
    tag: el.role,
    // `value` is user content on a text field, so it is only a name candidate
    // for controls (where the client puts the button's own title there).
    labels: [
      el.title,
      CONTROL_ROLE.test(el.role) ? el.value : undefined,
    ].filter((v): v is string => typeof v === "string" && v.length > 0),
    isControl: CONTROL_ROLE.test(el.role) || el.role === "menu item",
    isTextEntry: TEXT_ENTRY_ROLES.has(el.role),
    isMultiline: el.role === "text area",
    isSearch,
    isDisabled: el.disabled,
  };
}

// ── Per-conversation snapshot cache ───────────────────────────────────

interface CachedSnapshot {
  elements: AxElement[];
  at: number;
}

/**
 * A snapshot older than this is not trusted for gating. In practice the cache
 * is refreshed by every computer-use call, so it is seconds old; the bound only
 * matters when a session is resumed long after it stalled, where a stale label
 * would be worse than no label.
 */
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000;
const MAX_TRACKED_CONVERSATIONS = 32;

const snapshots = new Map<string, CachedSnapshot>();

/** Record the accessibility snapshot carried by a computer-use tool result. */
export function recordAxSnapshot(
  conversationId: string,
  resultContent: string,
): void {
  const elements = parseAxSnapshot(resultContent);
  if (elements.length === 0) return;
  if (
    !snapshots.has(conversationId) &&
    snapshots.size >= MAX_TRACKED_CONVERSATIONS
  ) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
  snapshots.set(conversationId, { elements, at: Date.now() });
}

/** Test seam: forget everything cached for a conversation. */
export function clearAxSnapshot(conversationId?: string): void {
  if (conversationId === undefined) snapshots.clear();
  else snapshots.delete(conversationId);
}

function currentElements(conversationId: string): AxElement[] {
  const cached = snapshots.get(conversationId);
  if (!cached) return [];
  if (Date.now() - cached.at > MAX_SNAPSHOT_AGE_MS) return [];
  return cached.elements;
}

/**
 * How far (Chebyshev, in points) a coordinate click may sit from an element's
 * reported centre and still be considered that element. Coordinate clicks are
 * produced by copying the `at (x, y)` centre out of the snapshot, so the useful
 * radius is tiny; a wide radius would start claiming neighbouring controls.
 */
const COORD_MATCH_TOLERANCE_PT = 12;

/**
 * Resolve what a computer-use click is aimed at: an exact `element_id` match,
 * or the nearest snapshot element to an `x`/`y` within
 * {@link COORD_MATCH_TOLERANCE_PT}. Returns `null` when nothing matches.
 */
export function resolveCuTarget(
  conversationId: string,
  input: Record<string, unknown>,
): AxElement | null {
  const elements = currentElements(conversationId);
  if (elements.length === 0) return null;

  const rawId = input.element_id;
  const id =
    typeof rawId === "number"
      ? rawId
      : typeof rawId === "string" && /^\d+$/.test(rawId.trim())
        ? Number(rawId.trim())
        : null;
  if (id !== null) return elements.find((el) => el.id === id) ?? null;

  const x = typeof input.x === "number" ? input.x : null;
  const y = typeof input.y === "number" ? input.y : null;
  if (x === null || y === null) return null;

  let best: AxElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const el of elements) {
    const distance = Math.max(Math.abs(el.x - x), Math.abs(el.y - y));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = el;
    }
  }
  return bestDistance <= COORD_MATCH_TOLERANCE_PT ? best : null;
}

/** The element the snapshot reports as focused, if any. */
export function resolveCuFocus(conversationId: string): AxElement | null {
  return currentElements(conversationId).find((el) => el.focused) ?? null;
}

// ── Guard ─────────────────────────────────────────────────────────────

const CLICK_TOOLS = new Set([
  "computer_use_click",
  "computer_use_double_click",
]);

function isRightClick(toolName: string, input: Record<string, unknown>) {
  return (
    toolName === "computer_use_right_click" || input.click_type === "right"
  );
}

/**
 * Evaluate the high-consequence checkpoint for a computer-use action.
 * Returns the blocking tool result, or `null` to proceed.
 */
export function evaluateComputerUseSendGate(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult | null {
  if (!context.conversationId) return null;

  if (CLICK_TOOLS.has(toolName) && !isRightClick(toolName, input)) {
    const target = resolveCuTarget(context.conversationId, input);
    if (!target) return null;
    const control = axElementToControl(target);
    if (!isSendControl(control)) return null;
    const decision = gateResolvedSendControl({
      toolName,
      input,
      context,
      controlLabel: describeControl(control),
      targetDescription:
        typeof input.element_id === "number" ||
        typeof input.element_id === "string"
          ? `element [${target.id}]`
          : `the control at (${target.x}, ${target.y})`,
      kind: "click",
    });
    return decision.blocked ? decision.result! : null;
  }

  if (toolName === "computer_use_key") {
    const key = typeof input.key === "string" ? input.key : "";
    const chord = parseKeyChord(key);
    // Only ⌘/Ctrl+Enter is gated on the desktop: there is no page host to tell
    // an Enter-sends composer from an Enter-inserts-newline one, and gating a
    // bare Enter would break every dialog, search box, and form on the machine.
    if (!chord.enter || chord.shift || !(chord.meta || chord.ctrl)) return null;
    const focus = resolveCuFocus(context.conversationId);
    if (!focus) return null;
    const control = axElementToControl(focus);
    if (!control.isTextEntry) return null;
    const decision = gateResolvedSendControl({
      toolName,
      input,
      context,
      controlLabel: key,
      targetDescription: focus.title
        ? `the focused field "${focus.title}"`
        : "the focused text field",
      kind: "key",
    });
    return decision.blocked ? decision.result! : null;
  }

  return null;
}

/**
 * Wrap a computer-use proxy dispatch: run the send checkpoint before the action
 * leaves the daemon, then feed the response's accessibility snapshot back into
 * the cache so the NEXT action can be resolved.
 */
export async function runGuardedComputerUseTool(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
  invoke: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  const blocked = evaluateComputerUseSendGate(toolName, input, context);
  if (blocked) return blocked;
  const result = await invoke();
  try {
    if (context.conversationId && typeof result?.content === "string") {
      recordAxSnapshot(context.conversationId, result.content);
    }
  } catch {
    // A snapshot we cannot parse just means no coverage for the next action.
  }
  return result;
}
