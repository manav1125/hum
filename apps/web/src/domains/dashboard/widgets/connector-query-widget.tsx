/**
 * Connector-query widget — ASSISTANT-ROUTED (the honest path for finances /
 * Linear / Notion, where there is NO native daemon endpoint).
 *
 * It NEVER renders fabricated numbers. Instead it's a labeled "via Cue · from
 * your connected apps" card whose primary action posts a preset intent to the
 * assistant (`postChatMessage`) and navigates to the conversation, where Cue
 * actually fetches the data from the user's connected tools. Until then it
 * shows only the ask + a connect-prompt affordance.
 */

import { useState } from "react";
import { ArrowUpRight, Plug } from "lucide-react";
import { useNavigate } from "react-router";

import { postChatMessage } from "@/domains/chat/api/messages";
import { routes } from "@/utils/routes";

import { C } from "../theme";
import type { ConnectorPreset } from "../templates";
import { ProvenanceBadge, WidgetFrame } from "./widget-frame";

export function ConnectorQueryWidget({
  assistantId,
  preset,
}: {
  assistantId: string;
  preset: ConnectorPreset;
}) {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await postChatMessage(assistantId, null, preset.intent);
      if (!result.ok) {
        setError(result.error.detail ?? "Couldn’t reach Cue — try again.");
        return;
      }
      navigate(routes.conversation(result.conversationId));
    } catch {
      setError("Couldn’t reach Cue — try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <WidgetFrame
      title={preset.label}
      badge={<ProvenanceBadge>via Cue · from your connected apps</ProvenanceBadge>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontSize: 13, color: C.t2, lineHeight: 1.4, margin: 0 }}>
          {preset.description} There’s no live preview here — Cue fetches it
          fresh so the numbers are always real, never cached or guessed.
        </p>

        <button
          type="button"
          onClick={run}
          disabled={submitting}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            fontSize: 13,
            fontWeight: 500,
            border: `1px solid ${C.blue}`,
            background: C.blue,
            color: "#fff",
            borderRadius: 10,
            padding: "9px 14px",
            cursor: submitting ? "default" : "pointer",
            opacity: submitting ? 0.65 : 1,
            alignSelf: "flex-start",
          }}
        >
          {submitting ? "Asking Cue…" : preset.cta}
          <ArrowUpRight size={15} />
        </button>

        {error ? (
          <div style={{ fontSize: 12, color: C.danger }}>{error}</div>
        ) : null}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 11.5,
            color: C.t3,
          }}
        >
          <Plug size={13} />
          <span>
            Not connected yet?{" "}
            <button
              type="button"
              onClick={() => navigate("/assistant/intelligence")}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: C.blueS,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              Connect an app
            </button>{" "}
            so Cue has something to pull from.
          </span>
        </div>
      </div>
    </WidgetFrame>
  );
}
