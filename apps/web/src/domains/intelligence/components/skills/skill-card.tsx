import { Loader2 } from "lucide-react";
import type { KeyboardEvent } from "react";

import { SkillIcon } from "@/domains/intelligence/components/skills/skill-icon";
import { SkillOriginTag } from "@/domains/intelligence/components/skills/skill-origin-tag";
import {
  isAvailableSkill,
  isRemovableSkill,
  type SkillInfo,
} from "@/domains/intelligence/skills/types";
import { rebrandSkillProse } from "@/domains/intelligence/skills/utils";

const C = {
  line: "#E5E9F0",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#C9D1DC",
  dangerBorder: "#F0B9AC",
  danger: "#DA491A",
} as const;

interface SkillCardProps {
  skill: SkillInfo;
  onSelect: () => void;
  onInstall?: () => void;
  onRemove?: () => void;
  isInstalling?: boolean;
  isRemoving?: boolean;
}

/**
 * One skill card in the Skills list — a direct translation of the skill row in
 * surfaces/Skills.dc.html: a 30px icon, the name + origin tag, a clamped
 * description, and a trailing action. Removable (custom/installed) skills get a
 * danger-bordered trash; bundled Cue skills get a muted, non-interactive trash;
 * not-yet-installed catalog skills get an install affordance.
 */
export function SkillCard({
  skill,
  onSelect,
  onInstall,
  onRemove,
  isInstalling = false,
  isRemoving = false,
}: SkillCardProps) {
  const available = isAvailableSkill(skill);
  const removable = isRemovableSkill(skill);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        padding: "14px 16px",
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        background: "#fff",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
          flexShrink: 0,
        }}
      >
        <SkillIcon skill={skill} className="h-[30px] w-[30px]" />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            style={{
              fontSize: 14.5,
              fontWeight: 600,
              color: C.t1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {rebrandSkillProse(skill.name)}
          </span>
          <SkillOriginTag origin={skill.origin} />
        </div>
        <div
          style={{
            fontSize: 13,
            color: C.t2,
            marginTop: 4,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {rebrandSkillProse(skill.description)}
        </div>
      </div>

      {available ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onInstall?.();
          }}
          disabled={!onInstall || isInstalling}
          aria-label="Install skill"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            border: "none",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: C.t2,
            cursor: isInstalling ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {isInstalling ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <span aria-hidden style={{ fontSize: 16 }}>
              ⤓
            </span>
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (removable) onRemove?.();
          }}
          disabled={!removable || isRemoving || !onRemove}
          aria-label={
            removable ? "Remove skill" : "Bundled skill cannot be removed"
          }
          title={removable ? undefined : "Bundled skills cannot be removed"}
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            border: removable ? `1px solid ${C.dangerBorder}` : "none",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: removable ? C.danger : C.t3,
            cursor: removable && !isRemoving ? "pointer" : "default",
            flexShrink: 0,
          }}
        >
          {isRemoving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <span aria-hidden style={{ fontSize: 15 }}>
              🗑
            </span>
          )}
        </button>
      )}
    </div>
  );
}
