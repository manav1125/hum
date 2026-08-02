/**
 * The Cue sign-on arc — the first thing every user sees.
 *
 * Built from `docs/design/handoff-2026-08-02/06-signon/` (concept "gravity").
 * Screens, in the pack's own lettering:
 *
 *   S  splash        chaos falls into orbit; "Get started"
 *   A  sign in       email → we send a secure link (no password, ever)
 *   B  check email   the link is in flight; resend on a countdown
 *   E  Cue address   `<name>` + a fixed `.justcue.app` suffix
 *   D1 expired       the session lapsed — send a fresh link
 *   D2 not found     that email has no Cue here
 *   D3 offline       the whole system holds still
 *
 * C (connecting) is NOT here: it plays over the real boot, after a link is
 * redeemed, and lives in `connecting-overlay.tsx`.
 *
 * WHAT THIS SCREEN MAY NOT DO
 * - No password field. Cue is magic-link only by design; a password box here
 *   would be a phishing surface for a credential that does not exist.
 * - No token or address in a URL it constructs. The email goes in a POST body
 *   and nowhere else.
 * - No dead ends. A self-hosted instance has no account service of its own, so
 *   every failure to reach HQ degrades to something still actionable — the
 *   hosted sign-in page, or the access-token paste for anyone who already
 *   holds one.
 *
 * The access-token paste is deliberately kept (behind "Have an access token?"
 * on E). It is the documented recovery path in `deploy/README` and the only
 * way in when HQ is down entirely; hiding it would trade a rare ugly screen
 * for a rare unrecoverable one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  connectedSelfHostInstance,
  isSelfHostMode,
  seedCueToken,
} from "@/lib/self-hosted/cue-self-host";
import { openUrl } from "@/runtime/browser";
import { isNativePlatform } from "@/runtime/native-auth";
import { haptic } from "@/utils/haptics";

import {
  GravityStyles,
  OrbitalSystem,
  prefersReducedMotion,
  type GravityMode,
} from "./gravity-kit";
import {
  INSTANCE_DOMAIN,
  instanceUrlFromAddress,
  looksLikeEmail,
  requestSigninLink,
  signinPageUrl,
  type SigninOutcome,
} from "./signon-client";

/** Device-scoped: the splash is a first-run story, not a toll booth. */
const LS_SEEN_SPLASH = "cue:signon:seenSplash";

/** Resend cooldown, matching the pack's `Resend link · 0:42`. */
const RESEND_SECONDS = 42;

type Step =
  | "splash"
  | "signin"
  | "check"
  | "address"
  | "expired"
  | "notfound"
  | "offline";

