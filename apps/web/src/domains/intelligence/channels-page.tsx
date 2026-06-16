import {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Hash,
  Mail,
  MessageCircle,
  MessagesSquare,
  Phone,
  Send,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

/**
 * Channels — reach Cue from anywhere and let Cue reach you.
 *
 * Presentational surface for binding external messaging channels (Telegram,
 * Slack, WhatsApp, Email, SMS) used both for inbound chat and for outbound
 * notifications (e.g. the daily action board's morning push). The daemon-side
 * adapters and channel-verification routes already exist; this page is the
 * front-end that will be wired to them. State here is local so the connect /
 * verify flow is demonstrable end-to-end in the UI.
 */

type ChannelState = "disconnected" | "verifying" | "connected";

interface ChannelDef {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly icon: LucideIcon;
  /** Inbound = you can chat with Cue here; Outbound = Cue can notify you here. */
  readonly inbound: boolean;
  readonly outbound: boolean;
  /** Short, channel-specific setup steps shown when expanded. */
  readonly steps: readonly string[];
  /** Label for the credential the user pastes (null = OAuth, no paste field). */
  readonly credentialLabel: string | null;
  readonly credentialHint?: string;
}

const CHANNELS: readonly ChannelDef[] = [
  {
    id: "telegram",
    name: "Telegram",
    blurb: "Chat with Cue and get pushes in a private Telegram thread.",
    icon: Send,
    inbound: true,
    outbound: true,
    credentialLabel: "Bot token",
    credentialHint: "Create a bot with @BotFather and paste its token.",
    steps: [
      "Message @BotFather on Telegram and create a new bot.",
      "Paste the bot token below and start verification.",
      "Send the verification code to your bot to confirm it's you.",
    ],
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "DM Cue in Slack and route notifications to your DMs.",
    icon: Hash,
    inbound: true,
    outbound: true,
    credentialLabel: null,
    steps: [
      "Authorize the Cue Slack app for your workspace.",
      "Pick the DM channel Cue should use.",
      "Confirm the guardian identity to finish binding.",
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    blurb: "Send and receive messages through the WhatsApp Cloud API.",
    icon: MessageCircle,
    inbound: true,
    outbound: true,
    credentialLabel: "Access token",
    credentialHint: "From your Meta WhatsApp Cloud API app.",
    steps: [
      "Create a Meta WhatsApp Cloud API app and phone number.",
      "Paste the phone number ID and access token below.",
      "Point the inbound webhook at this device to receive messages.",
    ],
  },
  {
    id: "email",
    name: "Email",
    blurb: "Give Cue an inbound address and a provider to send from.",
    icon: Mail,
    inbound: true,
    outbound: true,
    credentialLabel: "Provider API key",
    credentialHint: "Mailgun or Resend API key for outbound mail.",
    steps: [
      "Choose an email provider (Mailgun or Resend).",
      "Paste the provider API key and sending domain.",
      "Add the inbound webhook in your provider to route replies to Cue.",
    ],
  },
  {
    id: "sms",
    name: "SMS / Voice",
    blurb: "Text or call Cue through a Twilio number.",
    icon: Phone,
    inbound: true,
    outbound: true,
    credentialLabel: "Twilio auth token",
    credentialHint: "Account SID + auth token from the Twilio console.",
    steps: [
      "Buy or connect a Twilio phone number.",
      "Paste your Account SID and auth token below.",
      "Set the messaging webhook to this device.",
    ],
  },
];

function Badge({
  tone,
  children,
}: {
  tone: "on" | "off" | "pending";
  children: React.ReactNode;
}) {
  const cls =
    tone === "on"
      ? "bg-emerald-500/10 text-emerald-500"
      : tone === "pending"
        ? "bg-amber-500/10 text-amber-500"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

function CapabilityTag({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <Icon className="size-3" />
      {label}
    </span>
  );
}

function ChannelCard({ def }: { def: ChannelDef }) {
  const [state, setState] = useState<ChannelState>("disconnected");
  const [expanded, setExpanded] = useState(false);
  const [credential, setCredential] = useState("");
  const Icon = def.icon;

  const startVerify = () => {
    setState("verifying");
    // Presentational: simulate the verification handshake completing.
    window.setTimeout(() => setState("connected"), 1400);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex items-center justify-between gap-3 p-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">
                {def.name}
              </span>
              {state === "connected" && (
                <Badge tone="on">
                  <Check className="size-3" /> Connected
                </Badge>
              )}
              {state === "verifying" && <Badge tone="pending">Verifying…</Badge>}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {def.blurb}
            </div>
          </div>
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
        </button>
        {state === "connected" ? (
          <button
            type="button"
            onClick={() => setState("disconnected")}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="shrink-0 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600"
          >
            Set up
          </button>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-border bg-muted/20 p-4">
          <div className="flex flex-wrap gap-1.5">
            {def.inbound && <CapabilityTag icon={MessagesSquare} label="Chat with Cue" />}
            {def.outbound && <CapabilityTag icon={Bell} label="Receive notifications" />}
          </div>

          <ol className="flex flex-col gap-1.5">
            {def.steps.map((step, i) => (
              <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
                  {i + 1}
                </span>
                <span className="leading-5">{step}</span>
              </li>
            ))}
          </ol>

          {def.credentialLabel && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-foreground">
                {def.credentialLabel}
              </span>
              <input
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={`Paste your ${def.credentialLabel.toLowerCase()}`}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-sky-500"
              />
              {def.credentialHint && (
                <span className="text-xs text-muted-foreground">
                  {def.credentialHint}
                </span>
              )}
            </label>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={state === "verifying" || state === "connected"}
              onClick={startVerify}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
            >
              <ShieldCheck className="size-4" />
              {def.credentialLabel ? "Save & verify" : "Authorize"}
            </button>
            {state === "connected" && (
              <span className="text-xs text-emerald-500">
                This channel is active.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChannelsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-2">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-500">
          <MessagesSquare className="size-3.5" />
          Channels
        </span>
        <h1 className="text-2xl font-semibold text-foreground">
          Reach Cue anywhere
        </h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          Connect a messaging channel so you can chat with Cue outside the app —
          and so Cue can reach you with notifications like your morning action
          board. Each channel is verified to you and private.
        </p>
      </header>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
        Setup here is a preview of the flow — channel binding will activate once
        connected to the backend. The delivery adapters and verification already
        exist on the daemon.
      </div>

      <div className="flex flex-col gap-2">
        {CHANNELS.map((c) => (
          <ChannelCard key={c.id} def={c} />
        ))}
      </div>
    </div>
  );
}
