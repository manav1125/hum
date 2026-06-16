import {
  Bot,
  Check,
  Copy,
  Link2,
  Network,
  Plus,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useState } from "react";

/**
 * Agent Network (A2A) — let Cue collaborate with other agents.
 *
 * Presentational surface for the agent-to-agent protocol: enable the A2A
 * endpoint, view your agent card, and pair with other agents via invite
 * tokens. The A2A protocol, agent-card endpoint, task store, and invite
 * create/redeem routes already exist on the daemon; this page is the
 * front-end that will be wired to them. State is local so the enable + pair
 * flow is demonstrable in the UI.
 */

interface ConnectedAgent {
  readonly id: string;
  readonly name: string;
  readonly endpoint: string;
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-sky-500" : "bg-muted-foreground/30"
      }`}
      aria-pressed={on}
    >
      <span
        className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function Field({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
          {value}
        </code>
        {copyable && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(value);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}

export function AgentsPage() {
  const [enabled, setEnabled] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [redeemToken, setRedeemToken] = useState("");
  const [agents, setAgents] = useState<ConnectedAgent[]>([]);

  const createInvite = () => {
    // Presentational placeholder token; the daemon's invite route mints real ones.
    setInvite("cue-a2a-invite-XXXX-XXXX-XXXX (preview)");
  };

  const redeem = () => {
    if (!redeemToken.trim()) return;
    setAgents((prev) => [
      ...prev,
      {
        id: `agent-${prev.length + 1}`,
        name: "Paired agent",
        endpoint: "https://…/a2a/message:send",
      },
    ]);
    setRedeemToken("");
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-2">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-500">
          <Network className="size-3.5" />
          Agent Network
        </span>
        <h1 className="text-2xl font-semibold text-foreground">
          Let Cue work with other agents
        </h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          Cue speaks the open agent-to-agent (A2A) protocol. Turn it on to let
          other people's agents send tasks to yours — and pair with agents you
          trust using one-time invites.
        </p>
      </header>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
        This is a preview of the pairing flow — the A2A protocol, agent card,
        and invite routes already exist on the daemon and will be wired up next.
      </div>

      {/* Enable */}
      <section className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Sparkles className="size-4" />
          </span>
          <div>
            <div className="text-sm font-semibold text-foreground">
              Enable A2A endpoint
            </div>
            <div className="text-xs text-muted-foreground">
              Exposes your agent at <code className="font-mono">/a2a/message:send</code>{" "}
              so paired agents can reach it.
            </div>
          </div>
        </div>
        <Toggle on={enabled} onClick={() => setEnabled((v) => !v)} />
      </section>

      {enabled && (
        <>
          {/* Your agent card */}
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">
                Your agent card
              </h2>
            </div>
            <Field label="Agent name" value="Cue (personal assistant)" />
            <Field
              label="Inbound endpoint"
              value="https://your-device/a2a/message:send"
              copyable
            />
            <div className="flex flex-wrap gap-1.5">
              {["General conversation", "Push notifications"].map((cap) => (
                <span
                  key={cap}
                  className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  <Check className="size-3" /> {cap}
                </span>
              ))}
            </div>
          </section>

          {/* Pair */}
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
              <div className="flex items-center gap-2">
                <Plus className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">
                  Invite an agent
                </h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Create a one-time token and share it with the agent you want to
                pair with.
              </p>
              {invite ? (
                <Field label="Invite token" value={invite} copyable />
              ) : (
                <button
                  type="button"
                  onClick={createInvite}
                  className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600"
                >
                  <Link2 className="size-4" /> Create invite
                </button>
              )}
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">
                  Redeem an invite
                </h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Paste a token you received to pair with another agent.
              </p>
              <input
                value={redeemToken}
                onChange={(e) => setRedeemToken(e.target.value)}
                placeholder="Paste invite token"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-sky-500"
              />
              <button
                type="button"
                onClick={redeem}
                className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/50"
              >
                Pair agent
              </button>
            </div>
          </section>

          {/* Connected agents */}
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Connected agents
            </h2>
            {agents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                No agents paired yet. Create or redeem an invite to connect one.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {agents.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Bot className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">
                          {a.name}
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {a.endpoint}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setAgents((prev) => prev.filter((x) => x.id !== a.id))
                      }
                      className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
