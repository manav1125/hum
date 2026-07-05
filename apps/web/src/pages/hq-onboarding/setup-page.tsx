/**
 * HQ first-run setup — `/assistant/hq/setup`.
 *
 * "From zero to a working HQ — without a settings wizard." Faithful to the
 * Cue-HQ-Build onboarding frames (v3's five-step flow + v4's Step-0 fork and
 * the R5·A4 personal variants):
 *
 *   0 · "What's Cue for?"  — Me / My work / My company multi-select. Sets the
 *       default workspace mode (me→observe, work→assist, company→autonomous;
 *       the widest leash selected wins) and tunes every later line of copy.
 *   1 · Name your HQ        → company-profile.identity
 *   2 · Connect your world  → real source cards that deep-link into the same
 *       contacts/channels setup the Channels page uses; each individually
 *       skippable. The "already found" proof band shows REAL captured-item
 *       counts or nothing at all — never a fabricated number.
 *   3 · Give Cue direction  → company-profile.direction (free text). File
 *       upload is a visual affordance only for now (org-knowledge API is
 *       future backend work — see the report).
 *   4 · First mission       → mission chips (personal vs company variant) →
 *       POST missions, then a static "meet your team" panel.
 *
 * Every step past the fork has an explicit Skip. Progress is persisted to
 * `cue:hq-setup-progress` (via ./setup-state) so the HQ setup meter can read
 * N-of-5 through `useSetupProgress()`.
 *
 * Visual language reuses the locked HQ kit (serif display, DM Mono
 * microlabels, `--mv1-*` theme tokens via `C`) so light/dark and desktop/390
 * follow the app theme with no bespoke palette.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { routes } from "@/utils/routes";
import { C, mono, serif } from "@/domains/activity/theme";
import {
  ApertureMark,
  HqStyle,
  MicroLabel,
  MODE_META,
} from "@/pages/hq/hq-kit";

import {
  isPersonalFork,
  markSetupCompleted,
  markSetupStarted,
  markStep,
  meterProgress,
  modeCaption,
  modeForFork,
  setFork as persistFork,
  useSetupState,
  type ForkSelection,
  type SetupStepId,
} from "./setup-state";
import {
  useAlreadyFound,
  useCompanyProfile,
  useCreateMission,
  usePutCompanyProfile,
  useSourceCards,
  type SourceCard,
} from "./use-setup-data";

// ---------------------------------------------------------------------------
// The flow model — Step 0 (fork) + five tracked steps.
// ---------------------------------------------------------------------------

type Screen = "fork" | "name" | "connect" | "direction" | "mission" | "team";

const ORDER: Screen[] = [
  "fork",
  "name",
  "connect",
  "direction",
  "mission",
  "team",
];

/** Resume: the tracked step id → the screen that fulfills it. */
function resumeScreen(next: SetupStepId | null): Screen {
  if (next === null) return "fork";
  if (next === "mode") return "fork";
  return next; // name | connect | direction | mission are 1:1 with screens
}

// ---------------------------------------------------------------------------
// Page shell + step chrome
// ---------------------------------------------------------------------------

