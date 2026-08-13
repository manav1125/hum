/**
 * Mv3SkillHistory — a skill's recent revisions, in the mobile-v3 grammar.
 *
 * The data is the same read the desktop detail page performs
 * (`useSkillHistory` → `GET …/skills/{id}/history`): one entry per update to
 * the whole skill, newest first, bounded by workspace history compaction. The
 * PRESENTATION is not shared. The desktop component is a card in a wide
 * two-column page with two line-number gutters per diff row; a phone sheet has
 * ~320px of usable width, so this is a native disclosure instead — a quiet
 * summary row that opens onto the list, and each revision opening onto its
 * diff.
 *
 * Two rules the sheet depends on:
 *
 *  · **Secondary by default.** History is reference material, not the reason
 *    the sheet opened, so the section is collapsed and the collapsed state
 *    carries the only fact most readers want ("last changed 3 weeks ago").
 *  · **The diff scrolls itself.** Source lines are arbitrarily long and must
 *    never widen the sheet. Each diff sits in its own `overflow-x: auto` well
 *    with `overscroll-behavior-x: contain`, so a sideways swipe pans the code
 *    and stops at its edge rather than chaining out to the sheet behind it.
 *
 * The section is absent — not empty — when there is nothing behind it. An
 * assistant without the route 404s, which the hook maps to "no revisions", so
 * an older instance renders exactly as it did before this existed.
 */

import { useMemo, useState } from "react";

import {
  parseUnifiedDiff,
  type DiffRow,
} from "@/domains/intelligence/skills/parse-unified-diff";
import {
  shouldShowHistorySection,
  useSkillHistory,
  type SkillRevision,
} from "@/domains/intelligence/skills/use-skill-history";
import { formatFullLocalDate, formatRelativeDate } from "@/utils/format-date";
import { haptic } from "@/utils/haptics";

import { microLabel, mv3Mono } from "../mv3-kit";

/**
 * The changed-files line for a revision row.
 *
 * A phone row is one line wide, so a revision touching five files is spelled
 * as its first file plus a count rather than an ellipsised path soup — the
 * count is the honest part, and the full list is one tap away in the diff.
 */
export function revisionFilesLabel(files: string[]): string {
  if (files.length === 0) return "";
  if (files.length === 1) return files[0];
  return `${files[0]} +${files.length - 1} more`;
}

/** "3 changes" / "1 change" — the collapsed row's right-hand count. */
export function revisionCountLabel(count: number): string {
  return `${count} change${count === 1 ? "" : "s"}`;
}

/* ─────────────────────────────── The section ─────────────────────────────── */

export function Mv3SkillHistory({
  assistantId,
  skillId,
}: {
  assistantId: string | null;
  skillId: string;
}) {
  const { revisions, truncatedByCompaction, isLoading, isError } =
    useSkillHistory(assistantId, skillId);

  if (
    !shouldShowHistorySection({
      isLoading,
      isError,
      revisionCount: revisions.length,
    })
  ) {
    return null;
  }

  return (
    <Mv3SkillHistoryCard
      skillId={skillId}
      revisions={revisions}
      truncatedByCompaction={truncatedByCompaction}
      isError={isError}
    />
  );
}

/**
 * The rendered card, separated from the query so the collapse behaviour and
 * the diff container can be exercised with fixture revisions.
 */
