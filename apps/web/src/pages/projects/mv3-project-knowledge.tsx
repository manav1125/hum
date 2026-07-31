/**
 * Mv3ProjectKnowledge — the mobile v3 knowledge card (spec frame 41): typed
 * file rows (PDF/XLS/URL badge glyphs) under a "KNOWLEDGE · N FILES"
 * microlabel, with "＋ Add" opening an iOS sheet (upload files / pin a link)
 * and a per-row sheet (open link / remove).
 *
 * DATA — the real project-scoped knowledge store, the same endpoints desktop's
 * ProjectKnowledge uses (GET/POST/DELETE /projects/:id/knowledge + the
 * two-step POST /attachments upload). The runner lists every item here in the
 * run preamble alongside the brief, so the footer copy is honest.
 */
import { useRef, useState } from "react";

import { SheetShell, microLabel, mv3Mono, rise } from "@/mobile-v3";
import { haptic } from "@/utils/haptics";

import type { ProjectKnowledgeItem } from "./use-project-knowledge";
import {
  useAddProjectKnowledge,
  useProjectKnowledge,
  useRemoveProjectKnowledge,
  useUploadKnowledgeFiles,
} from "./use-project-knowledge";

/**
 * Typed badge (frame 41): 26×26 r7 tinted chip with a 9px bold type glyph.
 * PDF red is frame-41-verbatim for dark; light re-tones to the failure-card's
 * AA red leg (#B3453B) per the mechanical dark↔light rule. XLS/URL ride the
 * existing green/micro tokens.
 */
const BADGE_CSS = `
.mv3-pk-badge { --mv3pk-red: #b3453b; }
[data-theme="dark"] .mv3-pk-badge,
[data-theme="velvet"] .mv3-pk-badge { --mv3pk-red: #e5675b; }
`;

function badgeOf(item: ProjectKnowledgeItem): { glyph: string; color: string } {
  if (item.kind === "link") return { glyph: "URL", color: "var(--mv3-micro)" };
  const name = (item.filename ?? item.label ?? "").toLowerCase();
  const mime = (item.mimeType ?? "").toLowerCase();
  if (mime.includes("pdf") || name.endsWith(".pdf"))
    return { glyph: "PDF", color: "var(--mv3pk-red)" };
  if (
    mime.includes("sheet") ||
    mime.includes("excel") ||
    /\.(xlsx?|csv|tsv|numbers)$/.test(name)
  )
    return { glyph: "XLS", color: "var(--mv3-green)" };
  if (mime.includes("word") || /\.(docx?|pages|md|txt|rtf)$/.test(name))
    return { glyph: "DOC", color: "var(--mv3-violet-text)" };
  if (mime.startsWith("image/"))
    return { glyph: "IMG", color: "var(--mv3-teal-text)" };
  return { glyph: "FILE", color: "var(--mv3-muted)" };
}

function formatSize(sizeBytes: number | null | undefined): string | null {
  if (sizeBytes == null) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

const secondaryBtn: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  background: "var(--mv3-btn2-bg)",
  border: "1px solid var(--mv3-btn2-border)",
  color: "var(--mv3-text)",
  borderRadius: 12,
  padding: 10,
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
  textAlign: "left" as const,
};