export function HqSetupPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const state = useSetupState();

  const [screen, setScreen] = useState<Screen>(() => {
    // Resume where they left off: first not-done tracked step, else fork.
    const { next } = meterProgress(state);
    return resumeScreen(next);
  });

  const fork = state.fork;
  const personal = isPersonalFork(fork);
  // Personal fork folds the autonomy step → "N OF 4"; company keeps 5.
  const totalSteps = personal ? 4 : 5;

  const putProfile = usePutCompanyProfile(assistantId);

  const go = (next: Screen) => setScreen(next);
  const advance = () => {
    const i = ORDER.indexOf(screen);
    go(ORDER[Math.min(i + 1, ORDER.length - 1)]);
  };
  const enterHq = () => {
    markSetupCompleted(Date.now());
    void navigate(routes.hq);
  };

  // Persist the fork the first render it exists, so a reload resumes in-mode.
  if (!state.started) markSetupStarted();

  return (
    <div style={pageStyle}>
      <HqStyle />
      <SetupFlowStyle />
      <div style={shellStyle} data-slot="hq-setup-shell">
        <TopBar
          onExit={() => void navigate(routes.hq)}
          done={meterProgress(state).doneCount}
          total={5}
        />

        {screen === "fork" && (
          <ForkStep
            initial={fork}
            onContinue={(sel) => {
              persistFork(sel);
              putProfile.mutate({
                path: { assistant_id: assistantId },
                body: { workspaceMode: modeForFork(sel) },
              });
              markStep("mode", "done");
              advance();
            }}
            onSkip={() => {
              markStep("mode", "skipped");
              advance();
            }}
          />
        )}

        {screen === "name" && (
          <NameStep
            assistantId={assistantId}
            stepNo={1}
            total={totalSteps}
            personal={personal}
            onContinue={(name) => {
              putProfile.mutate({
                path: { assistant_id: assistantId },
                body: { identity: name },
              });
              markStep("name", "done");
              advance();
            }}
            onSkip={() => {
              markStep("name", "skipped");
              advance();
            }}
          />
        )}

        {screen === "connect" && (
          <ConnectStep
            assistantId={assistantId}
            stepNo={2}
            total={totalSteps}
            personal={personal}
            onContinue={(anyConnected) => {
              markStep("connect", anyConnected ? "done" : "skipped");
              advance();
            }}
            onSkip={() => {
              markStep("connect", "skipped");
              advance();
            }}
          />
        )}

        {screen === "direction" && (
          <DirectionStep
            stepNo={3}
            total={totalSteps}
            personal={personal}
            onContinue={(text) => {
              if (text.trim().length > 0) {
                putProfile.mutate({
                  path: { assistant_id: assistantId },
                  body: { direction: text.trim() },
                });
                markStep("direction", "done");
              } else {
                markStep("direction", "skipped");
              }
              advance();
            }}
            onSkip={() => {
              markStep("direction", "skipped");
              advance();
            }}
          />
        )}

        {screen === "mission" && (
          <MissionStep
            assistantId={assistantId}
            stepNo={4}
            total={totalSteps}
            personal={personal}
            onCreated={() => {
              markStep("mission", "done");
              go("team");
            }}
            onSkip={() => {
              markStep("mission", "skipped");
              go("team");
            }}
          />
        )}

        {screen === "team" && (
          <TeamStep
            assistantId={assistantId}
            total={totalSteps}
            personal={personal}
            onEnter={enterHq}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function TopBar({
  onExit,
  done,
  total,
}: {
  onExit: () => void;
  done: number;
  total: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 22,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <ApertureMark size={18} />
        <MicroLabel color={C.t3}>Onboarding · first run</MicroLabel>
      </div>
      <button type="button" onClick={onExit} style={ghostLinkStyle}>
        {done >= total ? "Done" : `${done}/${total} · Do this later ›`}
      </button>
    </div>
  );
}

/** The white first-run card every step lives inside. */
function StepCard({ children }: { children: ReactNode }) {
  return (
    <div style={cardStyle} data-slot="hq-setup-card">
      {children}
    </div>
  );
}

function StepHead({
  label,
  title,
  blurb,
}: {
  label: string;
  title: string;
  blurb: string;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <MicroLabel color={C.blue} style={{ marginBottom: 12 }}>
        {label}
      </MicroLabel>
      <h1
        style={{
          fontFamily: serif,
          fontSize: 30,
          lineHeight: 1.08,
          color: C.t1,
          fontWeight: 400,
          margin: "0 0 8px",
        }}
      >
        {title}
      </h1>
      <p style={{ fontSize: 13.5, color: C.t2, lineHeight: 1.5, margin: 0 }}>
        {blurb}
      </p>
    </div>
  );
}

/** Dark "Continue ›" pill. */
function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...primaryBtnStyle,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

function SkipLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={skipLinkStyle}>
      {children}
    </button>
  );
}

/** Continue + Skip row — the footer every skippable step shares. */
function StepFooter({
  continueLabel,
  onContinue,
  continueDisabled,
  onSkip,
  skipLabel = "Skip for now",
  caption,
}: {
  continueLabel: string;
  onContinue: () => void;
  continueDisabled?: boolean;
  onSkip: () => void;
  skipLabel?: string;
  caption?: string;
}) {
  return (
    <div style={{ marginTop: 22 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
        }}
      >
        <PrimaryButton onClick={onContinue} disabled={continueDisabled}>
          {continueLabel}
        </PrimaryButton>
        <SkipLink onClick={onSkip}>{skipLabel}</SkipLink>
      </div>
      {caption ? (
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            color: C.t3,
            marginTop: 12,
            letterSpacing: "0.02em",
          }}
        >
          {caption}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 0 — the fork
// ---------------------------------------------------------------------------

const FORK_OPTIONS: Array<{
  key: keyof ForkSelection;
  icon: string;
  title: string;
  sub: string;
}> = [
  {
    key: "me",
    icon: "🧠",
    title: "Me",
    sub: "Work better with AI, day to day",
  },
  {
    key: "work",
    icon: "💼",
    title: "My work",
    sub: "A role, a desk, an assistant-first flow",
  },
  {
    key: "company",
    icon: "🚀",
    title: "My company",
    sub: "Missions, agents, autonomous runs",
  },
];

function ForkStep({
  initial,
  onContinue,
  onSkip,
}: {
  initial: ForkSelection | null;
  onContinue: (sel: ForkSelection) => void;
  onSkip: () => void;
}) {
  const [sel, setSel] = useState<ForkSelection>(
    initial ?? { me: false, work: false, company: false },
  );
  const anySelected = sel.me || sel.work || sel.company;
  const toggle = (k: keyof ForkSelection) =>
    setSel((s) => ({ ...s, [k]: !s[k] }));

  return (
    <StepCard>
      <StepHead
        label={'Step 0 · "What’s Cue for?"'}
        title="What should Cue help you run?"
        blurb="Pick any that fit — you can change this later."
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {FORK_OPTIONS.map((opt) => {
          const on = sel[opt.key];
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => toggle(opt.key)}
              aria-pressed={on}
              style={{
                ...selectRowStyle,
                borderColor: on ? C.blue : C.line,
                background: on ? C.blueW : C.surface,
                boxShadow: on ? `inset 0 0 0 1px ${C.blue}` : "none",
              }}
            >
              <span style={rowIconStyle} aria-hidden>
                {opt.icon}
              </span>
              <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 14.5,
                    fontWeight: 600,
                    color: C.t1,
                  }}
                >
                  {opt.title}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 12,
                    color: C.t2,
                    marginTop: 1,
                  }}
                >
                  {opt.sub}
                </span>
              </span>
              <span
                aria-hidden
                style={{
                  ...checkDotStyle,
                  borderColor: on ? C.blue : C.line2,
                  background: on ? C.blue : "transparent",
                  color: on ? "#fff" : "transparent",
                }}
              >
                ✓
              </span>
            </button>
          );
        })}
      </div>
      <StepFooter
        continueLabel="Continue ›"
        continueDisabled={!anySelected}
        onContinue={() => onContinue(sel)}
        onSkip={onSkip}
        skipLabel="Skip"
        caption={
          anySelected
            ? `Sets your default mode: ${modeCaption(sel)}`
            : "Sets your default mode."
        }
      />
    </StepCard>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — name
