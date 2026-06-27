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
 */
export async function postVoiceIntake(
  assistantId: string,
  transcript: string,
): Promise<VoiceIntakeResult> {
  try {
    const { data, response } = await client.post<VoiceIntakeResponse, unknown>({
      url: "/v1/assistants/{assistant_id}/voice-intake",
      path: { assistant_id: assistantId },
      body: { transcript },
      throwOnError: false,
    });
    if (
      !response?.ok ||
      !data ||
      typeof data !== "object" ||
      typeof (data as VoiceIntakeResponse).conversationId !== "string"
    ) {
      return {
        ok: false,
        error: "Couldn’t turn your voice note into a thread — try again.",
      };
    }
    return { ok: true, data: data as VoiceIntakeResponse };
  } catch {
    return { ok: false, error: "Couldn’t reach Cue — try again." };
  }
}
