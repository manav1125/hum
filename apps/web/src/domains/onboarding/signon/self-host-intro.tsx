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
 * Everything it shows is either typed by the user on this screen or read from
 * the session. Nothing is invented to fill a gap: on a fresh instance there
 * is no activity to show, and this says so by not claiming any.
 */
import { useState } from "react";
import { useNavigate } from "react-router";

import {
  setPendingAssistantName,
  setPendingPreChatContext,
} from "@/domains/onboarding/prechat";
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { useAuthStore } from "@/stores/auth-store";
import { persistConsentForUser } from "@/utils/onboarding-cleanup";
import { routes } from "@/utils/routes";
import { haptic } from "@/utils/haptics";

import { GravityStyles, OrbitalSystem } from "./gravity-kit";
import { markSelfHostIntroComplete } from "./intro-state";

type IntroStep = "arrived" | "consent" | "names";

export function SelfHostIntro() {
  const navigate = useNavigate();
  const [step, setStep] = useState<IntroStep>("arrived");

  const finish = () => {
    markSelfHostIntroComplete();
    void haptic.success();
    void navigate(routes.assistant, { replace: true });
  };

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
            <ArrivedStep onNext={() => setStep("consent")} />
          ) : null}
          {step === "consent" ? (
            <ConsentStep onNext={() => setStep("names")} />
          ) : null}
          {step === "names" ? <NamesStep onDone={finish} /> : null}
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
 */
function ArrivedStep({ onNext }: { onNext: () => void }) {
  const user = useAuthStore((s) => s.user);
  const name = displayNameOf(user);

  return (
    <div>
      <IntroTitle>{name ? `You're in, ${name}.` : "You're in."}</IntroTitle>
      <IntroBody>
        This Cue is yours alone — it runs on your own instance. Nothing has
        happened here yet; two quick questions and it starts working.
      </IntroBody>
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

function ConsentStep({ onNext }: { onNext: () => void }) {
  const [tos, setTos] = useState(false);
  const [ai, setAi] = useState(false);
  const setTosAccepted = useOnboardingStore.getState().setTosAccepted;
  const setAiDataConsent = useOnboardingStore.getState().setAiDataConsent;

  const accept = () => {
    setTosAccepted(true);
    setAiDataConsent(true);
    // Same per-user device keys the platform funnel writes, so a later build
    // that DOES run the platform gate does not re-prompt this user.
    persistConsentForUser(useAuthStore.getState().user?.id ?? null, true, true);
    void haptic.light();
    onNext();
  };

  return (
    <div>
      <IntroTitle>Before we start</IntroTitle>
      <IntroBody>
        Two things Cue needs you to agree to, in plain terms.
      </IntroBody>

      <ConsentRow
        checked={tos}
        onChange={setTos}
        id="cue-consent-tos"
        label="I accept Cue's terms of use and privacy policy."
      />
      <ConsentRow
        checked={ai}
        onChange={setAi}
        id="cue-consent-ai"
        label="I understand my conversations are sent to third-party AI providers to generate replies."
      />

      <div style={{ marginTop: 18 }}>
        <IntroPrimary disabled={!tos || !ai} onClick={accept}>
          Agree and continue
        </IntroPrimary>
      </div>
      {!tos || !ai ? (
        <p
          role="status"
          style={{
            display: "flex",
            gap: 8,
            margin: "12px 0 0",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--gv-muted)",
          }}
        >
          <span aria-hidden>‖</span>
          <span>
            Both boxes are required — Cue will not proceed without them.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function ConsentRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      style={{
        display: "flex",
        gap: 11,
        alignItems: "flex-start",
        marginTop: 16,
        fontSize: 14,
        lineHeight: 1.55,
        cursor: "pointer",
      }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }}
      />
      <span>{label}</span>
    </label>
  );
}

/* ───────────────────────────── 3 · names ─────────────────────────────── */

function NamesStep({ onDone }: { onDone: () => void }) {
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
        — you can change them later.
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
        placeholder="Cue"
        value={assistantName}
        onChange={setAssistantName}
      />

      <div style={{ marginTop: 20 }}>
        <IntroPrimary onClick={save}>Start using Cue</IntroPrimary>
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
