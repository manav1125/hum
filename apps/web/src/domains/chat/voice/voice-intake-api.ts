/**
 * Typed client binding for the voice-intake endpoint
 * (`POST /v1/assistants/{assistant_id}/voice-intake`).
 *
 * This route is newer than the generated daemon SDK, so — like
 * {@link import("@/pages/command-center/use-next-move")} does for next-move — it
 * names the wire shape by hand and calls through the already-configured, authed
 * daemon `client`, which carries the same base URL + session cookie every
 * generated daemon call uses. When the route lands in `daemon.json` and codegen
 * runs, the body type can be swapped for the generated one with no call-site
 * churn.
 *
 * The endpoint turns a dictated transcript into a working thread: it creates the
 * conversation, lists the spoken action items as the first assistant message,
 * and queues an executable work item per open action item — then returns the
 * `conversationId` to navigate into.
 */

import { postChatMessage } from "@/domains/chat/api/messages";
import { client } from "@/generated/daemon/client.gen";

export interface VoiceIntakeActionItem {
  text: string;
  owner: string | null;
  done: boolean;
}

export interface VoiceIntakeWorkItem {
  id: string;
  title: string;
  created: boolean;
}

export interface VoiceIntakeResponse {
  conversationId: string;
  summary: string;
  actionItems: VoiceIntakeActionItem[];
  workItems: VoiceIntakeWorkItem[];
}

export type VoiceIntakeResult =
  | { ok: true; data: VoiceIntakeResponse }
  | { ok: false; error: string };

/**
 * Turn a dictated transcript into a working thread. Resolves to the conversation
 * to navigate into, or a friendly error string on any failure.
 *
 * Resilient by design (mirrors the next-move hero): the structured
 * `voice-intake` route is new, and new daemon routes can lag behind the gateway's
 * route propagation. So if it isn't reachable we fall back to the proven
 * `POST /messages` path — the transcript still opens a real thread and Cue reads
 * it back and lists the action items conversationally. The magic degrades from
 * "structured extraction + queued work items" to "Cue answers your brain-dump in
 * a thread", never to a dead end.
 */
export async function postVoiceIntake(
  assistantId: string,
  transcript: string,
): Promise<VoiceIntakeResult> {
  // 1) Preferred: the structured voice-intake route.
  try {
    const { data, response } = await client.post<VoiceIntakeResponse, unknown>({
      url: "/v1/assistants/{assistant_id}/voice-intake",
      path: { assistant_id: assistantId },
      body: { transcript },
      throwOnError: false,
    });
    if (
      response?.ok &&
      data &&
      typeof data === "object" &&
      typeof (data as VoiceIntakeResponse).conversationId === "string"
    ) {
      return { ok: true, data: data as VoiceIntakeResponse };
    }
  } catch {
    // fall through to the resilient message-path fallback
  }

  // 2) Fallback: open a thread the proven way and let Cue read the brain-dump
  //    back. We frame the transcript so Cue lists the action items and offers to
  //    start — the same shape voice-intake produces, just composed by the model
  //    in-conversation instead of by the dedicated route.
  try {
    const framed =
      `I just said this out loud — read it back briefly, then list the distinct ` +
      `action items as a numbered list and offer to start on them:\n\n` +
      `"${transcript.trim()}"`;
    const result = await postChatMessage(assistantId, null, framed);
    if (result.ok) {
      return {
        ok: true,
        data: {
          conversationId: result.conversationId,
          summary: "",
          actionItems: [],
          workItems: [],
        },
      };
    }
    return {
      ok: false,
      error: result.error.detail ?? "Couldn’t reach Cue — try again.",
    };
  } catch {
    return { ok: false, error: "Couldn’t reach Cue — try again." };
  }
}
