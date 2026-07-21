/**
 * Discovery + Cue Live clarity gallery — a public, backend-free preview of the
 * L1 / D1 / D2 frames rendered with sample data, so every state can be checked
 * in a real browser (light + dark, mobile + desktop) without an authenticated
 * daemon. Not part of the product IA.
 *
 * Route: `/design-preview.html?gallery=discovery`.
 */
import { MemoryRouter } from "react-router";

import type { CapabilityPower } from "@/domains/discovery/use-capability-powers";
import { CueLiveExplainerView } from "@/domains/intelligence/cue-live-explainer";
import { PermissionsBanner } from "@/domains/intelligence/cue-live-page";
import type { CueLiveWebState } from "@/domains/intelligence/cue-live-web-state";
import { C, mono, serif } from "@/lib/hq-theme";
import { Mv3ExploreView } from "@/mobile-v3/you/explore-page";
import { ExploreHqView } from "@/pages/explore/explore-page";

const HOTKEY = "Control+Option+Space";

// Frozen at module load: the gallery must not recompute timestamps on render.
const MINUTES_AGO_42 = new Date(Date.now() - 42 * 60_000).toISOString();
const HOURS_AGO_3 = new Date(Date.now() - 3 * 3_600_000).toISOString();

const CUE_LIVE_STATES: Exclude<CueLiveWebState, { kind: "live" }>[] = [
  { kind: "unpaired" },
  {
    kind: "offline",
    machineName: "Manav's MacBook Pro",
    lastSeenAt: MINUTES_AGO_42,
  },
  { kind: "idle", machineName: "Manav's MacBook Pro" },
  { kind: "unreachable" },
  { kind: "loading" },
];

/** One power per state so the whole taxonomy is visible at once. */
const SAMPLE_POWERS: CapabilityPower[] = [
  {
    id: "organizer",
    glyph: "🖥",
    title: "Tidy up your Mac",
    hqTitle: "Desktop organizer",
    line: "Sorts your desktop & downloads on command.",
    caveat: "Needs the Mac app.",
    state: "needs-you",
    cta: "Learn",
    to: "/assistant/desktop-control",
  },
  {
    id: "watchers",
    glyph: "👁",
    title: "Watch your inbox & GitHub",
    hqTitle: "Watchers",
    line: "Flags what matters, files the rest · 3 watching.",
    caveat: null,
    state: "on",
    cta: "On ✓",
    to: "/assistant/automations",
  },
  {
    id: "playbooks",
    glyph: "⚡",
    title: "Trigger → action rules",
    hqTitle: "Playbooks",
    line: '"When X happens, do Y" — Playbooks.',
    caveat: null,
    state: "available",
    cta: "Set up",
    to: "/assistant/automations",
  },
  {
    id: "plugins",
    glyph: "🧩",
    title: "Extend Cue with Plugins",
    hqTitle: "Plugins",
    line: "Add tools & apps from the marketplace.",
    caveat: null,
    state: "available",
    cta: "Browse",
    to: "/assistant/plugins",
  },
  {
    id: "extension",
    glyph: "🌐",
    title: "Drive your browser",
    hqTitle: "Browser extension",
    line: "The Cue extension fills forms & navigates for you.",
    caveat: "Needs the extension — Cue can't detect it from here.",
    state: "needs-you",
    cta: "Learn",
    to: null,
  },
  {
    id: "phone",
    glyph: "📞",
    title: "Answer your phone",
    hqTitle: "Phone channel",
    line: "A Cue number screens & takes calls.",
    caveat: "Needs setup.",
    state: "available",
    cta: "Set up",
    to: "/assistant/channels",
  },
  {
    id: "cue-live",
    glyph: "✦",
    title: "Act on your Mac screen",
    hqTitle: "Cue Live",
    line: "Sees & acts on your Mac screen — Look, Guide, or take control.",
    caveat: null,
    state: "running",
    cta: "Running",
    to: "/assistant/cue-live",
  },
];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 44 }}>
      <h2 style={{ fontFamily: serif, fontSize: 26, color: C.t1, margin: 0 }}>
        {title}
      </h2>
      {note ? (
        <p style={{ fontSize: 13, color: C.t2, margin: "6px 0 16px" }}>
          {note}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 390,
        height: 844,
        borderRadius: 34,
        overflow: "hidden",
        border: `1px solid ${C.line2}`,
        flexShrink: 0,
        background: "var(--mv3-bg)",
      }}
    >
      {children}
    </div>
  );
}

