/**
 * ArtefactCard — the thing Cue made, with its verb on it.
 *
 * A drafted email is a card with Send on it. A proposed meeting is a card with
 * a time on it. Never a wall of prose the user has to select and copy out of a
 * chat bubble.
 *
 * SAFETY — read this before adding anything to this file.
 *
 * This component performs no action. Its only outward edge is `onAction`, which
 * posts a surface action to the daemon; the daemon then runs the tool, and any
 * tool in the send / spend / publish / delete class hits the hard checkpoint in
 * `assistant/src/tools/outbound-send.ts` and parks for an explicit human
 * approval that no trust level can clear. That is why a Send button here is
 * safe: it is a request to prepare the send, not the send.
 *
 * The failure mode this is built against is a real one — a background run once
 * emailed a partner with nobody approving it. So: no API client may be imported
 * here, no local "sent" state may be invented, and a gated verb must say, on
 * the card, before it is pressed, that the user still has to approve it.
 */

import { Check, Clock3, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellumai/design-library";

import { parseArtefact } from "@/domains/chat/partner/artefact";
import type { Surface } from "@/domains/chat/types/types";

export interface ArtefactCardProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
}

export function ArtefactCard({ surface, onAction }: ArtefactCardProps) {
  // `requested` records only that WE asked — never that anything happened.
  // The finished state comes from the server via `surface.completed`.
  const [requested, setRequested] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const artefact = parseArtefact(surface);
  if (!artefact) return null;

  const handle = async (actionId: string) => {
    setSubmitting(actionId);
    try {
      const data = surface.actions?.find((a) => a.id === actionId)?.data;
      await onAction(surface.surfaceId, actionId, data);
      setRequested(actionId);
    } finally {
      setSubmitting(null);
    }
  };

  const requestedAction = artefact.actions.find((a) => a.id === requested);
  const done = Boolean(surface.completed);

  return (
    <div
      data-testid="artefact-card"
      data-gated={artefact.hasGatedAction ? "true" : undefined}
      className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4"
    >
      {artefact.kind ? (
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--content-tertiary)]">
          {artefact.kind}
        </div>
      ) : null}
      <h3 className="text-title-small text-[var(--content-strong)]">
        {artefact.title}
      </h3>

      {artefact.fields.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {artefact.fields.map((field) => (
            <div key={field.label} className="contents">
              <dt className="text-[12.5px] text-[var(--content-tertiary)]">
                {field.label}
              </dt>
              <dd className="m-0 min-w-0 break-words text-[12.5px] text-[var(--content-secondary)]">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {artefact.body ? (
        <p className="mt-3 whitespace-pre-wrap text-[13.5px] text-[var(--content-default)]">
          {artefact.body}
        </p>
      ) : null}

      {done ? (
        <div className="mt-4 flex items-center gap-1.5 text-[12.5px] text-[var(--system-positive-strong)]">
          <Check aria-hidden className="size-3.5 shrink-0" />
          {surface.completionSummary ?? "Done"}
        </div>
      ) : requestedAction ? (
        // We asked. We do NOT claim it happened — a gated verb is now sitting
        // in front of the approval gate, and that is exactly what we say.
        <div
          data-testid="artefact-awaiting"
          className="mt-4 flex items-center gap-1.5 text-[12.5px] text-[var(--system-mid-strong)]"
        >
          <Clock3 aria-hidden className="size-3.5 shrink-0" />
          {requestedAction.gated
            ? "Waiting on your approval."
            : "Working on it."}
        </div>
      ) : artefact.actions.length > 0 ? (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {artefact.actions.map((action) => (
              <Button
                key={action.id}
                variant={action.primary ? "primary" : "outlined"}
                disabled={submitting !== null}
                onClick={() => void handle(action.id)}
                leftIcon={
                  submitting === action.id ? (
                    <Loader2 className="animate-spin" />
                  ) : undefined
                }
              >
                {action.label}
              </Button>
            ))}
          </div>
          {artefact.hasGatedAction ? (
            <div
              data-testid="artefact-approval-note"
              className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--content-tertiary)]"
            >
              <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
              You approve it before it leaves.
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