export function Mv3ProjectKnowledge({
  assistantId,
  projectId,
  delay,
}: {
  assistantId: string;
  projectId: string;
  delay: number;
}) {
  const { items, isLoading, isError } = useProjectKnowledge(
    assistantId,
    projectId,
  );
  const upload = useUploadKnowledgeFiles(assistantId, projectId);
  const addKnowledge = useAddProjectKnowledge(assistantId, projectId);
  const removeKnowledge = useRemoveProjectKnowledge(assistantId, projectId);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openItem = items.find((i) => i.id === openItemId) ?? null;

  const onFilesPicked = (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    setError(null);
    upload.mutate(files, {
      onSuccess: () => {
        haptic.success();
        setAddOpen(false);
      },
      onError: () => setError("Upload failed — try again."),
    });
  };

  const submitLink = () => {
    const raw = linkDraft.trim();
    if (!raw || addKnowledge.isPending) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    setError(null);
    haptic.medium();
    addKnowledge.mutate(
      { path: { assistant_id: assistantId, id: projectId }, body: { url } },
      {
        onSuccess: () => {
          haptic.success();
          setLinkDraft("");
          setAddOpen(false);
        },
        onError: () => setError("Couldn’t add that link — is the URL valid?"),
      },
    );
  };

  const remove = (id: string) => {
    haptic.medium();
    removeKnowledge.mutate(
      { path: { assistant_id: assistantId, id: projectId, knowledgeId: id } },
      { onSuccess: () => setOpenItemId(null) },
    );
  };

  const countLabel =
    items.length > 0
      ? `Knowledge · ${items.length} ${items.length === 1 ? "file" : "files"}`
      : "Knowledge";

  return (
    <>
      <style>{BADGE_CSS}</style>
      <div
        data-mv3
        style={{
          background: "var(--mv3-card)",
          border: "1px solid var(--mv3-card-border)",
          borderRadius: 20,
          padding: "14px 16px",
          ...rise(delay),
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            marginBottom: items.length > 0 ? 4 : 2,
          }}
        >
          <span
            style={{ ...microLabel, fontSize: 9.5, color: "var(--mv3-muted)" }}
          >
            {countLabel}
          </span>
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              setError(null);
              setAddOpen(true);
            }}
            style={{
              marginLeft: "auto",
              fontSize: 11.5,
              color: "var(--mv3-micro)",
              background: "transparent",
              border: "none",
              padding: "12px 0 12px 12px",
              margin: "-12px 0",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            ＋ Add
          </button>
        </div>

        {items.map((item, i) => {
          const badge = badgeOf(item);
          const label = item.label ?? item.filename ?? item.url ?? "…";
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              className="cue-pressable mv3-pk-badge"
              onClick={() => {
                haptic.light();
                setOpenItemId(item.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  haptic.light();
                  setOpenItemId(item.id);
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 0",
                minHeight: 44,
                cursor: "pointer",
                borderBottom:
                  i < items.length - 1
                    ? "1px solid var(--mv3-line)"
                    : "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: `color-mix(in srgb, ${badge.color} 15%, transparent)`,
                  color: badge.color,
                  fontSize: 9,
                  fontWeight: 700,
                  fontFamily: mv3Mono,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {badge.glyph}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  color: "var(--mv3-text)",
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
              <span
                aria-hidden
                style={{ fontSize: 12, color: "var(--mv3-faint)" }}
              >
                ›
              </span>
            </div>
          );
        })}

        {items.length === 0 ? (
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              setAddOpen(true);
            }}
            style={{
              display: "block",
              width: "100%",
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--mv3-muted)",
              background: "transparent",
              border: "none",
              padding: "6px 0",
              minHeight: 44,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
            }}
          >
            {isLoading
              ? "Loading knowledge…"
              : isError
                ? "Couldn’t load knowledge just now."
                : "Attach docs, specs, or links Cue should know about…"}
          </button>
        ) : null}

        <div
          style={{ fontSize: 10.5, color: "var(--mv3-faint)", marginTop: 9 }}
        >
          Cue can read these when working any task in this project.
        </div>
      </div>

      {/* ＋ Add sheet — upload files or pin a link (the real two-step upload). */}
      <SheetShell
        open={addOpen}
        onClose={() => setAddOpen(false)}
        label="Add project knowledge"
      >
        <div
          style={{
            ...microLabel,
            fontSize: 9.5,
            color: "var(--mv3-muted)",
            marginBottom: 12,
          }}
        >
          Add knowledge
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            onFilesPicked(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="cue-pressable"
          disabled={upload.isPending}
          onClick={() => {
            haptic.light();
            fileInputRef.current?.click();
          }}
          style={{ ...secondaryBtn, opacity: upload.isPending ? 0.6 : 1 }}
        >
          {upload.isPending ? "Uploading…" : "📎 Upload files"}
        </button>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitLink();
            }}
            placeholder="Paste a URL — doc, repo, dashboard…"
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              fontSize: 16,
              color: "var(--mv3-text)",
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 12,
              padding: "8px 13px",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <button
            type="button"
            className="cue-pressable"
            disabled={addKnowledge.isPending || !linkDraft.trim()}
            onClick={submitLink}
            style={{
              minHeight: 44,
              padding: "8px 16px",
              borderRadius: 12,
              border: "none",
              background: "var(--mv3-text)",
              color: "var(--mv3-bg)",
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              opacity: addKnowledge.isPending || !linkDraft.trim() ? 0.55 : 1,
            }}
          >
            {addKnowledge.isPending ? "Adding…" : "Add"}
          </button>
        </div>
        {error ? (
          <div style={{ fontSize: 11.5, color: "var(--mv3-amber-text)", marginTop: 8 }}>
            {error}
          </div>
        ) : null}
        <div style={{ fontSize: 11, color: "var(--mv3-faint)", marginTop: 10 }}>
          Cue can read these when working any task in this project.
        </div>
      </SheetShell>

      {/* Per-row sheet — open (links) / remove. */}
      <SheetShell
        open={openItem != null}
        onClose={() => setOpenItemId(null)}
        label="Knowledge item"
      >
        {openItem ? (
          <>
            <div
              style={{
                fontSize: 14.5,
                fontWeight: 600,
                color: "var(--mv3-text)",
                wordBreak: "break-word",
              }}
            >
              {openItem.label ?? openItem.filename ?? openItem.url ?? "…"}
            </div>
            <div
              style={{
                fontFamily: mv3Mono,
                fontSize: 10.5,
                color: "var(--mv3-faint)",
                marginTop: 5,
                wordBreak: "break-all",
              }}
            >
              {openItem.kind === "file"
                ? [openItem.mimeType, formatSize(openItem.sizeBytes)]
                    .filter(Boolean)
                    .join(" · ")
                : openItem.url}
            </div>
            {openItem.kind === "link" && openItem.url ? (
              <a
                href={openItem.url}
                target="_blank"
                rel="noreferrer"
                className="cue-pressable"
                onClick={() => haptic.light()}
                style={{
                  ...secondaryBtn,
                  display: "flex",
                  alignItems: "center",
                  marginTop: 12,
                  textDecoration: "none",
                  boxSizing: "border-box",
                }}
              >
                Open link ›
              </a>
            ) : null}
            <button
              type="button"
              className="cue-pressable"
              disabled={removeKnowledge.isPending}
              onClick={() => remove(openItem.id)}
              style={{
                ...secondaryBtn,
                marginTop: openItem.kind === "link" ? 8 : 12,
                color: "var(--mv3-amber-text)",
                opacity: removeKnowledge.isPending ? 0.6 : 1,
              }}
            >
              {removeKnowledge.isPending
                ? "Removing…"
                : "Remove from project"}
            </button>
          </>
        ) : null}
      </SheetShell>
    </>
  );
}