export function DiscoveryClarityGallery() {
  // `?section=l1|l1-narrow|d2|d1` renders one frame at a time — the full deck
  // is several thousand pixels tall, which is awkward to screenshot.
  const only = new URLSearchParams(globalThis.location?.search ?? "").get(
    "section",
  );
  const show = (key: string) => !only || only === key;
  return (
    <MemoryRouter>
      <div
        style={{
          background: C.bg,
          minHeight: "100vh",
          padding: "32px 28px 80px",
          fontFamily: "'DM Sans', system-ui, sans-serif",
          color: C.t1,
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          Design preview
        </div>
        <h1 style={{ fontFamily: serif, fontSize: 38, margin: "6px 0 30px" }}>
          Discovery + Cue Live clarity
        </h1>

        {show("l1") && (
          <Section
            title="L1 · Web idle explainer"
            note="Every real off-desktop state. The accelerator is the shipped value, never a literal."
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
              {CUE_LIVE_STATES.map((state) => (
                <div key={state.kind}>
                  <div
                    style={{
                      fontFamily: mono,
                      fontSize: 11,
                      color: C.t3,
                      marginBottom: 10,
                    }}
                  >
                    state: {state.kind}
                  </div>
                  <CueLiveExplainerView state={state} hotkey={HOTKEY} />
                </div>
              ))}
            </div>
          </Section>
        )}

        {show("l1-narrow") && (
          <Section
            title="L1 · narrow (390px)"
            note="The same frame at the mobile breakpoint — one column."
          >
            <div
              style={{
                width: 390,
                border: `1px solid ${C.line2}`,
                borderRadius: 16,
                padding: 14,
                background: C.bg,
              }}
            >
              <CueLiveExplainerView
                state={{
                  kind: "offline",
                  machineName: "Manav's MacBook Pro",
                  lastSeenAt: HOURS_AGO_3,
                }}
                hotkey={HOTKEY}
                isMobile
              />
            </div>
          </Section>
        )}

        {show("l3") && (
          <Section
            title="L3 · Mac grant flow"
            note="One permission ✓ at a time; the next un-granted step is the single lit action. Disappears once both are held."
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 20,
                maxWidth: 620,
              }}
            >
              {[
                { screenRecordingGranted: false, accessibilityTrusted: false },
                { screenRecordingGranted: true, accessibilityTrusted: false },
                { screenRecordingGranted: false, accessibilityTrusted: true },
              ].map((permissions, i) => (
                <div key={i}>
                  <div
                    style={{
                      fontFamily: mono,
                      fontSize: 11,
                      color: C.t3,
                      marginBottom: 8,
                    }}
                  >
                    screen:{String(permissions.screenRecordingGranted)} ·
                    accessibility:{String(permissions.accessibilityTrusted)}
                  </div>
                  <PermissionsBanner permissions={permissions} />
                </div>
              ))}
            </div>
          </Section>
        )}

        {show("d2") && (
          <Section
            title="D2 · HQ discovery"
            note="Seven powers, serif grid. Blue pulse = running, green = on, amber = needs you."
          >
            <div
              style={{
                border: `1px solid ${C.line2}`,
                borderRadius: 16,
                overflow: "hidden",
              }}
            >
              <ExploreHqView powers={SAMPLE_POWERS} />
            </div>
          </Section>
        )}

        {show("d1") && (
          <Section
            title="D1 · Mobile discovery"
            note="Left: first run (Skip / Done set the seen flag). Right: the persistent You → Explore surface."
          >
            <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
              <PhoneFrame>
                <Mv3ExploreView
                  powers={SAMPLE_POWERS}
                  firstRun
                  onFinish={() => {}}
                />
              </PhoneFrame>
              <PhoneFrame>
                <Mv3ExploreView
                  powers={SAMPLE_POWERS}
                  firstRun={false}
                  onFinish={() => {}}
                />
              </PhoneFrame>
            </div>
          </Section>
        )}
      </div>
    </MemoryRouter>
  );
}
