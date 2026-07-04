import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { isMarkdown } from "@/components/file-markdown";
import { SkillFileContent } from "@/domains/intelligence/components/skills/skill-file-content";
import { SkillIcon } from "@/domains/intelligence/components/skills/skill-icon";
import {
  isAvailableSkill,
  isRemovableSkill,
  type SkillInfo,
} from "@/domains/intelligence/skills/types";
import { useSkillDetailFiles } from "@/domains/intelligence/skills/use-skill-detail-files";
import { formatFriendlyDate } from "@/utils/format-date";

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#9AA6B2",
  danger: "#DA491A",
  dangerBorder: "#F0B9AC",
} as const;
const MONO = "'DM Mono', ui-monospace, monospace";

interface SkillDetailProps {
  assistantId: string;
  skill: SkillInfo;
  /** Full visible skill list — drives the left rail. */
  skills: SkillInfo[];
  onBack: () => void;
  onSelectSkill: (id: string) => void;
  onInstall?: () => void;
  onRemove?: () => void;
  isInstalling?: boolean;
  isRemoving?: boolean;
}

const metaLabel = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: ".08em",
  textTransform: "uppercase" as const,
  color: C.t3,
};

/**
 * Skill detail — a faithful translation of surfaces/SkillDetail.dc.html onto
 * real skill data. A `240px 1fr` split: a left rail listing the visible skills
 * (the active one highlighted) and a detail pane with the name, an
 * install/remove control, a metadata triplet (Added by / Last updated /
 * Trigger), the description, a rendered SKILL.md definition card with a
 * Preview/Code switch, and the bundle file tree. All wired to the real files
 * API + install/remove mutations.
 *
 * The dark nav is layout chrome owned by IntelligenceLayout — not rebuilt here.
 */
