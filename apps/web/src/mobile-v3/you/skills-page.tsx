/**
 * Mv3SkillsPage — the mobile Skills surface (spec frame 18: marketplace + the
 * consent moment · frame 30: installed-skill manage). Rendered by SkillsTab's
 * mobile branch; the desktop Skills grid is untouched.
 *
 * Segments:
 *  · Explore   — marketplace items streamed per enabled source (the SAME
 *                `useSourceItems` read the desktop Marketplace page uses),
 *                with the daemon skills catalog as the fallback when no
 *                marketplace source is enabled. "Get" runs the REAL two-phase
 *                install: plan → the consent sheet → confirm.
 *  · Installed — installed + bundled skills (`skillsGet`); tap → the frame-30
 *                manage screen.
 *
 * A horizontal category chip row (the desktop rail's `skillsCategoriesGet`
 * taxonomy) filters whichever daemon-skill list the segment shows — the
 * Installed segment and the catalog Explore fallback. Marketplace items carry
 * no category, so the row honestly hides for marketplace results.
 *  · Sources   — the real marketplace source registry (add/remove/toggle).
 *
 * The consent sheet renders the skill's DECLARED capability manifest from the
 * install plan: connectors/network read as ✓ allow (green), secrets/writes as
 * ‖ asks-first (amber) — the daemon's own elevated-capability split.
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
import { rebrandSkillProse } from "@/domains/intelligence/skills/utils";
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

/* ────────────────────────── Consent sheet (frame 18) ─────────────────────── */

function capabilityRows(caps: InstallResponse["capabilities"]): {
  label: string;
  elevated: boolean;
}[] {
  const rows: { label: string; elevated: boolean }[] = [];
  if (caps.connectors.length > 0)
    rows.push({
      label: `Use ${caps.connectors.join(", ")}`,
      elevated: false,
    });
  if (caps.network.length > 0)
    rows.push({
      label: `Reach ${caps.network.slice(0, 3).join(", ")}`,
      elevated: false,
    });
  if (caps.writes.length > 0)
    rows.push({
      label: `Write to ${caps.writes.slice(0, 3).join(", ")}`,
      elevated: true,
    });
  if (caps.secrets.length > 0)
    rows.push({
      label: `Use secrets: ${caps.secrets.join(", ")}`,
      elevated: true,
    });
  return rows;
}

function ConsentSheet({
  plan,
  confirming,
  error,
  onConfirm,
  onClose,
}: {
  plan: InstallResponse | null;
  confirming: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const rows = plan ? capabilityRows(plan.capabilities) : [];
  return (
    <SheetShell
      open={plan !== null}
      onClose={onClose}
      label="Before it can run"
    >
      {plan ? (
        <div style={{ padding: "2px 2px 8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <SkillTile emoji={plan.item?.emoji} size={40} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                Before it can run
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-muted)",
                  marginTop: 1,
                }}
              >
                You approve what every skill may touch
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginTop: 14,
            }}
          >
            {rows.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--mv3-btn2-bg)",
                  borderRadius: 12,
                  padding: "10px 12px",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 7,
                    background: "color-mix(in srgb, var(--mv3-green) 15%, transparent)",
                    color: "var(--mv3-green)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                  }}
                >
                  ✓
                </span>
                <span style={{ fontSize: 12.5, flex: 1 }}>
                  Declares no elevated capabilities — instructions only
                </span>
                <span
                  style={{ fontSize: 10.5, color: "var(--mv3-green)" }}
                >
                  allow
                </span>
              </div>
            ) : (
              rows.map((row) => (
                <div
                  key={row.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: row.elevated
                      ? "color-mix(in srgb, var(--mv3-amber) 8%, transparent)"
                      : "var(--mv3-btn2-bg)",
                    border: row.elevated
                      ? "1px solid color-mix(in srgb, var(--mv3-amber) 30%, transparent)"
                      : "1px solid transparent",
                    borderRadius: 12,
                    padding: "10px 12px",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 7,
                      background: `color-mix(in srgb, ${
                        row.elevated ? "var(--mv3-amber)" : "var(--mv3-green)"
                      } 16%, transparent)`,
                      color: row.elevated
                        ? "var(--mv3-amber)"
                        : "var(--mv3-green)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: row.elevated ? 700 : 400,
                      flexShrink: 0,
                    }}
                  >
                    {row.elevated ? "‖" : "✓"}
                  </span>
                  <span style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>
                    {row.label}
                  </span>
                  <span
                    style={{
                      fontSize: 10.5,
                      color: row.elevated
                        ? "var(--mv3-amber)"
                        : "var(--mv3-green)",
                      flexShrink: 0,
                    }}
                  >
                    {row.elevated ? "asks first" : "allow"}
                  </span>
                </div>
              ))
            )}
          </div>

          {plan.notice ? (
            <div
              style={{
                fontSize: 11.5,
                color: "var(--mv3-muted)",
                lineHeight: 1.5,
                marginTop: 12,
              }}
            >
              {plan.notice}
            </div>
          ) : null}
          {plan.files ? (
            <div
              style={{
                ...microLabel,
                color: "var(--mv3-faint)",
                marginTop: 10,
              }}
            >
              {plan.files.length} file{plan.files.length === 1 ? "" : "s"} to
              install
              {plan.skipped.length > 0
                ? ` · ${plan.skipped.length} skipped (never executable)`
                : ""}
            </div>
          ) : null}
          {error ? (
            <div style={{ fontSize: 12, color: "#E5675B", marginTop: 10 }}>
              {error}
            </div>
          ) : null}

          <button
            type="button"
            disabled={confirming}
            onClick={() => {
              haptic.medium();
              onConfirm();
            }}
            style={{
              width: "100%",
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              background: "var(--mv3-text)",
              color: "var(--mv3-bg)",
              border: "none",
              borderRadius: 13,
              padding: 13,
              minHeight: 48,
              cursor: confirming ? "default" : "pointer",
              opacity: confirming ? 0.6 : 1,
              marginTop: 13,
            }}
          >
            {confirming ? "Installing…" : "Install with these limits"}
          </button>
        </div>
      ) : null}
    </SheetShell>
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
    skill.sourceRepo ?? skill.author ?? skill.origin,
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
                    <SkillTile emoji={item.emoji} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14.5, fontWeight: 600 }}>
                        {item.displayName}
                      </div>
                      <div
                        style={{
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
                      </div>
                    </div>
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
                        onClick={() => startInstall(item)}
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
                  <SkillTile emoji={skill.emoji ?? skill.icon} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>
                      {skill.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--mv3-muted)",
                        marginTop: 1,
                      }}
                    >
                      {skill.author ?? skill.origin}
                      {typeof skill.installs === "number"
                        ? ` · ${skill.installs.toLocaleString()} installs`
                        : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={catalogInstall.isPending}
                    onClick={() => {
                      haptic.medium();
                      catalogInstall.mutate(skill.slug ?? skill.id);
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
                    {skill.kind === "bundled" ? "built in" : skill.origin}
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

      <ConsentSheet
        plan={plan}
        confirming={marketInstall.isPending}
        error={installError}
        onConfirm={confirmInstall}
        onClose={() => {
          setPlan(null);
          setInstallError(null);
        }}
      />
    </YouScreen>
  );
}
