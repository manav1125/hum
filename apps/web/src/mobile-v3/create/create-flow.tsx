/**
 * Mobile v3 Create — the flow host.
 *
 * Owns the stage stack and nothing else. It is deliberately presentational: the
 * only way it starts a build is by calling `onRun`, so the whole routing rule
 * can be exercised in a test with no router, no stores and no network.
 *
 * ## Why a stack, not nested sheets
 *
 * Design §3: *"Stage two is always a push, never a nested sheet — a sheet inside
 * a sheet loses the back gesture."* So the sheet is one surface, and stages are
 * pushed onto an array inside it. Back pops the array. Each pushed stage carries
 * both a chevron and a swipe-back gesture, because on a 390×844 phone the
 * chevron alone sits outside the thumb arc.
 *
 * The entry lives at the bottom of the stack and is the only stage that can sit
 * at the peek detent; pushing locks the sheet to full, because a pushed screen
 * that can be dragged to 42% is a clipped screen.
 */

import { useCallback, useState } from "react";

import { haptic } from "@/utils/haptics";

import { CreateChipStage } from "./create-chip-stage";
import { CreateDetentSheet, type Detent } from "./create-detent-sheet";
import { CreateEntry, type EntrySuggestion } from "./create-entry";
import { CreateFill } from "./create-fill";
import { CreateGallery } from "./create-gallery";
import { CreatePurpose } from "./create-purpose";
import { fillProgressLabel } from "./create-fill-model";
import type { KnownFact } from "./create-known-facts";
import {
  fromBlank,
  fromChips,
  fromEntry,
  fromFill,
  fromGallery,
  fromPurpose,
  type BuildRequest,
  type EntryAction,
  type Stage,
  type Transition,
} from "./create-spine";
import { getCreateType, withArticle } from "./create-types";
import { useSwipeBack } from "./use-swipe-back";

import "./mv3-create.css";

export interface CreateFlowProps {
  open: boolean;
  onClose: () => void;
  /** Starts the real run. The host seeds a thread and navigates. */
  onRun: (request: BuildRequest) => void;
  /** Facts Cue genuinely holds. `[]` is normal and renders correctly. */
  known?: KnownFact[];
  /** The active Brand Kit's name, or null. Never a placeholder. */
  brandName?: string | null;
  /** Real suggestions resolved by the host. Empty renders none. */
  suggestions?: EntrySuggestion[];
}