export function SignonFlow({
  /** Test seam: skip the splash's 9s story. */
  initialStep,
  fetchImpl,
}: {
  initialStep?: Step;
  fetchImpl?: typeof fetch;
} = {}) {
  const [step, setStep] = useState<Step>(() => {
    if (initialStep) return initialStep;
    // A device that previously held a session is not a first-run device: it
    // lapsed. Say so instead of replaying the welcome story at someone who
    // has already met Cue.
    if (hasLapsedSession()) return "expired";
    return hasSeenSplash() ? "signin" : "splash";
  });
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The desktop app's main process holds the instance connection, so it can
  // name the instance the user is signing in to. Absent everywhere else.
  const [instance, setInstance] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void connectedSelfHostInstance().then((url) => {
      if (cancelled || !url) return;
      try {
        setInstance(new URL(url).hostname);
      } catch {
        /* not a URL we can name — stay silent rather than show a raw string */
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const send = useCallback(
    async (address: string) => {
      setNotice(null);
      setFallbackUrl(null);
      setBusy(true);
      const outcome = await requestSigninLink(address, fetchImpl ?? fetch);
      setBusy(false);
      applyOutcome(outcome, {
        setStep,
        setNotice,
        setFallbackUrl,
      });
    },
    [fetchImpl],
  );

  const mode: GravityMode = gravityModeFor(step);

  return (
    <div
      data-gv
      data-signon-step={step}
      style={{
        position: "relative",
        display: "flex",
        // `100dvh`, not `100%`: this renders straight into `#root`, which has
        // no height of its own, so a percentage would collapse to the content
        // and leave the splash's absolutely-positioned layer with nothing to
        // fill.
        minHeight: "100dvh",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        background: step === "splash" ? "var(--gv-bg-deep)" : "var(--gv-bg)",
        color: "var(--gv-text)",
        fontFamily: "var(--gv-font)",
        padding: "32px 20px",
        transition: "background .6s ease",
      }}
    >
      <GravityStyles />

      {step === "splash" ? (
        <SplashScreen
          onDone={() => {
            markSplashSeen();
            void haptic.light();
            setStep("signin");
          }}
        />
      ) : (
        <SheetScreen mode={mode}>
          {step === "signin" ? (
            <SignInScreen
              instance={instance}
              busy={busy}
              notice={notice}
              fallbackUrl={fallbackUrl}
              onSubmit={(value) => {
                setEmail(value);
                void send(value);
              }}
              onUseAddress={() => {
                setNotice(null);
                setFallbackUrl(null);
                setStep("address");
              }}
            />
          ) : null}

          {step === "check" ? (
            <CheckEmailScreen
              email={email}
              busy={busy}
              notice={notice}
              onResend={() => void send(email)}
              onChangeEmail={() => {
                setNotice(null);
                setStep("signin");
              }}
            />
          ) : null}

          {step === "address" ? (
            <AddressScreen
              onBack={() => setStep("signin")}
              notice={notice}
              setNotice={setNotice}
            />
          ) : null}

          {step === "expired" ? (
            <ExpiredScreen
              onSendNew={() => {
                setNotice(null);
                setStep("signin");
              }}
            />
          ) : null}

          {step === "notfound" ? (
            <NotFoundScreen
              email={email}
              message={notice}
              onEdit={() => setStep("signin")}
            />
          ) : null}

          {step === "offline" ? (
            <OfflineScreen
              onRetry={() => {
                setNotice(null);
                setStep(email ? "check" : "signin");
              }}
            />
          ) : null}
        </SheetScreen>
      )}
    </div>
  );
}

/* ────────────────────────────── S · splash ───────────────────────────── */

const BEATS = [
  "Your inbox.",
  "Your meetings.",
  "Your commitments.",
  "One Cue.",
];

function SplashScreen({ onDone }: { onDone: () => void }) {
  // Reduced motion collapses the 9s story to its composed frame; there is no
  // point holding someone for nine seconds of animation they asked not to see.
  const reduced = useMemo(() => prefersReducedMotion(), []);

  return (
    <button
      type="button"
      onClick={onDone}
      aria-label="Get started"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        border: "none",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        cursor: "pointer",
        padding: 24,
      }}
    >
      <OrbitalSystem mode="falling" size={280} />

      <div
        style={{
          position: "relative",
          height: 44,
          width: "100%",
          maxWidth: 340,
          textAlign: "center",
        }}
      >
        {reduced ? (
          <span
            style={{
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: "-.02em",
            }}
          >
            {BEATS[BEATS.length - 1]}
          </span>
        ) : (
          BEATS.map((beat, i) => (
            <span
              key={beat}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: i === BEATS.length - 1 ? 30 : 26,
                fontWeight: 600,
                letterSpacing: "-.02em",
                opacity: 0,
                animation: `gvW${i + 1} 9s ease-out infinite`,
                willChange: "transform, opacity",
              }}
            >
              {beat}
            </span>
          ))
        )}
      </div>

      <p
        style={{
          margin: 0,
          fontSize: 14,
          color: "var(--gv-muted)",
          textAlign: "center",
        }}
      >
        Already in motion, before you ask.
      </p>

      <span
        style={{
          marginTop: 8,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          borderRadius: 12,
          background: "var(--gv-accent)",
          color: "var(--gv-on-accent)",
          padding: "13px 26px",
          fontSize: 15,
          fontWeight: 600,
        }}
      >
        Get started
      </span>
    </button>
  );
}

/* ─────────────────────── the glass sheet the rest share ──────────────── */

/**
 * A / B / E / D* all sit on a glass sheet with the orbital system idling
 * above: you sign in underneath your own solar system.
 */