// ---------------------------------------------------------------------------

function NameStep({
  assistantId,
  stepNo,
  total,
  personal,
  onContinue,
  onSkip,
}: {
  assistantId: string;
  stepNo: number;
  total: number;
  personal: boolean;
  onContinue: (name: string) => void;
  onSkip: () => void;
}) {
  const { profile } = useCompanyProfile(assistantId);
  const [name, setName] = useState("");
  // Prefill once from the existing identity if any.
  const seeded = useMemo(() => profile?.identity ?? "", [profile?.identity]);
  const value = name.length > 0 ? name : seeded;

  return (
    <StepCard>
      <StepHead
        label={`Step ${stepNo} / ${total}`}
        title={personal ? "Name your space" : "Name your HQ"}
        blurb={
          personal
            ? "What should we call it? This is home base for everything Cue does for you."
            : "What are we building? This becomes home base for every mission and agent."
        }
      />
      <MicroLabel color={C.t3} style={{ marginBottom: 7 }}>
        {personal ? "SPACE NAME" : "COMPANY NAME"}
      </MicroLabel>
      <input
        value={value}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim().length > 0)
            onContinue(value.trim());
        }}
        placeholder={personal ? "e.g. Manav" : "e.g. Northwind"}
        style={inputStyle}
      />
      <StepFooter
        continueLabel="Continue ›"
        continueDisabled={value.trim().length === 0}
        onContinue={() => onContinue(value.trim())}
        onSkip={onSkip}
      />
    </StepCard>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — connect
