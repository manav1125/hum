/**
 * Connect step, onboarding-v2 — the searchable Composio connect-tools grid.
 *
 * Two tabs:
 *   · Easy connect — a searchable grid of Composio-connectable apps. The
 *     toolkit list is fetched + cached server-side by the daemon
 *     (`GET /v1/connector-apps`, curated static fallback when Composio is
 *     unavailable). Connect opens the Composio OAuth URL in a new tab; the
 *     grid refetches on focus so a finished connect shows as CONNECTED.
 *   · Custom — the original channel source cards (email/Slack/WhatsApp/…)
 *     that deep-link into the same contacts/channels setup the Channels
 *     page uses, plus the honest "already found" proof band.
 *
 * Every card is skippable; the whole step is skippable — footer copy:
 * "Connect a few now, or skip and add them anytime."
 */

import { useState, type CSSProperties } from "react";
import { useNavigate } from "react-router";

import { C, mono } from "@/domains/activity/theme";
import { MicroLabel } from "@/pages/hq/hq-kit";
import { routes } from "@/utils/routes";

import {
  connectPillStyle,
  inputStyle,
  rowIconStyle,
  selectRowStyle,
  StepCard,
  StepFooter,
  StepHead,
} from "./setup-chrome";
import {
  useAlreadyFound,
  useConnectApp,
  useConnectorApps,
  useSourceCards,
  type ConnectorAppItem,
  type SourceCard,
} from "./use-setup-data";

export function ConnectToolsStep({
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
  const [tab, setTab] = useState<"easy" | "custom">("easy");
  const [query, setQuery] = useState("");

  const grid = useConnectorApps(assistantId, query);
  const { cards, connectedIds } = useSourceCards(assistantId);
  const found = useAlreadyFound(assistantId, connectedIds);

  const anyConnected = grid.connectedCount > 0 || connectedIds.length > 0;

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

      {/* Easy connect / Custom tabs */}
      <div
        role="tablist"
        style={{ display: "flex", gap: 6, marginBottom: 12 }}
        data-slot="hq-setup-connect-tabs"
      >
        {(
          [
            ["easy", "Easy connect"],
            ["custom", "Custom"],
          ] as const
        ).map(([key, label]) => {
          const on = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTab(key)}
              style={{
                ...tabStyle,
                background: on ? C.t1 : C.bg,
                color: on ? C.bg : C.t2,
                borderColor: on ? C.t1 : C.line2,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {tab === "easy" ? (
        <div data-slot="hq-setup-connect-grid">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps — Gmail, Notion, GitHub…"
            aria-label="Search connectable apps"
            style={{ ...inputStyle, fontSize: 13.5, marginBottom: 10 }}
          />
          {grid.isLoading ? (
            <div style={{ fontSize: 13, color: C.t3, padding: "8px 0" }}>
              Loading connectable apps…
            </div>
          ) : grid.apps.length === 0 ? (
            <div style={{ fontSize: 13, color: C.t3, padding: "8px 0" }}>
              No apps match “{query}”.
            </div>
          ) : (
            <div style={gridStyle}>
              {grid.apps.slice(0, 30).map((app) => (
                <AppCard
                  key={app.slug}
                  app={app}
                  assistantId={assistantId}
                  connectable={grid.connectable}
                />
              ))}
            </div>
          )}
          {!grid.isLoading && grid.apps.length > 30 ? (
            <div
              style={{
                fontFamily: mono,
                fontSize: 10.5,
                color: C.t3,
                marginTop: 8,
              }}
            >
              {grid.apps.length - 30} more — keep typing to narrow it down.
            </div>
          ) : null}
        </div>
      ) : (
        <CustomTab
          assistantId={assistantId}
          cards={cards}
          personal={personal}
          found={found}
        />
      )}

      <StepFooter
        continueLabel="Continue ›"
        onContinue={() => onContinue(anyConnected)}
        onSkip={onSkip}
        caption="Connect a few now, or skip and add them anytime."
      />
    </StepCard>
  );
}

// ---------------------------------------------------------------------------
// Easy-connect grid card
// ---------------------------------------------------------------------------

function AppCard({
  app,
  assistantId,
  connectable,
}: {
  app: ConnectorAppItem;
  assistantId: string;
  connectable: boolean;
}) {
  const connect = useConnectApp(assistantId);
  const [note, setNote] = useState<string | null>(null);

  const start = () => {
    setNote(null);
    connect.mutate(
      {
        path: { assistant_id: assistantId },
        body: { slug: app.slug },
      },
      {
        onSuccess: (data) => {
          const url = (data as { redirectUrl?: string }).redirectUrl;
          if (url) window.open(url, "_blank", "noopener");
          else setNote("Couldn't start — try again.");
        },
        onError: () => setNote("Couldn't start — add it later from Connectors."),
      },
    );
  };

  return (
    <div style={appCardStyle} data-slot="hq-setup-app-card">
      <span
        aria-hidden
        style={{ ...rowIconStyle, width: 32, height: 32, fontSize: 14 }}
      >
        {app.name.charAt(0).toUpperCase()}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 600,
            color: C.t1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {app.name}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 10.5,
            color: C.t3,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {note ?? app.category}
        </span>
      </span>
      {app.connected ? (
        <span
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            letterSpacing: "0.06em",
            color: C.green,
            flexShrink: 0,
          }}
        >
          ✓ CONNECTED
        </span>
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={!connectable || connect.isPending}
          style={{
            ...connectPillStyle,
            fontSize: 11.5,
            padding: "5px 10px",
            opacity: connectable ? 1 : 0.5,
            cursor: connectable ? "pointer" : "not-allowed",
          }}
          title={
            connectable
              ? `Connect ${app.name}`
              : "Easy connect isn't configured on this instance yet"
          }
        >
          {connect.isPending ? "…" : "Connect"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom tab — the original channel source cards + proof band
// ---------------------------------------------------------------------------

function CustomTab({
  assistantId: _assistantId,
  cards,
  personal,
  found,
}: {
  assistantId: string;
  cards: SourceCard[];
  personal: boolean;
  found: { count: number; titles: string[] };
}) {
  const navigate = useNavigate();
  const connect = (id: string) =>
    void navigate(`${routes.contacts.root}?channel=${encodeURIComponent(id)}`);

  return (
    <div data-slot="hq-setup-connect-custom">
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {cards.length === 0 ? (
          <div style={{ fontSize: 13, color: C.t3, padding: "8px 0" }}>
            No connectable sources available yet.
          </div>
        ) : (
          cards.map((card) => (
            <div key={card.id} style={selectRowStyle}>
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
                  style={{
                    display: "block",
                    fontSize: 12,
                    color: C.t2,
                    marginTop: 1,
                  }}
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
                <button
                  type="button"
                  onClick={() => connect(card.id)}
                  style={connectPillStyle}
                >
                  Connect ›
                </button>
              )}
            </div>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const tabStyle: CSSProperties = {
  border: `1px solid ${C.line2}`,
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  background: C.bg,
  transition: "background .12s, color .12s",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
  gap: 8,
  maxHeight: 320,
  overflowY: "auto",
  paddingRight: 2,
};

const appCardStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  border: `1px solid ${C.line}`,
  borderRadius: 12,
  padding: "9px 10px",
  background: C.surface,
  minWidth: 0,
};

const foundBandStyle: CSSProperties = {
  marginTop: 12,
  border: `1px solid var(--mv1-green)`,
  background: "color-mix(in srgb, var(--mv1-green) 8%, transparent)",
  borderRadius: 14,
  padding: "12px 14px",
};
