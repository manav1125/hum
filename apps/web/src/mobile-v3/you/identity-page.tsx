/**
 * Mv3IdentityPage — the mobile Identity leaf (round-4 spec frame 53,
 * docs/design/mobile-round4/cue-mobile-round4.html). A You-cluster leaf in
 * the v3 grammar: ring-as-avatar card (the ring IS the avatar — violet
 * aurora marks the You cluster), grouped rows Name / Role & personality /
 * Voice, each opening a focused edit sheet on REAL endpoints:
 *
 *  · Name / Role & personality — the daemon's identity endpoint is
 *    read-only, so saves rewrite IDENTITY.md's bullet fields through the
 *    workspace routes (read → `applyIdentityEdits` → write); the identity
 *    query + sidebar store refresh after.
 *  · Voice — backed by the daemon TTS config
 *    (`services.tts.providers.elevenlabs.voiceId`, saved via config PATCH),
 *    with a live preview through `POST /tts/synthesize` (plays the saved
 *    voice). The row's 2-bar tick follows the frame.
 *  · Working style — the spec drew this row, but NO daemon config key backs
 *    it (verified: no such field anywhere in daemon config or IDENTITY.md
 *    parsing), so the row is honestly omitted.
 *
 * Desktop Identity is untouched — `IdentityPage` branches here on mobile.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { client } from "@/generated/daemon/client.gen";
import {
  configGetOptions,
  configGetQueryKey,
  identityGetOptions,
  identityGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  configPatch,
  workspaceFileGet,
  workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { CueRing } from "../cue-ring";
import { GlassCard } from "../glass-card";
import { SheetShell } from "../sheet-shell";
import { YouScreen } from "./you-kit";
import { applyIdentityEdits, type IdentityEdits } from "./identity-md";

/** Mirrors the daemon default (assistant/src/config/schemas/elevenlabs.ts). */
const DEFAULT_ELEVENLABS_VOICE_ID = "ZF6FPAbjXT4488VcRRnw";

const HELPER = "Changes apply to every new conversation and run";

interface TtsConfigShape {
  provider?: string;
  providers?: Record<string, Record<string, unknown> | undefined>;
}

/** Honest display label for the configured voice — never an invented name. */
function voiceValueLabel(tts: TtsConfigShape | undefined): string {
  const provider = tts?.provider ?? "elevenlabs";
  const providerCfg = tts?.providers?.[provider];
  const voiceId =
    typeof providerCfg?.voiceId === "string" ? providerCfg.voiceId : null;
  if (provider === "elevenlabs") {
    if (!voiceId || voiceId === DEFAULT_ELEVENLABS_VOICE_ID) return "Default";
    return voiceId.length > 10 ? `${voiceId.slice(0, 10)}…` : voiceId;
  }
  // Other providers: show the raw configured value (e.g. xAI "eve").
  if (voiceId) return voiceId;
  return provider;
}

/* ───────────────────────────── Edit sheet shell ──────────────────────────── */

function EditSheet({
  open,
  title,
  onClose,
  children,
  error,
  saving,
  onSave,
  saveLabel = "Save",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  saveLabel?: string;
}) {
  return (
    <SheetShell open={open} onClose={onClose} label={title}>
      <div style={{ padding: "0 2px 6px" }}>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{title}</div>
        {children}
        <div
          style={{ fontSize: 10.5, color: "var(--mv3-muted)", marginTop: 8 }}
        >
          {HELPER}
        </div>
        {error ? (
          <div role="alert" style={{ fontSize: 12, color: "#E5675B", marginTop: 8 }}>
            {error}
          </div>
        ) : null}
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            haptic.medium();
            onSave();
          }}
          style={{
            width: "100%",
            background: "var(--mv3-accent-fill-gradient)",
            color: "#ffffff",
            border: "none",
            borderRadius: 12,
            padding: 12,
            minHeight: 46,
            fontSize: 13.5,
            fontWeight: 600,
            fontFamily: "inherit",
            marginTop: 11,
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : saveLabel}
        </button>
      </div>
    </SheetShell>
  );
}

