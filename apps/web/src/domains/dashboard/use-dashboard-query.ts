/**
 * The dashboard query bar: "ask Cue anything".
 *
 * On submit it posts the message into a fresh server-minted conversation
 * (`conversationId: null`) via the same `postChatMessage` the chat composer
 * uses, optionally prefixing the active template's `queryContext` so the ask is
 * framed by the surface, then navigates to the resulting conversation.
 */

import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

import { postChatMessage } from "@/domains/chat/api/messages";
import { routes } from "@/utils/routes";

export interface UseDashboardQuery {
  value: string;
  setValue: (v: string) => void;
  submitting: boolean;
  error: string | null;
  submit: () => Promise<void>;
}

export function useDashboardQuery(
  assistantId: string,
  queryContext?: string,
): UseDashboardQuery {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const content = queryContext ? `${queryContext}\n\n${trimmed}` : trimmed;
      const result = await postChatMessage(assistantId, null, content);
      if (!result.ok) {
        setError(result.error.detail ?? "Couldn’t reach Cue — try again.");
        return;
      }
      setValue("");
      navigate(routes.conversation(result.conversationId));
    } catch {
      setError("Couldn’t reach Cue — try again.");
    } finally {
      setSubmitting(false);
    }
  }, [assistantId, navigate, queryContext, submitting, value]);

  return { value, setValue, submitting, error, submit };
}
