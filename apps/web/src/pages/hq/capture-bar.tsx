/**
 * HQ capture bar — "Tell Cue to do something, or drop anything in…".
 *
 * Wired to the exact thread-seeding path Create/Home use: mint a draft
 * conversation id, set it active, navigate with the text in `?prompt=` so the
 * chat route's `useAutoSendEffects` auto-sends it (see create-page.tsx).
 * The "↳ auto-files" chip states the promise: whatever you drop here lands on
 * the right mission via the normal capture→triage loop.
 */

import { useState } from "react";
import { useNavigate } from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

import { ApertureMark, C, mono } from "./hq-kit";

/** Mirrors chat's `createDraftConversationId` (a plain UUID) — inlined so the
 * HQ page doesn't lean on chat-domain internals (same move as create-page). */
function newDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function CaptureBar({
  placeholder = "Tell Cue to do something, or drop anything in…",
  autoFilesChip = true,
}: {
  placeholder?: string;
  autoFilesChip?: boolean;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState("");

  const send = () => {
    const prompt = text.trim();
    if (!prompt) return;
    useViewerStore.getState().setMainView("chat");
    const id = newDraftConversationId();
    useConversationStore.getState().setActiveConversationId(id);
    void navigate(
      `${routes.conversation(id)}?prompt=${encodeURIComponent(prompt)}`,
    );
  };

  return (
    <div
      data-slot="hq-capture-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        background: C.surface,
        border: `1.5px solid ${C.blue}`,
        borderRadius: 14,
        padding: "10px 14px",
        boxShadow: `0 12px 30px -16px color-mix(in srgb, ${C.blue} 40%, transparent)`,
      }}
    >
      <ApertureMark size={20} />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
        }}
        placeholder={placeholder}
        aria-label="Tell Cue to do something"
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          color: C.ink,
          background: "transparent",
          border: "none",
          outline: "none",
        }}
      />
      {autoFilesChip ? (
        <span
          title="Everything you send lands on the right mission automatically"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontFamily: mono,
            fontSize: 10,
            color: C.t3,
            background: C.sunken,
            borderRadius: 6,
            padding: "4px 8px",
            whiteSpace: "nowrap",
          }}
        >
          ↳ auto-files
        </span>
      ) : null}
      <button
        type="button"
        onClick={send}
        aria-label="Send to Cue"
        disabled={text.trim().length === 0}
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          background: C.blue,
          border: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          color: "#fff",
          cursor: text.trim().length === 0 ? "default" : "pointer",
          opacity: text.trim().length === 0 ? 0.55 : 1,
          flexShrink: 0,
        }}
      >
        ↑
      </button>
    </div>
  );
}
