/**
 * Mobile v3 native design system — foundation barrel.
 *
 * Spec: docs/design/mobile-v3/ (README + cue-mobile-v3.html). Everything in
 * this directory is mobile-gated by its call sites; the `--mv3-*` token layer
 * lives in ./mv3.css (imported from src/index.css) and never touches the
 * `--mv1-*` layer or desktop styles.
 */
export { AuroraBackdrop } from "./aurora-backdrop";
export { GlassCard, type GlassTint } from "./glass-card";
export { CueRing, CueRingHero, type OrbitChip } from "./cue-ring";
export { StateChip, type Mv3State } from "./state-chip";
export { TabBarV3 } from "./tab-bar-v3";
export { Mv3OverflowMenu } from "./overflow-menu";
export {
  overflowVisible,
  CORNER_CHROME_BAND,
  CORNER_CHROME_INSET,
} from "./corner-chrome";
export { LargeTitleHeader } from "./large-title-header";
export {
  SharedMobileHeader,
  type SharedHeaderAction,
  type SharedHeaderPill,
} from "./shared-header";
export { SheetShell } from "./sheet-shell";
export {
  cardBody,
  cardTitle,
  microLabel,
  mv3Font,
  mv3Mono,
  primaryBtn,
  rise,
  secondaryBtn,
} from "./mv3-kit";
export { Mv3Today } from "./today/mv3-today";
