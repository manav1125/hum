/**
 * TelegramSetupSheet — mobile-v3 on-device Telegram channel setup (spec
 * frame 39: token entry as a 3-step checklist — deep-link to BotFather, mono
 * paste field with the instance-only promise, live verification that flips
 * the CTA green).
 *
 * DATA (all real — the same endpoints the desktop contacts workbench uses):
 *  · save  = `POST /v1/assistants/{id}/integrations/telegram/config`
 *            ({ botToken }) — the daemon validates against Telegram getMe
 *            BEFORE storing, so a bad token is a 400 and never persists.
 *  · state = `GET  …/integrations/telegram/config` (already-configured case).
 *  · verify = polling `GET …/channels/readiness?channel=telegram` until the
 *            snapshot reports `ready` (plus one readiness refresh POST after
 *            the token lands so the probe re-runs immediately).
 *
 * Telegram-only by design: WhatsApp has no daemon config endpoint and email
 * is provisioned platform-side, so those re-skins would be token fields that
 * hit nothing — the sheet says so and offers the desktop workbench instead.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  channelsReadinessGetOptions,
  channelsReadinessGetQueryKey,
  integrationsTelegramConfigGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  channelsReadinessRefreshPost,
  integrationsTelegramConfigPost,
} from "@/generated/daemon/sdk.gen";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { GlassCard } from "@/mobile-v3/glass-card";
import { mv3Mono } from "@/mobile-v3/mv3-kit";
import { SheetShell } from "@/mobile-v3/sheet-shell";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";
import { haptic } from "@/utils/haptics";

type Stage = "token" | "verify" | "done";

interface TokenErrorInfo {
  /** Human sentence shown in the quiet-red line. */
  message: string;
  /** The raw upstream payload, kept behind a "Details" disclosure. */
  detail: string | null;
}

/**
 * The daemon relays Telegram's API response verbatim on a bad token, e.g.
 * `Telegram getMe failed: {"ok":false,"error_code":401,"description":
 * "Unauthorized"}` — raw JSON in sheet copy (mobile UAT P1-16). Pull out the
 * human part and park the payload behind a disclosure.
 */
function humanizeTelegramError(raw: string): TokenErrorInfo {
  const jsonMatch = /\{[\s\S]*\}/.exec(raw);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        error_code?: number;
        description?: string;
      };
      const message =
        parsed.error_code === 401
          ? "Telegram didn't recognize that token"
          : typeof parsed.description === "string" && parsed.description
            ? `Telegram said: ${parsed.description}`
            : "Telegram rejected that token";
      return { message, detail: raw };
    } catch {
      /* embedded braces but not JSON — fall through */
    }
  }
  // No embedded payload: short messages are already human; long ones get the
  // generic line with the original text as the detail.
  return raw.length > 140
    ? { message: "That token didn't validate", detail: raw }
    : { message: raw, detail: null };
}

const VERIFY_TIMEOUT_MS = 90_000;
const VERIFY_POLL_MS = 3_000;

/** The frame-39 Telegram plane tile (real logo mark, 44px, #29A9EB). */
function TelegramTile() {
  return (
    <span
      aria-hidden
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        background: "#29A9EB",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff">
        <path d="M21.5 4.5L2.9 11.7c-1 .4-1 1.4-.2 1.7l4.6 1.4 1.8 5.5c.3.8 1.1.9 1.6.3l2.5-2.4 4.8 3.5c.7.4 1.5.1 1.7-.8l3-14.9c.2-1-.5-1.6-1.2-1.5z" />
      </svg>
    </span>
  );
}

/** Step number badge — pending gray / active blue / done green (frame 39). */
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
      {n}
    </span>
  );
}

