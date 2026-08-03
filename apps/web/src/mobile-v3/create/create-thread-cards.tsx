/**
 * Mobile v3 Create — the cards that land in a chat thread.
 *
 * These are the two surfaces Create does NOT own the host for: they render
 * inside the mobile chat thread, which another workstream builds. So they are
 * pure presentational components with every value injected — no stores, no
 * queries, no navigation. The chat surface renders them and supplies the
 * callbacks. See `index.ts` for the exported contract.
 *
 * ## What is real here, and what is deliberately not drawn
 *
 * Design's J4 shows "BUILDING · 7 OF 12" over five slide thumbnails, three
 * filled and two dashed. Neither is available:
 *
 * - **No ordinal.** No event in the SSE union carries `{current, total}`. The
 *   step stream is tool-call granularity and `trace_event.sequence` is a
 *   monotonic stream counter with no known total. So the eyebrow reads
 *   "BUILDING" with a real elapsed clock beside it, and never an "n of m".
 * - **No partial thumbnails.** Nothing emits a per-slide image mid-build; the
 *   client has nothing to render until the run completes. So the tiles are the
 *   TEMPLATE SKELETON — real `layoutRhythm` from the chosen template — and the
 *   caption says exactly that. Thumbnails that "fill in" on a timer would be a
 *   fabricated generation, which is the specific failure this codebase already
 *   shipped once with brand extraction.
 *
 * What IS real: the narrated current step (from the turn's tool stream), the
 * elapsed clock, the leave-and-come-back promise (the turn runs server-side
 * against a conversation id), and the filing line (see create-filing.ts).
 */

import { haptic } from "@/utils/haptics";

import { FailureCard } from "../failure-card";
import {
  elapsedLabel,
  isDelivered,
  LEAVE_PROMISE,
  narrationLine,
  statusEyebrow,
  type BuildState,
} from "./create-build-model";
import { filingLine, type FilingDestination } from "./create-filing";
import type { AdjacentOffer, RemixChip } from "./create-followups";
import {
  humanizeStep,
  skeletonFor,
  skeletonTileCount,
  type Skeleton,
} from "./create-skeleton";

import "./mv3-create.css";

/* ----------------------------------------------------------------------- */
/* J4 — building                                                            */
/* ----------------------------------------------------------------------- */

export interface CreateBuildingCardProps {
  state: BuildState;
  /** Re-render clock. Pass `Date.now()` from the host's ticker. */
  now?: number;
}

function SkeletonStrip({ skeleton }: { skeleton: Skeleton }) {
  const count = skeletonTileCount(skeleton);
  return (
    <>
      <div className="mv3c-skeleton" aria-hidden>
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="mv3c-skel" />
        ))}
      </div>
      <div className="mv3c-caption">
        <div className="mv3c-step">
          {skeleton.steps
            .slice(0, count)
            .map(humanizeStep)
            .join(" · ")}
        </div>
        {/* Non-optional: a skeleton without this reads as a preview. */}
        <div className="mv3c-disclaimer">{skeleton.disclaimer}</div>
      </div>
    </>
  );
}

