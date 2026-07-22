/**
 * `FeatureTour` — the single, always-mounted host that presents coach-mark
 * tips for whichever surface the user is on.
 *
 * Mounted once at the app root (`RootLayout`). Each render it maps the current
 * route to a surface (see `tour-registry.ts`), hands that surface's ordered
 * steps to `useFeatureTour`, and renders one `Coachmark` for the active step.
 * On non-app routes (auth, onboarding) no surface matches and it renders
 * nothing — so tips never interrupt the first-run flow.
 *
 * Everything about *when* a tip shows (show-once, sequencing, opt-out,
 * orientation coordination) lives in the hook + registry; this component is
 * just the glue between the router and the presenter.
 */

import { useMemo } from "react";
import { useLocation } from "react-router";

import { Coachmark } from "@vellumai/design-library";

import {
  stepsForSurface,
  surfaceForPath,
  type CoachStep,
} from "./tour-registry";
import { coachDisabled, useFeatureTour } from "./use-feature-tour";

const NO_STEPS: CoachStep[] = [];

export function FeatureTour() {
  const { pathname } = useLocation();

  const surface = useMemo(() => surfaceForPath(pathname), [pathname]);
  const steps = useMemo(
    () => (surface ? stepsForSurface(surface.id) : NO_STEPS),
    [surface],
  );

  // Hold the tour when the surface gates it (e.g. HQ's one-time orientation
  // panel is still pending) or the user has globally opted out.
  const enabled =
    surface != null && (surface.gate?.() ?? true) && !coachDisabled();

  const tour = useFeatureTour(steps, { enabled, surfaceId: surface?.id });

  if (!tour.activeStep || !tour.targetEl) return null;

  const step = tour.activeStep;

  return (
    <Coachmark
      open
      target={tour.targetEl}
      title={step.title}
      side={step.side}
      align={step.align}
      stepIndex={tour.stepIndex}
      stepCount={tour.stepCount}
      onNext={tour.hasNext ? tour.next : undefined}
      // Always offered: a tip the user can't permanently turn off is nagware,
      // and most surfaces carry a single step (so a `stepCount > 1` gate left
      // them with no opt-out at all). "Skip tour" is global — no more tips
      // anywhere — which is exactly what someone hitting it is asking for.
      onSkip={tour.skip}
      onDismiss={tour.dismiss}
    >
      {step.body}
    </Coachmark>
  );
}
