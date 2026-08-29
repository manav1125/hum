/**
 * Re-applying an agent's identity to its conversation, every time.
 *
 * An agent is not just a name on a work item. It carries a charter, a model
 * pin, and tool scopes, and the last of those is a guardrail: an agent given
 * `tool_scopes` is one the owner has deliberately restricted.
 *
 * Those consequences used to be attached to the in-memory conversation at run
 * time and nowhere else, which made them last exactly as long as that object.
 * The evictor sweeps idle conversations; a daemon restart drops them all.
 * After either, the conversation came back plain — unrestricted tools, no
 * model pin — and nothing said the restriction had stopped applying.
 *
 * So the binding is persisted on the conversation row, and this module is the
 * one place that turns that row back into applied identity. Anything that
 * hydrates a conversation calls {@link applyAgentBinding}; nothing else
 * reconstructs the same rules, because two reconstructions would drift and the
 * drift would be silent in the permissive direction.
 *
 * ## Why the model pin is not re-applied here
 *
 * A model pin is resolved when the conversation is CONSTRUCTED (it becomes the
 * provider's `modelOverride`), so it has to be passed at creation rather than
 * set afterwards. {@link resolveAgentModelOverride} exists for callers at that
 * point. Tool scopes and the charter can be applied to a live conversation,
 * and are.
 */

import { buildAgentToolScopeFilter } from "../guardrails/agent-tool-scopes.js";
import { getConversationAgentId } from "../memory/conversation-crud.js";
import { getLogger } from "../util/logger.js";
import { type Agent, getAgent, getAgentByAssignee } from "./agent-store.js";

const log = getLogger("agent-binding");

/** The subset of a conversation this needs, so callers stay testable. */
export interface AgentBindable {
  toolScopeFilter?: (toolName: string) => boolean;
  agentCharter?: string;
}

/**
 * Resolve an agent from either an explicit id or a work-item assignee name.
 *
 * Returns `undefined` for the house assistant — a null assignee, an unknown
 * name, or a deleted agent. That is deliberately the same answer for all
 * three: the house assistant is unrestricted, and there is no safe way to
 * "partially" apply a missing agent.
 *
 * A deleted agent is worth one log line. Its conversations still name it, and
 * silently widening them back to unrestricted tools is exactly the lapse this
 * module exists to prevent, so it should at least be visible.
 */
export function resolveAgent(opts: {
  agentId?: string | null;
  assignee?: string | null;
}): Agent | undefined {
  if (opts.agentId) {
    const byId = getAgent(opts.agentId);
    if (byId) return byId;
    log.warn(
      { agentId: opts.agentId },
      "conversation names an agent that no longer exists; running unrestricted as the house assistant",
    );
    return undefined;
  }
  if (opts.assignee) return getAgentByAssignee(opts.assignee);
  return undefined;
}

/**
 * The agent bound to a conversation, resolved without ever throwing.
 *
 * Conversation construction calls this, and the daemon's rule is that a
 * subsystem failure degrades rather than blocking startup or a turn. A
 * conversation that could not be built because one column read failed is a
 * far worse outcome than one built without its binding — the owner would lose
 * the assistant entirely, not just an agent's scoping.
 *
 * The fallback is the house assistant, which is unrestricted, so this widens a
 * guardrail on failure. That is only acceptable because the failure means the
 * conversations table is unreadable, at which point nothing else works either.
 * It is logged at error rather than swallowed, because a scoped agent quietly
 * becoming unscoped is exactly the lapse this module exists to prevent.
 */
export function resolveConversationAgent(
  conversationId: string,
): Agent | undefined {
  let agentId: string | null;
  try {
    agentId = getConversationAgentId(conversationId);
  } catch (err) {
    log.error(
      { err, conversationId },
      "could not read the conversation's agent binding; running unrestricted as the house assistant",
    );
    return undefined;
  }
  return resolveAgent({ agentId });
}

/**
 * Apply an agent's tool scopes to a conversation.
 *
 * Idempotent and safe to call on every hydration. An agent with no scopes
 * clears the filter rather than leaving a previous one in place: a
 * conversation reassigned from a scoped agent to an unscoped one must not keep
 * enforcing the old agent's restriction, which would be a confusing denial the
 * owner cannot explain from anything on screen.
 */
export function applyAgentBinding(
  conversation: AgentBindable,
  agent: Agent | undefined,
): void {
  conversation.toolScopeFilter = agent?.toolScopes
    ? buildAgentToolScopeFilter(agent.toolScopes)
    : undefined;
  conversation.agentCharter = buildAgentCharterPreamble(agent);
}

/**
 * The per-conversation model override an agent's pin implies, if any.
 *
 * Separate from {@link applyAgentBinding} because it has to be supplied when
 * the conversation is constructed, not set on a live one.
 */
export function resolveAgentModelOverride(
  agent: Agent | undefined,
): string | undefined {
  return agent?.model ?? undefined;
}

/**
 * The line that tells the agent who it is, prepended to its runs.
 *
 * Kept here beside the rest of the identity so a conversation rehydrated hours
 * later can be given the same framing as its first turn. An agent whose
 * charter only reaches the first message of a run drifts back into being
 * generic Cue over a long thread, which is the same failure as the tool scopes
 * lapsing, just slower and harder to notice.
 */
export function buildAgentCharterPreamble(
  agent: Agent | undefined,
): string | undefined {
  if (!agent) return undefined;
  const parts = [
    `You are ${agent.name}${agent.domain ? `, ${agent.domain}` : ""}.`,
  ];
  if (agent.charter) parts.push(agent.charter);
  return parts.join("\n\n");
}
