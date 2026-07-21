/**
 * Mv3SkillsPage — the mobile Skills surface (spec frame 18: marketplace + the
 * consent moment · frame 30: installed-skill manage). Rendered by SkillsTab's
 * mobile branch; the desktop Skills grid is untouched.
 *
 * Segments:
 *  · Explore   — marketplace items streamed per enabled source (the SAME
 *                `useSourceItems` read the desktop Marketplace page uses),
 *                with the daemon skills catalog as the fallback when no
 *                marketplace source is enabled. A card tap opens the frame-57
 *                detail sheet; "Get" opens the SAME sheet with the confirm
 *                card focused and runs the REAL two-phase install (plan →
 *                confirm) — no naked installs (see `SkillDetailSheet`).
 *  · Installed — installed + bundled skills (`skillsGet`); tap → the frame-30
 *                manage screen.
 *
 * A horizontal category chip row (the desktop rail's `skillsCategoriesGet`
 * taxonomy) filters whichever daemon-skill list the segment shows — the
 * Installed segment and the catalog Explore fallback. Marketplace items carry
 * no category, so the row honestly hides for marketplace results.
 *  · Sources   — the real marketplace source registry (add/remove/toggle).
 *
 * The detail sheet's "WILL BE ABLE TO" renders the skill's DECLARED capability
 * manifest (marketplace metadata, superseded by the install plan once fetched):
 * connectors/network read as ✓ allow (green), secrets/writes as ‖ asks-first
 * (amber) — the daemon's own elevated-capability split.
 *
 * Frame-30 honesty: per-skill run history, runs·reversed and spend have no
 * per-skill data source yet, so those sections are omitted (never faked).
 * ALLOWED TO renders only when the skill's declared manifest is known (it was
 * installed from the marketplace); otherwise the section is absent.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { installSkill } from "@/domains/intelligence/skills/install";
import {
  isRemovableSkill,
  type SkillInfo,
} from "@/domains/intelligence/skills/types";
import {
  rebrandSkillProse,
  skillOriginLabel,
} from "@/domains/intelligence/skills/utils";
import { useSkillCategories } from "@/domains/intelligence/skills/use-skill-categories";
import { useSkillDetailFiles } from "@/domains/intelligence/skills/use-skill-detail-files";
import { SkillFileContent } from "@/domains/intelligence/components/skills/skill-file-content";
import {
  skillsGetOptions,
  skillsGetQueryKey,
  useSkillsByIdDeleteMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  useAddSource,
  useInstallSkill,
  useInstalled,
  useMarketplaceSources,
  useRemoveSource,
  useSourceItems,
  type InstallResponse,
  type MarketplaceItem,
} from "@/pages/marketplace/use-marketplace";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { SheetShell } from "../sheet-shell";
import { microLabel, primaryBtn, rise } from "../mv3-kit";
import {
  capabilityRows,
  catalogDetailModel,
  marketplaceDetailModel,
  SkillDetailSheet,
} from "./skill-detail-sheet";
import { Eyebrow, QuietLink, SegRail, TrustFootnote, YouScreen } from "./you-kit";

type Segment = "explore" | "installed" | "sources";

function SkillTile({
  emoji,
  size = 36,
}: {
  emoji?: string | null;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: "rgba(61,110,232,.18)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.44),
        flexShrink: 0,
      }}
    >
      {emoji || "✦"}
    </span>
  );
}

/* ───────────────────── Installed-skill manage (frame 30) ─────────────────── */

