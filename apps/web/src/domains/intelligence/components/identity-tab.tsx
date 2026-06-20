import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { getAssistant } from "@/assistant/api";
import { fetchAssistantIdentity } from "@/assistant/identity";
import { AvatarManagementModal } from "@/components/avatar/avatar-management-modal";
import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { ConstellationView } from "@/domains/intelligence/components/constellation-view/constellation-view";
import { SkillDetail } from "@/domains/intelligence/components/skills/skill-detail";
import { installSkill } from "@/domains/intelligence/skills/install";
import type { SkillInfo } from "@/domains/intelligence/skills/types";
import {
    skillsGetOptions,
    skillsGetQueryKey,
    useSkillsByIdDeleteMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { type Options } from "@/generated/daemon/sdk.gen";
import type { IdentityGetResponse, SkillsGetData } from "@/generated/daemon/types.gen";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { captureError } from "@/lib/sentry/capture-error";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { ConfirmDialog } from "@vellumai/design-library";

export interface IdentityCardProps {
  assistantName: string;
  assistantPersonality: string;
  assistantRole: string;
  hatchedDate: string;
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  onOpenThread?: (message: string) => void;
  onOpenModal: () => void;
}

export function IdentityCard({
  assistantName,
  assistantPersonality,
  assistantRole,
  hatchedDate,
  components,
  traits,
  customImageUrl,
  onOpenThread,
  onOpenModal,
}: IdentityCardProps) {
  return (
    <div
      style={{
        width: "100%",
        border: "1px solid #E5E9F0",
        borderRadius: 16,
        padding: 24,
        display: "flex",
        flexDirection: "column",
        background: "#FFFFFF",
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: "#1A2230",
        lineHeight: 1.5,
      }}
    >
      {/* Header — name + edit pencil */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: 21,
            fontWeight: 600,
            letterSpacing: "-.4px",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {assistantName}
        </div>
        <EditPencil
          label="Edit name"
          title="Edit Name"
          onOpenThread={onOpenThread}
          message="I would like to change your name"
        />
      </div>

      {/* Avatar hero */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          marginTop: 22,
        }}
      >
        <div
          style={{
            width: 150,
            height: 150,
            borderRadius: 34,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 16px 36px -16px rgba(26,34,48,.5)",
            overflow: "hidden",
            background: customImageUrl ? "transparent" : "#1A2230",
          }}
        >
          <ChatAvatar
            components={components}
            traits={traits}
            customImageUrl={customImageUrl}
            size={150}
            interactive
          />
        </div>
        <button
          type="button"
          onClick={onOpenModal}
          style={{
            fontSize: 13.5,
            border: "1px solid #D7DDE7",
            borderRadius: 10,
            padding: "9px 18px",
            background: "#FFFFFF",
            color: "#1A2230",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Update Avatar
        </button>
      </div>

      {/* Role */}
      <MetaRow
        label="Role"
        value={assistantRole}
        valueColor={assistantRole === "Not set" ? "#8D99A5" : "#1A2230"}
        marginTop={24}
        edit={
          <EditPencil
            label="Edit role"
            title="Edit Role"
            onOpenThread={onOpenThread}
            message="I would like to change your role description"
          />
        }
      />

      {/* Personality */}
      <MetaRow
        label="Personality"
        value={assistantPersonality || "Not set"}
        valueColor={assistantPersonality ? "#1A2230" : "#8D99A5"}
        marginTop={18}
        truncate
        edit={
          <EditPencil
            label="Edit personality"
            title="Edit Personality"
            onOpenThread={onOpenThread}
            message="I would like to change your personality"
          />
        }
      />

      {/* Hatched — pinned to the bottom of the card */}
      <div style={{ marginTop: "auto", paddingTop: 24 }}>
        <div style={{ fontSize: 13, color: "#5A6672" }}>Hatched</div>
        <div style={{ fontSize: 15, marginTop: 3 }}>{hatchedDate}</div>
      </div>
    </div>
  );
}

/** Top-bordered label/value row with an optional edit affordance (Role / Personality). */
function MetaRow({
  label,
  value,
  valueColor,
  marginTop,
  truncate = false,
  edit,
}: {
  label: string;
  value: string;
  valueColor: string;
  marginTop: number;
  truncate?: boolean;
  edit: ReactNode;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid #E5E9F0",
        marginTop,
        paddingTop: 18,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: "#5A6672" }}>{label}</div>
        <div
          title={value}
          style={{
            fontSize: 15,
            color: valueColor,
            marginTop: 3,
            ...(truncate
              ? {
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }
              : {}),
          }}
        >
          {value}
        </div>
      </div>
      {edit}
    </div>
  );
}

/**
 * The `✎` edit affordance. There is no direct identity-edit mutation on this
 * surface, so each pencil routes the user into chat with a pre-filled request
 * (the real place identity changes happen). Disabled when no chat handler.
 */
function EditPencil({
  label,
  title,
  message,
  onOpenThread,
}: {
  label: string;
  title: string;
  message: string;
  onOpenThread?: (message: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={!onOpenThread}
      onClick={() => onOpenThread?.(message)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        flexShrink: 0,
        border: "none",
        background: "transparent",
        color: "#8D99A5",
        cursor: onOpenThread ? "pointer" : "default",
        opacity: onOpenThread ? 1 : 0.5,
      }}
    >
      <Pencil aria-hidden size={15} />
    </button>
  );
}

interface IdentityTabProps {
  assistantId: string;
  onOpenThread?: (message: string) => void;
}

export function IdentityTab({ assistantId, onOpenThread }: IdentityTabProps) {
  const queryClient = useQueryClient();
  const {
    components,
    traits,
    customImageUrl,
    isLoading: isAvatarLoading,
    invalidate: invalidateAvatar,
  } = useAssistantAvatar(assistantId);
  const [identity, setIdentity] = useState<IdentityGetResponse | null>(null);
  const [assistantCreatedAt, setAssistantCreatedAt] = useState<string | null>(null);
  const [loadedAssistantId, setLoadedAssistantId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [removingSkillId, setRemovingSkillId] = useState<string | null>(null);
  const [skillPendingRemoval, setSkillPendingRemoval] = useState<SkillInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchAssistantIdentity(assistantId),
      getAssistant(assistantId).catch(() => ({ ok: false as const, status: 0, error: {} })),
    ]).then(([identityData, assistantResult]) => {
      if (cancelled) return;
      setIdentity(identityData);
      if (assistantResult.ok) {
        setAssistantCreatedAt(assistantResult.data.created);
      } else {
        setAssistantCreatedAt(null);
      }
      setLoadedAssistantId(assistantId);
    }).catch((err) => {
      if (cancelled) return;
      captureError(err, { context: "identity_tab_load" });
    });

    return () => {
      cancelled = true;
    };
  }, [assistantId]);

  const isLoading = loadedAssistantId !== assistantId || isAvatarLoading;
  const [constellationFullscreen, setConstellationFullscreen] = useState(false);

  const skillsQuery = useQuery({
    ...skillsGetOptions({
      path: { assistant_id: assistantId },
      query: { kind: "installed" },
    }),
    select: (data): SkillInfo[] => data.skills,
    enabled: Boolean(assistantId),
  });
  const installedSkills = useMemo(() => skillsQuery.data ?? [], [skillsQuery.data]);

  const handleAvatarChange = useCallback(() => {
    invalidateAvatar();
  }, [invalidateAvatar]);

  const handleOpenModal = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setModalOpen(false);
  }, []);

  const handleGenerateWithAI = useCallback(() => {
    onOpenThread?.("I'd like to create a custom AI-generated avatar.");
  }, [onOpenThread]);

  const invalidateSkills = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: skillsGetQueryKey({
        path: { assistant_id: assistantId },
      } as Options<SkillsGetData>),
    });
  }, [assistantId, queryClient]);

  const installMutation = useMutation({
    mutationFn: (slug: string) => installSkill(assistantId, slug),
    onMutate: (slug) => setInstallingSkillId(slug),
    onSettled: () => {
      setInstallingSkillId(null);
      invalidateSkills();
    },
  });

  const uninstallMutation = useSkillsByIdDeleteMutation({
    onMutate: (variables) => setRemovingSkillId(variables.path.id),
    onSettled: () => {
      setRemovingSkillId(null);
      invalidateSkills();
    },
  });

  const handleInstall = useCallback(
    (skill: SkillInfo) => {
      installMutation.mutate(skill.slug ?? skill.id);
    },
    [installMutation],
  );

  const handleRemove = useCallback((skill: SkillInfo) => {
    setSkillPendingRemoval(skill);
  }, []);

  const confirmRemove = useCallback(() => {
    if (!skillPendingRemoval) {
      return;
    }
    uninstallMutation.mutate({
      path: { assistant_id: assistantId, id: skillPendingRemoval.id },
    });
    setSkillPendingRemoval(null);
  }, [assistantId, skillPendingRemoval, uninstallMutation]);

  const selectedSkill = useMemo(() => {
    if (!selectedSkillId) {
      return null;
    }
    return installedSkills.find((s) => s.id === selectedSkillId) ?? null;
  }, [installedSkills, selectedSkillId]);

  const removalDialog = (
    <ConfirmDialog
      open={skillPendingRemoval !== null}
      title="Remove skill"
      message={
        skillPendingRemoval
          ? `Remove "${skillPendingRemoval.name}" from this assistant?`
          : ""
      }
      confirmLabel="Remove"
      destructive
      onConfirm={confirmRemove}
      onCancel={() => setSkillPendingRemoval(null)}
    />
  );

  if (selectedSkill) {
    return (
      <>
        <SkillDetail
          assistantId={assistantId}
          skill={selectedSkill}
          skills={installedSkills}
          onBack={() => setSelectedSkillId(null)}
          onSelectSkill={(id) => setSelectedSkillId(id)}
          onInstall={() => handleInstall(selectedSkill)}
          onRemove={() => handleRemove(selectedSkill)}
          isInstalling={installingSkillId === (selectedSkill.slug ?? selectedSkill.id)}
          isRemoving={removingSkillId === selectedSkill.id}
        />
        {removalDialog}
      </>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2"
          style={{
            borderColor: "#E5E9F0",
            borderTopColor: "#8D99A5",
          }}
        />
      </div>
    );
  }

  const assistantName = identity?.name || "Assistant";
  const assistantPersonality = identity?.personality || "";
  const assistantRole = identity?.role || "Not set";
  const hatchedDate = assistantCreatedAt
    ? new Date(assistantCreatedAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Unknown";

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 lg:flex-row lg:items-stretch">
      <div
        className={`mx-auto w-full max-w-md lg:mx-0 lg:h-full lg:w-[320px] lg:shrink-0 lg:overflow-y-auto ${
          constellationFullscreen ? "hidden" : "flex"
        }`}
      >
        <IdentityCard
          assistantName={assistantName}
          assistantPersonality={assistantPersonality}
          assistantRole={assistantRole}
          hatchedDate={hatchedDate}
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          onOpenThread={onOpenThread}
          onOpenModal={handleOpenModal}
        />
      </div>

      <div className="min-h-[480px] min-w-0 flex-1 lg:min-h-0">
        <ConstellationView
          skills={installedSkills}
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          className="h-full w-full"
          isFullscreen={constellationFullscreen}
          onToggleFullscreen={() => setConstellationFullscreen((v) => !v)}
          onSelectSkill={setSelectedSkillId}
        />
      </div>

      <AvatarManagementModal
        open={modalOpen}
        onClose={handleCloseModal}
        assistantId={assistantId}
        customImageUrl={customImageUrl}
        onAvatarChange={handleAvatarChange}
        onGenerateWithAI={onOpenThread ? handleGenerateWithAI : undefined}
      />
      {removalDialog}
    </div>
  );
}
