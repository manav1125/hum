/**
 * The one adjacent thing Cue noticed while it was in there.
 *
 * Deliberately the quietest card in the transcript: a rule, a sentence, and the
 * offer. It is not an alert and it is not a to-do — it is a colleague
 * mentioning something on the way out. Whether it is allowed to appear at all
 * is decided by `selectAdjacentOffer`, not here.
 */

import { useState } from "react";

import { Button } from "@vellumai/design-library";

import { parseAdjacentOffer } from "@/domains/chat/partner/adjacent-offer";
import type { Surface } from "@/domains/chat/types/types";

export interface AdjacentOfferRowProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
}

export function AdjacentOfferRow({ surface, onAction }: AdjacentOfferRowProps) {
  const [dismissed, setDismissed] = useState(false);
  const offer = parseAdjacentOffer(surface);
  if (!offer || dismissed) return null;

  const actions = (surface.actions ?? []).filter((a) => a.id && a.label);

  return (
    <div
      data-testid="adjacent-offer"
      className="w-full border-l-2 border-[var(--border-element)] py-1 pl-3"
    >
      <p className="m-0 text-[13.5px] text-[var(--content-secondary)]">
        {offer.note}
      </p>
      {actions.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button
              key={action.id}
              variant="outlined"
              size="compact"
              onClick={() =>
                void onAction(surface.surfaceId, action.id, action.data)
              }
            >
              {action.label}
            </Button>
          ))}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="rounded px-1 text-[12.5px] text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
          >
            Not now
          </button>
        </div>
      ) : null}
    </div>
  );
}
