/**
 * Agents — faithful translation of `surfaces/Agents.dc.html`, now wired to the
 * daemon.
 *
 * "Let Cue work with other agents": an ink hero with the agent-network
 * constellation, the Enable-A2A card, the paired-agents grid, and the
 * create-invite card. Live data comes from the A2A config endpoint
 * (`integrationsA2aConfigGet` — drives the real on/off toggle), the contacts
 * endpoint (A2A channels → the paired-agent cards + "Paired agents · N"), and
 * the outstanding-invites endpoint (`contactsInvitesGet` → the dashed "pending"
 * nodes in the hero constellation). Toggling the endpoint calls
 * `integrationsA2aConfigPost`/`integrationsA2aConfigDelete` and refetches the
 * config. The "create invite" / empty-state CTAs deep-link to
 * `/assistant/contacts?invite=a2a`, where the working A2A invite flow lives —
 * the contacts surface enables A2A if needed and opens the invite dialog
 * directly. This page does not reimplement the invite dialog.
 */

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { formatFriendlyDate } from "@/utils/format-date";
import {
  integrationsA2aConfigDelete,
  integrationsA2aConfigPost,
} from "@/generated/daemon/sdk.gen";
import {
  contactsGetOptions,
  contactsInvitesGetOptions,
  integrationsA2aConfigGetOptions,
  integrationsA2aConfigGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
  violetS: "#534AB7",
  violetW: "#EEEDFB",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

const KEYFRAMES = `
@keyframes cueDash{to{stroke-dashoffset:-14}}
@keyframes cuePulse{0%{transform:scale(1);opacity:.65}100%{transform:scale(1.45);opacity:0}}
@keyframes cueSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.cue-anim *{animation:none !important}}
`;

const LINES = [
  { x: 230, y: 52, stroke: C.blue, o: 0.7, dash: 1.1 },
  { x: 356, y: 96, stroke: C.violet, o: 0.6, dash: 1.3 },
  { x: 372, y: 196, stroke: C.t3, o: 0.35, dash: 0 },
  { x: 118, y: 92, stroke: C.violet, o: 0.5, dash: 1.5 },
  { x: 104, y: 206, stroke: C.t3, o: 0.3, dash: 0 },
] as const;

/**
 * A pairing/invite the hero constellation can render around the central Cue
 * node. Derived from real paired contacts + outstanding invites; falls back to
 * dashed "pending" placeholders so the artwork never collapses.
 */
type ConstellationNode = {
  x: number;
  y: number;
  initials: string;
  label: string;
  bg: string;
  fg: string;
  dashed?: boolean;
};

const NODE_SLOTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 230, y: 52 },
  { x: 356, y: 96 },
  { x: 118, y: 92 },
  { x: 372, y: 196 },
  { x: 104, y: 206 },
];

function AgentNode({ x, y, initials, label, bg, fg, dashed }: ConstellationNode) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%,-50%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
      }}
    >
      <span
        style={{
          width: dashed ? 36 : 40,
          height: dashed ? 36 : 40,
          borderRadius: 12,
          background: bg,
          color: fg,
          border: dashed ? "1.5px dashed rgba(255,255,255,.3)" : undefined,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: initials.length > 1 ? 13 : 15,
          fontWeight: initials.length > 1 ? 600 : 400,
        }}
      >
        {initials}
      </span>
      <span style={{ fontFamily: mono, fontSize: 8.5, color: dashed ? "#6B788C" : "#9DB4E6" }}>
        {label}
      </span>
    </div>
  );
}

function PairedCard({ agent }: { agent: PairedAgent }) {
  const badge = agent.active
    ? { label: "TRUSTED", bg: "#E2F0E7", color: C.green }
    : { label: "SCOPED", bg: C.blueW, color: C.blueS };
  const tone = agent.tone === "violet"
    ? { bg: C.violetW, fg: C.violetS }
    : { bg: C.blueW, fg: C.blueS };
  const messages =
    agent.interactionCount > 0
      ? `${agent.interactionCount} message${agent.interactionCount === 1 ? "" : "s"} exchanged`
      : "no messages yet";
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            background: tone.bg,
            color: tone.fg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: agent.initials.length > 1 ? 13 : 16,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {agent.initials}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{agent.name}</div>
          <div style={{ fontSize: 11.5, color: C.t2 }}>{agent.pairedLabel}</div>
        </div>
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            background: badge.bg,
            color: badge.color,
            padding: "3px 8px",
            borderRadius: 6,
          }}
        >
          {badge.label}
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.t2, marginTop: 10 }}>
        Paired over the agent-to-agent protocol · {messages}
      </div>
    </div>
  );
}