function SheetScreen({
  mode,
  children,
}: {
  mode: GravityMode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        maxWidth: 420,
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      <OrbitalSystem mode={mode} size={210} dim />
      <div
        style={{
          marginTop: -18,
          width: "100%",
          borderRadius: 22,
          border: "1px solid var(--gv-glass-line)",
          background: "var(--gv-glass)",
          backdropFilter: "blur(18px)",
          padding: "26px 22px",
          animation: "gvRise .5s cubic-bezier(.2,.7,.2,1) both",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <h1
      style={{
        margin: 0,
        fontSize: 27,
        lineHeight: 1.12,
        fontWeight: 600,
        letterSpacing: "-.025em",
        textAlign: "center",
      }}
    >
      {children}
    </h1>
  );
}

function Body({ children }: { children: React.ReactNode }) {
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

function PrimaryButton({
  children,
  disabled,
  onClick,
  type = "button",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{
        position: "relative",
        overflow: "hidden",
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
      {disabled ? null : (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: 70,
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,.24), transparent)",
            animation: "gvSheen 5.5s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />
      )}
    </button>
  );
}

function QuietButton({
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
        minHeight: 44,
        border: "none",
        background: "none",
        color: disabled ? "var(--gv-muted)" : "var(--gv-accent-text)",
        fontSize: 13.5,
        fontFamily: "inherit",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

/**
 * Every state carries a glyph as well as a colour — an inline status line no
 * screen reader or colour-blind user has to infer from a hue.
 */
function StateLine({
  tone,
  glyph,
  children,
}: {
  tone: "error" | "info" | "ok";
  glyph: string;
  children: React.ReactNode;
}) {
  const color =
    tone === "error"
      ? "var(--gv-error)"
      : tone === "ok"
        ? "var(--gv-ok)"
        : "var(--gv-muted)";
  return (
    <p
      role="status"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        margin: "14px 0 0",
        fontSize: 13.5,
        lineHeight: 1.55,
        color,
        textAlign: "left",
      }}
    >
      <span aria-hidden style={{ lineHeight: 1.55 }}>
        {glyph}
      </span>
      <span>{children}</span>
    </p>
  );
}

/* ────────────────────────────── A · sign in ──────────────────────────── */

function SignInScreen({
  instance,
  busy,
  notice,
  fallbackUrl,
  onSubmit,
  onUseAddress,
}: {
  instance: string | null;
  busy: boolean;
  notice: string | null;
  fallbackUrl: string | null;
  onSubmit: (email: string) => void;
  onUseAddress: () => void;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  return (
    <form
      // The input stays `type="email"` for the right mobile keyboard, but the
      // browser's own validation bubble is suppressed: it is a grey OS popup
      // in the middle of a designed screen, it disappears on the next click,
      // and it is not announced the way our inline state line is.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!looksLikeEmail(value)) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        void haptic.medium();
        onSubmit(value.trim());
      }}
    >
      <Title>
        Welcome.
        <br />
        This one&apos;s yours.
      </Title>
      <Body>
        Your private Cue is waiting. Enter your email and we&apos;ll send a
        secure sign-in link.
      </Body>
      {instance ? (
        <p
          style={{
            margin: "8px 0 0",
            textAlign: "center",
            fontFamily: "var(--gv-mono)",
            fontSize: 12,
            color: "var(--gv-muted)",
          }}
        >
          {instance}
        </p>
      ) : null}

      <label
        htmlFor="cue-signin-email"
        style={{
          display: "block",
          margin: "22px 0 7px",
          fontFamily: "var(--gv-mono)",
          fontSize: 11,
          letterSpacing: ".07em",
          color: "var(--gv-muted)",
        }}
      >
        EMAIL
      </label>
      <input
        id="cue-signin-email"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="you@example.com"
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? "cue-signin-email-error" : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          if (invalid) setInvalid(false);
        }}
        style={{
          width: "100%",
          minHeight: 50,
          borderRadius: 12,
          border: `1px solid ${invalid ? "var(--gv-error)" : "var(--gv-border)"}`,
          background: "var(--gv-surface)",
          color: "var(--gv-text)",
          // 16px minimum: anything smaller makes iOS Safari zoom on focus.
          fontSize: 16,
          fontFamily: "inherit",
          padding: "0 14px",
          outline: "none",
        }}
      />
      {invalid ? (
        <span id="cue-signin-email-error">
          <StateLine tone="error" glyph="!">
            That doesn&apos;t look like an email address yet.
          </StateLine>
        </span>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send sign-in link"}
        </PrimaryButton>
      </div>

      {notice ? (
        <StateLine tone="error" glyph="!">
          {notice}
        </StateLine>
      ) : null}

      {fallbackUrl ? (
        <div style={{ marginTop: 6 }}>
          <QuietButton
            onClick={() => {
              // The bare sign-in page. No email, no token, nothing personal in
              // the URL — the user retypes their address on the other side.
              //
              // `openUrl` and not `location.assign`: inside the desktop app
              // this SPA IS the app window, and navigating it to justcue.ai
              // would replace Cue with a web page the user cannot get back
              // from. `openUrl` hands Electron's window-open handler the URL,
              // which sends it to the system browser.
              void openUrl(fallbackUrl);
            }}
          >
            Continue on justcue.ai →
          </QuietButton>
        </div>
      ) : null}

      <div style={{ marginTop: 4 }}>
        <QuietButton onClick={onUseAddress}>
          Enter your Cue address instead
        </QuietButton>
      </div>
    </form>
  );
}

/* ─────────────────────────── B · check email ─────────────────────────── */

function CheckEmailScreen({
  email,
  busy,
  notice,
  onResend,
  onChangeEmail,
}: {
  email: string;
  busy: boolean;
  notice: string | null;
  onResend: () => void;
  onChangeEmail: () => void;
}) {
  const [left, setLeft] = useState(RESEND_SECONDS);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timer.current = setInterval(() => {
      setLeft((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  // "Open Mail" is only rendered where it can actually open something. On a
  // desktop browser a mailto: with no handler is a button that does nothing,
  // which is the exact failure class this rework exists to remove.
  const canOpenMail = isNativePlatform();

  return (
    <div>
      <Title>Your link is in flight</Title>
      <Body>
        Sent to <strong style={{ color: "var(--gv-text)" }}>{email}</strong>.
        Open it on this device and you&apos;ll drop straight into your Cue.
      </Body>
      <StateLine tone="info" glyph="◷">
        The link is good for 15 minutes.
      </StateLine>

      {canOpenMail ? (
        <div style={{ marginTop: 16 }}>
          <PrimaryButton
            onClick={() => {
              void haptic.medium();
              globalThis.window?.location.assign("message://");
            }}
          >
            Open Mail
          </PrimaryButton>
        </div>
      ) : null}

      <div style={{ marginTop: canOpenMail ? 4 : 16 }}>
        {left > 0 ? (
          <QuietButton disabled onClick={() => undefined}>
            Resend link · 0:{String(left).padStart(2, "0")}
          </QuietButton>
        ) : canOpenMail ? (
          <QuietButton disabled={busy} onClick={onResend}>
            {busy ? "Sending…" : "Resend link"}
          </QuietButton>
        ) : (
          <PrimaryButton disabled={busy} onClick={onResend}>
            {busy ? "Sending…" : "Resend link"}
          </PrimaryButton>
        )}
      </div>

      {notice ? (
        <StateLine tone="error" glyph="!">
          {notice}
        </StateLine>
      ) : null}

      <div style={{ marginTop: 4 }}>
        <QuietButton onClick={onChangeEmail}>Use a different email</QuietButton>
      </div>
    </div>
  );
}

/* ───────────────────────── E · enter Cue address ─────────────────────── */

function AddressScreen({
  onBack,
  notice,
  setNotice,
}: {
  onBack: () => void;
  notice: string | null;
  setNotice: (value: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    setNotice(null);
    const url = instanceUrlFromAddress(name);
    if (!url) {
      setNotice(
        `Enter just the name — the part before ${INSTANCE_DOMAIN.slice(1)}.`,
      );
      return;
    }
    setConnecting(true);
    // In the desktop app the SPA is served from `app://` and is not any
    // instance, so the main process owns the connection. Seeding here instead
    // would strand the session on an origin that talks to no daemon.
    const bridge = globalThis.window?.vellum?.selfHost;
    if (bridge) {
      const connected = await bridge.connect(url).catch(() => null);
      if (connected) return; // main is loading the instance now
      setConnecting(false);
      setNotice("That address doesn't point at a Cue instance.");
      return;
    }
    globalThis.window?.location.assign(url);
  };

  const connectWithToken = () => {
    setNotice(null);
    const bridge = globalThis.window?.vellum?.selfHost;
    if (bridge && token.includes("://")) {
      setConnecting(true);
      void bridge
        .connect(token)
        .then((connected) => {
          if (connected) return; // main is loading the instance now
          setConnecting(false);
          setNotice(
            "That link doesn't point at a Cue instance. Paste the full https link from your sign-in email.",
          );
        })
        .catch(() => {
          setConnecting(false);
          setNotice("That link doesn't point at a Cue instance.");
        });
      return;
    }
    if (!seedCueToken(token)) {
      setNotice(
        "That doesn't look like a valid access token. Paste the token (or the full connect link) you were given.",
      );
      return;
    }
    setConnecting(true);
    globalThis.window?.location.assign("/assistant/");
  };

  return (
    <div>
      <Title>You know the way.</Title>
      <Body>
        Enter your Cue&apos;s web address and we&apos;ll take you straight
        there.
      </Body>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginTop: 22,
          borderRadius: 12,
          border: "1px solid var(--gv-border)",
          background: "var(--gv-surface)",
          overflow: "hidden",
        }}
      >
        <input
          id="cue-instance-name"
          aria-label="Your Cue address"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (notice) setNotice(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void connect();
            }
          }}
          placeholder="cue-you"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 50,
            border: "none",
            background: "transparent",
            color: "var(--gv-text)",
            fontFamily: "var(--gv-mono)",
            fontSize: 16,
            padding: "0 4px 0 14px",
            outline: "none",
          }}
        />
        <span
          style={{
            padding: "0 14px 0 0",
            fontFamily: "var(--gv-mono)",
            fontSize: 16,
            color: "var(--gv-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {INSTANCE_DOMAIN}
        </span>
      </div>

      {notice ? (
        <StateLine tone="error" glyph="!">
          {notice}
        </StateLine>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <PrimaryButton
          disabled={connecting || !name.trim()}
          onClick={() => void connect()}
        >
          {connecting ? "Connecting…" : "Connect"}
        </PrimaryButton>
      </div>

      <div style={{ marginTop: 4 }}>
        <QuietButton onClick={onBack}>← Back to email sign-in</QuietButton>
      </div>

      {showToken ? (
        <div style={{ marginTop: 14 }}>
          <label
            htmlFor="cue-token"
            style={{
              display: "block",
              marginBottom: 7,
              fontFamily: "var(--gv-mono)",
              fontSize: 11,
              letterSpacing: ".07em",
              color: "var(--gv-muted)",
            }}
          >
            ACCESS TOKEN
          </label>
          <textarea
            id="cue-token"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              if (notice) setNotice(null);
            }}
            rows={3}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="eyJhbGciOi…  or the full https link you were given"
            style={{
              width: "100%",
              resize: "none",
              borderRadius: 12,
              border: "1px solid var(--gv-border)",
              background: "var(--gv-surface)",
              color: "var(--gv-text)",
              fontFamily: "var(--gv-mono)",
              fontSize: 13,
              padding: "10px 12px",
              outline: "none",
            }}
          />
          <div style={{ marginTop: 8 }}>
            <QuietButton
              disabled={!token.trim() || connecting}
              onClick={connectWithToken}
            >
              Connect with token
            </QuietButton>
          </div>
        </div>
      ) : (
        <QuietButton onClick={() => setShowToken(true)}>
          Have an access token? Paste it instead
        </QuietButton>
      )}
    </div>
  );
}

/* ──────────────────────────── D1 · expired ───────────────────────────── */

function ExpiredScreen({ onSendNew }: { onSendNew: () => void }) {
  return (
    <div>
      <Title>Your sign-in expired</Title>
      <Body>
        Sign-in links last 15 minutes, and a session lasts 30 days. Send
        yourself a fresh one — nothing in your Cue has changed.
      </Body>
      <StateLine tone="error" glyph="◷">
        This device&apos;s access has lapsed.
      </StateLine>
      <div style={{ marginTop: 16 }}>
        <PrimaryButton onClick={onSendNew}>Send a new link</PrimaryButton>
      </div>
    </div>
  );
}

/* ─────────────────────────── D2 · not recognised ─────────────────────── */

function NotFoundScreen({
  email,
  message,
  onEdit,
}: {
  email: string;
  message: string | null;
  onEdit: () => void;
}) {
  return (
    <div>
      <Title>We couldn&apos;t find a Cue for that email</Title>
      <Body>
        {message ?? "Double-check the address, or ask whoever set up your Cue."}
      </Body>
      <StateLine tone="error" glyph="○">
        <span style={{ fontFamily: "var(--gv-mono)" }}>{email}</span> has no Cue
        here.
      </StateLine>
      <div style={{ marginTop: 16 }}>
        <PrimaryButton onClick={onEdit}>Try another email</PrimaryButton>
      </div>
    </div>
  );
}

/* ──────────────────────────── D3 · offline ───────────────────────────── */

function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div>
      <Title>You&apos;re offline</Title>
      <Body>
        The orbit&apos;s still here — connect to the internet and everything
        picks right back up.
      </Body>
      <StateLine tone="error" glyph="⦸">
        No network connection.
      </StateLine>
      <div style={{ marginTop: 16 }}>
        <PrimaryButton onClick={onRetry}>Retry</PrimaryButton>
      </div>
    </div>
  );
}

