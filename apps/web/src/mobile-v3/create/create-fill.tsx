/**
 * Mobile v3 Create — J3, fill.
 *
 * Design's rule 1, restated as what this component may and may not render:
 *
 *   MAY   state what Cue knows as a checkable block, then ask the gaps
 *   MAY   ask nothing, when there are no gaps (the host skips this screen)
 *   MAY   say plainly that it knows nothing yet, and ask only what's required
 *   NEVER render a bare list of empty inputs with no framing
 *
 * The last one is the load-bearing prohibition and it is covered by a test. The
 * defence is structural rather than stylistic: `buildFillPlan` never puts an
 * optional input in `gaps`, so even with an empty known block a template with
 * eight inputs asks its four required ones — and the headline says which case
 * you are in, so "I've got most of it" is never shown over an empty block.
 *
 * Shape follows 1d rather than a form: each ask is a chat-style card, chip rows
 * where the registry declares options, one text field where it doesn't. The
 * primary action sits in the footer, inside the thumb arc at any sheet height.
 */

import { useMemo, useState } from "react";

import { haptic } from "@/utils/haptics";

import {
  fillHeadline,
  fillProgressLabel,
  knownHeadline,
  type FillPlan,
  type Gap,
} from "./create-fill-model";

import "./mv3-create.css";

export interface CreateFillProps {
  plan: FillPlan;
  /** The active Brand Kit's name, when there is one. Null renders honestly. */
  brandName?: string | null;
  onBuild: (values: Record<string, string | string[]>) => void;
  /** Build with what we have — the gaps become the model's problem, stated. */
  onSkip: () => void;
}

type Values = Record<string, string | string[]>;

function GapField({
  gap,
  value,
  onChange,
}: {
  gap: Gap;
  value: string | string[] | undefined;
  onChange: (next: string | string[]) => void;
}) {
  if (gap.kind === "chips" && gap.options?.length) {
    return (
      <div className="mv3c-askfield" role="group" aria-label={gap.label}>
        {gap.options.map((option) => (
          <button
            key={option}
            type="button"
            className="mv3c-optchip"
            aria-pressed={value === option}
            onClick={() => {
              haptic.light();
              onChange(option);
            }}
          >
            {option}
          </button>
        ))}
      </div>
    );
  }

  const isLong = gap.kind === "long_text";
  const inputType =
    gap.kind === "number" ? "number" : gap.kind === "url" ? "url" : "text";
  const shown = Array.isArray(value) ? value.join(", ") : (value ?? "");

  if (isLong) {
    return (
      <textarea
        className="mv3c-askinput"
        rows={2}
        aria-label={gap.label}
        placeholder={gap.placeholder ?? "One or two sentences…"}
        value={shown}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <input
      className="mv3c-askinput"
      type={inputType}
      aria-label={gap.label}
      placeholder={
        gap.placeholder ??
        (gap.kind === "tags" ? "Comma separated" : undefined)
      }
      value={shown}
      onChange={(e) =>
        onChange(
          gap.kind === "tags"
            ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
            : e.target.value,
        )
      }
    />
  );
}

export function CreateFill({
  plan,
  brandName,
  onBuild,
  onSkip,
}: CreateFillProps) {
  const [values, setValues] = useState<Values>(() => ({ ...plan.prefilled }));
  const [showDeferred, setShowDeferred] = useState(false);

  const set = (key: string, next: string | string[]) =>
    setValues((prev) => ({ ...prev, [key]: next }));

  // Every required gap answered — the button is only live when the build has
  // what it needs. "Skip" remains available and is a different, stated act.
  const ready = useMemo(
    () =>
      plan.gaps.every((gap) => {
        const v = values[gap.key];
        return Array.isArray(v) ? v.length > 0 : Boolean(v?.toString().trim());
      }),
    [plan.gaps, values],
  );

  const known = knownHeadline(plan);

  return (
    <>
      <div className="mv3c-flow">
        {/* The framing sentence. Rule 1 is that this is never absent. */}
        {known ? (
          <>
            <div className="mv3c-said">{known}</div>
            <div className="mv3c-known">
              {plan.known.map((fact) => (
                <div key={fact.id} className="mv3c-knownrow">
                  <span className="mv3c-tick" aria-hidden>
                    ✓
                  </span>
                  <span className="mv3c-knownlabel">{fact.label}</span>
                  <span className="mv3c-knownvalue">{fact.value}</span>
                  <span className="mv3c-origin">{fact.origin}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="mv3c-said">
            I don't have anything on this yet, so I'll ask for the essentials
            and work the rest out as I build.
          </div>
        )}

        {plan.gaps.length > 0 ? (
          <>
            <div className="mv3c-said">{fillHeadline(plan)}</div>
            <div className="mv3c-ask">
              {plan.gaps.map((gap) => (
                <div key={gap.key}>
                  <div className="mv3c-asklabel">{gap.label}</div>
                  <GapField
                    gap={gap}
                    value={values[gap.key]}
                    onChange={(next) => set(gap.key, next)}
                  />
                  {gap.help ? (
                    <div className="mv3c-disclaimer">{gap.help}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {/* Optional inputs are reachable, never blocking — this is the other
            half of how eight fields become two questions. */}
        {plan.deferred.length > 0 ? (
          showDeferred ? (
            <div className="mv3c-ask">
              {plan.deferred.map((gap) => (
                <div key={gap.key}>
                  <div className="mv3c-asklabel">{gap.label}</div>
                  <GapField
                    gap={gap}
                    value={values[gap.key]}
                    onChange={(next) => set(gap.key, next)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <button
              type="button"
              className="mv3c-rescue"
              style={{ textAlign: "left", marginTop: 0 }}
              onClick={() => {
                haptic.light();
                setShowDeferred(true);
              }}
            >
              <span>
                Add {plan.deferred.length} more detail
                {plan.deferred.length === 1 ? "" : "s"} ›
              </span>{" "}
              — I'll work without them
            </button>
          )
        ) : null}

        <div style={{ height: 4 }} />
      </div>

      <div className="mv3c-footer">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mv3c-brandchip">
            {brandName ? `In your brand · ${brandName}` : "No brand kit set"}
          </span>
        </div>
        <button
          type="button"
          className="mv3c-primary"
          disabled={!ready}
          onClick={() => {
            haptic.medium();
            onBuild(values);
          }}
        >
          Build it →
        </button>
        <div className="mv3c-footnote">
          {ready
            ? "Lands in the thread — you can leave while it runs."
            : `${fillProgressLabel(plan)} · fill these in, or skip and I'll ask as I go.`}
        </div>
        {!ready ? (
          <button
            type="button"
            className="mv3c-rescue"
            onClick={() => {
              haptic.light();
              onSkip();
            }}
          >
            <span>Skip and build anyway ›</span>
          </button>
        ) : null}
      </div>
    </>
  );
}
