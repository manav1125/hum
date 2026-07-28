/**
 * Device-branching entries for the review + watch-live routes.
 *
 * These three routes were mounted straight onto the mobile-v3 pages, with no
 * `useIsMobile` gate at all — so a desktop user who clicked "Watch it run" or
 * "See the result" from a chat landed on a full-bleed 390px aurora phone
 * surface inside desktop chrome. Same branch shape as
 * `domains/intelligence/desktop-control-page.tsx`: phone gets the frame-16/17
 * pages it was designed for, desktop gets its serif-HQ counterpart.
 *
 * `/assistant/review-queue` and `/assistant/review-queue/list` are two
 * different surfaces on a phone (a swipe pager and its index list) but one on
 * desktop, where the list and the deliverable fit side by side — so both
 * resolve to {@link DesktopReviewPage}, and a `?item=` deep link works either
 * way.
 */
import { useIsMobile } from "@/hooks/use-is-mobile";
import { ReviewIndexPage } from "@/mobile-v3/review/review-index-page";
import { ReviewQueuePage } from "@/mobile-v3/review/review-queue-page";
import { WatchLivePage } from "@/mobile-v3/watch/watch-live-page";

import { DesktopReviewPage } from "./desktop-review-page";
import { DesktopWatchPage } from "./desktop-watch-page";

/** `/assistant/review-queue` — the phone's pager, or the desktop surface. */
export function ReviewQueueRoute() {
  const isMobile = useIsMobile();
  if (isMobile) return <ReviewQueuePage />;
  return <DesktopReviewPage />;
}

/** `/assistant/review-queue/list` — the phone's index, or the same desktop surface. */
export function ReviewIndexRoute() {
  const isMobile = useIsMobile();
  if (isMobile) return <ReviewIndexPage />;
  return <DesktopReviewPage />;
}

/** `/assistant/work/:workItemId/live` — the phone's frame 17, or the desktop timeline. */
export function WatchLiveRoute() {
  const isMobile = useIsMobile();
  if (isMobile) return <WatchLivePage />;
  return <DesktopWatchPage />;
}