export function Mv3SkillHistoryCard({
  skillId,
  revisions,
  truncatedByCompaction,
  isError = false,
}: {
  skillId: string;
  revisions: SkillRevision[];
  truncatedByCompaction: boolean;
  /** The read failed — say so rather than implying the skill never changed. */
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const summary = isError
    ? "Couldn't load"
    : revisions.length > 0
      ? `Last changed ${formatRelativeDate(revisions[0].changedAt)}`
      : "";

  return (
    <div
      data-slot="mv3-skill-history"
      style={{
        background: "var(--mv3-card)",
        border: "1px solid var(--mv3-card-border)",
        borderRadius: 18,
        // The sheet is the only thing that scrolls sideways-never; a card that
        // cannot be squeezed below its content is how that promise breaks.
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        disabled={isError}
        onClick={() => {
          haptic.light();
          setOpen((v) => !v);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          width: "100%",
          minHeight: 48,
          padding: "12px 15px",
          background: "transparent",
          border: "none",
          textAlign: "left",
          fontFamily: "inherit",
          color: "var(--mv3-text)",
          cursor: isError ? "default" : "pointer",
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              ...microLabel,
              fontSize: 9.5,
              color: "var(--mv3-muted)",
              display: "block",
            }}
          >
            History
          </span>
          {summary ? (
            <span
              style={{
                display: "block",
                marginTop: 3,
                fontSize: 12.5,
                color: "var(--mv3-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {summary}
            </span>
          ) : null}
        </span>
        {isError ? null : (
          <>
            <span
              style={{ fontSize: 11.5, color: "var(--mv3-muted)", flexShrink: 0 }}
            >
              {revisionCountLabel(revisions.length)}
            </span>
            <span
              aria-hidden
              style={{
                flexShrink: 0,
                color: "var(--mv3-muted)",
                fontSize: 12,
                display: "inline-block",
                transform: open ? "rotate(90deg)" : undefined,
                transition: "transform .14s ease",
              }}
            >
              ›
            </span>
          </>
        )}
      </button>

      {open && !isError ? (
        <div style={{ borderTop: "1px solid var(--mv3-line)", minWidth: 0 }}>
          {revisions.map((revision) => (
            <RevisionRow
              key={revision.id}
              revision={revision}
              skillId={skillId}
            />
          ))}
          {truncatedByCompaction ? (
            <p
              style={{
                margin: 0,
                padding: "10px 15px 12px",
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--mv3-muted)",
              }}
            >
              Recent changes only — older history is periodically compacted.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── One revision ──────────────────────────────── */

function RevisionRow({
  revision,
  skillId,
}: {
  revision: SkillRevision;
  skillId: string;
}) {
  const [open, setOpen] = useState(false);
  // Parsing walks the whole diff and the collapsed row needs it only for the
  // +/- counts, so it stays off the render path of a list that may hold 20.
  const parsed = useMemo(
    () => parseUnifiedDiff(revision.diff, skillId),
    [revision.diff, skillId],
  );

  return (
    <div style={{ borderTop: "1px solid var(--mv3-line)", minWidth: 0 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          haptic.light();
          setOpen((v) => !v);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          minHeight: 48,
          padding: "10px 15px",
          background: "transparent",
          border: "none",
          textAlign: "left",
          fontFamily: "inherit",
          color: "var(--mv3-text)",
          cursor: "pointer",
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 13,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {formatRelativeDate(revision.changedAt)}
          </span>
          <span
            style={{
              display: "block",
              marginTop: 2,
              fontFamily: mv3Mono,
              fontSize: 10.5,
              color: "var(--mv3-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {revisionFilesLabel(revision.files)}
          </span>
        </span>
        {parsed.added > 0 ? (
          <span
            style={{
              flexShrink: 0,
              fontFamily: mv3Mono,
              fontSize: 11.5,
              color: "var(--mv3-green-text)",
            }}
          >
            +{parsed.added}
          </span>
        ) : null}
        {parsed.removed > 0 ? (
          <span
            style={{
              flexShrink: 0,
              fontFamily: mv3Mono,
              fontSize: 11.5,
              color: "var(--mv3-fail-text)",
            }}
          >
            &minus;{parsed.removed}
          </span>
        ) : null}
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            color: "var(--mv3-muted)",
            fontSize: 12,
            display: "inline-block",
            transform: open ? "rotate(90deg)" : undefined,
            transition: "transform .14s ease",
          }}
        >
          ›
        </span>
      </button>

      {open ? (
        <div style={{ padding: "0 15px 12px", minWidth: 0 }}>
          <p
            style={{
              margin: "0 0 8px",
              fontSize: 11,
              color: "var(--mv3-muted)",
            }}
          >
            {formatFullLocalDate(revision.changedAt)}
          </p>
          {parsed.files.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: "var(--mv3-muted)" }}>
              No preview available for this change.
            </p>
          ) : (
            parsed.files.map((file) => (
              <div key={file.path} style={{ marginBottom: 8, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: mv3Mono,
                    fontSize: 10.5,
                    color: "var(--mv3-muted)",
                    marginBottom: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {file.path}
                </div>
                <DiffWell rows={file.rows} />
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The horizontally scrolling diff container.
 *
 * `overflowX: auto` is what keeps a 200-column source line inside this box;
 * `overscrollBehaviorX: contain` is what stops the swipe that reaches its end
 * from continuing into whatever scrolls behind it. `maxWidth: 100%` plus the
 * `minWidth: 0` on every ancestor is what stops the intrinsic width of the
 * `width: max-content` row stack from widening the sheet instead of
 * overflowing inside this element.
 */
function DiffWell({ rows }: { rows: DiffRow[] }) {
  return (
    <div
      data-slot="mv3-diff-well"
      style={{
        maxWidth: "100%",
        overflowX: "auto",
        overflowY: "hidden",
        overscrollBehaviorX: "contain",
        WebkitOverflowScrolling: "touch",
        background: "var(--mv3-token-well)",
        border: "1px solid var(--mv3-token-well-border)",
        borderRadius: 10,
        padding: "6px 0",
      }}
    >
      <div style={{ width: "max-content", minWidth: "100%" }}>
        {rows.map((row, index) => (
          <DiffLine key={index} row={row} />
        ))}
      </div>
    </div>
  );
}

/**
 * One rendered diff row. A phone drops the desktop's second line-number
 * gutter: two 38px columns is a quarter of the usable width, and the number a
 * reader wants on a change they are reading forwards is the one in the file
 * as it stands now.
 */
function DiffLine({ row }: { row: DiffRow }) {
  if (row.type === "meta") {
    return (
      <div
        aria-hidden
        style={{
          padding: "1px 12px",
          fontFamily: mv3Mono,
          fontSize: 11,
          color: "var(--mv3-muted)",
        }}
      >
        ⋯
      </div>
    );
  }

  const isAdd = row.type === "add";
  const isDel = row.type === "del";

  return (
    <div
      style={{
        display: "flex",
        whiteSpace: "pre",
        fontFamily: mv3Mono,
        fontSize: 11,
        lineHeight: 1.55,
        color: isAdd
          ? "var(--mv3-green-text)"
          : isDel
            ? "var(--mv3-fail-text)"
            : "var(--mv3-muted)",
      }}
    >
      <span
        style={{
          width: 30,
          flexShrink: 0,
          paddingRight: 6,
          textAlign: "right",
          color: "var(--mv3-muted)",
        }}
      >
        {row.newNo ?? row.oldNo ?? ""}
      </span>
      <span style={{ width: 12, flexShrink: 0, textAlign: "center" }}>
        {isAdd ? "+" : isDel ? "-" : " "}
      </span>
      <span style={{ paddingRight: 12 }}>{row.text}</span>
    </div>
  );
}
