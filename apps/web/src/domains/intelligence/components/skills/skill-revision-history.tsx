/**
 * Recent revisions for one skill, rendered as an expandable list.
 *
 * One entry is one update to the whole skill, not one file: the daemon diffs a
 * commit against the skill's directory, so a change spanning `SKILL.md` and a
 * companion file arrives as a single revision with a combined diff. Entries
 * are shown newest first and collapsed by default, since the common question
 * is "when did this last change" and the diff is the follow-up.
 *
 * The list is bounded by workspace history compaction, so it is labelled as
 * recent changes and never presented as a complete record.
 *
 * Ported from upstream 4fe79f4a13. Styling is a deliberate placeholder that
 * follows the inline-style palette of `skill-detail.tsx`.
 * TODO(design): replace the hand-rolled disclosure with the design-system
 * Collapsible (keyboard/aria semantics) and align diff colors with the chat
 * file-diff view once the skills surface gets its design pass. Mobile
 * (`skill-detail-mobile.tsx`) does not render history yet.
 */

import { useMemo, useState } from "react";

import {
  parseUnifiedDiff,
  type DiffRow,
} from "@/domains/intelligence/skills/parse-unified-diff";
import {
  useSkillHistory,
  type SkillRevision,
} from "@/domains/intelligence/skills/use-skill-history";
import { formatFullLocalDate, formatRelativeDate } from "@/utils/format-date";

const C = {
  line: "#E5E9F0",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#9AA6B2",
  addText: "#1B7F4B",
  addBg: "#EAF7EF",
  delText: "#B83C12",
  delBg: "#FBEFEA",
  sunken: "#EEF1F6",
} as const;
const MONO = "'DM Mono', ui-monospace, monospace";

export function SkillRevisionHistory({
  assistantId,
  skillId,
}: {
  assistantId: string;
  skillId: string;
}) {
  const { revisions, truncatedByCompaction, isLoading, isError } =
    useSkillHistory(assistantId, skillId);

  if (isLoading) {
    return <EmptyNote>Loading revision history…</EmptyNote>;
  }

  if (isError) {
    return <EmptyNote>Couldn&apos;t load revision history.</EmptyNote>;
  }

  return (
    <SkillRevisionList
      skillId={skillId}
      revisions={revisions}
      truncatedByCompaction={truncatedByCompaction}
    />
  );
}

/**
 * The rendered list, separated from the query so it can be exercised directly
 * with fixture revisions.
 */
export function SkillRevisionList({
  skillId,
  revisions,
  truncatedByCompaction,
}: {
  skillId: string;
  revisions: SkillRevision[];
  truncatedByCompaction: boolean;
}) {
  if (revisions.length === 0) {
    return <EmptyNote>No changes recorded yet.</EmptyNote>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {revisions.map((revision) => (
        <RevisionRow key={revision.id} revision={revision} skillId={skillId} />
      ))}
      {truncatedByCompaction && (
        <p style={{ fontSize: 12, color: C.t3, margin: "2px 2px 0" }}>
          Showing recent changes. Older history is periodically compacted, so
          this may not reach back to when the skill was created.
        </p>
      )}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 13, color: C.t3, padding: "6px 0", margin: 0 }}>
      {children}
    </p>
  );
}

function RevisionRow({
  revision,
  skillId,
}: {
  revision: SkillRevision;
  skillId: string;
}) {
  const [open, setOpen] = useState(false);
  // Parsing walks the whole diff, and the collapsed row needs it only for the
  // +/- counts, so keep it off the render path for a list that may hold 20.
  const parsed = useMemo(
    () => parseUnifiedDiff(revision.diff, skillId),
    [revision.diff, skillId],
  );

  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          padding: "9px 12px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "inherit",
        }}
      >
        <span
          aria-hidden
          style={{
            color: C.t3,
            fontSize: 11,
            display: "inline-block",
            transform: open ? "rotate(90deg)" : undefined,
            transition: "transform .12s",
          }}
        >
          ▶
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              display: "block",
              fontSize: 13.5,
              color: C.t1,
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
              fontSize: 11.5,
              color: C.t3,
              fontFamily: MONO,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {revision.files.join(" · ")}
          </span>
        </span>
        {parsed.added > 0 && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 12,
              fontFamily: MONO,
              color: C.addText,
            }}
          >
            +{parsed.added}
          </span>
        )}
        {parsed.removed > 0 && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 12,
              fontFamily: MONO,
              color: C.delText,
            }}
          >
            &minus;{parsed.removed}
          </span>
        )}
      </button>

      {open && (
        <div style={{ borderTop: `1px solid ${C.line}` }}>
          <p
            style={{
              margin: 0,
              padding: "6px 12px",
              fontSize: 11.5,
              color: C.t3,
            }}
          >
            {formatFullLocalDate(revision.changedAt)}
          </p>
          {parsed.files.length === 0 ? (
            <p
              style={{
                margin: 0,
                padding: "0 12px 10px",
                fontSize: 12,
                color: C.t3,
              }}
            >
              No preview available for this change.
            </p>
          ) : (
            parsed.files.map((file) => (
              <div key={file.path}>
                <p
                  style={{
                    margin: 0,
                    padding: "5px 12px",
                    borderTop: `1px solid ${C.line}`,
                    background: C.sunken,
                    fontFamily: MONO,
                    fontSize: 11,
                    color: C.t2,
                  }}
                >
                  {file.path}
                </p>
                <div
                  style={{
                    overflowX: "auto",
                    padding: "4px 0",
                    fontFamily: MONO,
                    fontSize: 11.5,
                    lineHeight: 1.55,
                  }}
                >
                  {file.rows.map((row, index) => (
                    <DiffLine key={index} row={row} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** One rendered diff row: two line-number gutters, a marker, the text. */
function DiffLine({ row }: { row: DiffRow }) {
  if (row.type === "meta") {
    return (
      <div style={{ padding: "1px 12px", color: C.t3 }} aria-hidden>
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
        backgroundColor: isAdd ? C.addBg : isDel ? C.delBg : undefined,
        color: isAdd ? C.addText : isDel ? C.delText : C.t2,
      }}
    >
      <span
        style={{
          width: 38,
          flexShrink: 0,
          paddingRight: 8,
          textAlign: "right",
          color: C.t3,
        }}
      >
        {row.oldNo ?? ""}
      </span>
      <span
        style={{
          width: 38,
          flexShrink: 0,
          paddingRight: 8,
          textAlign: "right",
          color: C.t3,
        }}
      >
        {row.newNo ?? ""}
      </span>
      <span style={{ width: 14, flexShrink: 0, textAlign: "center" }}>
        {isAdd ? "+" : isDel ? "-" : " "}
      </span>
      <span style={{ flex: 1, paddingRight: 12 }}>{row.text}</span>
    </div>
  );
}
