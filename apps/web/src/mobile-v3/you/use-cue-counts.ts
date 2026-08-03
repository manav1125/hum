/**
 * The numbers the ⓶ surfaces print, and nothing else.
 *
 * Both the ⓶ screen (v24 F2) and the Your Cue leaf list (v22 M5) put a count
 * beside a row. They read it from here so the two can never disagree about how
 * many agents are on staff — the HQ-headline-vs-sidebar-badge bug this
 * codebase already had to fix once, in a different pair of surfaces.
 *
 * **`null` means "not known yet", and renders as nothing.** Never `0`: a zero
 * that means "the request hasn't landed" is indistinguishable from a zero that
 * means "you have none", and the second is information while the first is a
 * fabrication. Every consumer here omits the meta rather than printing a
 * placeholder.
 *
 * React Query dedupes the underlying fetches, so mounting both surfaces (the
 * ⓶ screen pushes to the leaf list) costs one round of requests, not two.
 */
import { useQuery } from "@tanstack/react-query";

import {
  agentsGetOptions,
  connectorappsGetOptions,
  contactsGetOptions,
  documentsGetOptions,
  skillsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { attentionCount } from "@/lib/connector-health";

const SLOW = 60_000;

/** A work item that is running right now, reduced to what a row can show. */
export interface WorkingRow {
  id: string;
  title: string;
  /** The runner's own live line ("Searching the web…"), or null. */
  note: string | null;
  /** "cue" | "you" | a contact name; null reads as Cue. */
  assignee: string | null;
}

export interface CueCounts {
  /** Agents on staff. */
  agents: number | null;
  /** Skills learned or authored. */
  skills: number | null;
  /** Connectors actually connected (not the catalogue size). */
  connectorsLive: number | null;
  /** Connectors that need attention — a real health read, not a guess. */
  connectorsAttention: number;
  /** People Cue knows. */
  people: number | null;
  /** Documents in the Library. */
  library: number | null;
  /** What is running right now, newest first. */
  working: readonly WorkingRow[];
  /**
   * True when at least one of the reads failed. The surfaces use it to say
   * "couldn't read" instead of drawing an empty state — a failed fetch is an
   * error state, not an empty one.
   */
  isError: boolean;
}

export function useCueCounts(assistantId: string): CueCounts {
  const enabled = assistantId.length > 0;
  const path = { assistant_id: assistantId };

  const agents = useQuery({
    ...agentsGetOptions({ path }),
    enabled,
    staleTime: SLOW,
  });
  const skills = useQuery({
    ...skillsGetOptions({ path }),
    enabled,
    staleTime: SLOW,
  });
  const apps = useQuery({
    ...connectorappsGetOptions({ path, query: {} }),
    enabled,
    staleTime: SLOW,
  });
  const contacts = useQuery({
    ...contactsGetOptions({ path }),
    enabled,
    staleTime: SLOW,
  });
  const documents = useQuery({
    ...documentsGetOptions({ path }),
    enabled,
    staleTime: SLOW,
  });
  // The only fast-polling read: "working now" is the one thing on the ⓶ screen
  // that is worthless if it is a minute stale.
  const workItems = useQuery({
    ...workitemsGetOptions({ path }),
    enabled,
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  const appList = apps.data?.apps ?? [];

  return {
    agents: agents.data ? agents.data.agents.length : null,
    skills: skills.data ? skills.data.skills.length : null,
    connectorsLive: apps.data
      ? appList.filter((a) => a.connected).length
      : null,
    connectorsAttention: attentionCount(appList),
    people: contacts.data ? contacts.data.contacts.length : null,
    library: documents.data ? documents.data.documents.length : null,
    working: (workItems.data?.items ?? [])
      .filter((i) => i.status === "running")
      .map((i) => ({
        id: i.id,
        title: i.title,
        note: i.lastProgressNote,
        assignee: i.assignee,
      })),
    isError:
      agents.isError ||
      skills.isError ||
      apps.isError ||
      contacts.isError ||
      documents.isError ||
      workItems.isError,
  };
}