/* ──────────────────────────────── plumbing ───────────────────────────── */

function gravityModeFor(step: Step): GravityMode {
  switch (step) {
    case "splash":
      return "falling";
    case "expired":
      return "decayed";
    case "notfound":
      return "empty";
    case "offline":
      return "frozen";
    default:
      return "idle";
  }
}

/**
 * Route an HQ answer onto a screen. Exported for the test suite so the
 * mapping — the part that decides whether a user sees "check your email" or
 * the truth — can be asserted without driving the DOM for every branch.
 */
export function applyOutcome(
  outcome: SigninOutcome,
  ui: {
    setStep: (step: Step) => void;
    setNotice: (value: string | null) => void;
    setFallbackUrl: (value: string | null) => void;
  },
): void {
  switch (outcome.kind) {
    case "sent":
      void haptic.success();
      ui.setStep("check");
      return;
    case "offline":
      ui.setStep("offline");
      return;
    case "invite_required":
      ui.setNotice(outcome.message);
      ui.setStep("notfound");
      return;
    case "invited_no_account":
      // Not a "not found": the person IS expected, their Cue just isn't up.
      // Keep them on the sign-in screen with the real explanation.
      ui.setNotice(outcome.message);
      return;
    case "send_failed":
      ui.setNotice(
        "We couldn't send the email just now. Try again in a moment.",
      );
      return;
    case "email_not_configured":
      // HQ has no mailer. Saying "check your inbox" here would be a lie.
      ui.setNotice(
        "This Cue can't send email right now, so no link went out. Contact hello@justcue.ai.",
      );
      ui.setFallbackUrl(signinPageUrl());
      return;
    case "unreachable":
      ui.setNotice(
        "We couldn't reach Cue's sign-in service from here, so no link was sent.",
      );
      ui.setFallbackUrl(outcome.signinUrl);
      return;
  }
}

function hasSeenSplash(): boolean {
  try {
    return localStorage.getItem(LS_SEEN_SPLASH) === "1";
  } catch {
    return false;
  }
}

function markSplashSeen(): void {
  try {
    localStorage.setItem(LS_SEEN_SPLASH, "1");
  } catch {
    /* private mode — replaying the splash is a far smaller cost than a crash */
  }
}

/**
 * This device has been signed in before and no longer is. `isSelfHostMode()`
 * is only ever set by a successful token seed, and the auth layer clears the
 * TOKEN (not the flag) on expiry or a 401 — so flag-without-token is exactly
 * "your access lapsed", and the user deserves to be told that rather than be
 * shown a first-run welcome.
 */
function hasLapsedSession(): boolean {
  return isSelfHostMode();
}
