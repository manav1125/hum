/**
 * The two route elements behind `/assistant/your-cue`, branching on layout.
 *
 * Kept as its own file rather than an inline element in `routes.tsx` for one
 * reason: the branch is a *product* decision, not a routing detail, and it
 * needs somewhere to be explained.
 *
 * **Desktop** renders the leaf column beside the door, so the door itself is a
 * redirect — a landing screen you must read before reaching the leaf you came
 * for is a toll.
 *
 * **The phone** has no column. The same redirect drops you inside a single
 * setting with no map, which is how the phone ended up with a settings door
 * that led nowhere legible. It gets the ⓶ screen (v24 F2), and the full leaf
 * list one push behind it (v22 M5).
 */
import { Navigate } from "react-router";

import { useMobileLayout } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";

import { Mv3CueScreen } from "./cue-screen";
import { Mv3YourCuePage } from "./your-cue-page";

export function YourCueDoor() {
  const isMobile = useMobileLayout();
  if (isMobile) return <Mv3CueScreen />;
  return <Navigate to={routes.identity} replace />;
}

export function YourCueAllDoor() {
  const isMobile = useMobileLayout();
  // Desktop's leaf column already IS this list, so the URL folds back into the
  // door rather than rendering a second, worse copy of the rail.
  if (!isMobile) return <Navigate to={routes.identity} replace />;
  return <Mv3YourCuePage />;
}
