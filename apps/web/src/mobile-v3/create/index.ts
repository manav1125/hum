/**
 * Mobile v3 Create — the public surface.
 *
 * This barrel is the contract other mobile-v3 workstreams build against. Nothing
 * outside this folder should import a file from it directly; if something you
 * need isn't here, ask rather than reach in, so the internals stay free to move.
 *
 * ## For the chats workstream
 *
 * Three things, and only three:
 *
 * 1. **`openMv3Create()`** — the composer's ✎ handler. Optionally takes
 *    `{ seedText }` so a half-typed sentence rides into Create instead of being
 *    dropped, and `{ projectTitle }` when the calling surface has genuinely
 *    resolved one.
 *
 *    ```tsx
 *    import { openMv3Create } from "@/mobile-v3/create";
 *    <button aria-label="Create" onClick={() => openMv3Create({ seedText: draft })}>✎</button>
 *    ```
 *
 * 2. **`<Mv3CreateSheet />`** — mount once, near the app root (not per screen).
 *    It reads the store, so it needs no props. Create owns everything inside it.
 *
 * 3. **`<CreateBuildingCard />` and `<CreateArtefactCard />`** — the two cards
 *    that land in a thread. Both are pure: no stores, no queries, no navigation.
 *    Build a `BuildState` with `startBuild()`, advance it with `observeStep()`
 *    from the turn's tool stream, and finish with `deliverBuild()` or
 *    `failBuild()`. Render the building card while `phase` is queued/building
 *    and the artefact card after — the artefact card renders the failure itself
 *    when `phase` is `failed`, so there is no third component to remember.
 *
 *    `remixChipsFor(typeId, asset)` and `adjacentOfferFor(typeId, asset)` supply
 *    the card's chips and its single offer; `filingLine(destination)` is already
 *    called inside the card, so pass a `FilingDestination` built from
 *    `destinationFromOutput()` or, at minimum, `{ conversationId }`.
 *
 * Two things to know before wiring the cards:
 *
 * - **`deliverBuild(state, null)` does not deliver.** A run that ends with no
 *   artefact routes to a failure, because a no-op is not a success. Do not
 *   pre-empt this with a placeholder artefact to "make the card render".
 * - **There is no build percentage or "n of m".** The pipeline emits no artefact
 *   ordinal, so the model exposes none. `elapsedLabel()` is a real clock and is
 *   safe to show; anything shaped like progress is not available.
 */

/* The host + the summon seam. */
export { Mv3CreateSheet } from "./mv3-create-sheet";
export {
  openMv3Create,
  closeMv3Create,
  useMv3CreateStore,
  type CreateSummonContext,
} from "./create-store";

/* The flow, for hosts that want to place it themselves. */
export { CreateFlow, type CreateFlowProps } from "./create-flow";

/* The thread cards. */
export {
  CreateBuildingCard,
  CreateArtefactCard,
  type CreateBuildingCardProps,
  type CreateArtefactCardProps,
} from "./create-thread-cards";

/* Build state — construct and advance a build. */
export {
  startBuild,
  observeStep,
  deliverBuild,
  failBuild,
  isDelivered,
  elapsedLabel,
  elapsedSeconds,
  narrationLine,
  statusEyebrow,
  LEAVE_PROMISE,
  type BuildState,
  type BuildPhase,
  type BuildArtefact,
  type BuildFailure,
} from "./create-build-model";

/* Filing — rule 3. */
export {
  filingLine,
  hasRichDestination,
  destinationFromOutput,
  type FilingDestination,
  type LibraryKind,
  type OutputRowLike,
} from "./create-filing";

/* Follow-ups — rules 4 and 5. */
export {
  remixChipsFor,
  adjacentOfferFor,
  type RemixChip,
  type RemixAction,
  type AdjacentOffer,
} from "./create-followups";

/* Facts — for hosts that can prove more than this one can. */
export {
  brandFact,
  contextFact,
  memoryFacts,
  staticFactsProvider,
  EMPTY_FACTS_PROVIDER,
  type KnownFact,
  type FactOrigin,
  type KnownFactsProvider,
} from "./create-known-facts";

/* The types + the spine, for tests and for surfaces that route into Create. */
export {
  MV3_CREATE_TYPES,
  getCreateType,
  galleryEntriesFor,
  type Mv3CreateType,
  type Mv3GalleryEntry,
} from "./create-types";
export {
  fromEntry,
  fromGallery,
  fromBlank,
  fromPurpose,
  inferType,
  PURPOSE_OPTIONS,
  type BuildRequest,
  type EntryAction,
  type Stage,
  type Transition,
} from "./create-spine";
export {
  buildFillPlan,
  fillHeadline,
  fillProgressLabel,
  isEmptyForm,
  type FillPlan,
  type Gap,
  type GapKind,
} from "./create-fill-model";
export { skeletonFor, type Skeleton } from "./create-skeleton";
