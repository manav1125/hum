/**
 * SheetReferencePicker — "make it look like this" for the mobile Create sheet
 * (spec frame 36). The desktop CreateReference flow (create-view.tsx
 * ReferenceDrop/ReferenceChip) mounted into the sheet with mobile input
 * affordances: the dashed "＋ Drop image or paste URL" pill opens the photo
 * picker AND carries an inline paste/type field for URLs.
 *
 * Extraction parity note: like desktop, the "Extracting the look…" beat is
 * COSMETIC (a 900ms state) — no vision endpoint runs here. The reference
 * rides into `CreateIntent.reference` and the skill does the real extraction
 * at generation time (see create-intent.ts referenceContract). The traits
 * line is therefore the contract's generic trait set ("palette · composition
 * · mood"), never fabricated per-image traits.
 *
 * The confirmed chip rides exactly ONE generation (the parent clears it on
 * submit) and is dismissible via ✕.
 */
import { useEffect, useRef, useState } from "react";

import { haptic } from "@/utils/haptics";

import type { CreateReference } from "./create-intent";

/** True for strings that look like an http(s) URL a user might paste. */
function looksLikeUrl(v: string): boolean {
  return /^https?:\/\/\S+$/i.test(v.trim());
}

/** Short display name for an image reference (desktop parity). */
function referenceImageName(ref: string): string {
  if (ref.startsWith("blob:") || ref.startsWith("data:")) {
    return "uploaded image";
  }
  const tail = ref.split("/").pop() ?? ref;
  return tail.length > 28 ? `${tail.slice(0, 25)}…` : tail;
}

/** Short display name for a URL reference (host, sans scheme/www). */
function referenceUrlHost(ref: string): string {
  try {
    return new URL(ref).hostname.replace(/^www\./, "");
  } catch {
    return ref.length > 28 ? `${ref.slice(0, 25)}…` : ref;
  }
}

const CARD: React.CSSProperties = {
  background: "var(--mv3-card)",
  border: "1px solid var(--mv3-card-border)",
  borderRadius: 18,
  padding: "13px 14px",
};

/** 44×44 leading thumb — image cover or link glyph. */
function RefThumb({ reference }: { reference: CreateReference }) {
  return (
    <span
      aria-hidden
      style={{
        width: 44,
        height: 44,
        borderRadius: 11,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        fontSize: 16,
        color: "var(--mv3-micro)",
        background:
          reference.kind === "image"
            ? `center / cover no-repeat url("${reference.ref}"), var(--mv3-btn2-bg)`
            : "var(--mv3-btn2-bg)",
      }}
    >
      {reference.kind === "url" ? "🔗" : null}
    </span>
  );
}

export function SheetReferencePicker({
  reference,
  onReference,
  onClear,
}: {
  reference: CreateReference | null;
  onReference: (r: CreateReference) => void;
  onClear: () => void;
}) {
  const [extracting, setExtracting] = useState<CreateReference | null>(null);
  const [draft, setDraft] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const beginExtract = (ref: CreateReference) => {
    haptic.light();
    setDraft("");
    setExtracting(ref);
    if (timer.current) clearTimeout(timer.current);
    // Brief "extracting the look…" beat (desktop parity, cosmetic).
    timer.current = setTimeout(() => {
      setExtracting(null);
      onReference(ref);
    }, 900);
  };

  const takeFile = (file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    beginExtract({ kind: "image", ref: URL.createObjectURL(file) });
  };

  const commitDraft = (text: string) => {
    if (looksLikeUrl(text)) beginExtract({ kind: "url", ref: text.trim() });
  };

  /* 36b — live extraction card. */
  if (extracting) {
    return (
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <RefThumb reference={extracting} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 5,
                  background: "var(--mv3-accent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <span style={{ display: "flex", gap: 1.5, height: 6 }}>
                  <span
                    style={{
                      width: 1.5,
                      background: "#ffffff",
                      animation:
                        "createRefBar .9s ease-in-out 0s infinite",
                    }}
                  />
                  <span
                    style={{
                      width: 1.5,
                      background: "#ffffff",
                      animation:
                        "createRefBar .9s ease-in-out .3s infinite",
                    }}
                  />
                </span>
              </span>
              <span style={{ fontSize: 12.5, color: "var(--mv3-micro)" }}>
                Extracting the look…
              </span>
            </div>
            <div
              style={{
                fontSize: 10.5,
                color: "var(--mv3-muted)",
                marginTop: 3,
              }}
            >
              palette · composition · mood
            </div>
          </div>
          <button
            type="button"
            aria-label="Cancel reference"
            onClick={() => {
              if (timer.current) clearTimeout(timer.current);
              setExtracting(null);
            }}
            style={{
              flexShrink: 0,
              minWidth: 44,
              minHeight: 44,
              margin: "-10px -14px -10px 0",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              color: "var(--mv3-faint)",
              fontFamily: "inherit",
            }}
          >
            ✕
          </button>
        </div>
        {/* transform-only bars; frozen by the [data-mv3] reduced-motion rule */}
        <style>
          {"@keyframes createRefBar{0%,100%{transform:scaleY(.4)}50%{transform:scaleY(1)}}"}
        </style>
      </div>
    );
  }

  /* 36c — confirmed reference chip (rides ONE generation, dismissible). */
  if (reference) {
    const name =
      reference.kind === "image"
        ? referenceImageName(reference.ref)
        : referenceUrlHost(reference.ref);
    return (
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <RefThumb reference={reference} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--mv3-text)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              Reference: {name}
            </div>
            <div
              style={{
                fontSize: 10.5,
                color: "var(--mv3-muted)",
                marginTop: 3,
              }}
            >
              palette · composition · mood — for this one generation only
            </div>
          </div>
          <button
            type="button"
            aria-label="Remove reference"
            onClick={() => {
              haptic.light();
              onClear();
            }}
            style={{
              flexShrink: 0,
              minWidth: 44,
              minHeight: 44,
              margin: "-10px -14px -10px 0",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              color: "var(--mv3-faint)",
              fontFamily: "inherit",
            }}
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  /* 36a — dashed affordance: photo picker + inline paste/type URL field. */
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "var(--mv3-btn2-bg)",
        border: "1px dashed color-mix(in srgb, var(--mv3-muted) 55%, transparent)",
        borderRadius: 99,
        padding: "2px 6px 2px 4px",
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          takeFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="cue-pressable"
        aria-label="Add a style reference from your photos"
        onClick={() => fileInput.current?.click()}
        style={{
          flexShrink: 0,
          minWidth: 44,
          minHeight: 44,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontSize: 15,
          color: "var(--mv3-micro)",
          fontFamily: "inherit",
        }}
      >
        ＋
      </button>
      <input
        aria-label="Paste a URL to borrow its look"
        placeholder="Drop image or paste URL"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          // A pasted/typed URL commits as soon as it reads as one.
          if (looksLikeUrl(e.target.value)) commitDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitDraft(draft);
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text/plain");
          if (looksLikeUrl(text)) {
            e.preventDefault();
            commitDraft(text);
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 16,
          padding: "10px 8px 10px 0",
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--mv3-text)",
          fontFamily: "inherit",
        }}
      />
    </div>
  );
}
