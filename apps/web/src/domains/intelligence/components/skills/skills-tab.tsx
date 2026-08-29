import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { requestComposerFocus } from "@/utils/composer-focus";
import { routes } from "@/utils/routes";

import { SkillCard } from "@/domains/intelligence/components/skills/skill-card";
import { SkillCategoryIndex } from "@/domains/intelligence/components/skills/skill-category-index";
import { SkillDetail } from "@/domains/intelligence/components/skills/skill-detail";
import { SkillDetailMobile } from "@/domains/intelligence/components/skills/skill-detail-mobile";
import { installSkill } from "@/domains/intelligence/skills/install";
import {
  isAvailableSkill,
  type SkillFilter,
  type SkillInfo,
} from "@/domains/intelligence/skills/types";
import { useSkillCategories } from "@/domains/intelligence/skills/use-skill-categories";
import {
  resolveFilterParams,
  sortSkills,
} from "@/domains/intelligence/skills/utils";
import {
  skillsGetOptions,
  skillsGetQueryKey,
  useSkillsByIdDeleteMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { type Options } from "@/generated/daemon/sdk.gen";
import type { SkillsGetData } from "@/generated/daemon/types.gen";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useIsMobile, useMobileLayout } from "@/hooks/use-is-mobile";
import { Mv3SkillsPage } from "@/mobile-v3/you/skills-page";
import { getLocalBool, setLocalBool } from "@/utils/local-settings";
import { haptic } from "@/utils/haptics";
import { ConfirmDialog } from "@vellumai/design-library";

interface SkillsTabProps {
  assistantId: string;
  /**
   * Optional skill id to open in the detail view on first mount. Comes from
   * the `?skill=<id>` deep-link. Only seeds the initial state — internal
   * navigation thereafter is local state.
   */
  initialSkillId?: string;
}

const SEARCH_DEBOUNCE_MS = 300;
const TIP_STORAGE_KEY = "vellum:skills:tipDismissed";

/**
 * Token palette — the theme-aware `--mv1-*` layer (src/index.css). Under the
 * dark/velvet themes these resolve to the Skills.dc.html dark-book hexes; under
 * light they fall back to the v0.3 light literals — so the screen follows the
 * active theme instead of pasting the light mock onto the app's dark shell.
 */
const C = {
  ink: "var(--mv1-ink)",
  blue: "var(--mv1-blue)",
  bg: "var(--mv1-canvas)",
  card: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  violet: "var(--mv1-violet)",
  violetWash: "var(--mv1-violet-strong)",
  danger: "var(--mv1-danger)",
} as const;
const SERIF = "'Instrument Serif', Georgia, serif";

/**
 * Skills — a faithful translation of surfaces/Skills.dc.html onto real skill
 * data. The dark editorial hero ("Cue knows N skills — and learns new ones
 * from you"), the tip banner, a search + filter row, then a `240px 1fr` grid:
 * the category index rail on the left and skill cards on the right. Each card
 * carries the real skill's icon, name, origin tag, description, and a delete
 * affordance (danger-bordered when removable).
 *
 * The dark nav + Intelligence tab bar are layout chrome owned by
 * IntelligenceLayout — not rebuilt here. Routed under the active-assistant
 * gate, so `assistantId` is always present.
 *
 * Real data + mutations are preserved: the skills list (with origin/kind/
 * category filters + search), install, remove (confirm dialog), and the
 * empty-state CTA ("Describe a skill in chat" → /assistant/).
 */
export function SkillsTab({ assistantId, initialSkillId }: SkillsTabProps) {
  // MOBILE — the mobile-v3 Skills surface (spec frames 18 + 30: marketplace
  // segments, the consent sheet, installed-skill manage). Branch in a thin
  // wrapper so the desktop body's hooks never change count across a
  // breakpoint flip. Desktop keeps the editorial grid untouched.
  const isMobile = useMobileLayout();
  if (isMobile) {
    return (
      <Mv3SkillsPage
        assistantId={assistantId}
        initialSkillId={initialSkillId}
      />
    );
  }
  return (
    <SkillsTabDesktop
      assistantId={assistantId}
      initialSkillId={initialSkillId}
    />
  );
}

