/**
 * PhoneSetupSheet — mobile-v3 on-device phone-channel (Twilio) setup
 * (spec frame 73: a 3-step checklist in the frame-39 grammar — deep-link to
 * the Twilio console, a masked credential pair with the instance-only
 * promise, then assign the voice number that makes Cue answer as your
 * receptionist).
 *
 * DATA (all real — the same daemon endpoints the desktop Twilio workbench
 * uses):
 *  · credentials = `POST /v1/assistants/{id}/integrations/twilio/credentials`
 *      ({ accountSid, authToken }) — the daemon validates against Twilio
 *      BEFORE storing (the auth token lands in the credential store, never
 *      the config doc), so a bad pair is a 400 that never persists.
 *  · config  = `GET  …/integrations/twilio/config` (already-configured case).
 *  · numbers = `GET  …/integrations/twilio/numbers` (voice-capable numbers on
 *      the account) → `POST …/numbers/assign` ({ phoneNumber }) wires that
 *      number's voice webhook so inbound calls ring Cue.
 *  · persona = `POST …/config/set` ({ path: "calls.receptionist.persona",
 *      value }) — the free-text receptionist persona the inbound call loop
 *      reads.
 *
 * HONESTY: the sheet renders on any instance, but a line under the number
 * step says calls stay inert until a voice number is assigned AND Twilio
 * credentials are live — no drawn affordance the backend can't honor.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  integrationsTwilioConfigGetOptions,
  integrationsTwilioConfigGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  configSetPost,
  integrationsTwilioCredentialsPost,
  integrationsTwilioNumbersAssignPost,
  integrationsTwilioNumbersGet,
} from "@/generated/daemon/sdk.gen";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { GlassCard } from "@/mobile-v3/glass-card";
import { mv3Mono } from "@/mobile-v3/mv3-kit";
import { SheetShell } from "@/mobile-v3/sheet-shell";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";
import { haptic } from "@/utils/haptics";

type Stage = "credentials" | "number" | "done";

interface TwilioNumber {
  phoneNumber: string;
  friendlyName: string;
  capabilities: { voice: boolean };
}

/** Mask all but the last 4 chars of a stored credential for the manage view. */
function maskTail(value: string | undefined): string {
  if (!value) return "";
  const tail = value.slice(-4);
  return `••••••••${tail}`;
}

/** The frame-73 phone plane tile (Twilio red, 44px). */
function PhoneTile() {
  return (
    <span
      aria-hidden
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        background: "#F22F46",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff">
        <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z" />
      </svg>
    </span>
  );
}

/** Step number badge — pending gray / active blue / done green (frame 39/73). */
function StepBadge({
  n,
  state,
}: {
  n: number;
  state: "pending" | "active" | "done";
}) {
  const bg =
    state === "done"
      ? "color-mix(in srgb, var(--mv3-green) 18%, transparent)"
      : state === "active"
        ? "var(--mv3-accent)"
        : "var(--mv3-btn2-bg)";
  const color =
    state === "done"
      ? "var(--mv3-green)"
      : state === "active"
        ? "#fff"
        : "var(--mv3-muted)";
  return (
    <span
      aria-hidden
      style={{
        width: 20,
        height: 20,
        borderRadius: "50%",
        background: bg,
        color,
        fontSize: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {state === "done" ? "✓" : n}
    </span>
  );
}

function stepCardStyle(
  state: "pending" | "active" | "done",
): React.CSSProperties {
  if (state === "active") {
    return {
      border: "1.5px solid var(--mv3-accent)",
      boxShadow: "0 0 0 3px rgba(61,110,232,.12)",
    };
  }
  return { opacity: state === "pending" ? 0.7 : 1 };
}

const tokenWell: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "var(--mv3-token-well)",
  border: "1px solid var(--mv3-token-well-border)",
  borderRadius: 11,
  padding: "0 13px",
};

const wellInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: mv3Mono,
  fontSize: 16,
  color: "var(--mv3-text)",
  background: "transparent",
  border: "none",
  outline: "none",
  padding: "12px 0",
  minHeight: 44,
};

