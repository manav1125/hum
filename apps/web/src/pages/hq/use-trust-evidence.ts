/**
 * Trust-ceremony data bindings (§5) — the evidence numbers behind a grant and
 * the two write paths a decision takes. These routes are newer than the
 * generated daemon SDK, so — like `voice-intake-api` and `use-next-move` do —
 * we name the wire shape by hand and call through the already-configured,
 * authed daemon `client` (same base URL + session as every generated call).
 *
 *   - GET  /acts/summary?agent=…   → "34 approved · 0 reversed" track record.
 *   - POST /confirm                → the persistent trust grant (always_allow +
 *                                    pattern/scope), when the sheet is mounted
 *                                    from a live confirmation card (requestId).
 *
 * "Never" doesn't hit these — it appends a never-line to the company profile,
 * which the caller already owns via {@link usePutCompanyProfile}.
 */

import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/daemon/client.gen";

export interface ActsEvidence {
  acts: number;
  reversed: number;
  estMinutesSaved: number;
}

/**
 * The agent's track record — approved acts vs. reversals — powering the
 * "34 approved · 0 reversed" trust evidence. Resolves to null while the ledger
 * is still empty or the route hasn't propagated ("measuring…" in the UI).
 */
export function useActsEvidence(assistantId: string, agent: string | null) {
  const query = useQuery({
    queryKey: ["acts-summary", assistantId, agent],
    enabled: Boolean(assistantId),
    staleTime: 30_000,
    queryFn: async (): Promise<ActsEvidence | null> => {
      try {
        const { data, response } = await client.get<ActsEvidence, unknown>({
          url: "/v1/assistants/{assistant_id}/acts/summary",
          path: { assistant_id: assistantId },
          query: agent ? { agent } : {},
          throwOnError: false,
        });
        if (response?.ok && data && typeof data === "object") {
          const d = data as Partial<ActsEvidence>;
          if (typeof d.acts === "number" && typeof d.reversed === "number") {
            return {
              acts: d.acts,
              reversed: d.reversed,
              estMinutesSaved:
                typeof d.estMinutesSaved === "number" ? d.estMinutesSaved : 0,
            };
          }
        }
      } catch {
        // Route not reachable yet — degrade to "measuring…".
      }
      return null;
    },
  });
  return {
    evidence: query.data ?? null,
    isLoading: query.isLoading,
    /** True once we have a real, non-empty track record to show. */
    hasEvidence: (query.data?.acts ?? 0) > 0,
  };
}

export type GrantResult = { ok: true } | { ok: false; error: string };

/**
 * Persist a trust grant by resolving a live confirmation with `always_allow` +
 * the chosen pattern/scope — the same persistent-decision path the approvals
 * confirm flow uses. Requires the `requestId` of the pending confirmation the
 * grant sheet was mounted from.
 */
export async function grantTrustScope(
  assistantId: string,
  opts: { requestId: string; pattern?: string; scope?: string },
): Promise<GrantResult> {
  try {
    const { response } = await client.post<{ accepted?: boolean }, unknown>({
      url: "/v1/assistants/{assistant_id}/confirm",
      path: { assistant_id: assistantId },
      body: {
        requestId: opts.requestId,
        decision: "always_allow",
        ...(opts.pattern ? { selectedPattern: opts.pattern } : {}),
        ...(opts.scope ? { selectedScope: opts.scope } : {}),
      },
      throwOnError: false,
    });
    if (response?.ok) return { ok: true };
    return { ok: false, error: "Couldn’t record the grant — try again." };
  } catch {
    return { ok: false, error: "Couldn’t reach Cue — try again." };
  }
}