// --- Real-data shaping -----------------------------------------------------

type ContactChannel = {
  type: string;
  status: string;
  verifiedAt?: number | null;
  lastSeenAt?: number | null;
};
type Contact = {
  id: string;
  displayName: string;
  lastInteraction?: number | null;
  interactionCount: number;
  channels: ReadonlyArray<ContactChannel>;
};

/**
 * A paired agent = a contact that owns at least one A2A channel. Shaped to the
 * mock's card: an initials avatar (alternating blue/violet tone), the name, a
 * "paired <date>" subtitle from the channel's verification time, a trust badge
 * derived from channel status, and an exchanged-message count.
 */
type PairedAgent = {
  id: string;
  name: string;
  initials: string;
  active: boolean;
  interactionCount: number;
  pairedLabel: string;
  tone: "blue" | "violet";
};

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "◆";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function isContact(value: unknown): value is Contact {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.displayName === "string" &&
    Array.isArray(v.channels)
  );
}

/**
 * The invites endpoint types its rows as `unknown`, so narrow defensively and
 * read only the fields we render. Whatever string-ish label/status the daemon
 * provides, we surface it honestly.
 */
type Invite = {
  id: string;
  label: string;
  status: string;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toInvite(value: unknown, index: number): Invite | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const id =
    asString(v.id) ?? asString(v.inviteId) ?? asString(v.token) ?? `invite-${index}`;
  const label =
    asString(v.label) ??
    asString(v.displayName) ??
    asString(v.name) ??
    asString(v.contactName) ??
    asString(v.sourceChannel) ??
    "One-time invite";
  const status = asString(v.status) ?? "pending";
  return { id, label, status };
}