// ---------------------------------------------------------------------------

function ConnectStep({
  assistantId,
  stepNo,
  total,
  personal,
  onContinue,
  onSkip,
}: {
  assistantId: string;
  stepNo: number;
  total: number;
  personal: boolean;
  onContinue: (anyConnected: boolean) => void;
  onSkip: () => void;
}) {
  const navigate = useNavigate();
  const { cards, connectedIds, isLoading } = useSourceCards(assistantId);
  const found = useAlreadyFound(assistantId, connectedIds);

  // Each card deep-links into the same contacts/channels setup the Channels
  // page uses (returning here refetches readiness on focus).
  const connect = (id: string) =>
    void navigate(`${routes.contacts.root}?channel=${encodeURIComponent(id)}`);

  return (
    <StepCard>
      <StepHead
        label={
          personal
            ? `Step ${stepNo} of ${total} · Personal`
            : `Step ${stepNo} / ${total}`
        }
        title={personal ? "Connect your world." : "Connect where work flows"}
        blurb={
          personal
            ? "Cue can only help with what it can see. Just yours — nothing shared, nothing posted."
            : "The more it can see, the more it catches. Nothing leaves without your say-so."
        }
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {isLoading && cards.length === 0 ? (
          <div style={{ fontSize: 13, color: C.t3, padding: "8px 0" }}>
            Loading your sources…
          </div>
        ) : cards.length === 0 ? (
          <div style={{ fontSize: 13, color: C.t3, padding: "8px 0" }}>
            No connectable sources available yet.
          </div>
        ) : (
          cards.map((card) => (
            <SourceRow
              key={card.id}
              card={card}
              onConnect={() => connect(card.id)}
            />
          ))
        )}
      </div>

      {/* The "already found" proof band — REAL counts only, or nothing. */}
      {found.count > 0 ? (
        <div style={foundBandStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 6,
            }}
          >
            <span aria-hidden style={{ color: C.green }}>
              ✦
            </span>
            <MicroLabel color={C.green}>
              {personal
                ? `Already found · ${found.count}`
                : `Already found in your inbox · ${found.count}`}
            </MicroLabel>
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {found.titles.map((t, i) => (
              <li
                key={i}
                style={{
                  fontSize: 12.5,
                  color: C.t2,
                  lineHeight: 1.5,
                  display: "flex",
                  gap: 6,
                }}
              >
                <span aria-hidden style={{ color: C.green }}>
                  ·
                </span>
                <span style={{ minWidth: 0 }}>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {personal ? (
        <div style={{ ...selectRowStyle, cursor: "default", marginTop: 9 }}>
          <span style={rowIconStyle} aria-hidden>
            ＋
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: "block",
                fontSize: 13.5,
                fontWeight: 600,
                color: C.t1,
              }}
            >
              Anything you want Cue to know about you
            </span>
            <span
              style={{
                display: "block",
                fontSize: 12,
                color: C.t2,
                marginTop: 1,
              }}
            >
              notes, lists, a “how I like things done” doc — optional
            </span>
          </span>
        </div>
      ) : null}

      <StepFooter
        continueLabel="Continue ›"
        onContinue={() => onContinue(connectedIds.length > 0)}
        onSkip={onSkip}
      />
    </StepCard>
  );
}

function SourceRow({
  card,
  onConnect,
}: {
  card: SourceCard;
  onConnect: () => void;
}) {
  return (
    <div style={selectRowStyle}>
      <span style={rowIconStyle} aria-hidden>
        {card.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 14,
            fontWeight: 600,
            color: C.t1,
          }}
        >
          {card.label}
        </span>
        <span
          style={{ display: "block", fontSize: 12, color: C.t2, marginTop: 1 }}
        >
          {card.subtitle}
        </span>
      </span>
      {card.connected ? (
        <span
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            letterSpacing: "0.08em",
            color: C.green,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <span aria-hidden>✓</span> CONNECTED
        </span>
      ) : (
        <button type="button" onClick={onConnect} style={connectPillStyle}>
          Connect ›
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — direction
// ---------------------------------------------------------------------------

function DirectionStep({
  stepNo,
  total,
  personal,
  onContinue,
  onSkip,
}: {
  stepNo: number;
  total: number;
  personal: boolean;
  onContinue: (text: string) => void;
  onSkip: () => void;
}) {
  const [text, setText] = useState("");

  return (
    <StepCard>
      <StepHead
        label={
          personal
            ? `Step ${stepNo} of ${total} · Personal`
            : `Step ${stepNo} / ${total}`
        }
        title={
          personal
            ? "What should Cue know about you?"
            : "Hand Cue your direction"
        }
        blurb={
          personal
            ? "A few lines about how you like things done — or just say it, “keep me on top of…”. Cue reads it so its calls match yours."
            : "Drop a strategy doc, deck, or a few lines. Cue reads it so its calls match yours."
        }
      />

      {/* File-drop affordance. Upload lands in a future org-knowledge API —
          for now this is a visual invitation; the text box below is what
          actually persists (company-profile.direction). */}
      <div style={dropZoneStyle} aria-hidden>
        <span style={{ fontSize: 20, color: C.t3 }}>⌘</span>
        <span style={{ fontSize: 12.5, color: C.t3 }}>
          Drop files here, or browse
        </span>
        <span
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            color: C.t3,
            letterSpacing: "0.06em",
          }}
        >
          COMING SOON
        </span>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          personal
            ? "keep me on top of my inbox, plan travel, and never let a reply slip…"
            : "We’re a seed-stage team building… going for $40K MRR by Q3…"
        }
        rows={4}
        style={textareaStyle}
      />

      <StepFooter
        continueLabel="Continue ›"
        onContinue={() => onContinue(text)}
        onSkip={onSkip}
      />
    </StepCard>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — first mission
// ---------------------------------------------------------------------------

interface MissionChip {
  icon: string;
  title: string;
  outcome: string;
  evidence: string;
}

const COMPANY_CHIPS: MissionChip[] = [
  {
    icon: "💰",
    title: "Raise a $500K seed",
    outcome: "Close a $500K seed round",
    evidence: "Investor asks already waiting",
  },
  {
    icon: "📅",
    title: "Book the investor meetings",
    outcome: "Get investor meetings on the calendar",
    evidence: "Cue can find open slots this week",
  },
  {
    icon: "🚀",
    title: "Ship the next release",
    outcome: "Ship v2 and drive adoption",
    evidence: "Turn the roadmap into a moving ring",
  },
];

const PERSONAL_CHIPS: MissionChip[] = [
  {
    icon: "📥",
    title: "Get my inbox under control",
    outcome: "Keep my inbox at zero and nothing slips",
    evidence: "From what’s sitting unread right now",
  },
  {
    icon: "🌴",
    title: "Plan a trip",
    outcome: "Plan and book my next trip end to end",
    evidence: "From flight alerts in your inbox",
  },
  {
    icon: "💳",
    title: "Stay on top of my finances",
    outcome: "Keep me ahead of bills and money moves",
    evidence: "From bank notices sitting unread",
  },
];

function MissionStep({
  assistantId,
  stepNo,
  total,
  personal,
  onCreated,
  onSkip,
}: {
  assistantId: string;
  stepNo: number;
  total: number;
  personal: boolean;
  onCreated: () => void;
  onSkip: () => void;
}) {
  const chips = personal ? PERSONAL_CHIPS : COMPANY_CHIPS;
  const [picked, setPicked] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const create = useCreateMission(assistantId);

  const chosen: { title: string; outcome: string } | null =
    picked != null
      ? { title: chips[picked].title, outcome: chips[picked].outcome }
      : custom.trim().length > 0
        ? { title: custom.trim(), outcome: custom.trim() }
        : null;

  const submit = () => {
    if (!chosen || create.isPending) return;
    create.mutate(
      {
        path: { assistant_id: assistantId },
        body: { title: chosen.title, outcome: chosen.outcome },
      },
      { onSuccess: onCreated, onError: onCreated },
    );
  };

  return (
    <StepCard>
      <StepHead
        label={
          personal
            ? `Step ${stepNo} of ${total} · Personal`
            : `Step ${stepNo} / ${total}`
        }
        title={
          personal
            ? "What should Cue take off your plate first?"
            : "What should Cue chase first?"
        }
        blurb={
          personal
            ? "Suggested from what it just saw — pick one, or tell it anything."
            : "Pick one and Cue staffs a ring. You can add more any time."
        }
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {chips.map((chip, i) => {
          const on = picked === i;
          return (
            <button
              key={chip.title}
              type="button"
              onClick={() => {
                setPicked(i);
                setCustom("");
              }}
              aria-pressed={on}
              style={{
                ...selectRowStyle,
                borderColor: on ? C.blue : C.line,
                background: on ? C.blueW : C.surface,
                boxShadow: on ? `inset 0 0 0 1px ${C.blue}` : "none",
              }}
            >
              <span style={rowIconStyle} aria-hidden>
                {chip.icon}
              </span>
              <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 14,
                    fontWeight: 600,
                    color: C.t1,
                  }}
                >
                  {chip.title}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 12,
                    color: C.t2,
                    marginTop: 1,
                  }}
                >
                  {chip.evidence}
                </span>
              </span>
              <span
                aria-hidden
                style={{
                  ...checkDotStyle,
                  borderColor: on ? C.blue : C.line2,
                  background: on ? C.blue : "transparent",
                  color: on ? "#fff" : "transparent",
                }}
              >
                ✓
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 10 }}>
        <input
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            if (e.target.value.length > 0) setPicked(null);
          }}
          placeholder={
            personal
              ? "Or just say it — “keep me on top of…”"
              : "Describe your own…"
          }
          style={inputStyle}
        />
      </div>

      <StepFooter
        continueLabel={
          create.isPending
            ? "Starting…"
            : personal
              ? "Start with this ›"
              : "Assemble the team ›"
        }
        continueDisabled={chosen == null || create.isPending}
        onContinue={submit}
        onSkip={onSkip}
        skipLabel="Skip"
      />
    </StepCard>
  );
}

