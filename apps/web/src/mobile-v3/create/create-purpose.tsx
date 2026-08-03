/**
 * Mobile v3 Create — J6, the rescue.
 *
 * Design reframed this deliberately, and the reframing is the whole point:
 * the question is **"what's it for?"**, not "what kind of file?", *because
 * someone unsure doesn't know the format either*. So none of the five answers
 * names an artefact type — each names a JOB, and the spine maps it to a type the
 * user never had to think about.
 *
 * It is reachable only from the entry's "Not sure what you need?" line. Nothing
 * routes here automatically, which is what makes it a rescue rather than a step
 * everyone is marched through.
 */

import { haptic } from "@/utils/haptics";

import { PURPOSE_OPTIONS } from "./create-spine";

import "./mv3-create.css";

export interface CreatePurposeProps {
  onPick: (purposeId: string) => void;
  /** Bail out into free text — always available, never the only way on. */
  onDescribe: () => void;
}

export function CreatePurpose({ onPick, onDescribe }: CreatePurposeProps) {
  return (
    <>
      {/* Centred, not top-aligned: five tall rows pinned to the top put every
          target in the upper third, where a thumb can't reach them. Centring
          drops the whole group into the lower half without changing its order. */}
      <div
        className="mv3c-body"
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <div style={{ padding: "4px 18px 0" }}>
          <h2 className="mv3c-title" style={{ fontSize: 27 }}>
            What's it for?
          </h2>
          <p
            style={{
              fontSize: 13,
              color: "var(--mv3-muted)",
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            I'll work out the format from there.
          </p>
        </div>

        <div className="mv3c-purpose" style={{ marginTop: 20 }}>
          {PURPOSE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="mv3c-purposerow"
              onClick={() => {
                haptic.light();
                onPick(option.id);
              }}
            >
              <span style={{ fontSize: 19 }} aria-hidden>
                {option.glyph}
              </span>
              <span style={{ flex: 1 }}>
                <span className="mv3c-purposename" style={{ display: "block" }}>
                  {option.label}
                </span>
                <span className="mv3c-purposedetail" style={{ display: "block" }}>
                  {option.detail}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div style={{ height: 18 }} />
      </div>

      <div className="mv3c-footer" style={{ borderTop: "none" }}>
        <button type="button" className="mv3c-rescue" onClick={onDescribe}>
          Or <span>just describe it</span> and I'll figure it out
        </button>
      </div>
    </>
  );
}