export function AgentsPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const configQuery = useQuery(
    integrationsA2aConfigGetOptions({ path: { assistant_id: assistantId } }),
  );
  const invitesQuery = useQuery(
    contactsInvitesGetOptions({ path: { assistant_id: assistantId } }),
  );
  const contactsQuery = useQuery(
    contactsGetOptions({ path: { assistant_id: assistantId } }),
  );

  const enabled = configQuery.data?.enabled ?? false;

  const configToggle = useMutation({
    mutationFn: async (nextEnabled: boolean) => {
      if (nextEnabled) {
        await integrationsA2aConfigPost({
          path: { assistant_id: assistantId },
          throwOnError: true,
        });
      } else {
        await integrationsA2aConfigDelete({
          path: { assistant_id: assistantId },
          throwOnError: true,
        });
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: integrationsA2aConfigGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      }),
  });

  const pairedAgents = useMemo<PairedAgent[]>(() => {
    const contacts = contactsQuery.data?.contacts ?? [];
    return contacts
      .filter(isContact)
      .flatMap((contact) => {
        const a2aChannels = contact.channels.filter((ch) => ch.type === "a2a");
        if (a2aChannels.length === 0) return [];
        const pairedAt = a2aChannels
          .map((ch) => ch.verifiedAt ?? ch.lastSeenAt ?? null)
          .filter((t): t is number => typeof t === "number")
          .sort((a, b) => a - b)[0];
        return [
          {
            id: contact.id,
            name: contact.displayName,
            initials: initialsFor(contact.displayName),
            active: a2aChannels.some((ch) => ch.status === "active"),
            interactionCount: contact.interactionCount,
            pairedLabel:
              typeof pairedAt === "number"
                ? `paired ${formatFriendlyDate(new Date(pairedAt))}`
                : "paired recently",
          },
        ];
      })
      // Alternate the avatar tone (blue / violet) per card, as the mock does.
      .map((agent, i): PairedAgent => ({
        ...agent,
        tone: i % 2 === 0 ? "blue" : "violet",
      }));
  }, [contactsQuery.data]);

  const invites = useMemo<Invite[]>(() => {
    const rows = invitesQuery.data?.invites ?? [];
    return rows
      .map((row, i) => toInvite(row, i))
      .filter((inv): inv is Invite => inv !== null);
  }, [invitesQuery.data]);

  // Deep-link straight into the A2A invite flow on the contacts surface. The
  // `invite=a2a` param tells contacts-page.tsx to enable A2A if needed and open
  // the GenerateInviteLinkDialog, so the invite is reachable even before any
  // agent is paired.
  const goToInvite = () => navigate("/assistant/contacts?invite=a2a");

  // Build the hero constellation from real pairings + invites, padding with
  // dashed "pending" placeholders so the artwork stays balanced.
  const constellationNodes = useMemo<ConstellationNode[]>(() => {
    const nodes: ConstellationNode[] = [];
    for (const agent of pairedAgents) {
      if (nodes.length >= NODE_SLOTS.length) break;
      const slot = NODE_SLOTS[nodes.length]!;
      nodes.push({
        ...slot,
        initials: initialsFor(agent.name),
        label: agent.name.split(/\s+/)[0] ?? "agent",
        bg: C.blueW,
        fg: C.blueS,
      });
    }
    for (let i = 0; i < invites.length; i += 1) {
      if (nodes.length >= NODE_SLOTS.length) break;
      const slot = NODE_SLOTS[nodes.length]!;
      nodes.push({
        ...slot,
        initials: "?",
        label: "pending",
        bg: "rgba(255,255,255,.06)",
        fg: "#7E8BA3",
        dashed: true,
      });
    }
    while (nodes.length < NODE_SLOTS.length) {
      const slot = NODE_SLOTS[nodes.length]!;
      nodes.push({
        ...slot,
        initials: "?",
        label: "unknown",
        bg: "rgba(255,255,255,.06)",
        fg: "#7E8BA3",
        dashed: true,
      });
    }
    return nodes;
  }, [pairedAgents, invites]);

  const isLoading =
    configQuery.isLoading || invitesQuery.isLoading || contactsQuery.isLoading;

  return (
    <div style={{ padding: "0 0 28px", fontFamily: "'DM Sans', system-ui, sans-serif", color: C.t1 }}>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      {/* HERO with network */}
      <div
        style={{
          position: "relative",
          background: C.ink,
          borderRadius: 18,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "1fr 460px",
          alignItems: "center",
          minHeight: 280,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(440px 280px at 80% 50%,rgba(127,119,221,.22),transparent 70%)",
          }}
        />
        <div style={{ padding: "34px 36px", position: "relative" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "rgba(61,110,232,.18)",
              color: "#9DB4E6",
              borderRadius: 999,
              padding: "5px 12px",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            ⧉ Agent Network
          </span>
          <div
            style={{
              fontSize: 32,
              fontWeight: 600,
              letterSpacing: "-1px",
              color: "#fff",
              marginTop: 14,
              lineHeight: 1.08,
            }}
          >
            Let Cue work
            <br />
            with other agents.
          </div>
          <p style={{ fontSize: 14.5, color: "#AEB7C7", marginTop: 12, maxWidth: 400 }}>
            Cue speaks the open agent-to-agent (A2A) protocol. Let trusted agents
            send tasks to yours — and pair with them using scoped, one-time
            invites.
          </p>
        </div>
        <div className="cue-anim" style={{ position: "relative", height: 280 }}>
          <svg
            width="460"
            height="280"
            viewBox="0 0 460 280"
            style={{ position: "absolute", inset: 0 }}
          >
            {LINES.map((l, i) => (
              <line
                key={i}
                x1="230"
                y1="140"
                x2={l.x}
                y2={l.y}
                stroke={l.stroke}
                strokeWidth="1.5"
                strokeDasharray="3 4"
                opacity={l.o}
                style={l.dash ? { animation: `cueDash ${l.dash}s linear infinite` } : undefined}
              />
            ))}
          </svg>
          <div
            style={{
              position: "absolute",
              left: 230,
              top: 140,
              transform: "translate(-50%,-50%)",
              width: 64,
              height: 64,
              borderRadius: 18,
              background: "#0F1620",
              border: "1px solid rgba(255,255,255,.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2,
            }}
          >
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 18,
                border: "2px solid rgba(61,110,232,.6)",
                animation: "cuePulse 2.4s ease-out infinite",
              }}
            />
            <span style={{ fontSize: 36, fontWeight: 600, color: "#EEF2F7", position: "relative", lineHeight: 1 }}>
              C
              <span
                style={{
                  position: "absolute",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: C.blue,
                  right: 9,
                  bottom: 13,
                }}
              />
            </span>
          </div>
          {constellationNodes.map((node) => (
            <AgentNode key={`${node.x}-${node.y}`} {...node} />
          ))}
        </div>
      </div>

      {/* Enable A2A */}
      <div
        style={{
          border: `1.5px solid ${C.ink}`,
          borderRadius: 14,
          padding: "18px 20px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginTop: 18,
        }}
      >
        <span style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: C.violet, flexShrink: 0 }}>
          ✦
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Enable A2A endpoint</div>
          <div style={{ fontSize: 13, color: C.t2, marginTop: 2 }}>
            Exposes your agent at{" "}
            <span style={{ fontFamily: mono, fontSize: 12, background: "#F4F6F9", padding: "1px 6px", borderRadius: 5 }}>
              /a2a/message:send
            </span>{" "}
            so paired agents can reach it.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Enable A2A endpoint"
          disabled={configQuery.isLoading || configToggle.isPending}
          onClick={() => configToggle.mutate(!enabled)}
          style={{
            width: 46,
            height: 26,
            borderRadius: 999,
            background: enabled ? C.blue : C.line2,
            border: "none",
            padding: 0,
            position: "relative",
            flexShrink: 0,
            cursor: configQuery.isLoading || configToggle.isPending ? "default" : "pointer",
            opacity: configQuery.isLoading || configToggle.isPending ? 0.6 : 1,
            transition: "background .15s ease",
          }}
        >
          <span
            style={{
              position: "absolute",
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "#fff",
              top: 2,
              left: enabled ? 22 : 2,
              boxShadow: "0 1px 3px rgba(0,0,0,.2)",
              transition: "left .15s ease",
            }}
          />
        </button>
      </div>

      {/* Paired agents */}
      <div
        style={{
          fontFamily: mono,
          fontSize: 10.5,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: C.t3,
          margin: "26px 0 12px",
        }}
      >
        Paired agents · {pairedAgents.length}
      </div>

      {isLoading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: "40px 0",
            color: C.t3,
            fontSize: 13,
          }}
        >
          <Loader2 size={18} style={{ animation: "cueSpin .9s linear infinite" }} />
          Loading agent network…
        </div>
      ) : pairedAgents.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {pairedAgents.map((agent) => (
            <PairedCard key={agent.id} agent={agent} />
          ))}
        </div>
      ) : (
        <div
          style={{
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            padding: "28px 20px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>No paired agents yet</div>
          <div style={{ fontSize: 12.5, color: C.t2, marginTop: 4, maxWidth: 340, marginInline: "auto" }}>
            Send a scoped, one-time invite to pair Cue with an agent you trust.
          </div>
          <button
            type="button"
            onClick={goToInvite}
            style={{
              marginTop: 14,
              fontSize: 12.5,
              background: C.blue,
              color: "#fff",
              border: "none",
              borderRadius: 9,
              padding: "9px 16px",
              cursor: "pointer",
            }}
          >
            Send an invite
          </button>
        </div>
      )}

      {/* Create invite */}
      <div
        style={{
          border: `1px dashed ${C.line2}`,
          borderRadius: 14,
          padding: 16,
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginTop: 12,
        }}
      >
        <span style={{ width: 40, height: 40, borderRadius: 11, background: "#F4F6F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: C.t2, flexShrink: 0 }}>
          +
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Create a one-time invite</div>
          <div style={{ fontSize: 12, color: C.t2 }}>
            Generate a scoped pairing link for an agent you trust
          </div>
        </div>
        <button
          type="button"
          onClick={goToInvite}
          style={{ fontSize: 12.5, background: C.blue, color: "#fff", border: "none", borderRadius: 9, padding: "9px 16px", cursor: "pointer" }}
        >
          New invite
        </button>
      </div>
    </div>
  );
}