// ---------------------------------------------------------------------------
// Meet the team (post-mission)
// ---------------------------------------------------------------------------

const TEAM = [
  { glyph: "⚙", name: "Ops", role: "Runs the operational rings" },
  { glyph: "▲", name: "Builder", role: "Ships the product work" },
  { glyph: "✦", name: "Growth", role: "Drives the top of funnel" },
];

function TeamStep({
  assistantId,
  total,
  personal,
  onEnter,
}: {
  assistantId: string;
  total: number;
  personal: boolean;
  onEnter: () => void;
}) {
  const { profile } = useCompanyProfile(assistantId);
  const name =
    profile?.identity?.trim() || (personal ? "Your space" : "Your HQ");

  return (
    <StepCard>
      <MicroLabel color={C.blue} style={{ marginBottom: 12 }}>
        {`Step ${total} / ${total} · Meet your team`}
      </MicroLabel>

      <div style={teamHeroStyle} data-slot="hq-setup-team-hero">
        <div
          style={{
            fontFamily: serif,
            fontSize: 34,
            color: "#fff",
            lineHeight: 1,
          }}
        >
          9%
        </div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.12em",
            color: "rgba(255,255,255,.62)",
            marginTop: 4,
          }}
        >
          STARTED
        </div>
      </div>

      <h1
        style={{
          fontFamily: serif,
          fontSize: 26,
          fontWeight: 400,
          color: C.t1,
          margin: "18px 0 6px",
          lineHeight: 1.1,
        }}
      >
        {name} is live.
      </h1>
      <p style={{ fontSize: 13.5, color: C.t2, lineHeight: 1.5, margin: 0 }}>
        {personal
          ? "Your team is on it — you’ll approve before anything leaves your side."
          : "Ops and Growth are already on your first mission. You’ll approve before anything leaves the building."}
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 18,
        }}
      >
        {TEAM.map((m) => (
          <div key={m.name} style={{ ...selectRowStyle, cursor: "default" }}>
            <span style={rowIconStyle} aria-hidden>
              {m.glyph}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.t1,
                }}
              >
                {m.name}
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 12,
                  color: C.t2,
                  marginTop: 1,
                }}
              >
                {m.role}
              </span>
            </span>
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                letterSpacing: "0.08em",
                color: C.t3,
              }}
            >
              {MODE_META.assist.label.toUpperCase()}
            </span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 22 }}>
        <PrimaryButton onClick={onEnter}>
          {personal ? "Enter your space ›" : "Enter HQ ›"}
        </PrimaryButton>
      </div>
    </StepCard>
  );
}