export function CreateBuildingCard({ state, now }: CreateBuildingCardProps) {
  // A finished or failed build is not a building card. The host should have
  // swapped to the artefact card; rendering nothing is safer than showing a
  // spinner over a run that already ended.
  if (state.phase === "delivered" || state.phase === "failed") return null;

  const skeleton = skeletonFor(state.templateId);

  return (
    <div className="mv3c" data-mv3>
      <div className="mv3c-build" role="status" aria-live="polite">
        <div className="mv3c-buildhead">
          <span className="mv3c-bars" aria-hidden>
            <span className="mv3c-bar" />
            <span className="mv3c-bar" style={{ animationDelay: "0.3s" }} />
          </span>
          <span className="mv3c-buildlabel">{statusEyebrow(state)}</span>
          <span className="mv3c-elapsed">{elapsedLabel(state, now)}</span>
        </div>

        {skeleton ? (
          <SkeletonStrip skeleton={skeleton} />
        ) : (
          <div className="mv3c-caption" style={{ borderTop: "none" }}>
            <div className="mv3c-step">{narrationLine(state)}</div>
          </div>
        )}

        {skeleton ? (
          <div className="mv3c-caption">
            <div className="mv3c-step">{narrationLine(state)}</div>
          </div>
        ) : null}
      </div>

      <div className="mv3c-leave">{LEAVE_PROMISE}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* J5 — delivered                                                           */
/* ----------------------------------------------------------------------- */

export interface CreateArtefactCardProps {
  state: BuildState;
  /** Where it filed. Always supplied — the thread is provable at minimum. */
  destination: FilingDestination;
  /** Type-specific remix chips (rule 5). */
  remixChips: RemixChip[];
  /** At most one adjacent offer (rule 4). Null renders no offer block. */
  offer: AdjacentOffer | null;
  onOpen?: () => void;
  onShare?: () => void;
  onRemix: (chip: RemixChip) => void;
  onAcceptOffer: (offer: AdjacentOffer) => void;
  onDeclineOffer: () => void;
  /** Retry a failed build. */
  onRetry?: () => void;
}

export function CreateArtefactCard({
  state,
  destination,
  remixChips,
  offer,
  onOpen,
  onShare,
  onRemix,
  onAcceptOffer,
  onDeclineOffer,
  onRetry,
}: CreateArtefactCardProps) {
  // The failure gate. A failed build renders as a failure — it never falls
  // through to the artefact branch, and it never shows Open / Share / remix
  // chips for a thing that does not exist.
  if (state.phase === "failed" || !isDelivered(state) || !state.artefact) {
    if (state.phase !== "failed") return null;
    return (
      <div className="mv3c" data-mv3>
        <FailureCard
          title="I couldn't finish this"
          reason={state.failure?.message}
          primaryLabel={state.failure?.retryable ? "Try again" : "Tell Cue"}
          onPrimary={() => {
            haptic.light();
            onRetry?.();
          }}
        />
      </div>
    );
  }

  const artefact = state.artefact;

  return (
    <div className="mv3c" data-mv3>
      <div className="mv3c-artefact">
        <div className="mv3c-cover" aria-hidden>
          <div className="mv3c-tile-rule" style={{ height: 5, width: "58%" }} />
          <div
            className="mv3c-tile-rule"
            style={{ height: 2.5, width: "74%", marginTop: 7, opacity: 0.4 }}
          />
          <div style={{ display: "flex", gap: 4, marginTop: 16 }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: 30,
                  borderRadius: 4,
                  background: "var(--mv3c-ghost)",
                }}
              />
            ))}
          </div>
          {/* Only rendered when the run reported a real measure. */}
          {artefact.measure ? (
            <span className="mv3c-measure">{artefact.measure}</span>
          ) : null}
        </div>

        <div className="mv3c-artmeta">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mv3c-tick" style={{ fontSize: 12 }} aria-hidden>
              ✓
            </span>
            <span className="mv3c-artname">{artefact.name}</span>
          </div>

          {/* Rule 3 — "that line is why Create lives in Cue". */}
          <div className="mv3c-filed">{filingLine(destination)}</div>

          <div className="mv3c-actions">
            {onOpen && artefact.openHref !== undefined ? (
              <button
                type="button"
                className="mv3c-open"
                onClick={() => {
                  haptic.medium();
                  onOpen();
                }}
              >
                Open
              </button>
            ) : null}
            {onShare ? (
              <button
                type="button"
                className="mv3c-secondary"
                onClick={() => {
                  haptic.light();
                  onShare();
                }}
              >
                Share
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {remixChips.length > 0 ? (
        <div className="mv3c-remix" role="group" aria-label="Change this">
          {remixChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="mv3c-optchip"
              onClick={() => {
                haptic.light();
                onRemix(chip);
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}

      {offer ? (
        <div className="mv3c-offer">
          <div className="mv3c-offertext">{offer.question}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
            <button
              type="button"
              className="mv3c-offeryes"
              onClick={() => {
                haptic.medium();
                onAcceptOffer(offer);
              }}
            >
              Do it
            </button>
            <button
              type="button"
              className="mv3c-optchip"
              onClick={() => {
                haptic.light();
                onDeclineOffer();
              }}
            >
              Not now
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