/** The frame's focused-field treatment: blue 1.5px border + soft glow. */
const FIELD_STYLE: React.CSSProperties = {
  width: "100%",
  background: "var(--mv3-btn2-bg)",
  border: "1.5px solid var(--mv3-accent)",
  borderRadius: 14,
  padding: "12px 14px",
  marginTop: 10,
  fontSize: 16, // ≥16 so iOS Safari doesn't zoom the sheet on focus.
  lineHeight: 1.55,
  color: "var(--mv3-text)",
  fontFamily: "inherit",
  outline: "none",
  boxShadow: "0 0 0 3px rgba(61,110,232,.12)",
};

/* ─────────────────────────────── Row atom ────────────────────────────────── */

function IdentityRow({
  label,
  value,
  valueSet,
  ornament,
  isLast,
  onPress,
}: {
  label: string;
  value: string;
  /** False renders the value in the faint "Not set" tone. */
  valueSet: boolean;
  /** Leading ornament inside the value slot (the voice 2-bar tick). */
  ornament?: React.ReactNode;
  isLast?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${label} — ${value}`}
      className="cue-pressable"
      onClick={() => {
        haptic.light();
        onPress();
      }}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 16px",
        minHeight: 48,
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: isLast ? "none" : "1px solid var(--mv3-line)",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "var(--mv3-text)",
      }}
    >
      <span style={{ fontSize: 14, flex: 1, minWidth: 0 }}>{label}</span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13.5,
          color: valueSet ? "var(--mv3-muted)" : "var(--mv3-muted)",
          maxWidth: 150,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {ornament}
        {value}
      </span>
      <span style={{ color: "var(--mv3-muted)" }} aria-hidden>
        ›
      </span>
    </button>
  );
}

/** The Voice row's live 2-bar tick (frame 53). */
function VoiceBars() {
  return (
    <span
      aria-hidden
      style={{ display: "flex", gap: 1.5, height: 10, alignItems: "center" }}
    >
      {[0, 0.3].map((delay) => (
        <span
          key={delay}
          style={{
            width: 2,
            height: "100%",
            background: "var(--mv3-micro)",
            borderRadius: 1,
            animation: `mv3Bar .9s ease-in-out ${delay}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

/* ─────────────────────────────── The screen ──────────────────────────────── */

type SheetKind = "name" | "persona" | "voice" | null;

export function Mv3IdentityPage({ assistantId }: { assistantId: string }) {
  const queryClient = useQueryClient();
  const identityVersion = useAssistantIdentityStore.use.version();
  const setStoreIdentity = useAssistantIdentityStore.use.setIdentity();

  const identityQuery = useQuery({
    ...identityGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
  });
  const identity = identityQuery.data ?? null;

  const configQuery = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });
  const tts = useMemo(() => {
    const services = configQuery.data?.services as
      | Record<string, unknown>
      | undefined;
    return services?.["tts"] as TtsConfigShape | undefined;
  }, [configQuery.data]);

  const [sheet, setSheet] = useState<SheetKind>(null);
  const [draftName, setDraftName] = useState("");
  const [draftRole, setDraftRole] = useState("");
  const [draftPersonality, setDraftPersonality] = useState("");
  const [draftVoiceId, setDraftVoiceId] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const name = identity?.name?.trim() ?? "";
  const role = identity?.role?.trim() ?? "";
  const personality = identity?.personality?.trim() ?? "";

  const openSheet = (kind: Exclude<SheetKind, null>) => {
    if (kind === "name") setDraftName(name);
    if (kind === "persona") {
      setDraftRole(role);
      setDraftPersonality(personality);
    }
    if (kind === "voice") {
      const provider = tts?.provider ?? "elevenlabs";
      const cfg = tts?.providers?.[provider];
      setDraftVoiceId(typeof cfg?.voiceId === "string" ? cfg.voiceId : "");
      setPreviewError(null);
    }
    setSheet(kind);
  };

  /** IDENTITY.md read-modify-write — the real identity save path. */
  const saveIdentity = useMutation({
    mutationFn: async (edits: IdentityEdits) => {
      const read = await workspaceFileGet({
        path: { assistant_id: assistantId },
        query: { path: "IDENTITY.md" },
        throwOnError: false,
      });
      if (!read.response?.ok || typeof read.data?.content !== "string") {
        throw new Error("Couldn't read IDENTITY.md — try again.");
      }
      const updated = applyIdentityEdits(read.data.content, edits);
      if (updated === null) {
        throw new Error(
          "IDENTITY.md has no identity fields to edit — ask Cue in chat instead.",
        );
      }
      const write = await workspaceWritePost({
        path: { assistant_id: assistantId },
        body: { path: "IDENTITY.md", content: updated, encoding: "utf-8" },
        throwOnError: false,
      });
      if (!write.response?.ok) {
        throw new Error("Couldn't save IDENTITY.md — try again.");
      }
      return edits;
    },
    onSuccess: (edits) => {
      haptic.success();
      void queryClient.invalidateQueries({
        queryKey: identityGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
      // Keep the app chrome (sidebar name) in step immediately.
      if (typeof edits.name === "string" && edits.name.trim().length > 0) {
        setStoreIdentity(edits.name.trim(), identityVersion);
      }
      setSheet(null);
    },
  });

  /** Voice save — the daemon TTS config key backs this row. */
  const saveVoice = useMutation({
    mutationFn: async (voiceId: string) => {
      const { response } = await configPatch({
        path: { assistant_id: assistantId },
        body: {
          services: {
            tts: { providers: { elevenlabs: { voiceId } } },
          },
        },
        throwOnError: false,
      });
      if (!response?.ok) throw new Error("Couldn't save the voice — try again.");
    },
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries({
        queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      setSheet(null);
    },
  });

  /** Live preview — plays the currently saved voice via the daemon TTS. */
  const playPreview = async () => {
    if (previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    haptic.light();
    try {
      const { data, response } = await client.post({
        url: "/v1/assistants/{assistant_id}/tts/synthesize",
        path: { assistant_id: assistantId },
        body: { text: `Hey — it's ${name || "Cue"}. This is how I sound.` },
        parseAs: "blob",
      });
      if (!response?.ok || !data) {
        throw new Error("Voice preview isn't available right now.");
      }
      const url = URL.createObjectURL(data as Blob);
      try {
        const audio = new Audio(url);
        await audio.play();
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : "Voice preview failed.",
      );
    } finally {
      setPreviewing(false);
    }
  };

  const personaValue =
    role || personality
      ? [role, personality].filter(Boolean).join(" · ")
      : "Not set";
  const heroSub =
    role || personality
      ? [role, personality].filter(Boolean).join(" · ")
      : "Tell Cue who it is — name, role, how it talks";

  const identityError =
    saveIdentity.error instanceof Error ? saveIdentity.error.message : null;
  const provider = tts?.provider ?? "elevenlabs";
  const voiceEditable = provider === "elevenlabs";

  return (
    <YouScreen
      tint="violet"
      testId="mv3-identity"
      back={routes.channels}
      backLabel="You"
      title="Identity"
      sub="Who your Cue is — name, voice, how it works"
    >
      {/* Ring-as-avatar card — the ring IS the avatar. */}
      <GlassCard padding="18px 17px" style={{ textAlign: "center" }}>
        <button
          type="button"
          aria-label="Edit name"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            openSheet("name");
          }}
          style={{
            position: "relative",
            width: 74,
            height: 74,
            margin: "0 auto",
            display: "block",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "var(--mv3-text)",
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: -14,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, var(--mv3-ring-glow), transparent 62%)",
              filter: "blur(12px)",
              animation: "mv3Glow 4s ease-in-out infinite",
            }}
          />
          <CueRing size={74} style={{ position: "relative" }} />
          <span
            aria-hidden
            style={{
              position: "absolute",
              right: -4,
              bottom: -2,
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
            }}
          >
            ✎
          </span>
        </button>
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "-.4px",
            marginTop: 12,
          }}
        >
          {identityQuery.isLoading ? "…" : name || "Cue"}
        </div>
        <div
          style={{ fontSize: 12.5, color: "var(--mv3-muted)", marginTop: 3 }}
        >
          {identityQuery.isLoading ? " " : heroSub}
        </div>
      </GlassCard>

      {/* Grouped rows — each opens a focused edit sheet. */}
      <GlassCard padding={0} style={{ overflow: "hidden" }}>
        <IdentityRow
          label="Name"
          value={name || "Not set"}
          valueSet={Boolean(name)}
          onPress={() => openSheet("name")}
        />
        <IdentityRow
          label="Role & personality"
          value={personaValue}
          valueSet={Boolean(role || personality)}
          onPress={() => openSheet("persona")}
        />
        <IdentityRow
          label="Voice"
          value={configQuery.isLoading ? "…" : voiceValueLabel(tts)}
          valueSet
          ornament={<VoiceBars />}
          isLast
          onPress={() => openSheet("voice")}
        />
        {/* "Working style" (spec frame 53) is omitted: no daemon config key
            backs it — shipping the row would fake a control. */}
      </GlassCard>

      {/* Name sheet. */}
      <EditSheet
        open={sheet === "name"}
        title="Name"
        onClose={() => setSheet(null)}
        error={identityError}
        saving={saveIdentity.isPending}
        onSave={() => saveIdentity.mutate({ name: draftName })}
      >
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="Cue"
          aria-label="Assistant name"
          style={FIELD_STYLE}
        />
      </EditSheet>

      {/* Role & personality sheet. */}
      <EditSheet
        open={sheet === "persona"}
        title="Role & personality"
        onClose={() => setSheet(null)}
        error={identityError}
        saving={saveIdentity.isPending}
        onSave={() =>
          saveIdentity.mutate({
            role: draftRole,
            personality: draftPersonality,
          })
        }
      >
        <input
          value={draftRole}
          onChange={(e) => setDraftRole(e.target.value)}
          placeholder="Chief of staff"
          aria-label="Role"
          style={FIELD_STYLE}
        />
        <textarea
          value={draftPersonality}
          onChange={(e) => setDraftPersonality(e.target.value)}
          placeholder="Candid, brief, no fluff. Push back when I'm wrong."
          aria-label="Personality"
          rows={3}
          style={{ ...FIELD_STYLE, resize: "vertical" }}
        />
      </EditSheet>

      {/* Voice sheet — real config key; preview plays the saved voice. */}
      <EditSheet
        open={sheet === "voice"}
        title="Voice"
        onClose={() => setSheet(null)}
        error={
          previewError ??
          (saveVoice.error instanceof Error ? saveVoice.error.message : null)
        }
        saving={saveVoice.isPending}
        saveLabel={voiceEditable ? "Save" : "Done"}
        onSave={() => {
          if (voiceEditable) saveVoice.mutate(draftVoiceId.trim());
          else setSheet(null);
        }}
      >
        {voiceEditable ? (
          <>
            <input
              value={draftVoiceId}
              onChange={(e) => setDraftVoiceId(e.target.value)}
              placeholder={DEFAULT_ELEVENLABS_VOICE_ID}
              aria-label="ElevenLabs voice ID"
              style={FIELD_STYLE}
            />
            <div
              style={{
                fontSize: 11.5,
                color: "var(--mv3-muted)",
                marginTop: 8,
                lineHeight: 1.5,
              }}
            >
              ElevenLabs voice ID — leave empty for the default voice.
            </div>
          </>
        ) : (
          <div
            style={{
              fontSize: 12.5,
              color: "var(--mv3-muted)",
              marginTop: 10,
              lineHeight: 1.55,
            }}
          >
            Voice runs on {provider} — change it from desktop Settings →
            Models &amp; Services.
          </div>
        )}
        <button
          type="button"
          disabled={previewing}
          onClick={() => void playPreview()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "var(--mv3-btn2-bg)",
            color: "var(--mv3-text)",
            border: "1px solid var(--mv3-btn2-border)",
            borderRadius: 12,
            padding: "10px 16px",
            minHeight: 44,
            fontSize: 13,
            fontFamily: "inherit",
            marginTop: 10,
            cursor: previewing ? "default" : "pointer",
            opacity: previewing ? 0.6 : 1,
          }}
        >
          <VoiceBars />
          {previewing ? "Playing…" : "Preview the saved voice"}
        </button>
      </EditSheet>
    </YouScreen>
  );
}