/** 14px verification spinner (frame 39 step 3) — frozen by reduced motion. */
function VerifySpinner() {
  return (
    <span
      aria-hidden
      style={{ position: "relative", width: 14, height: 14, flexShrink: 0 }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          border: "2px solid rgba(61,110,232,.3)",
          borderTopColor: "var(--mv3-accent)",
          animation: "mv3Spin 1s linear infinite",
        }}
      />
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

export function TelegramSetupSheet({
  open,
  onClose,
  onOpenWorkbench,
}: {
  open: boolean;
  onClose: () => void;
  /** "Other channels" escape hatch → the desktop contacts workbench. */
  onOpenWorkbench: () => void;
}) {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const [stage, setStage] = useState<Stage>("token");
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<TokenErrorInfo | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [verifyStartedAt, setVerifyStartedAt] = useState<number | null>(null);
  const [canPaste] = useState(
    () =>
      typeof navigator !== "undefined" &&
      typeof navigator.clipboard?.readText === "function",
  );

  // Already-configured detection — a saved token skips straight to verify.
  const configQuery = useQuery({
    ...integrationsTelegramConfigGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: open,
    staleTime: 10_000,
  });
  useEffect(() => {
    if (!open || stage !== "token" || token) return;
    const config = configQuery.data;
    if (config?.hasBotToken) {
      setBotUsername(config.botUsername ?? null);
      setStage("verify");
      setVerifyStartedAt(Date.now());
    }
  }, [open, stage, token, configQuery.data]);

  // Live verify: poll the channel's real readiness until it reports ready.
  const readinessQuery = useQuery({
    ...channelsReadinessGetOptions({
      path: { assistant_id: assistantId },
      query: { channel: "telegram" },
    }),
    enabled: open && stage === "verify",
    refetchInterval: VERIFY_POLL_MS,
  });
  const snapshot = (
    readinessQuery.data?.snapshots as
      | Array<{
          channel: string;
          ready: boolean;
          channelHandle?: string | null;
        }>
      | undefined
  )?.find((s) => s.channel === "telegram");

  const doneRef = useRef(false);
  useEffect(() => {
    if (stage === "verify" && snapshot?.ready && !doneRef.current) {
      doneRef.current = true;
      haptic.success();
      setStage("done");
    }
  }, [stage, snapshot?.ready]);

  // Timed out = the poll has been ticking past the window (measured off the
  // query's own dataUpdatedAt so render stays pure — it advances every poll).
  const verifyTimedOut =
    stage === "verify" &&
    verifyStartedAt !== null &&
    readinessQuery.dataUpdatedAt > 0 &&
    readinessQuery.dataUpdatedAt - verifyStartedAt > VERIFY_TIMEOUT_MS;

  const saveMutation = useMutation({
    mutationFn: async (botToken: string) => {
      const { data, error, response } = await integrationsTelegramConfigPost({
        path: { assistant_id: assistantId },
        body: { botToken },
        throwOnError: false,
      });
      assertHasResponse(response, error, "Couldn't reach your instance.");
      if (!response.ok || !data) {
        // Bad token = the config endpoint's 400 — surfaced inline, quiet red.
        throw new Error(
          extractErrorMessage(error, response, "That token didn't validate."),
        );
      }
      return data;
    },
    onSuccess: (data) => {
      haptic.medium();
      setBotUsername(data.botUsername ?? null);
      setStage("verify");
      setVerifyStartedAt(Date.now());
      // Nudge the readiness probe so "ready" lands without the cache TTL.
      void channelsReadinessRefreshPost({
        path: { assistant_id: assistantId },
        body: { channel: "telegram", includeRemote: true },
        throwOnError: false,
      }).finally(() => {
        void queryClient.invalidateQueries({
          queryKey: channelsReadinessGetQueryKey({
            path: { assistant_id: assistantId },
            query: { channel: "telegram" },
          }),
        });
      });
    },
    onError: (error) => {
      haptic.error();
      setTokenError(
        humanizeTelegramError(
          error instanceof Error
            ? error.message
            : "That token didn't validate.",
        ),
      );
    },
  });

  const pasteToken = async () => {
    haptic.light();
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setTokenError(null);
        setToken(text.trim());
      }
    } catch {
      /* permission denied — the field still accepts manual paste */
    }
  };

  const retryVerify = () => {
    haptic.light();
    setVerifyStartedAt(Date.now());
    void channelsReadinessRefreshPost({
      path: { assistant_id: assistantId },
      body: { channel: "telegram", includeRemote: true },
      throwOnError: false,
    }).finally(() => void readinessQuery.refetch());
  };

  const step2State: "pending" | "active" | "done" =
    stage === "token" ? "active" : "done";
  const step3State: "pending" | "active" | "done" =
    stage === "done" ? "done" : stage === "verify" ? "active" : "pending";

  const botHandle = botUsername
    ? `@${botUsername}`
    : (snapshot?.channelHandle ?? "your bot");

  if (!open) return null;

  return (
    <SheetShell open onClose={onClose} label="Set up Telegram">
      <div style={{ padding: "0 2px 4px" }}>
        {/* Header — frame 39's tile + title + promise line. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <TelegramTile />
          <div>
            <div
              style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.4px" }}
            >
              Telegram
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--mv3-muted)",
                marginTop: 1,
              }}
            >
              Talk to Cue from any chat app
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
          {/* Step 1 — BotFather deep link. */}
          <GlassCard radius={18} padding="13px 15px" blur={false}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              {/* Frame 39 renders step 1's badge green (it's an instruction
                  + deep link, not a tracked completion). */}
              <StepBadge n={1} state="done" />
              <span style={{ fontSize: 13, flex: 1 }}>
                Message <b style={{ color: "var(--mv3-micro)" }}>@BotFather</b>,
                create a bot
              </span>
              <a
                href="https://t.me/botfather"
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

          {/* Step 2 — the token. */}
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
                marginBottom: step2State === "active" ? 9 : 0,
              }}
            >
              <StepBadge n={2} state={step2State} />
              <span style={{ fontSize: 13, flex: 1 }}>
                {step2State === "done"
                  ? `Bot token saved${botUsername ? ` — ${botHandle}` : ""}`
                  : "Paste the bot token"}
              </span>
            </div>
            {step2State === "active" ? (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    // Gap frame 51's light rule: token wells are a #F2F3F7
                    // inset on the white card with a hairline border — never
                    // a dark well. Dark keeps the designed inset (tokens in
                    // mv3.css).
                    background: "var(--mv3-token-well)",
                    border: "1px solid var(--mv3-token-well-border)",
                    borderRadius: 11,
                    padding: "0 13px",
                  }}
                >
                  <input
                    type="text"
                    value={token}
                    onChange={(e) => {
                      setTokenError(null);
                      setToken(e.target.value);
                    }}
                    placeholder="7218:AAH-dK9…"
                    aria-label="Telegram bot token"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    style={{
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
                    }}
                  />
                  {canPaste ? (
                    <button
                      type="button"
                      onClick={() => void pasteToken()}
                      style={{
                        fontSize: 11,
                        color: "var(--mv3-micro)",
                        background: "none",
                        border: "none",
                        padding: "12px 0 12px 10px",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        flexShrink: 0,
                      }}
                    >
                      Paste
                    </button>
                  ) : null}
                </div>
                {tokenError ? (
                  <div
                    role="alert"
                    style={{
                      fontSize: 11.5,
                      color: "#E5675B",
                      marginTop: 7,
                      lineHeight: 1.4,
                    }}
                  >
                    {tokenError.message} — check it and try again.
                    {tokenError.detail ? (
                      <details style={{ marginTop: 4 }}>
                        <summary
                          style={{
                            fontSize: 10.5,
                            color: "var(--mv3-muted)",
                            cursor: "pointer",
                            listStyle: "none",
                          }}
                        >
                          Details
                        </summary>
                        <div
                          style={{
                            fontFamily: mv3Mono,
                            fontSize: 10,
                            color: "var(--mv3-muted)",
                            marginTop: 3,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {tokenError.detail}
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                <div
                  style={{
                    fontSize: 10.5,
                    color: "var(--mv3-muted)",
                    marginTop: 7,
                  }}
                >
                  Stored on your instance only — never our servers
                </div>
              </>
            ) : null}
          </GlassCard>

          {/* Step 3 — live verify. */}
          <GlassCard
            radius={18}
            padding="13px 15px"
            blur={false}
            style={stepCardStyle(step3State)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <StepBadge n={3} state={step3State} />
              <span style={{ fontSize: 13, flex: 1 }}>
                {step3State === "done"
                  ? `${botHandle} is live`
                  : `Send "hi" to ${botHandle} to verify`}
              </span>
              {step3State === "active" ? <VerifySpinner /> : null}
            </div>
            {verifyTimedOut && step3State === "active" ? (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-muted)",
                  marginTop: 8,
                  lineHeight: 1.4,
                }}
              >
                Still waiting — make sure you messaged the right bot.{" "}
                <button
                  type="button"
                  onClick={retryVerify}
                  style={{
                    fontSize: 11.5,
                    color: "var(--mv3-micro)",
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Check again
                </button>
              </div>
            ) : null}
          </GlassCard>
        </div>

        {/* CTA — disabled wait state flips green on the "hi" (frame 39). */}
        {stage === "token" ? (
          <button
            type="button"
            disabled={!token.trim() || saveMutation.isPending}
            onClick={() => {
              haptic.medium();
              setTokenError(null);
              saveMutation.mutate(token.trim());
            }}
            style={{
              width: "100%",
              background:
                !token.trim() || saveMutation.isPending
                  ? "var(--mv3-btn2-bg)"
                  : "var(--mv3-accent-fill-gradient)",
              color:
                !token.trim() || saveMutation.isPending
                  ? "var(--mv3-muted)"
                  : "#fff",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 14,
              padding: 13,
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              marginTop: 12,
              cursor:
                !token.trim() || saveMutation.isPending ? "default" : "pointer",
            }}
          >
            {saveMutation.isPending
              ? "Checking with Telegram…"
              : tokenError
                ? "Try again"
                : "Save token"}
          </button>
        ) : stage === "verify" ? (
          <button
            type="button"
            disabled
            style={{
              width: "100%",
              background: "var(--mv3-btn2-bg)",
              color: "var(--mv3-muted)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 14,
              padding: 13,
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              marginTop: 12,
            }}
          >
            Waiting for your &ldquo;hi&rdquo;…
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
              marginTop: 12,
              cursor: "pointer",
            }}
          >
            Connected — say hi anytime ✓
          </button>
        )}

        {/* Honest scope note: only Telegram has an on-device config endpoint. */}
        <div
          style={{
            fontSize: 11,
            color: "var(--mv3-muted)",
            textAlign: "center",
            marginTop: 12,
            lineHeight: 1.5,
          }}
        >
          WhatsApp and email setup aren&rsquo;t on-device yet —{" "}
          <button
            type="button"
            onClick={() => {
              haptic.light();
              onOpenWorkbench();
            }}
            style={{
              fontSize: 11,
              color: "var(--mv3-micro)",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            open the desktop workbench ›
          </button>
        </div>
      </div>
    </SheetShell>
  );
}