// ---------------------------------------------------------------------------
// Styles — all ride theme-aware `C` tokens (light/dark follow the app theme).
// ---------------------------------------------------------------------------

const pageStyle: CSSProperties = {
  minHeight: "100%",
  background: C.bg,
  display: "flex",
  justifyContent: "center",
  padding: "40px 20px 80px",
};

const shellStyle: CSSProperties = {
  width: "100%",
  maxWidth: 520,
};

const cardStyle: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 22,
  padding: 28,
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

const selectRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  border: `1px solid ${C.line}`,
  borderRadius: 14,
  padding: "13px 14px",
  background: C.surface,
  cursor: "pointer",
  textAlign: "left",
  font: "inherit",
  transition: "border-color .12s, background .12s",
};

const rowIconStyle: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 11,
  background: C.sunken,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 18,
  flexShrink: 0,
};

const checkDotStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: `1.5px solid ${C.line2}`,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  flexShrink: 0,
};

const inputStyle: CSSProperties = {
  width: "100%",
  border: `1px solid ${C.line2}`,
  borderRadius: 12,
  padding: "12px 14px",
  fontSize: 15,
  color: C.t1,
  background: C.bg,
  outline: "none",
  boxSizing: "border-box",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  fontSize: 13.5,
  lineHeight: 1.5,
  resize: "vertical",
  marginTop: 10,
  fontFamily: "inherit",
};

const dropZoneStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  border: `1.5px dashed ${C.line2}`,
  borderRadius: 14,
  padding: "22px 16px",
  background: C.bg,
};

const foundBandStyle: CSSProperties = {
  marginTop: 12,
  border: `1px solid var(--mv1-green)`,
  background: "color-mix(in srgb, var(--mv1-green) 8%, transparent)",
  borderRadius: 14,
  padding: "12px 14px",
};

const teamHeroStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  background: "linear-gradient(150deg, #16202E, #0C121B)",
  borderRadius: 18,
  padding: "26px 0",
};

const primaryBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: C.t1,
  color: C.bg,
  border: "none",
  borderRadius: 12,
  padding: "12px 22px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const skipLinkStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: C.t3,
  fontSize: 13,
  cursor: "pointer",
  padding: "6px 4px",
};

const connectPillStyle: CSSProperties = {
  border: `1px solid ${C.line2}`,
  background: C.bg,
  color: C.t1,
  borderRadius: 9,
  padding: "7px 14px",
  fontSize: 12.5,
  cursor: "pointer",
  flexShrink: 0,
};

const ghostLinkStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: C.t3,
  fontFamily: mono,
  fontSize: 11,
  letterSpacing: "0.04em",
  cursor: "pointer",
};

/** 390px: the shell already caps at 520 and centers; tighten padding + type. */
function SetupFlowStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: [
          '@media (max-width:440px){[data-slot="hq-setup-card"]{padding:20px 18px !important;border-radius:18px !important}}',
        ].join("\n"),
      }}
    />
  );
}
