/**
 * EmptyOrbit — the first-morning empty Today state (spec frame 22): the mark
 * waiting inside a dashed still orbit, "Your orbit is empty — for now.", and
 * the two one-tap fill paths (tell Cue something / connect Gmail).
 *
 * COORDINATOR NOTE (integration line): `mv3-today.tsx` should render this when
 * ALL of its slots are empty — i.e. in `Mv3Today`, before the card stack:
 *
 *   if (!move.hasMove && approvals.length === 0 && review.length === 0 &&
 *       running.length === 0 && cameIn.length === 0) return <EmptyOrbit />;
 *
 * (One line at merge; this file deliberately does not import mv3-today.)
 */
import { useNavigate } from "react-router";

import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "./aurora-backdrop";
import { CueRing } from "./cue-ring";

export function EmptyOrbit() {
  const navigate = useNavigate();
  return (
    <div
      data-mv3
      data-slot="mv3-empty-orbit"
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop
        style={{
          background:
            "radial-gradient(46% 36% at 50% 30%, var(--mv3-aurora), transparent 68%)",
        }}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 30px",
          position: "relative",
          zIndex: 2,
        }}
      >
        {/* The waiting mark — dashed still orbit, breathing glow. */}
        <div style={{ position: "relative", width: 110, height: 110, margin: "0 auto" }}>
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: -12,
              borderRadius: "50%",
              border: "1px dashed var(--mv3-guide-ring)",
            }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: -24,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, var(--mv3-ring-glow), transparent 62%)",
              filter: "blur(16px)",
              animation: "mv3Glow 4s ease-in-out infinite",
            }}
          />
          <CueRing
            size={110}
            stroke="var(--mv3-text)"
            style={{ position: "relative" }}
          />
        </div>

        <div
          style={{
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "-0.6px",
            textAlign: "center",
            marginTop: 26,
            lineHeight: 1.2,
          }}
        >
          Your orbit is empty —
          <br />
          for now.
        </div>
        <div
          style={{
            fontSize: 14,
            color: "var(--mv3-muted)",
            textAlign: "center",
            marginTop: 10,
            lineHeight: 1.55,
          }}
        >
          Tell Cue one thing you&rsquo;re working on,
          <br />
          or connect an inbox and watch it fill itself.
        </div>

        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.medium();
            // NOT routes.assistant: on mobile that renders ConversationRedirect,
            // which with no target conversation navigates straight back to
            // routes.home — i.e. this tab. Today's primary call to action did
            // nothing at all. routes.conversations is the path mobile already
            // uses to reach chat (see mobile-v3/overflow-menu.tsx).
            navigate(routes.conversations);
          }}
          style={{
            width: "100%",
            background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
            color: "#ffffff",
            border: "none",
            borderRadius: 15,
            padding: 15,
            minHeight: 48,
            fontSize: 15,
            fontWeight: 600,
            fontFamily: "inherit",
            marginTop: 24,
            cursor: "pointer",
            boxShadow: "var(--mv3-primary-btn-shadow)",
          }}
        >
          Tell Cue what&rsquo;s on your plate
        </button>
        <div style={{ textAlign: "center", marginTop: 13 }}>
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              navigate(routes.connectors);
            }}
            style={{
              fontSize: 13,
              color: "var(--mv3-micro)",
              background: "none",
              border: "none",
              padding: "10px 12px",
              minHeight: 44,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Connect Gmail instead ›
          </button>
        </div>
      </div>
    </div>
  );
}
