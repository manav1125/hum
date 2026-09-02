import { useQuery } from "@tanstack/react-query";

import { mintLearnSession } from "@/lib/learn-session";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

/**
 * The Learn course catalog, for surfaces OUTSIDE the Learn iframe (today: the
 * Library's Courses section). Lists via the sidecar's owner-scoped
 * `GET /api/stages` through the gateway's shim — same cookie jar as the
 * classroom itself, so the anonymous-owner identity matches what the iframe
 * uses on this origin.
 *
 * Purely additive and fail-quiet: any failure yields an empty catalog so the
 * Library's own content never depends on the sidecar being reachable. The
 * course CONTENT never moves — cards deep-link into the Learn surface
 * (`/assistant/learn?p=/classroom/<id>`), where the classroom's own UX takes
 * over.
 */
export interface LearnCourse {
  id: string;
  name: string;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
}

export function useLearnCourses(): {
  courses: LearnCourse[];
  loading: boolean;
} {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const enabled = useAssistantFeatureFlagStore.use.learnApp();

  const { data = [], isLoading } = useQuery({
    queryKey: ["learn-courses"],
    enabled: hasHydrated && enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<LearnCourse[]> => {
      if ((await mintLearnSession()) !== "ready") return [];
      const res = await fetch("/api/stages", { credentials: "include" });
      if (!res.ok) return [];
      const body = (await res.json().catch(() => null)) as {
        stages?: unknown;
      } | null;
      if (!body || !Array.isArray(body.stages)) return [];
      return (body.stages as Array<Record<string, unknown>>)
        .filter((s) => typeof s.id === "string" && typeof s.name === "string")
        .map((s) => ({
          id: s.id as string,
          name: s.name as string,
          sceneCount: typeof s.sceneCount === "number" ? s.sceneCount : 0,
          createdAt: typeof s.createdAt === "number" ? s.createdAt : 0,
          updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
  });

  return { courses: data, loading: isLoading };
}