function SkillsTabDesktop({ assistantId, initialSkillId }: SkillsTabProps) {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  const [searchValue, setSearchValue] = useState("");
  const debouncedSearch = useDebouncedValue(
    searchValue.trim(),
    SEARCH_DEBOUNCE_MS,
  );
  const [filter] = useState<SkillFilter>("all");
  const [category, setCategory] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(
    initialSkillId ?? null,
  );
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(
    null,
  );
  const [removingSkillId, setRemovingSkillId] = useState<string | null>(null);
  const [skillPendingRemoval, setSkillPendingRemoval] =
    useState<SkillInfo | null>(null);
  const [tipDismissed, setTipDismissed] = useState(() =>
    getLocalBool(TIP_STORAGE_KEY, false),
  );

  const { data: categories = [] } = useSkillCategories(assistantId);

  const { origin, kind } = useMemo(() => resolveFilterParams(filter), [filter]);

  const skillsQuery = useQuery({
    ...skillsGetOptions({
      path: { assistant_id: assistantId },
      query: {
        include: "catalog",
        origin,
        kind,
        q: debouncedSearch || undefined,
        category: category ?? undefined,
      },
    }),
    select: (
      data,
    ): {
      skills: SkillInfo[];
      categoryCounts?: Record<string, number>;
      totalCount?: number;
    } => ({
      skills: data.skills,
      categoryCounts: data.categoryCounts,
      totalCount: data.totalCount,
    }),
    enabled: Boolean(assistantId),
  });

  // Unfiltered-by-category query: keeps the category index counts + the hero
  // headline total stable while a category is selected (the primary query is
  // narrowed to that category and can't supply the global counts).
  const countsQuery = useQuery({
    ...skillsGetOptions({
      path: { assistant_id: assistantId },
      query: {
        include: "catalog",
        origin,
        kind,
        q: debouncedSearch || undefined,
      },
    }),
    select: (
      data,
    ): {
      skills: SkillInfo[];
      categoryCounts?: Record<string, number>;
      totalCount?: number;
    } => ({
      skills: data.skills,
      categoryCounts: data.categoryCounts,
      totalCount: data.totalCount,
    }),
    enabled: Boolean(assistantId) && category !== null,
  });

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

  const handleDismissTip = useCallback(() => {
    setTipDismissed(true);
    setLocalBool(TIP_STORAGE_KEY, true);
  }, []);

  const allSkills = useMemo(
    () => skillsQuery.data?.skills ?? [],
    [skillsQuery.data?.skills],
  );

  const countsSource = category !== null ? countsQuery.data : skillsQuery.data;
  const { counts, totalCount } = useDerivedCounts(
    countsSource?.skills ?? allSkills,
    countsSource?.categoryCounts,
    countsSource?.totalCount,
  );

  // Active count for the hero sub-line — installed/bundled skills (anything
  // that isn't a not-yet-installed catalog entry).
  const activeCount = useMemo(
    () =>
      (countsSource?.skills ?? allSkills).filter((s) => !isAvailableSkill(s))
        .length,
    [countsSource?.skills, allSkills],
  );

  const displayedSkills = useMemo(() => sortSkills(allSkills), [allSkills]);

  const selectedSkill = useMemo(() => {
    if (!selectedSkillId) return null;
    return allSkills.find((s) => s.id === selectedSkillId) ?? null;
  }, [allSkills, selectedSkillId]);

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
    const detailProps = {
      assistantId,
      skill: selectedSkill,
      skills: displayedSkills,
      onBack: () => setSelectedSkillId(null),
      onSelectSkill: (id: string) => setSelectedSkillId(id),
      onInstall: () => handleInstall(selectedSkill),
      onRemove: () => handleRemove(selectedSkill),
      isInstalling:
        installingSkillId === (selectedSkill.slug ?? selectedSkill.id),
      isRemoving: removingSkillId === selectedSkill.id,
    };
    return (
      <>
        {isMobile ? (
          <SkillDetailMobile {...detailProps} />
        ) : (
          <SkillDetail {...detailProps} />
        )}
        {removalDialog}
      </>
    );
  }

  const isSearching = skillsQuery.isFetching && Boolean(debouncedSearch);

  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        padding: "0 0 24px",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
      }}
    >
      {/* ── Editorial hero ───────────────────────────────────────────── */}
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          background: C.ink,
          borderRadius: 16,
          padding: "20px 24px",
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 22,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(340px 160px at 90% 50%,rgba(127,119,221,.26),transparent 70%)",
          }}
        />
        <div style={{ position: "relative", flex: 1 }}>
          <div
            style={{
              fontFamily: SERIF,
              fontSize: 24,
              color: C.t1,
              letterSpacing: "-.2px",
              lineHeight: 1.2,
            }}
          >
            Cue knows{" "}
            <span style={{ fontStyle: "italic", color: C.violetWash }}>
              <span data-slot="skills-total-count">{totalCount}</span> skill
              {totalCount === 1 ? "" : "s"}
            </span>{" "}
            — and learns new ones from you.
          </div>
          <div style={{ fontSize: 13, color: C.t2, marginTop: 5 }}>
            <span data-slot="skills-active-count">{activeCount}</span>{" "}
            {activeCount === 1 ? "is" : "are"} active right now. Describe any
            task in chat and Cue will build a skill for it.
          </div>
        </div>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              // Skills are written by asking Cue — there is no separate
              // creation surface — so this lands in the composer, focused and
              // ready. It used to navigate to `/assistant/` and stop there:
              // from inside the app that is a move to a page you may already
              // be on, with nothing focused and nothing said, which reads as a
              // button that does nothing at all.
              void navigate(routes.home);
              // With the sentence already written. Focus alone landed you in
              // chat with a blinking cursor and nothing said, which is a
              // button that moved you rather than one that did anything.
              requestComposerFocus(
                "Create a skill for me. Ask me what it should do, when it should run, and what it needs access to — then write it.",
              );
            }}
            style={{
              fontSize: 12.5,
              background: C.violet,
              color: "#fff",
              border: "none",
              borderRadius: 9,
              padding: "10px 17px",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
            }}
          >
            <span aria-hidden>✦</span> Create a skill
          </button>
        </div>
      </div>

      {/* ── Tip banner ───────────────────────────────────────────────── */}
      {!tipDismissed && (
        <div
          style={{
            background: C.bg,
            borderRadius: 12,
            padding: "13px 16px",
            display: "flex",
            alignItems: "center",
            gap: 11,
            fontSize: 13.5,
            color: C.t2,
          }}
        >
          <span aria-hidden style={{ color: C.violet }}>
            ✦
          </span>
          You can create a new custom skill by describing what you want in chat.
          <button
            type="button"
            onClick={handleDismissTip}
            aria-label="Dismiss tip"
            style={{
              marginLeft: "auto",
              color: C.t3,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 13.5,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Search row ───────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <div
          style={{
            flex: 1,
            border: `1px solid ${C.line2}`,
            borderRadius: 11,
            padding: "0 14px",
            display: "flex",
            alignItems: "center",
            gap: 9,
            fontSize: 14,
            color: C.t1,
          }}
        >
          <span aria-hidden style={{ fontSize: 13, color: C.t3 }}>
            🔍
          </span>
          <input
            type="search"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            placeholder="Search skills"
            aria-label="Search skills"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 14,
              color: C.t1,
              padding: "11px 0",
              fontFamily: "inherit",
            }}
          />
          {isSearching && (
            <Loader2 className="size-4 animate-spin" color={C.t3} />
          )}
        </div>
      </div>

      {/* ── Category index + skill cards ─────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "240px 1fr",
          gap: 18,
          marginTop: 16,
          flex: 1,
          minHeight: 0,
        }}
      >
        {!isMobile && (
          <div style={{ overflowY: "auto" }}>
            <SkillCategoryIndex
              categories={categories}
              selected={category}
              onSelect={setCategory}
              counts={counts}
              totalCount={totalCount}
              showCounts={!isSearching}
            />
          </div>
        )}

        <div style={{ minWidth: 0, overflowY: "auto", paddingRight: 4 }}>
          {skillsQuery.isLoading ? (
            <LoadingState />
          ) : skillsQuery.isError ? (
            <ErrorState />
          ) : displayedSkills.length === 0 ? (
            <EmptyState
              category={category}
              onClearCategory={() => setCategory(null)}
              onDescribe={() => void navigate("/assistant/")}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {displayedSkills.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onSelect={() => setSelectedSkillId(skill.id)}
                  onInstall={() => handleInstall(skill)}
                  onRemove={() => handleRemove(skill)}
                  isInstalling={installingSkillId === (skill.slug ?? skill.id)}
                  isRemoving={removingSkillId === skill.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {removalDialog}
    </div>
  );
}

function useDerivedCounts(
  skills: SkillInfo[],
  serverCounts: Record<string, number> | undefined,
  serverTotal: number | undefined,
): { counts: Record<string, number>; totalCount: number } {
  return useMemo(() => {
    if (serverCounts && Object.keys(serverCounts).length > 0) {
      return {
        counts: serverCounts,
        totalCount: serverTotal ?? skills.length,
      };
    }
    const computed: Record<string, number> = {};
    for (const skill of skills) {
      const cat = skill.category ?? "system";
      computed[cat] = (computed[cat] ?? 0) + 1;
    }
    return {
      counts: computed,
      totalCount: serverTotal ?? skills.length,
    };
  }, [skills, serverCounts, serverTotal]);
}

function LoadingState() {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
      aria-hidden
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 76,
            borderRadius: 13,
            background:
              "linear-gradient(90deg,#EEF1F6 0%,#E2E7EF 50%,#EEF1F6 100%)",
            backgroundSize: "340px 100%",
            animation: "cueShimmer 1.3s linear infinite",
          }}
        />
      ))}
    </div>
  );
}

function ErrorState() {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        background: C.card,
        padding: "48px 24px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 8 }} aria-hidden>
        ⚠
      </div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Failed to load skills</div>
      <p style={{ fontSize: 13, color: C.t2, marginTop: 4 }}>
        Something went wrong. Try refreshing the page.
      </p>
    </div>
  );
}

function EmptyState({
  category,
  onClearCategory,
  onDescribe,
}: {
  category: string | null;
  onClearCategory: () => void;
  onDescribe: () => void;
}) {
  if (category) {
    return (
      <div
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          background: "#fff",
          padding: "48px 24px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 28, marginBottom: 8 }} aria-hidden>
          ▦
        </div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>
          No skills in this category
        </div>
        <p style={{ fontSize: 13, color: C.t2, marginTop: 4 }}>
          Try a different category or clear the filter.
        </p>
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            onClearCategory();
          }}
          style={{
            marginTop: 16,
            fontSize: 12.5,
            background: C.blue,
            color: "#fff",
            border: "none",
            borderRadius: 9,
            padding: "9px 16px",
            cursor: "pointer",
          }}
        >
          Show all skills
        </button>
      </div>
    );
  }
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        background: C.card,
        padding: "48px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{ fontSize: 26, marginBottom: 10, color: C.violet }}
        aria-hidden
      >
        ✦
      </div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>No skills yet</div>
      <p
        style={{
          fontSize: 13,
          color: C.t2,
          marginTop: 4,
          maxWidth: 360,
          marginInline: "auto",
        }}
      >
        Cue learns new skills from you — describe any task in chat and Cue will
        build a skill for it.
      </p>
      <button
        type="button"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          onDescribe();
        }}
        style={{
          marginTop: 16,
          fontSize: 12.5,
          background: C.violet,
          color: "#fff",
          border: "none",
          borderRadius: 9,
          padding: "10px 17px",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
        }}
      >
        <span aria-hidden>✦</span> Describe a skill in chat
      </button>
    </div>
  );
}