export function PhoneSetupSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const [stage, setStage] = useState<Stage>("credentials");
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [credError, setCredError] = useState<string | null>(null);

  const [numbers, setNumbers] = useState<TwilioNumber[] | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<string | null>(null);
  const [numberError, setNumberError] = useState<string | null>(null);
  const [assignedNumber, setAssignedNumber] = useState<string | null>(null);

  const [persona, setPersona] = useState("");
  const [personaSaved, setPersonaSaved] = useState(false);
  const personaLoaded = useRef(false);

  // Already-configured detection — a live credential pair (and maybe a number)
  // skips straight to the number step or the manage view.
  const configQuery = useQuery({
    ...integrationsTwilioConfigGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: open,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!open) return;
    const config = configQuery.data;
    if (!config) return;
    if (config.hasCredentials && config.phoneNumber) {
      setAssignedNumber(config.phoneNumber);
      setStage("done");
    } else if (config.hasCredentials) {
      setStage((s) => (s === "credentials" ? "number" : s));
    }
    if (config.accountSid && !accountSid) setAccountSid(config.accountSid);
  }, [open, configQuery.data, accountSid]);

  // Reset volatile state when the sheet closes so a reopen starts clean.
  useEffect(() => {
    if (!open) {
      personaLoaded.current = false;
      setAuthToken("");
      setCredError(null);
      setNumberError(null);
      setPersonaSaved(false);
    }
  }, [open]);

  // ── Step 2 — validate + store credentials ────────────────────────────
  const saveCreds = useMutation({
    mutationFn: async (input: { accountSid: string; authToken: string }) => {
      const { data, error, response } = await integrationsTwilioCredentialsPost({
        path: { assistant_id: assistantId },
        body: { accountSid: input.accountSid, authToken: input.authToken },
        throwOnError: false,
      });
      assertHasResponse(response, error, "Couldn't reach your instance.");
      if (!response.ok || !data?.hasCredentials) {
        throw new Error(
          extractErrorMessage(
            error,
            response,
            "Twilio didn't accept those credentials.",
          ),
        );
      }
      return data;
    },
    onSuccess: () => {
      haptic.medium();
      setCredError(null);
      setStage("number");
      void queryClient.invalidateQueries({
        queryKey: integrationsTwilioConfigGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
      void loadNumbers();
    },
    onError: (err) => {
      haptic.error();
      setCredError(err instanceof Error ? err.message : "That didn't validate.");
    },
  });

  // ── Step 3 — list voice numbers ──────────────────────────────────────
  const loadingNumbers = useRef(false);
  async function loadNumbers() {
    if (loadingNumbers.current) return;
    loadingNumbers.current = true;
    setNumberError(null);
    try {
      const { data, error, response } = await integrationsTwilioNumbersGet({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });
      assertHasResponse(response, error, "Couldn't reach your instance.");
      if (!response.ok || !data) {
        setNumberError(
          extractErrorMessage(error, response, "Couldn't list your numbers."),
        );
        return;
      }
      const voice = (data.numbers ?? []).filter((n) => n.capabilities?.voice);
      setNumbers(voice);
      if (voice.length === 1) setSelectedNumber(voice[0]!.phoneNumber);
    } finally {
      loadingNumbers.current = false;
    }
  }

  useEffect(() => {
    if (open && stage === "number" && numbers === null) void loadNumbers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stage]);

  // ── Step 3 — assign the chosen number ────────────────────────────────
  const assign = useMutation({
    mutationFn: async (phoneNumber: string) => {
      // The daemon route accepts { phoneNumber }; the generated type
      // under-declares the body (never), so pass the payload through.
      const { data, error, response } = await integrationsTwilioNumbersAssignPost({
        path: { assistant_id: assistantId },
        body: { phoneNumber } as unknown as never,
        throwOnError: false,
      });
      assertHasResponse(response, error, "Couldn't reach your instance.");
      if (!response.ok || !data) {
        throw new Error(
          extractErrorMessage(error, response, "Couldn't assign that number."),
        );
      }
      return data;
    },
    onSuccess: (data) => {
      haptic.success();
      setAssignedNumber(data.phoneNumber ?? selectedNumber);
      setStage("done");
      void queryClient.invalidateQueries({
        queryKey: integrationsTwilioConfigGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
    },
    onError: (err) => {
      haptic.error();
      setNumberError(
        err instanceof Error ? err.message : "Couldn't assign that number.",
      );
    },
  });

  // ── Receptionist persona (config/set) ────────────────────────────────
  const savePersona = useMutation({
    mutationFn: async (value: string) => {
      // config/set takes { path, value }; the generated type declares no body,
      // so pass it through to the real CLI-backed endpoint.
      const { error, response } = await configSetPost({
        path: { assistant_id: assistantId },
        body: { path: "calls.receptionist.persona", value } as unknown as never,
        throwOnError: false,
      });
      assertHasResponse(response, error, "Couldn't reach your instance.");
      if (!response.ok) {
        throw new Error(
          extractErrorMessage(error, response, "Couldn't save the persona."),
        );
      }
    },
    onSuccess: () => {
      haptic.light();
      setPersonaSaved(true);
    },
  });

  const commitPersona = () => {
    const value = persona.trim();
    if (!personaLoaded.current) return;
    savePersona.mutate(value);
  };

  const step2State: "pending" | "active" | "done" =
    stage === "credentials" ? "active" : "done";
  const step3State: "pending" | "active" | "done" =
    stage === "done" ? "done" : stage === "number" ? "active" : "pending";

  if (!open) return null;

  return (
    <SheetShell open onClose={onClose} label="Set up your phone line">
      <div style={{ padding: "0 2px 4px" }}>
        {/* Header — frame 73's tile + title + promise line. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <PhoneTile />
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.4px" }}>
              Phone line
            </div>
            <div
              style={{ fontSize: 11.5, color: "var(--mv3-muted)", marginTop: 1 }}
            >
              Cue answers your calls as a receptionist
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 9,
            marginTop: 16,
          }}
        >
          {/* Step 1 — Twilio console deep link. */}
          <GlassCard radius={18} padding="13px 15px" blur={false}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <StepBadge n={1} state="done" />
              <span style={{ fontSize: 13, flex: 1 }}>
                Create a{" "}
                <b style={{ color: "var(--mv3-micro)" }}>Twilio</b> account, buy a
                voice number
              </span>
              <a
                href="https://console.twilio.com"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => haptic.medium()}
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-micro)",
                  textDecoration: "none",
                  padding: "12px 0 12px 12px",
                  margin: "-12px 0",
                }}
              >
                Open ›
              </a>
            </div>
          </GlassCard>

          {/* Step 2 — credentials. */}
          <GlassCard
            radius={18}
            padding="13px 15px"
            blur={false}
            style={stepCardStyle(step2State)}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                marginBottom: step2State === "active" ? 10 : 0,
              }}
            >
              <StepBadge n={2} state={step2State} />
              <span style={{ fontSize: 13, flex: 1 }}>
                {step2State === "done"
                  ? `Credentials saved${
                      configQuery.data?.accountSid
                        ? ` — ${maskTail(configQuery.data.accountSid)}`
                        : ""
                    }`
                  : "Paste your Account SID and Auth Token"}
              </span>
            </div>
            {step2State === "active" ? (
              <>
                <div style={tokenWell}>
                  <input
                    type="text"
                    value={accountSid}
                    onChange={(e) => {
                      setCredError(null);
                      setAccountSid(e.target.value);
                    }}
                    placeholder="Account SID   AC…"
                    aria-label="Twilio Account SID"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    style={wellInput}
                  />
                </div>
                <div style={{ ...tokenWell, marginTop: 8 }}>
                  <input
                    type="password"
                    value={authToken}
                    onChange={(e) => {
                      setCredError(null);
                      setAuthToken(e.target.value);
                    }}
                    placeholder="Auth Token  ••••••••"
                    aria-label="Twilio Auth Token"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    style={wellInput}
                  />
                </div>
                {credError ? (
                  <div
                    role="alert"
                    style={{
                      fontSize: 11.5,
                      color: "#E5675B",
                      marginTop: 7,
                      lineHeight: 1.4,
                    }}
                  >
                    {credError}
                  </div>
                ) : null}
                <div
                  style={{
                    fontSize: 10.5,
                    color: "var(--mv3-muted)",
                    marginTop: 7,
                  }}
                >
                  Stored on your instance only — the token never touches our
                  servers
                </div>
              </>
            ) : null}
          </GlassCard>

          {/* Step 3 — assign a voice number. */}
          <GlassCard
            radius={18}
            padding="13px 15px"
            blur={false}
            style={stepCardStyle(step3State)}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                marginBottom: step3State === "active" ? 10 : 0,
              }}
            >
              <StepBadge n={3} state={step3State} />
              <span style={{ fontSize: 13, flex: 1 }}>
                {step3State === "done"
                  ? `${assignedNumber ?? "Your number"} is live`
                  : "Choose the number Cue answers"}
              </span>
            </div>
            {step3State === "active" ? (
              <>
                {numbers === null ? (
                  <div style={{ fontSize: 12, color: "var(--mv3-muted)" }}>
                    Loading your voice numbers…
                  </div>
                ) : numbers.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--mv3-muted)", lineHeight: 1.5 }}>
                    No voice-capable numbers on this account yet — buy one in the
                    Twilio console, then reopen this sheet.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {numbers.map((n) => {
                      const active = selectedNumber === n.phoneNumber;
                      return (
                        <button
                          key={n.phoneNumber}
                          type="button"
                          onClick={() => {
                            haptic.light();
                            setSelectedNumber(n.phoneNumber);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                            textAlign: "left",
                            fontFamily: "inherit",
                            background: active
                              ? "rgba(61,110,232,.12)"
                              : "var(--mv3-btn2-bg)",
                            border: active
                              ? "1.5px solid var(--mv3-accent)"
                              : "1px solid var(--mv3-btn2-border)",
                            borderRadius: 11,
                            padding: "11px 13px",
                            minHeight: 44,
                            cursor: "pointer",
                          }}
                        >
                          <span
                            style={{
                              fontFamily: mv3Mono,
                              fontSize: 14,
                              color: "var(--mv3-text)",
                            }}
                          >
                            {n.phoneNumber}
                          </span>
                          <span
                            style={{ fontSize: 11, color: "var(--mv3-muted)" }}
                          >
                            {active ? "Selected" : n.friendlyName}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {numberError ? (
                  <div
                    role="alert"
                    style={{
                      fontSize: 11.5,
                      color: "#E5675B",
                      marginTop: 7,
                      lineHeight: 1.4,
                    }}
                  >
                    {numberError}
                  </div>
                ) : null}
                <div
                  style={{
                    fontSize: 10.5,
                    color: "var(--mv3-muted)",
                    marginTop: 8,
                    lineHeight: 1.5,
                  }}
                >
                  Calls stay inert until a number is assigned here — assigning
                  points that number's voice webhook at Cue.
                </div>
              </>
            ) : null}
          </GlassCard>
        </div>

        {/* Receptionist persona — the frame-73 persona line. */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>
            Receptionist persona
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--mv3-muted)",
              marginTop: 2,
              marginBottom: 7,
              lineHeight: 1.5,
            }}
          >
            How Cue introduces itself and what it will and won't do. It always
            checks with you before anything irreversible.
          </div>
          <textarea
            value={persona}
            onFocus={() => {
              // Only treat edits as user intent once the field is focused —
              // avoids saving an empty string over a config we never loaded.
              personaLoaded.current = true;
            }}
            onChange={(e) => {
              setPersonaSaved(false);
              setPersona(e.target.value);
            }}
            onBlur={commitPersona}
            placeholder="Warm, concise front desk for Acme. Take a message, never quote prices."
            aria-label="Receptionist persona"
            rows={3}
            style={{
              width: "100%",
              fontFamily: "inherit",
              fontSize: 14,
              color: "var(--mv3-text)",
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 12,
              padding: "11px 13px",
              outline: "none",
              resize: "vertical",
              lineHeight: 1.45,
            }}
          />
          {personaSaved ? (
            <div
              style={{ fontSize: 10.5, color: "var(--mv3-green)", marginTop: 5 }}
            >
              Saved ✓
            </div>
          ) : null}
        </div>

        {/* CTA — advances per stage. */}
        {stage === "credentials" ? (
          <button
            type="button"
            disabled={
              !accountSid.trim() || !authToken.trim() || saveCreds.isPending
            }
            onClick={() => {
              haptic.medium();
              setCredError(null);
              saveCreds.mutate({
                accountSid: accountSid.trim(),
                authToken: authToken.trim(),
              });
            }}
            style={{
              width: "100%",
              background:
                !accountSid.trim() || !authToken.trim() || saveCreds.isPending
                  ? "var(--mv3-btn2-bg)"
                  : "var(--mv3-accent-fill-gradient)",
              color:
                !accountSid.trim() || !authToken.trim() || saveCreds.isPending
                  ? "var(--mv3-muted)"
                  : "#fff",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 14,
              padding: 13,
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              marginTop: 14,
              cursor:
                !accountSid.trim() || !authToken.trim() || saveCreds.isPending
                  ? "default"
                  : "pointer",
            }}
          >
            {saveCreds.isPending ? "Checking with Twilio…" : "Save credentials"}
          </button>
        ) : stage === "number" ? (
          <button
            type="button"
            disabled={!selectedNumber || assign.isPending}
            onClick={() => {
              if (!selectedNumber) return;
              haptic.medium();
              setNumberError(null);
              assign.mutate(selectedNumber);
            }}
            style={{
              width: "100%",
              background:
                !selectedNumber || assign.isPending
                  ? "var(--mv3-btn2-bg)"
                  : "var(--mv3-accent-fill-gradient)",
              color:
                !selectedNumber || assign.isPending
                  ? "var(--mv3-muted)"
                  : "#fff",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 14,
              padding: 13,
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              marginTop: 14,
              cursor: !selectedNumber || assign.isPending ? "default" : "pointer",
            }}
          >
            {assign.isPending ? "Wiring the number…" : "Use this number"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              haptic.medium();
              onClose();
            }}
            style={{
              width: "100%",
              background: "var(--mv3-green)",
              color: "var(--mv3-bg)",
              border: "none",
              borderRadius: 14,
              padding: 13,
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              marginTop: 14,
              cursor: "pointer",
            }}
          >
            Your line is live — Cue picks up ✓
          </button>
        )}

        {/* "How it behaves" honesty line. */}
        <div
          style={{
            fontSize: 11,
            color: "var(--mv3-muted)",
            textAlign: "center",
            marginTop: 12,
            lineHeight: 1.5,
          }}
        >
          Cue answers as your receptionist, takes a message, and files the
          action items into your work. It never does anything irreversible
          without asking you first.
        </div>
      </div>
    </SheetShell>
  );
}
