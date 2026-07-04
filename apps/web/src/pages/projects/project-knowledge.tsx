/**
 * Project knowledge — the Claude-Projects-style panel on the project detail
 * page. Upload files or pin links; Cue materializes the files into the agent's
 * workspace and reads them when working ANY task in this project (the runner
 * lists them in every run's preamble alongside the context brief).
 *
 * Matches the detail page's mv1-token styling (theme-aware light/dark) and
 * stacks cleanly on mobile: the header actions wrap, rows are single-column.
 */

import { FileText, Link2, Paperclip, Plus, X } from "lucide-react";
import { useRef, useState } from "react";

import { C, mono, relativeTime } from "@/domains/activity/theme";

import type { ProjectKnowledgeItem } from "./use-project-knowledge";
import {
  useAddProjectKnowledge,
  useProjectKnowledge,
  useRemoveProjectKnowledge,
  useUploadKnowledgeFiles,
} from "./use-project-knowledge";

function formatSize(sizeBytes: number | null | undefined): string | null {
  if (sizeBytes == null) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function KnowledgeRow({
  item,
  onRemove,
  removing,
}: {
  item: ProjectKnowledgeItem;
  onRemove: () => void;
  removing: boolean;
}) {
  const isFile = item.kind === "file";
  const label = item.label ?? item.filename ?? item.url ?? "…";
  const meta = isFile
    ? [item.mimeType, formatSize(item.sizeBytes)].filter(Boolean).join(" · ")
    : item.url;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 9,
        border: `1px solid ${C.line}`,
        background: C.sunken,
        minWidth: 0,
      }}
    >
      <span aria-hidden style={{ color: C.t3, display: "flex", flexShrink: 0 }}>
        {isFile ? <FileText size={14} /> : <Link2 size={14} />}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {!isFile && item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "block",
              fontSize: 12.5,
              fontWeight: 500,
              color: C.t1,
              textDecoration: "none",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {label}
          </a>
        ) : (
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: C.t1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {label}
          </div>
        )}
        {meta ? (
          <div
            style={{
              fontFamily: mono,
              fontSize: 10,
              color: C.t3,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginTop: 1,
            }}
          >
            {meta}
          </div>
        ) : null}
      </div>
      {item.addedAt ? (
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            color: C.t3,
            flexShrink: 0,
          }}
        >
          {relativeTime(item.addedAt)}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove ${label}`}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: C.t3,
          cursor: "pointer",
          flexShrink: 0,
          opacity: removing ? 0.4 : 1,
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function ProjectKnowledge({
  assistantId,
  projectId,
  accent,
}: {
  assistantId: string;
  projectId: string;
  accent: string;
}) {
  const { items, isLoading } = useProjectKnowledge(assistantId, projectId);
  const upload = useUploadKnowledgeFiles(assistantId, projectId);
  const addKnowledge = useAddProjectKnowledge(assistantId, projectId);
  const removeKnowledge = useRemoveProjectKnowledge(assistantId, projectId);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [addingLink, setAddingLink] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFilesPicked = (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    setError(null);
    upload.mutate(files, {
      onError: () => setError("Upload failed — try again."),
    });
  };

  const submitLink = () => {
    const raw = linkDraft.trim();
    if (!raw || addKnowledge.isPending) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    setError(null);
    addKnowledge.mutate(
      {
        path: { assistant_id: assistantId, id: projectId },
        body: { url },
      },
      {
        onSuccess: () => {
          setLinkDraft("");
          setAddingLink(false);
        },
        onError: () => setError("Couldn't add that link — is the URL valid?"),
      },
    );
  };

  const remove = (id: string) => {
    setRemovingId(id);
    setError(null);
    removeKnowledge.mutate(
      {
        path: { assistant_id: assistantId, id: projectId, knowledgeId: id },
      },
      { onSettled: () => setRemovingId(null) },
    );
  };

  const actionButtonStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontFamily: mono,
    fontSize: 10.5,
    padding: "4px 10px",
    borderRadius: 7,
    border: `1px solid ${C.line2}`,
    background: "transparent",
    color: C.t2,
    cursor: "pointer",
  };

  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${accent}`,
        background: C.surface,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.t3,
          }}
        >
          Knowledge — Cue reads these
        </span>
        <div
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={upload.isPending}
            style={{
              ...actionButtonStyle,
              opacity: upload.isPending ? 0.5 : 1,
            }}
          >
            <Paperclip size={11} />
            {upload.isPending ? "Uploading…" : "Add files"}
          </button>
          <button
            type="button"
            onClick={() => setAddingLink((v) => !v)}
            style={actionButtonStyle}
          >
            <Link2 size={11} /> Add link
          </button>
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
      </div>

      {addingLink ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            autoFocus
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitLink();
              if (e.key === "Escape") {
                setLinkDraft("");
                setAddingLink(false);
              }
            }}
            placeholder="Paste a URL — doc, repo, dashboard…"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              color: C.ink,
              background: C.bg,
              border: `1px solid ${C.line2}`,
              borderRadius: 8,
              padding: "7px 10px",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={submitLink}
            disabled={addKnowledge.isPending || !linkDraft.trim()}
            style={{
              fontFamily: mono,
              fontSize: 11,
              padding: "5px 12px",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              background: C.ink,
              color: C.bg,
              opacity: addKnowledge.isPending || !linkDraft.trim() ? 0.5 : 1,
            }}
          >
            {addKnowledge.isPending ? "Adding…" : "Add"}
          </button>
        </div>
      ) : null}

      {error ? (
        <div style={{ fontSize: 12, color: C.danger, marginBottom: 8 }}>
          {error}
        </div>
      ) : null}

      {items.length > 0 ? (
        <div style={{ display: "grid", gap: 6 }}>
          {items.map((item) => (
            <KnowledgeRow
              key={item.id}
              item={item}
              removing={removingId === item.id}
              onRemove={() => remove(item.id)}
            />
          ))}
        </div>
      ) : isLoading ? (
        <div style={{ fontSize: 12.5, color: C.t3 }}>Loading knowledge…</div>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            padding: "12px 12px",
            border: `1px dashed ${C.line2}`,
            borderRadius: 9,
            background: "transparent",
            fontSize: 12.5,
            color: C.t3,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <Plus size={13} /> Attach docs, specs, or links Cue should know about…
        </button>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 10,
          fontSize: 11,
          color: C.t3,
        }}
      >
        <span style={{ color: accent }}>▸</span>
        Cue can read these when working any task in this project.
      </div>
    </div>
  );
}