export function SkillDetail({
  skill,
  skills,
  assistantId,
  onBack,
  onSelectSkill,
  onInstall,
  onRemove,
  isInstalling = false,
  isRemoving = false,
}: SkillDetailProps) {
  const available = isAvailableSkill(skill);
  const removable = isRemovableSkill(skill);

  const {
    fileEntries,
    skillMd,
    activePath,
    activeFile,
    setSelectedPath,
    isFilesLoading,
    fileContent,
    isBinary,
    isContentLoading,
  } = useSkillDetailFiles(assistantId, skill.id);

  const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");
  useEffect(() => {
    setViewMode("preview");
  }, [activePath]);

  const activeIsMarkdown = activeFile
    ? isMarkdown(activeFile.name, undefined)
    : false;
  const effectiveViewMode = activeIsMarkdown ? viewMode : "raw";

  const addedBy = originAddedBy(skill);
  const lastUpdated = skill.publishedAt
    ? formatFriendlyDate(new Date(skill.publishedAt))
    : skill.version
      ? `v${skill.version}`
      : "—";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "240px 1fr",
        height: "100%",
        minHeight: 0,
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
      }}
    >
      {/* ── Skill list rail ──────────────────────────────────────────── */}
      <div
        style={{
          borderRight: `1px solid ${C.line}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            padding: "0 6px 10px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <button
            type="button"
            onClick={onBack}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12.5,
              color: C.t2,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "4px 2px",
              fontFamily: "inherit",
            }}
          >
            <span aria-hidden>←</span> Skills
          </button>
        </div>
        <div
          style={{
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 1,
            fontSize: 13.5,
            paddingRight: 4,
          }}
        >
          {skills.map((s) => {
            const active = s.id === skill.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelectSkill(s.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "9px 11px",
                  borderRadius: 9,
                  border: "none",
                  background: active ? C.sunken : "transparent",
                  color: active ? C.t1 : C.t2,
                  fontWeight: active ? 600 : 400,
                  fontSize: 13.5,
                  fontFamily: "inherit",
                  textAlign: "left",
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                <SkillIcon skill={s} className="h-[18px] w-[18px] shrink-0" />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Detail pane ──────────────────────────────────────────────── */}
      <div style={{ overflowY: "auto", minHeight: 0 }}>
        <div style={{ padding: "22px 28px" }}>
          {/* Header row */}
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
                display: "flex",
                alignItems: "center",
                gap: 12,
                minWidth: 0,
              }}
            >
              <SkillIcon skill={skill} className="h-7 w-7 shrink-0" />
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  letterSpacing: "-.3px",
                }}
              >
                {skill.name}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <StatusControl
                available={available}
                removable={removable}
                isInstalling={isInstalling}
                isRemoving={isRemoving}
                onInstall={onInstall}
                onRemove={onRemove}
              />
            </div>
          </div>

          {/* Metadata triplet */}
          <div
            style={{
              display: "flex",
              gap: 40,
              marginTop: 18,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={metaLabel}>Added by</div>
              <div style={{ fontSize: 13.5, marginTop: 4 }}>{addedBy}</div>
            </div>
            <div>
              <div style={metaLabel}>Last updated</div>
              <div style={{ fontSize: 13.5, marginTop: 4 }}>{lastUpdated}</div>
            </div>
            <div>
              <div style={metaLabel}>Category</div>
              <div
                style={{
                  fontSize: 13.5,
                  marginTop: 4,
                  borderBottom: `1px dashed ${C.line2}`,
                  display: "inline-block",
                  textTransform: "capitalize",
                }}
              >
                {skill.category || "general"}
              </div>
            </div>
          </div>

          {/* Description */}
          <div style={{ marginTop: 18 }}>
            <div style={metaLabel}>Description</div>
            <p
              style={{
                fontSize: 14,
                color: C.t2,
                lineHeight: 1.65,
                marginTop: 6,
                maxWidth: 680,
              }}
            >
              {skill.description}
            </p>
          </div>

          {/* Rendered definition */}
          <div
            style={{
              marginTop: 18,
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "11px 16px",
                borderBottom: `1px solid ${C.line}`,
                background: "#FBFBFD",
              }}
            >
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.t2 }}>
                {activeFile?.name ?? skillMd?.name ?? "SKILL.md"}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  gap: 3,
                  background: C.sunken,
                  borderRadius: 8,
                  padding: 3,
                }}
              >
                <ViewPill
                  active={effectiveViewMode === "preview"}
                  disabled={!activeIsMarkdown}
                  onClick={() => setViewMode("preview")}
                >
                  👁 Preview
                </ViewPill>
                <ViewPill
                  active={effectiveViewMode === "raw"}
                  onClick={() => setViewMode("raw")}
                >
                  &lt;/&gt; Code
                </ViewPill>
              </span>
            </div>
            <div style={{ minHeight: 200, maxHeight: 420, overflow: "hidden" }}>
              {isFilesLoading || isContentLoading ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: 200,
                  }}
                >
                  <Loader2 className="size-6 animate-spin" color={C.t3} />
                </div>
              ) : activeFile ? (
                <div style={{ maxHeight: 420, overflow: "auto" }}>
                  <SkillFileContent
                    fileName={activeFile.name}
                    content={fileContent}
                    isBinary={isBinary}
                    viewMode={effectiveViewMode}
                  />
                </div>
              ) : (
                <p
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: 200,
                    fontSize: 13,
                    color: C.t3,
                  }}
                >
                  No definition available.
                </p>
              )}
            </div>
          </div>

          {/* Bundle file tree */}
          <div
            style={{
              marginTop: 14,
              border: `1px solid ${C.line}`,
              borderRadius: 13,
              padding: "14px 16px",
            }}
          >
            <div style={{ ...metaLabel, marginBottom: 10 }}>Bundle</div>
            {isFilesLoading ? (
              <div style={{ display: "flex", padding: "6px 0" }}>
                <Loader2 className="size-4 animate-spin" color={C.t3} />
              </div>
            ) : fileEntries.length === 0 ? (
              <div style={{ fontSize: 13, color: C.t3 }}>
                No files available.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {fileEntries.map((entry) => {
                  const isDirectory = (entry.mimeType ?? "").endsWith(
                    "/directory",
                  );
                  const isActive = entry.path === activePath;
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => setSelectedPath(entry.path)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 13,
                        border: "none",
                        background: "transparent",
                        color: isActive ? C.blue : isDirectory ? C.t2 : C.t1,
                        fontWeight: isActive ? 600 : 400,
                        fontFamily: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      <span aria-hidden>{isDirectory ? "📁" : "📄"}</span>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {entry.name}
                      </span>
                      <span
                        style={{
                          marginLeft: "auto",
                          color: C.t3,
                          fontFamily: MONO,
                          fontSize: 10.5,
                        }}
                      >
                        {isDirectory ? "›" : formatSize(entry.size)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ViewPill({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 11,
        background: active ? "#fff" : "transparent",
        color: active ? C.t1 : C.t2,
        borderRadius: 6,
        padding: "4px 10px",
        border: "none",
        boxShadow: active ? "0 1px 2px rgba(0,0,0,.06)" : undefined,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled && !active ? 0.5 : 1,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

/**
 * The header status affordance. For installed/removable skills this is the
 * on-toggle + Remove pair the mock shows; for catalog skills it's an Install
 * button; bundled (non-removable) skills show the on-toggle alone.
 */
function StatusControl({
  available,
  removable,
  isInstalling,
  isRemoving,
  onInstall,
  onRemove,
}: {
  available: boolean;
  removable: boolean;
  isInstalling: boolean;
  isRemoving: boolean;
  onInstall?: () => void;
  onRemove?: () => void;
}) {
  if (available) {
    return (
      <button
        type="button"
        onClick={onInstall}
        disabled={!onInstall || isInstalling}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontSize: 12.5,
          background: C.ink,
          color: "#fff",
          border: "none",
          borderRadius: 9,
          padding: "8px 16px",
          cursor: isInstalling ? "default" : "pointer",
        }}
      >
        {isInstalling ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <span aria-hidden>⤓</span>
        )}
        Install
      </button>
    );
  }

  return (
    <>
      {/* "on" pill — installed skills are active */}
      <span
        aria-hidden
        style={{
          width: 40,
          height: 23,
          borderRadius: 999,
          background: C.blue,
          position: "relative",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            width: 19,
            height: 19,
            borderRadius: "50%",
            background: "#fff",
            top: 2,
            right: 2,
          }}
        />
      </span>
      {removable && (
        <button
          type="button"
          onClick={onRemove}
          disabled={isRemoving || !onRemove}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            border: `1px solid ${C.dangerBorder}`,
            background: "#fff",
            color: C.danger,
            borderRadius: 9,
            padding: "7px 14px",
            cursor: isRemoving ? "default" : "pointer",
          }}
        >
          {isRemoving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <span aria-hidden>🗑</span>
          )}
          Remove
        </button>
      )}
    </>
  );
}

function originAddedBy(skill: SkillInfo): string {
  switch (skill.origin) {
    case "vellum":
      return "Cue · bundled";
    case "custom":
      return "You · custom";
    case "clawhub":
      return skill.author ? `${skill.author} · Clawhub` : "Clawhub";
    case "skillssh":
      return skill.author ? `${skill.author} · skills.sh` : "skills.sh";
    default:
      return "Cue";
  }
}

function formatSize(size: number | null | undefined): string {
  if (size == null || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
