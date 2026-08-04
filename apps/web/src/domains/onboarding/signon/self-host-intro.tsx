/**
 * The self-host first-run intro — the three screens between a magic link and
 * a working Cue.
 *
 *   1 · You're in       honest landing: a name only if we actually have one,
 *                       and no fabricated activity (design pack, "Build rules")
 *   2 · Terms & data    the consent a gateway session was never asked for
 *   3 · Names           what Cue calls you, what you call Cue
 *
 * WHY THIS EXISTS RATHER THAN REUSING THE PLATFORM FUNNEL
 * The welcome → hosting → api-key → privacy → hatching arc is built and
 * works, but it is a LOCAL/PLATFORM arc: `privacy` continues to `hatching`,
 * which provisions an assistant. A self-hosted instance already has exactly
 * one assistant (`self`) running on the gateway that served this page, so
 * sending a self-host user down that path ends at a screen trying to hatch
 * something that exists — and `hosting` would offer a "Requires Account" Cue
 * Cloud card for an account a single-tenant instance cannot create. Those are
 * dead ends, so this arc collects the same two things (consent, names)
 * through the same writers and then gets out of the way.
 *
 * Everything it shows is either typed by the user on this screen, read from
 * the session, or read from the instance itself (`instance-facts.ts`). Nothing
 * is invented to fill a gap — and, since the gate that runs this arc is
 * device-scoped, nothing is assumed about the instance either. A second device
 * signing into an instance with history is told about that history; a fresh one
 * is told it is fresh; and when the instance does not answer, neither claim is
 * made and the arc runs exactly as before.
 */
import { useState } from "react";
import { useNavigate } from "react-router";

import {
  setPendingAssistantName,
  setPendingPreChatContext,
} from "@/domains/onboarding/prechat";
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { DayOneState } from "@/mobile-v3/states/day-one-state";
import { useAuthStore } from "@/stores/auth-store";
import { useConversationStore } from "@/stores/conversation-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { persistConsentForUser } from "@/utils/onboarding-cleanup";
import { routes } from "@/utils/routes";
import { haptic } from "@/utils/haptics";

import {
  applyConsentScopes,
  DEFAULT_CONSENT_SCOPES,
  persistConsentScopes,
  type ConsentScopeId,
  type ConsentScopes,
} from "./consent-scopes";
import { GravityStyles, OrbitalSystem } from "./gravity-kit";
import {
  arrivedBody,
  useInstanceFacts,
  type InstanceFacts,
} from "./instance-facts";
import { markSelfHostIntroComplete } from "./intro-state";

type IntroStep = "arrived" | "consent" | "names" | "dayOne";

/**
 * A fresh draft conversation id — a plain UUID, mirroring
 * `domains/chat/utils/conversation-selection.createDraftConversationId`,
 * inlined so onboarding stays free of a cross-domain import into chat
 * (CONVENTIONS.md; the Intelligence and Library surfaces inline the same).
 */
function newDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function SelfHostIntro() {
  const navigate = useNavigate();
  const [step, setStep] = useState<IntroStep>("arrived");
  const user = useAuthStore((s) => s.user);
  const facts = useInstanceFacts();

  /**
   * Names are asked once per PERSON, not once per device.
   *
   * If the instance already carries a name for this user, a laptop asking for
   * it again is friction dressed as diligence — and worse than friction: the
   * names step parks a pre-chat context, and the daemon's first-message handler
   * writes that context straight over `data/onboarding-context.json`, so a
   * second device answering "names" with empty tools/tasks would wipe the
   * onboarding facts the instance already had.
   *
   * Only `knownUserName` gets a vote. The assistant name cannot: the daemon
   * reports "Cue" both when the user chose it and when nobody has chosen, so it
   * is evidence of nothing (it is still good enough to be the field's
   * placeholder, which is what it is used for below).
   *
   * Unknown means ask. The read fails open, so an unreachable daemon lands on
   * the arc's original behaviour rather than skipping a question it should have
   * put.
   */
  const afterConsent = (): IntroStep =>
    facts.knownUserName ? "dayOne" : "names";

  /**
   * v28 · K3 — day one ends by PRODUCING THE FIRST THING, not by landing on an
   * empty deck. The answer is parked on the pending deep-link store and a fresh
   * thread is opened with it in the composer: a prefill, never an auto-send, so
   * the first model turn is still something the user pressed.
   */
  const finish = (firstThing?: string) => {
    markSelfHostIntroComplete();
    if (firstThing) {
      usePendingDeepLinkStore.getState().setPendingComposerMessage(firstThing);
      const draftId = newDraftConversationId();
      useConversationStore.getState().setActiveConversationId(draftId);
      void haptic.success();
      void navigate(routes.conversation(draftId), { replace: true });
      return;
    }
    void haptic.success();
    void navigate(routes.assistant, { replace: true });
  };

  // Day one is a full-bleed screen with its own bottom-anchored composer — it
  // does not sit on the intro's glass card, which is sized for a form.
  if (step === "dayOne") {
    return (
      <div
        data-gv
        data-intro-step={step}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--gv-bg)",
          color: "var(--gv-text)",
          fontFamily: "var(--gv-font)",
        }}
      >
        <GravityStyles />
        <DayOneState
          name={displayNameOf(user) ?? facts.knownUserName}
          onAnswer={(answer) => finish(answer)}
        />
      </div>
    );
  }

  return (
    <div
      data-gv
      data-intro-step={step}
      style={{
        position: "relative",
        display: "flex",
        minHeight: "100dvh",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        background: "var(--gv-bg)",
        color: "var(--gv-text)",
        fontFamily: "var(--gv-font)",
        padding: "32px 20px",
      }}
    >
      <GravityStyles />
      <div
        style={{
          display: "flex",
          width: "100%",
          maxWidth: 420,
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <OrbitalSystem mode="idle" size={200} dim />
        <div
          style={{
            marginTop: -16,
            width: "100%",
            borderRadius: 22,
            border: "1px solid var(--gv-glass-line)",
            background: "var(--gv-glass)",
            backdropFilter: "blur(18px)",
            padding: "26px 22px",
            animation: "gvRise .5s cubic-bezier(.2,.7,.2,1) both",
          }}
        >
          {step === "arrived" ? (
            <ArrivedStep facts={facts} onNext={() => setStep("consent")} />
          ) : null}
          {step === "consent" ? (
            <ConsentStep onNext={() => setStep(afterConsent())} />
          ) : null}
          {step === "names" ? (
            <NamesStep facts={facts} onDone={() => setStep("dayOne")} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── 1 · you're in ───────────────────────────── */

/**
 * The pack is explicit that this landing is "honest: name only (from the
 * account), no fabricated activity". So: if the session carries a display
 * name we greet with it, and if it does not we greet without one. We never
 * guess a name out of an email local-part and we never claim Cue has already
 * done work it has not done.
 *
 * The body sentence is the one thing here that is a claim about the INSTANCE
 * rather than about the session, so it is the one thing that has to be looked
 * up rather than assumed — see `arrivedBody`, which has an honest sentence for
 * each of the three states including "the instance did not answer".
 */
function ArrivedStep({
  facts,
  onNext,
}: {
  facts: InstanceFacts;
  onNext: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const name = displayNameOf(user) ?? facts.knownUserName;

  return (
    <div>
      <IntroTitle>{name ? `You're in, ${name}.` : "You're in."}</IntroTitle>
      <IntroBody>{arrivedBody(facts.conversationCount)}</IntroBody>
      <div style={{ marginTop: 20 }}>
        <IntroPrimary onClick={onNext}>Continue</IntroPrimary>
      </div>
    </div>
  );
}

/**
 * The greeting's name half, or null.
 *
 * Only a real given name counts. `username` and `email` are identifiers, not
 * names — "You're in, ada@example.com." reads like a mail-merge failure — and
 * a gateway session's synthetic local user carries neither a first nor a last
 * name, so on a plain self-host instance this correctly returns null and the
 * screen greets with "You're in." That is the honest landing the pack asks
 * for: a name only when we actually have one.
 */
function displayNameOf(
  user: { firstName?: string | null; lastName?: string | null } | null,
): string | null {
  const first = (user?.firstName ?? "").trim();
  if (first && !first.includes("@")) return first;
  const last = (user?.lastName ?? "").trim();
  if (last && !last.includes("@")) return last;
  return null;
}

/* ────────────────────────── 2 · terms & data ─────────────────────────── */

/**
 * The three cards (M8).
 *
 * Each card's body says what the capability PERMITS, in the terms the user
 * will meet it in — not a category name. "Draft and prepare" is only honest if
 * it also says that everything it produces waits for review, and "Send and
 * spend" is only honest if it says the money part out loud.
 *
 * The two legal consents (terms, AI-provider processing) did not go away: they
 * are the same two facts, stated once under the cards where the button is,
 * rather than as two more switches that look optional next to three that
 * aren't. Accepting still writes both through `persistConsentForUser`.
 */
const CONSENT_CARDS: Array<{
  id: ConsentScopeId;
  glyph: string;
  title: string;
  body: string;
  /** The stated norm. Only the third card has one, and it is a fact. */
  norm?: string;
  tone: "ok" | "hold";
}> = [
  {
    id: "read_organise",
    glyph: "✓",
    title: "Read and organise",
    body: "Watch the sources you connect, file what arrives, and surface what needs you. Nothing is read until you connect a source.",
    tone: "ok",
  },
  {
    id: "draft_prepare",
    glyph: "✎",
    title: "Draft and prepare",
    body: "Write replies, build documents, do research. Everything it produces waits for your review — nothing is delivered on its own.",
    tone: "ok",
  },
  {
    id: "send_spend",
    glyph: "‖",
    title: "Send and spend",
    body: "Off to start. With this off, Cue stops and asks you before anything leaves — an email, a message, a payment — every single time.",
    norm: "Most people leave this off for the first week.",
    tone: "hold",
  },
];

function ConsentStep({ onNext }: { onNext: () => void }) {
  const [scopes, setScopes] = useState<ConsentScopes>({
    ...DEFAULT_CONSENT_SCOPES,
  });
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const setTosAccepted = useOnboardingStore.getState().setTosAccepted;
  const setAiDataConsent = useOnboardingStore.getState().setAiDataConsent;

  const accept = () => {
    const userId = useAuthStore.getState().user?.id ?? null;
    setTosAccepted(true);
    setAiDataConsent(true);
    // Same per-user device keys the platform funnel writes, so a later build
    // that DOES run the platform gate does not re-prompt this user.
    persistConsentForUser(userId, true, true);
    // …and the three capabilities, both as device keys and as the autonomy
    // policy map the daemon actually enforces.
    persistConsentScopes(userId, scopes);
    void applyConsentScopes(assistantId, scopes);
    void haptic.light();
    onNext();
  };

  return (
    <div>
      <IntroTitle>What Cue may do for you</IntroTitle>
      <IntroBody>You can change any of this later in Guardrails.</IntroBody>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 9,
          marginTop: 18,
        }}
      >
        {CONSENT_CARDS.map((card) => (
          <ConsentCard
            key={card.id}
            card={card}
            on={scopes[card.id]}
            onToggle={(next) => {
              void haptic.light();
              setScopes((prev) => ({ ...prev, [card.id]: next }));
            }}
          />
        ))}
      </div>

      <div style={{ marginTop: 18 }}>
        <IntroPrimary onClick={accept}>Continue</IntroPrimary>
      </div>

      <p
        style={{
          margin: "12px 0 0",
          fontSize: 11.5,
          lineHeight: 1.55,
          color: "var(--gv-muted)",
          textAlign: "center",
        }}
      >
        Continuing accepts Cue&apos;s terms and privacy policy, and that your
        conversations are sent to third-party AI providers to generate replies.
      </p>
    </div>
  );
}

function ConsentCard({
  card,
  on,
  onToggle,
}: {
  card: (typeof CONSENT_CARDS)[number];
  on: boolean;
  onToggle: (next: boolean) => void;
}) {
  const labelId = `cue-scope-${card.id}`;
  // Off is expressed by the switch, the ‖ glyph AND the copy — never by colour
  // alone, and never by dimming the card. The explanatory sentence is the only
  // thing that says why this one is off, so it stays at full strength.
  const border =
    card.tone === "hold" ? "rgba(224,166,75,.35)" : "rgba(111,214,154,.30)";
  const glyphBg =
    card.tone === "hold" ? "rgba(224,166,75,.15)" : "rgba(111,214,154,.15)";
  const glyphColor =
    card.tone === "hold" ? "var(--gv-hold-text)" : "var(--gv-ok)";

  return (
    <div
      style={{
        background: "var(--gv-surface)",
        border: `1px solid ${border}`,
        borderRadius: 16,
        padding: "13px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          aria-hidden
          style={{
            width: 24,
            height: 24,
            borderRadius: 8,
            background: glyphBg,
            color: glyphColor,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          {card.glyph}
        </span>
        <span id={labelId} style={{ fontSize: 14.5, fontWeight: 600, flex: 1 }}>
          {card.title}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          onClick={() => onToggle(!on)}
          style={{
            width: 44,
            height: 26,
            flexShrink: 0,
            borderRadius: 99,
            border: on ? "none" : "1px solid var(--gv-border)",
            background: on ? "var(--gv-ok-fill)" : "var(--gv-track)",
            position: "relative",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 3,
              left: on ? 21 : 3,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: on ? "#FFFFFF" : "var(--gv-muted)",
              transition: "left .18s ease",
            }}
          />
        </button>
      </div>
      <p
        style={{
          margin: "8px 0 0",
          fontSize: 12.5,
          lineHeight: 1.55,
          color: "var(--gv-body)",
        }}
      >
        {card.body}
      </p>
      {card.norm ? (
        <p
          style={{
            margin: "7px 0 0",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: "var(--gv-hold-text)",
          }}
        >
          {card.norm}
        </p>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── 3 · names ─────────────────────────────── */

/**
 * Only reached when the instance does NOT already know who this is (see
 * `afterConsent`). The instance's own name for itself is used as the CUE IS
 * placeholder rather than as a prefilled value: a placeholder shows what Cue
 * currently answers to without turning "I left the field alone" into a written
 * answer, which matters because "Cue" is also what the daemon reports when
 * nobody has chosen anything.
 */
function NamesStep({
  facts,
  onDone,
}: {
  facts: InstanceFacts;
  onDone: () => void;
}) {
  const [userName, setUserName] = useState("");
  const [assistantName, setAssistantName] = useState("");

  const save = () => {
    const you = userName.trim();
    const them = assistantName.trim();
    if (them) setPendingAssistantName(them);
    // The same parking slot the platform pre-chat funnel uses, so the first
    // conversation picks these up through the existing consumer rather than a
    // second, parallel mechanism.
    // Empty tools/tasks are the truth here, not a placeholder: this arc asks
    // for names only, and inventing interests the user never stated is
    // exactly the fabrication the design rules forbid.
    setPendingPreChatContext({
      tools: [],
      tasks: [],
      tone: DEFAULT_GROUP_ID,
      ...(you ? { userName: you } : {}),
      ...(them ? { assistantName: them } : {}),
    });
    onDone();
  };

  return (
    <div>
      <IntroTitle>Names</IntroTitle>
      <IntroBody>
        What should Cue call you, and what should you call it? Both are optional
        — you can change them later. One question after this, then you&apos;re
        in.
      </IntroBody>

      <IntroField
        id="cue-intro-user-name"
        label="YOU ARE"
        placeholder="Ada"
        value={userName}
        onChange={setUserName}
      />
      <IntroField
        id="cue-intro-assistant-name"
        label="CUE IS"
        placeholder={facts.knownAssistantName ?? "Cue"}
        value={assistantName}
        onChange={setAssistantName}
      />

      <div style={{ marginTop: 20 }}>
        <IntroPrimary onClick={save}>Continue</IntroPrimary>
      </div>
    </div>
  );
}

/* ──────────────────────────── shared bits ────────────────────────────── */

function IntroTitle({ children }: { children: React.ReactNode }) {
  return (
    <h1
      style={{
        margin: 0,
        fontSize: 26,
        lineHeight: 1.15,
        fontWeight: 600,
        letterSpacing: "-.025em",
        textAlign: "center",
      }}
    >
      {children}
    </h1>
  );
}

function IntroBody({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: "12px 0 0",
        fontSize: 14.5,
        lineHeight: 1.6,
        color: "var(--gv-muted)",
        textAlign: "center",
      }}
    >
      {children}
    </p>
  );
}

function IntroPrimary({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        minHeight: 48,
        borderRadius: 13,
        border: "none",
        background: "var(--gv-accent)",
        color: "var(--gv-on-accent)",
        fontSize: 15,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}

function IntroField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div style={{ marginTop: 18 }}>
      <label
        htmlFor={id}
        style={{
          display: "block",
          marginBottom: 7,
          fontFamily: "var(--gv-mono)",
          fontSize: 11,
          letterSpacing: ".07em",
          color: "var(--gv-muted)",
        }}
      >
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="words"
        style={{
          width: "100%",
          minHeight: 48,
          borderRadius: 12,
          border: "1px solid var(--gv-border)",
          background: "var(--gv-surface)",
          color: "var(--gv-text)",
          fontSize: 16,
          fontFamily: "inherit",
          padding: "0 14px",
          outline: "none",
        }}
      />
    </div>
  );
}