function SkillManage({
  assistantId,
  skill,
  manifest,
  onBack,
  onRemoved,
}: {
  assistantId: string;
  skill: SkillInfo;
  /** Declared capability manifest, when known (marketplace-installed). */
  manifest: InstallResponse["capabilities"] | null;
  onBack: () => void;
  onRemoved: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);

  const files = useSkillDetailFiles(assistantId, skill.id);
  const removable = isRemovableSkill(skill);

  const remove = useSkillsByIdDeleteMutation({
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries({
        queryKey: skillsGetQueryKey({
          path: { assistant_id: assistantId },
        } as never),
      });
      onRemoved();
    },
  });

  const originLine = [
    skill.sourceRepo ?? skill.author ?? skillOriginLabel(skill.origin),
    skill.version ? `v${skill.version}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const manifestRows = manifest ? capabilityRows(manifest) : [];

  return (
    <YouScreen
      tint="violet"
      testId="mv3-skill-manage"
      back={onBack}
      backLabel="Skills"
      header={
        <div
          style={{
            padding: "4px 22px 14px",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
            <SkillTile emoji={skill.emoji ?? skill.icon} size={52} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: "-.4px",
                }}
              >
                {skill.name}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-muted)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {originLine}
              </div>
            </div>
          </div>
        </div>
      }
    >
      {skill.description ? (
        <GlassCard padding="14px 16px" radius={20} style={rise(0.1)}>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--mv3-muted)",
              lineHeight: 1.55,
            }}
          >
            {rebrandSkillProse(skill.description)}
          </div>
        </GlassCard>
      ) : null}

      {manifestRows.length > 0 ? (
        <GlassCard padding="14px 16px" radius={20} style={rise(0.2)}>
          <Eyebrow>Allowed to</Eyebrow>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 7,
              marginTop: 10,
            }}
          >
            {manifestRows.map((row) => (
              <div
                key={row.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  fontSize: 12.5,
                  color: row.elevated ? "var(--mv3-amber)" : "var(--mv3-text)",
                }}
              >
                <span
                  style={{
                    color: row.elevated
                      ? "var(--mv3-amber)"
                      : "var(--mv3-green)",
                    fontWeight: row.elevated ? 700 : 400,
                  }}
                >
                  {row.elevated ? "‖" : "✓"}
                </span>
                {row.label}
                {row.elevated ? " — asks first" : ""}
              </div>
            ))}
          </div>
        </GlassCard>
      ) : null}

      <GlassCard padding="14px 16px" radius={20} blur={false} style={rise(0.3)}>
        <Eyebrow
          trailing={
            <QuietLink label="View ›" onPress={() => setSourceOpen(true)} />
          }
        >
          Source · SKILL.md
        </Eyebrow>
        <div
          style={{ fontSize: 12, color: "var(--mv3-muted)", marginTop: 8 }}
        >
          {files.fileEntries.length > 0
            ? `${files.fileEntries.length} file${files.fileEntries.length === 1 ? "" : "s"} on your instance — inspect anytime`
            : "Reading the skill's files…"}
        </div>
      </GlassCard>

      {removable ? (
        <div style={{ textAlign: "center", padding: "4px 0" }}>
          <button
            type="button"
            onClick={() => {
              haptic.medium();
              setConfirmingRemove(true);
            }}
            style={{
              fontSize: 13,
              color: "#E5675B",
              background: "none",
              border: "none",
              padding: "10px 16px",
              minHeight: 44,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Uninstall skill
          </button>
        </div>
      ) : (
        <div
          style={{
            textAlign: "center",
            fontSize: 11.5,
            color: "var(--mv3-faint)",
            padding: "6px 0",
          }}
        >
          Built in — this skill ships with Cue and can't be removed.
        </div>
      )}

      {/* SKILL.md sheet — the real file content. */}
      <SheetShell
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
        label={`${skill.name} source`}
      >
        <div style={{ minHeight: 180 }}>
          {files.isContentLoading || files.isFilesLoading ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--mv3-muted)",
                padding: "16px 4px",
              }}
            >
              Loading the source…
            </div>
          ) : files.activeFile ? (
            <SkillFileContent
              fileName={files.activeFile.name}
              content={files.fileContent}
              isBinary={files.isBinary}
              viewMode="preview"
            />
          ) : (
            <div
              style={{
                fontSize: 13,
                color: "var(--mv3-muted)",
                padding: "16px 4px",
              }}
            >
              No files found for this skill.
            </div>
          )}
        </div>
      </SheetShell>

      <ConfirmDialog
        open={confirmingRemove}
        title="Uninstall skill"
        message={`Remove "${skill.name}" from this assistant?`}
        confirmLabel={remove.isPending ? "Removing…" : "Uninstall"}
        destructive
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate({
            path: { assistant_id: assistantId, id: skill.id },
          })
        }
        onCancel={() => {
          if (!remove.isPending) setConfirmingRemove(false);
        }}
      />
    </YouScreen>
  );
}

/* ─────────────────────────────── The screen ──────────────────────────────── */

export function Mv3SkillsPage({
  assistantId,
  initialSkillId,
}: {
  assistantId: string;
  initialSkillId?: string;
}) {
  const queryClient = useQueryClient();
  const [segment, setSegment] = useState<Segment>("explore");
  const [manageId, setManageId] = useState<string | null>(
    initialSkillId ?? null,
  );
  const [newSource, setNewSource] = useState("");
  // Category filter (the desktop rail's categories as a horizontal chip row).
  const [category, setCategory] = useState<string | null>(null);

  // Installed + bundled + catalog skills (the daemon skills store).
  const skillsQuery = useQuery({
    ...skillsGetOptions({
      path: { assistant_id: assistantId },
      query: { include: "catalog" },
    }),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });
  const allSkills = useMemo<SkillInfo[]>(
    () => (skillsQuery.data?.skills ?? []) as SkillInfo[],
    [skillsQuery.data],
  );
  const installedSkills = useMemo(
    () => allSkills.filter((s) => s.kind === "installed" || s.kind === "bundled"),
    [allSkills],
  );
  const catalogSkills = useMemo(
    () => allSkills.filter((s) => s.kind === "catalog"),
    [allSkills],
  );

  // The same daemon category taxonomy the desktop rail filters by. Only
  // daemon skills carry a category (marketplace items don't declare one), so
  // the chip row renders where that data exists: the Installed segment and
  // the catalog Explore fallback.
  const { data: categories = [] } = useSkillCategories(assistantId);

  // Marketplace: sources + per-source items + install plan flow.
  const { sources } = useMarketplaceSources(assistantId);
  const perSource = useSourceItems(assistantId, sources);
  const { installed: installedRecs } = useInstalled(assistantId);
  const marketInstall = useInstallSkill(assistantId);
  const addSource = useAddSource(assistantId);
  const removeSource = useRemoveSource(assistantId);

  const [plan, setPlan] = useState<InstallResponse | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  // Frame 57: card tap → detail sheet; "Get" → the SAME sheet with the
  // confirm card focused (one flow, no naked installs).
  const [detail, setDetail] = useState<
    | { kind: "market"; item: MarketplaceItem }
    | { kind: "catalog"; skill: SkillInfo }
    | null
  >(null);
  const [confirmingInstall, setConfirmingInstall] = useState(false);

  // Catalog fallback install (no consent payload exists on that route).
  const catalogInstall = useMutation({
    mutationFn: (slug: string) => installSkill(assistantId, slug),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: skillsGetQueryKey({
          path: { assistant_id: assistantId },
        } as never),
      });
    },
  });

  const startInstall = (item: MarketplaceItem) => {
    haptic.medium();
    setPendingItemId(item.id);
    setInstallError(null);
    marketInstall.mutate(
      { path: { assistant_id: assistantId }, body: { itemId: item.id } },
      {
        onSuccess: (data) => setPlan(data as InstallResponse),
        onError: (err) =>
          setInstallError(err instanceof Error ? err.message : String(err)),
        onSettled: () => setPendingItemId(null),
      },
    );
  };
  const confirmInstall = () => {
    if (!plan) return;
    setInstallError(null);
    marketInstall.mutate(
      {
        path: { assistant_id: assistantId },
        body: { itemId: plan.skillId, confirm: true },
      },
      {
        onSuccess: () => {
          haptic.success();
          setPlan(null);
          setDetail(null);
          setConfirmingInstall(false);
          void queryClient.invalidateQueries({
            queryKey: skillsGetQueryKey({
              path: { assistant_id: assistantId },
            } as never),
          });
        },
        onError: (err) =>
          setInstallError(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  /** Card tap — open the detail sheet (no install intent yet). */
  const openDetail = (
    target:
      | { kind: "market"; item: MarketplaceItem }
      | { kind: "catalog"; skill: SkillInfo },
  ) => {
    haptic.light();
    setInstallError(null);
    setPlan(null);
    setConfirmingInstall(false);
    setDetail(target);
  };

  /** "Get" — same sheet, confirm card focused; marketplace fetches the plan. */
  const openConfirm = (
    target:
      | { kind: "market"; item: MarketplaceItem }
      | { kind: "catalog"; skill: SkillInfo },
  ) => {
    setInstallError(null);
    setDetail(target);
    setConfirmingInstall(true);
    if (target.kind === "market" && plan?.skillId !== target.item.id) {
      setPlan(null);
      startInstall(target.item);
    }
  };

  const closeDetail = () => {
    setDetail(null);
    setConfirmingInstall(false);
    setPlan(null);
    setInstallError(null);
  };

  /** The confirm card's Install — the real install endpoints. */
  const handleConfirmInstall = () => {
    if (!detail) return;
    if (detail.kind === "market") {
      confirmInstall();
      return;
    }
    haptic.medium();
    setInstallError(null);
    catalogInstall.mutate(detail.skill.slug ?? detail.skill.id, {
      onSuccess: () => {
        haptic.success();
        closeDetail();
      },
      onError: (err) =>
        setInstallError(err instanceof Error ? err.message : String(err)),
    });
  };

  const allItems = useMemo(
    () => perSource.flatMap((group) => group.items),
    [perSource],
  );
  const marketLoading = perSource.some((g) => g.isLoading);

  /** Declared manifest for an installed skill, when the chain is known. */
  const manifestFor = (skill: SkillInfo): InstallResponse["capabilities"] | null => {
    const rec = installedRecs.find((r) => r.skillId === skill.id);
    if (!rec) return null;
    const item = allItems.find(
      (it) => it.source === rec.source && it.skillPath === rec.skillPath,
    );
    return item?.capabilities ?? null;
  };

  const manageSkill = manageId
    ? (installedSkills.find((s) => s.id === manageId) ??
      allSkills.find((s) => s.id === manageId) ??
      null)
    : null;

  if (manageSkill) {
    return (
      <SkillManage
        assistantId={assistantId}
        skill={manageSkill}
        manifest={manifestFor(manageSkill)}
        onBack={() => setManageId(null)}
        onRemoved={() => setManageId(null)}
      />
    );
  }

  const exploreFromMarketplace = allItems.length > 0 || marketLoading;

  // Category chips apply to whichever daemon-skill list the segment shows.
  const categoryList =
    segment === "installed"
      ? installedSkills
      : segment === "explore" && !exploreFromMarketplace
        ? catalogSkills
        : null;
  const categoryCounts = new Map<string, number>();
  if (categoryList) {
    for (const s of categoryList) {
      const slug = s.category || "system";
      categoryCounts.set(slug, (categoryCounts.get(slug) ?? 0) + 1);
    }
  }
  // A selection that no longer matches the visible list quietly reads as All.
  const activeCategory =
    category !== null && categoryCounts.has(category) ? category : null;
  const byCategory = (s: SkillInfo) =>
    activeCategory === null || (s.category || "system") === activeCategory;
  const visibleInstalled = installedSkills.filter(byCategory);
  const visibleCatalog = catalogSkills.filter(byCategory);
  const categoryChips = categories.filter((c) => categoryCounts.has(c.slug));

  return (
    <YouScreen
      tint="violet"
      testId="mv3-skills"
      back={routes.channels}
      header={
        <div
          style={{
            padding: "6px 22px 10px",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <div
            style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.8px" }}
          >
            Skills
          </div>
          <div style={{ marginTop: 10 }}>
            <SegRail<Segment>
              ariaLabel="Skills sections"
              value={segment}
              onChange={setSegment}
              items={[
                { value: "explore", label: "Explore" },
                {
                  value: "installed",
                  label:
                    installedSkills.length > 0
                      ? `Installed · ${installedSkills.length}`
                      : "Installed",
                },
                { value: "sources", label: "Sources" },
              ]}
            />
          </div>
          {categoryList && categoryChips.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <SegRail<string>
                ariaLabel="Filter skills by category"
                value={activeCategory ?? "all"}
                onChange={(v) => setCategory(v === "all" ? null : v)}
                items={[
                  { value: "all", label: `All · ${categoryList.length}` },
                  ...categoryChips.map((c) => ({
                    value: c.slug,
                    label: `${c.label} · ${categoryCounts.get(c.slug) ?? 0}`,
                  })),
                ]}
              />
            </div>
          ) : null}
        </div>
      }
    >
      {segment === "explore" ? (
        <>
          {exploreFromMarketplace ? (
            allItems.length === 0 ? (
              <div
                style={{
                  fontSize: 13,
                  color: "var(--mv3-muted)",
                  padding: "16px 4px",
                }}
              >
                Indexing skill sources…
              </div>
            ) : (
              allItems.slice(0, 40).map((item, i) => (
                <GlassCard
                  key={item.id}
                  padding="14px 16px"
                  radius={20}
                  blur={i < 3}
                  style={rise(0.1 + Math.min(i, 3) * 0.12)}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 11 }}
                  >
                    {/* Frame 57: the card body opens the detail sheet. */}
                    <button
                      type="button"
                      aria-label={`About ${item.displayName}`}
                      className="cue-pressable"
                      onClick={() => openDetail({ kind: "market", item })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 11,
                        flex: 1,
                        minWidth: 0,
                        background: "none",
                        border: "none",
                        padding: 0,
                        textAlign: "left",
                        cursor: "pointer",
                        color: "var(--mv3-text)",
                        fontFamily: "inherit",
                      }}
                    >
                      <SkillTile emoji={item.emoji} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: "block",
                            fontSize: 14.5,
                            fontWeight: 600,
                          }}
                        >
                          {item.displayName}
                        </span>
                        <span
                          style={{
                            display: "block",
                            fontSize: 11,
                            color: "var(--mv3-muted)",
                            marginTop: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.sourceLabel || item.source}
                          {item.license ? ` · ${item.license}` : ""}
                        </span>
                      </span>
                    </button>
                    {item.installed ? (
                      <span
                        style={{
                          ...microLabel,
                          fontSize: 9.5,
                          color: "var(--mv3-green)",
                          background:
                            "color-mix(in srgb, var(--mv3-green) 12%, transparent)",
                          padding: "4px 9px",
                          borderRadius: 6,
                        }}
                      >
                        ✓ Installed
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={pendingItemId === item.id}
                        onClick={() => {
                          haptic.medium();
                          openConfirm({ kind: "market", item });
                        }}
                        style={{
                          ...primaryBtn,
                          flex: "none",
                          padding: "10px 16px",
                          minHeight: 40,
                          fontSize: 12.5,
                          opacity: pendingItemId === item.id ? 0.6 : 1,
                        }}
                      >
                        {pendingItemId === item.id ? "…" : "Get"}
                      </button>
                    )}
                  </div>
                  {item.description ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--mv3-muted)",
                        marginTop: 9,
                        lineHeight: 1.5,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {rebrandSkillProse(item.description)}
                    </div>
                  ) : null}
                </GlassCard>
              ))
            )
          ) : catalogSkills.length > 0 ? (
            visibleCatalog.slice(0, 40).map((skill, i) => (
              <GlassCard
                key={skill.id}
                padding="14px 16px"
                radius={20}
                blur={i < 3}
                style={rise(0.1 + Math.min(i, 3) * 0.12)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  {/* Frame 57: the card body opens the detail sheet. */}
                  <button
                    type="button"
                    aria-label={`About ${skill.name}`}
                    className="cue-pressable"
                    onClick={() => openDetail({ kind: "catalog", skill })}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 11,
                      flex: 1,
                      minWidth: 0,
                      background: "none",
                      border: "none",
                      padding: 0,
                      textAlign: "left",
                      cursor: "pointer",
                      color: "var(--mv3-text)",
                      fontFamily: "inherit",
                    }}
                  >
                    <SkillTile emoji={skill.emoji ?? skill.icon} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: 14.5,
                          fontWeight: 600,
                        }}
                      >
                        {skill.name}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: 11,
                          color: "var(--mv3-muted)",
                          marginTop: 1,
                        }}
                      >
                        {skill.author ?? skillOriginLabel(skill.origin)}
                        {typeof skill.installs === "number"
                          ? ` · ${skill.installs.toLocaleString()} installs`
                          : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={catalogInstall.isPending}
                    onClick={() => {
                      haptic.medium();
                      openConfirm({ kind: "catalog", skill });
                    }}
                    style={{
                      ...primaryBtn,
                      flex: "none",
                      padding: "10px 16px",
                      minHeight: 40,
                      fontSize: 12.5,
                      opacity: catalogInstall.isPending ? 0.6 : 1,
                    }}
                  >
                    Get
                  </button>
                </div>
              </GlassCard>
            ))
          ) : (
            <GlassCard padding="18px 16px">
              <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
                {skillsQuery.isLoading
                  ? "Loading skills…"
                  : "Nothing to explore yet — add a skill source under Sources."}
              </div>
            </GlassCard>
          )}
          {installError && !plan ? (
            <div
              role="status"
              style={{
                fontSize: 12,
                color: "#E5675B",
                textAlign: "center",
              }}
            >
              {installError}
            </div>
          ) : null}
          <TrustFootnote>
            Every skill is reviewed before first use — change limits anytime
          </TrustFootnote>
        </>
      ) : segment === "installed" ? (
        installedSkills.length === 0 ? (
          <GlassCard padding="18px 16px">
            <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
              {skillsQuery.isLoading
                ? "Loading skills…"
                : "Nothing installed yet — describe any task in chat and Cue builds a skill for it."}
            </div>
          </GlassCard>
        ) : (
          <GlassCard padding={0} radius={20} style={{ overflow: "hidden", ...rise(0.1) }}>
            {visibleInstalled.map((skill, i) => (
              <button
                key={skill.id}
                type="button"
                aria-label={`Manage ${skill.name}`}
                className="cue-pressable"
                onClick={() => {
                  haptic.light();
                  setManageId(skill.id);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 15px",
                  minHeight: 56,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  borderBottom:
                    i === visibleInstalled.length - 1
                      ? "none"
                      : "1px solid var(--mv3-line)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  color: "var(--mv3-text)",
                }}
              >
                <SkillTile emoji={skill.emoji ?? skill.icon} size={32} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: 14,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {skill.name}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "var(--mv3-muted)",
                      marginTop: 1,
                    }}
                  >
                    {skill.kind === "bundled"
                      ? "built in"
                      : skillOriginLabel(skill.origin)}
                    {skill.version ? ` · v${skill.version}` : ""}
                  </span>
                </span>
                <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
                  ›
                </span>
              </button>
            ))}
          </GlassCard>
        )
      ) : (
        /* Sources */
        <>
          {sources.length === 0 ? (
            <GlassCard padding="18px 16px">
              <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
                No skill sources yet — add a GitHub repo of SKILL.md folders.
              </div>
            </GlassCard>
          ) : (
            <GlassCard padding={0} radius={20} style={{ overflow: "hidden", ...rise(0.1) }}>
              {sources.map((source, i) => (
                <div
                  key={source.address}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "12px 15px",
                    minHeight: 52,
                    borderBottom:
                      i === sources.length - 1
                        ? "none"
                        : "1px solid var(--mv3-line)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {source.label || source.address}
                    </div>
                    <div
                      style={{
                        fontSize: 10.5,
                        color: "var(--mv3-muted)",
                        marginTop: 1,
                      }}
                    >
                      {source.kind === "github" ? source.address : "built in"}
                      {source.enabled ? "" : " · off"}
                    </div>
                  </div>
                  {!source.builtIn ? (
                    <button
                      type="button"
                      disabled={removeSource.isPending}
                      onClick={() => {
                        haptic.medium();
                        removeSource.mutate({
                          path: { assistant_id: assistantId },
                          query: { address: source.address },
                        });
                      }}
                      style={{
                        fontSize: 12,
                        color: "#E5675B",
                        background: "none",
                        border: "none",
                        padding: "8px 4px",
                        minHeight: 40,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ))}
            </GlassCard>
          )}

          <GlassCard padding="13px 15px" radius={18} style={rise(0.25)}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={newSource}
                onChange={(e) => setNewSource(e.target.value)}
                placeholder="owner/repo"
                aria-label="Add a skill source"
                style={{
                  flex: 1,
                  fontSize: 16,
                  fontFamily: "inherit",
                  color: "var(--mv3-text)",
                  background: "var(--mv3-btn2-bg)",
                  border: "1px solid var(--mv3-btn2-border)",
                  borderRadius: 11,
                  padding: "10px 13px",
                  minHeight: 44,
                  minWidth: 0,
                  outline: "none",
                }}
              />
              <button
                type="button"
                disabled={
                  newSource.trim().length === 0 || addSource.isPending
                }
                onClick={() => {
                  haptic.medium();
                  addSource.mutate(
                    {
                      path: { assistant_id: assistantId },
                      body: { address: newSource.trim() },
                    },
                    { onSuccess: () => setNewSource("") },
                  );
                }}
                style={{
                  ...primaryBtn,
                  flex: "none",
                  padding: "10px 18px",
                  minHeight: 44,
                  opacity:
                    newSource.trim().length === 0 || addSource.isPending
                      ? 0.55
                      : 1,
                }}
              >
                {addSource.isPending ? "Adding…" : "Add"}
              </button>
            </div>
            {addSource.isError ? (
              <div style={{ fontSize: 12, color: "#E5675B", marginTop: 8 }}>
                Couldn't add that source — check the repo address.
              </div>
            ) : null}
          </GlassCard>
        </>
      )}

      {/* Frame 57: skill detail + install confirm — one sheet, one flow. */}
      <SkillDetailSheet
        open={detail !== null}
        model={
          detail === null
            ? null
            : detail.kind === "market"
              ? marketplaceDetailModel(detail.item)
              : catalogDetailModel(detail.skill)
        }
        installed={detail?.kind === "market" && Boolean(detail.item.installed)}
        confirming={confirmingInstall}
        planPending={
          detail?.kind === "market" && pendingItemId === detail.item.id
        }
        plan={detail?.kind === "market" ? plan : null}
        installing={
          detail?.kind === "market"
            ? marketInstall.isPending && pendingItemId === null
            : catalogInstall.isPending
        }
        error={installError}
        onGet={() => {
          if (detail) openConfirm(detail);
        }}
        onConfirm={handleConfirmInstall}
        onClose={closeDetail}
      />
    </YouScreen>
  );
}