export function CreateFlow({
  open,
  onClose,
  onRun,
  known = [],
  brandName = null,
  suggestions = [],
}: CreateFlowProps) {
  const [detent, setDetent] = useState<Detent>("peek");
  const [stack, setStack] = useState<Stage[]>([{ kind: "entry" }]);
  const [galleryShowAll, setGalleryShowAll] = useState(false);

  const stage = stack[stack.length - 1];
  const depth = stack.length - 1;

  const reset = useCallback(() => {
    setStack([{ kind: "entry" }]);
    setDetent("peek");
    setGalleryShowAll(false);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const pop = useCallback(() => {
    setGalleryShowAll(false);
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  /** Apply a spine transition: push a stage, or hand a build to the host. */
  const apply = useCallback(
    (transition: Transition) => {
      if (transition.go === "build") {
        // .medium on hand-off.
        haptic.medium();
        reset();
        onRun(transition.request);
        onClose();
        return;
      }
      setGalleryShowAll(false);
      // A push always takes the full detent — a clipped pushed screen has no
      // way to show its own primary action.
      setDetent("full");
      setStack((prev) => [...prev, transition.stage]);
    },
    [onClose, onRun, reset],
  );

  const onEntryAction = useCallback(
    (action: EntryAction) => apply(fromEntry(action, { known })),
    [apply, known],
  );

  const swipe = useSwipeBack(pop, depth > 0);

  if (!open) return null;

  const navFor = (): { title: string; sub?: string } | null => {
    if (stage.kind === "gallery") {
      const type = getCreateType(stage.typeId);
      const count = type?.templateCount ?? 0;
      return {
        title: type?.label ?? stage.typeId,
        sub: count > 0 ? `${count} templates` : undefined,
      };
    }
    if (stage.kind === "fill") {
      return {
        title: stage.plan.title,
        sub: fillProgressLabel(stage.plan),
      };
    }
    if (stage.kind === "chips") {
      const noun = getCreateType(stage.pending.typeId)?.noun;
      const n = stage.questions.length;
      return {
        title: noun ? withArticle(noun) : "Before I start",
        sub: `${n} question${n === 1 ? "" : "s"}`,
      };
    }
    if (stage.kind === "purpose") return { title: "Not sure" };
    return null;
  };

  const nav = navFor();

  return (
    <CreateDetentSheet
      open={open}
      onClose={close}
      label="Create"
      detent={detent}
      onDetentChange={setDetent}
      lockFull={depth > 0}
    >
      <div
        className="mv3c-stage"
        // Swipe-back is attached to the stage, so the gesture travels with the
        // screen it dismisses rather than the sheet that contains it.
        {...(depth > 0 ? swipe.handlers : {})}
        style={{
          transform: swipe.offset ? `translateX(${swipe.offset}px)` : undefined,
          transition: swipe.dragging ? "none" : undefined,
        }}
      >
        {nav ? (
          <div className="mv3c-navrow">
            <button
              type="button"
              className="mv3c-back"
              aria-label="Back"
              onClick={() => {
                haptic.light();
                pop();
              }}
            >
              ‹
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mv3c-navtitle">{nav.title}</div>
              {nav.sub ? <div className="mv3c-navsub">{nav.sub}</div> : null}
            </div>
            {/* Stage two is never a gate: skipping builds with what we have. */}
            {stage.kind === "chips" ? (
              <button
                type="button"
                className="mv3c-skip"
                onClick={() => {
                  haptic.light();
                  apply(fromChips(stage.pending, {}));
                }}
              >
                Skip
              </button>
            ) : null}
          </div>
        ) : null}

        {stage.kind === "entry" ? (
          <CreateEntry
            detent={detent}
            onExpand={() => setDetent("full")}
            onAction={onEntryAction}
            onClose={close}
            suggestions={suggestions}
          />
        ) : null}

        {stage.kind === "gallery" ? (
          <CreateGallery
            typeId={stage.typeId}
            showingAll={galleryShowAll}
            onShowAll={() => setGalleryShowAll(true)}
            // Re-scope IN PLACE — changing your mind must not cost a pop.
            onSwitchType={(typeId) =>
              setStack((prev) => [
                ...prev.slice(0, -1),
                { kind: "gallery", typeId },
              ])
            }
            onPickTemplate={(templateId) =>
              apply(fromGallery(stage.typeId, templateId, { known }))
            }
            onBlank={() =>
              apply(
                fromBlank(
                  stage.typeId,
                  `Make me ${withArticle(getCreateType(stage.typeId)?.noun ?? "thing")} — I'll describe what I want.`,
                  { known },
                ),
              )
            }
          />
        ) : null}

        {stage.kind === "fill" ? (
          <CreateFill
            plan={stage.plan}
            brandName={brandName}
            // Both exits go through the spine, so neither can route around the
            // chip stage that v29 puts in front of a video / canvas / audio run.
            onBuild={(values) => apply(fromFill(stage.plan, values))}
            onSkip={() => apply(fromFill(stage.plan, stage.plan.prefilled))}
          />
        ) : null}

        {stage.kind === "chips" ? (
          <CreateChipStage
            typeId={stage.pending.typeId}
            noun={getCreateType(stage.pending.typeId)?.noun ?? "thing"}
            questions={stage.questions}
            onBuild={(answers) => apply(fromChips(stage.pending, answers))}
          />
        ) : null}

        {stage.kind === "purpose" ? (
          <CreatePurpose
            onPick={(purposeId) => apply(fromPurpose(purposeId))}
            onDescribe={pop}
          />
        ) : null}
      </div>
    </CreateDetentSheet>
  );
}
