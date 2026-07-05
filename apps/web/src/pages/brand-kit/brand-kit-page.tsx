/**
 * BrandKitStudio — the stateful orchestrator that stitches the Brand Kit
 * surfaces into one flow, used by BOTH the Settings → Brand screen and the
 * onboarding step:
 *
 *   list ─▶ (has active kit) ─▶ review the active kit
 *        └▶ (no kit / "add another") ─▶ entry chooser ─▶ path flow ─▶ review
 *
 * The onboarding step passes `compact` (drops the standalone page chrome) and
 * `onDone` (fired after a save so the step can advance). Settings uses the
 * full chrome and a saved-kit switcher.
 */

import { useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useIsMobile } from "@/hooks/use-is-mobile";

import { C, Display, MicroLabel, Tag, mono } from "./brand-kit-ui";
import { BrandEntryChooser, type BrandPath } from "./brand-entry-chooser";
import { BrandPathFlow, BrandPathsStyle } from "./brand-paths";
import { BrandReview } from "./brand-review";
import {
  toBrandInput,
  useBrandProfiles,
  type BrandProfile,
  type BrandProfileInput,
} from "./use-brand-kit";

type View =
  | { kind: "chooser" }
  | { kind: "path"; path: BrandPath }
  | { kind: "review"; draft: BrandProfileInput; existing: BrandProfile | null };

export function BrandKitStudio({
  compact = false,
  onDone,
  onSkip,
}: {
  /** Drop the page header (onboarding renders its own step chrome). */
  compact?: boolean;
  /** Fired after a successful save (onboarding advances the flow). */
  onDone?: () => void;
  /** Renders the chooser's skip footer (onboarding only). */
  onSkip?: () => void;
}) {
  const assistantId = useActiveAssistantId();
  const { profiles, active, isLoading } = useBrandProfiles(assistantId);

  // Default view resolves once the list loads: an existing active kit lands on
  // its review screen; a first-time user lands on the chooser.
  const [view, setView] = useState<View | null>(null);
  const resolved: View =
    view ??
    (active
      ? { kind: "review", draft: toBrandInput(active), existing: active }
      : { kind: "chooser" });

  const goChooser = () => setView({ kind: "chooser" });

  return (
    <div style={{ position: "relative" }}>
      <BrandPathsStyle />

      {!compact && resolved.kind !== "review" ? (
        <PageHeader profiles={profiles} />
      ) : null}

      {isLoading && !view ? (
        <div style={{ padding: 40, textAlign: "center", color: C.t3 }}>
          <MicroLabel>Loading your brand…</MicroLabel>
        </div>
      ) : resolved.kind === "chooser" ? (
        <BrandEntryChooser
          showHeader={compact}
          onPick={(path) => setView({ kind: "path", path })}
          onSkip={onSkip}
        />
      ) : resolved.kind === "path" ? (
        <BrandPathFlow
          path={resolved.path}
          assistantId={assistantId}
          onBack={goChooser}
          onDraft={(draft) =>
            setView({ kind: "review", draft, existing: null })
          }
        />
      ) : (
        <BrandReview
          assistantId={assistantId}
          initial={resolved.draft}
          existing={resolved.existing}
          onAddAnother={goChooser}
          onSaved={() => onDone?.()}
        />
      )}

      {/* Saved-kit switcher — only in the full Settings surface with 2+ kits. */}
      {!compact && profiles.length > 1 && resolved.kind === "review" ? (
        <SavedKitSwitcher
          profiles={profiles}
          activeId={resolved.existing?.id ?? active?.id ?? null}
          onPick={(p) =>
            setView({ kind: "review", draft: toBrandInput(p), existing: p })
          }
          onAdd={goChooser}
        />
      ) : null}
    </div>
  );
}

function PageHeader({ profiles }: { profiles: BrandProfile[] }) {
  const isMobile = useIsMobile();
  return (
    <div style={{ marginBottom: 26, textAlign: isMobile ? "left" : "center" }}>
      <MicroLabel color={C.blue}>Brand Kit</MicroLabel>
      <Display size={isMobile ? 30 : 40} style={{ margin: "12px 0 10px" }}>
        Set up your brand
      </Display>
      <p
        style={{
          fontSize: 14,
          color: C.t2,
          lineHeight: 1.55,
          maxWidth: 460,
          margin: isMobile ? 0 : "0 auto",
        }}
      >
        {profiles.length
          ? "Your brand rides into every deck, doc, dashboard and image Cue makes."
          : "Cue applies your colors, fonts, logo and voice to every deck, doc, dashboard and image it makes. Start any way you like."}
      </p>
    </div>
  );
}

function SavedKitSwitcher({
  profiles,
  activeId,
  onPick,
  onAdd,
}: {
  profiles: BrandProfile[];
  activeId: string | null;
  onPick: (p: BrandProfile) => void;
  onAdd: () => void;
}) {
  return (
    <div style={{ marginTop: 24 }}>
      <MicroLabel style={{ display: "block", marginBottom: 10 }}>
        Your brands
      </MicroLabel>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {profiles.map((p) => {
          const on = p.id === activeId;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                border: `1px solid ${on ? C.blue : C.line2}`,
                background: on ? C.blueW : C.surface,
                borderRadius: 10,
                padding: "8px 12px",
                cursor: "pointer",
                fontFamily: mono,
                fontSize: 12,
                color: C.t1,
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: p.palette.primary || C.blue,
                }}
              />
              {p.name}
              {p.isActive === 1 ? <Tag tone="green">Active</Tag> : null}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          style={{
            border: `1px dashed ${C.line2}`,
            background: "transparent",
            borderRadius: 10,
            padding: "8px 12px",
            cursor: "pointer",
            fontSize: 12,
            color: C.t3,
          }}
        >
          + Add another brand
        </button>
      </div>
    </div>
  );
}
