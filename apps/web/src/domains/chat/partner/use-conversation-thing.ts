/**
 * A conversation belongs to a thing.
 *
 * The header should read `▤ Renew Acme`, so output lands in the right place and
 * the thread is findable later from the thing itself.
 *
 * There is no `conversations.project_id` column — the schema delta in the
 * design brief lists that binding as still owed. So rather than invent a field
 * or fabricate a chip, this derives the thing from the link that IS wired: work
 * items carry `originConversationId` (the thread they were started from) and
 * `projectId` (the thing they were filed under). If everything this thread
 * started went into one thing, that is the thing this conversation belongs to,
 * and we can say so honestly.
 *
 * Consequences of deriving rather than storing, stated plainly:
 *   - a conversation that has started no work shows no chip (it isn't filed)
 *   - a conversation whose work landed in two different things shows no chip
 *     (we don't know which one, so we don't pick one)
 * Both are silence, which is the correct failure mode. The chip appears the
 * moment the link is real.
 */

import { useQuery } from "@tanstack/react-query";

import { projectsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useSpawnedWork } from "@/domains/chat/hooks/use-spawned-work";

export interface ConversationThing {
  id: string;
  title: string;
  emoji: string | null;
}

/**
 * The unanimous project id across a conversation's spawned work, or null.
 *
 * Unfiled items are ignored rather than treated as disagreement — a thread that
 * filed two items into "Renew Acme" and left a third unfiled still belongs to
 * Renew Acme. Two *different* things is genuine ambiguity and yields null.
 */
export function unanimousProjectId(
  items: ReadonlyArray<{ projectId: string | null }>,
): string | null {
  let found: string | null = null;
  for (const item of items) {
    if (!item.projectId) continue;
    if (found === null) found = item.projectId;
    else if (found !== item.projectId) return null;
  }
  return found;
}

export function useConversationThing(
  assistantId: string | null | undefined,
  conversationId: string | null | undefined,
): ConversationThing | null {
  const { items } = useSpawnedWork(assistantId, conversationId);
  const projectId = unanimousProjectId(items);

  const projects = useQuery({
    ...projectsGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: Boolean(assistantId) && projectId !== null,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  if (!projectId) return null;
  const match = (projects.data?.projects ?? []).find((p) => p.id === projectId);
  // A project id we can't resolve to a name is not a chip. Never render an id.
  if (!match?.title) return null;
  return { id: match.id, title: match.title, emoji: match.emoji };
}
