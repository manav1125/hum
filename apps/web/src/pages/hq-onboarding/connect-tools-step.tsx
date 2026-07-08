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
 *
 * The visual language matches the OnboardingConnect handoff mock: a progress
 * header, serif headline with an italic-blue accent, an inset segmented
 * "Easy connect / Custom" toggle, category filter chips, an icon search
 * field, and a POPULAR two-column app grid where connected cards carry a
 * green ✓ badge + subtle green tint and available cards carry a blue
 * "+ Connect" button. It is a re-skin only — every live-data binding
 * (apps query, connected state, connect mutation, search + tab state, the
 * Continue/Skip handlers) is preserved.
 */

import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router";

import { ConnectorAppLogo } from "@/components/connector-app-logo";
import { C, mono, serif } from "@/domains/activity/theme";
import { MicroLabel } from "@/pages/hq/hq-kit";
import { routes } from "@/utils/routes";

import {
  connectPillStyle,
  rowIconStyle,
  selectRowStyle,
  StepCard,
  StepFooter,
} from "./setup-chrome";
import {
  useAlreadyFound,
  useConnectApp,
  useConnectorApps,
  useSourceCards,
  type ConnectorAppItem,
  type SourceCard,
} from "./use-setup-data";

// ---------------------------------------------------------------------------
// Category chips — best-effort keyword filter over the live `category` field.
//
// The connector-apps data carries a free-text `category` per app (e.g.
// "Email", "Calendar", "Developer", "Documents", "Files", "Messaging"). The
// six chips map to substring matches against that real field — we do NOT
// fabricate a category taxonomy into the data model. "All" is the pass-through.
// ---------------------------------------------------------------------------

const CATEGORIES = [
  "All",
  "Email",
  "Calendar",
  "Dev",
  "Docs",
  "Messaging",
] as const;
type Category = (typeof CATEGORIES)[number];

/** Keyword substrings (lowercase) that a chip matches against `category`. */
const CATEGORY_KEYWORDS: Record<Exclude<Category, "All">, string[]> = {
  Email: ["email", "mail", "inbox"],
  Calendar: ["calendar", "schedul", "meeting", "event"],
  Dev: ["dev", "repo", "code", "issue", "engineering", "ci"],
  Docs: ["doc", "note", "file", "drive", "database", "sheet", "wiki", "storage"],
  Messaging: ["messag", "chat", "slack", "dm", "channel", "social"],
};

function appMatchesCategory(app: ConnectorAppItem, cat: Category): boolean {
  if (cat === "All") return true;
  const hay = `${app.category} ${app.name} ${app.slug}`.toLowerCase();
  return CATEGORY_KEYWORDS[cat].some((kw) => hay.includes(kw));
}

const GRID_LIMIT = 30;

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
  const [cat, setCat] = useState<Category>("All");

  const grid = useConnectorApps(assistantId, query);
  const { cards, connectedIds } = useSourceCards(assistantId);
  const found = useAlreadyFound(assistantId, connectedIds);

  const anyConnected = grid.connectedCount > 0 || connectedIds.length > 0;

  // Apply the category chip on top of the hook's search filter.
  const filtered = useMemo(
    () => grid.apps.filter((a) => appMatchesCategory(a, cat)),
    [grid.apps, cat],
  );
  const shown = filtered.slice(0, GRID_LIMIT);
  const remaining = Math.max(0, filtered.length - shown.length);

  return (
    <StepCard>
      {/* Progress header — mono microlabel + 6-step bar row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <MicroLabel color={C.t3}>
          {personal
            ? `Step ${stepNo} of ${total} · Personal`
            : `Step ${stepNo} of ${total} · Connect`}
        </MicroLabel>
        <div style={{ display: "flex", gap: 5 }} aria-hidden>
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              style={{
                width: 22,
                height: 4,
                borderRadius: 2,
                background: i < stepNo ? C.blue : C.line2,
              }}
            />
          ))}
        </div>
      </div>

      {/* Serif headline with italic-blue accent */}
      <h1
        style={{
          fontFamily: serif,
          fontSize: 30,
          lineHeight: 1.1,
          color: C.t1,
          fontWeight: 400,
          letterSpacing: "-0.4px",
          margin: "0 0 8px",
        }}
      >
        {personal ? (
          <>
            Connect <span style={accentStyle}>your world</span>
          </>
        ) : (
          <>
            Connect where your <span style={accentStyle}>work flows</span>
          </>
        )}
      </h1>
      <p
        style={{
          fontSize: 13.5,
          color: C.t2,
          lineHeight: 1.5,
          margin: "0 0 20px",
          maxWidth: 520,
        }}
      >
        {personal
          ? "Cue can only help with what it can see. Just yours — nothing shared, nothing posted. "
          : "Cue watches these so nothing slips through. Connect a few now, or skip and add them anytime — "}
        <span style={{ color: C.t1 }}>nothing leaves without your say-so.</span>
      </p>

      {/* Easy connect / Custom segmented toggle */}
      <div
        role="tablist"
        style={{
          display: "inline-flex",
          background: C.sunken,
          borderRadius: 11,
          padding: 3,
          gap: 2,
          marginBottom: 14,
        }}
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
                ...segStyle,
                background: on ? C.surface : "transparent",
                color: on ? C.t1 : C.t2,
                boxShadow: on ? "0 1px 3px rgba(26,34,48,.12)" : "none",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {tab === "easy" ? (
        <div data-slot="hq-setup-connect-grid">
          {/* Category filter chips */}
          <div
            role="tablist"
            aria-label="Filter by category"
            style={{
              display: "flex",
              gap: 7,
              flexWrap: "wrap",
              marginBottom: 14,
            }}
            data-slot="hq-setup-connect-cats"
          >
            {CATEGORIES.map((c) => {
              const on = cat === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setCat(c)}
                  style={{
                    ...chipStyle,
                    background: on ? C.t1 : C.surface,
                    color: on ? C.bg : C.t2,
                    borderColor: on ? C.t1 : C.line2,
                  }}
                >
                  {c}
                </button>
              );
            })}
          </div>

          {/* Search field with icon */}
          <div style={searchWrapStyle}>
            <SearchIcon />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 470+ apps"
              aria-label="Search connectable apps"
              style={searchInputStyle}
            />
          </div>

          {grid.isLoading ? (
            <div style={{ fontSize: 13, color: C.t3, padding: "12px 0" }}>
              Loading connectable apps…
            </div>
          ) : shown.length === 0 ? (
            <div style={{ fontSize: 13, color: C.t3, padding: "12px 0" }}>
              {query.trim()
                ? `No apps match “${query}”.`
                : "No apps in this category."}
            </div>
          ) : (
            <>
              <MicroLabel color={C.t3} style={{ margin: "14px 0 10px" }}>
                Popular
              </MicroLabel>
              <div style={gridStyle}>
                {shown.map((app) => (
                  <AppCard
                    key={app.slug}
                    app={app}
                    assistantId={assistantId}
                    connectable={grid.connectable}
                  />
                ))}
              </div>
              {remaining > 0 ? (
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: 12.5,
                    color: C.t3,
                    marginTop: 14,
                  }}
                >
                  {remaining}+ more apps —{" "}
                  <span style={{ color: C.t2 }}>
                    start typing to narrow it down.
                  </span>
                </div>
              ) : null}
            </>
          )}
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
    <div
      style={{
        ...appCardStyle,
        ...(app.connected
          ? {
              border: `1px solid ${connectedBorder}`,
              background: connectedTint,
            }
          : null),
      }}
      data-slot="hq-setup-app-card"
      data-connected={app.connected ? "true" : "false"}
    >
      <ConnectorAppLogo
        name={app.name}
        logoUrl={app.logoUrl}
        size={38}
        imgSize={22}
        chipStyle={{ ...rowIconStyle, width: 38, height: 38, fontSize: 15 }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 14,
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
            fontSize: 12,
            color: C.t2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {note ?? app.category}
        </span>
      </span>
      {app.connected ? (
        <span style={connectedBadgeStyle}>
          <CheckIcon /> CONNECTED
        </span>
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={!connectable || connect.isPending}
          style={{
            ...connectCtaStyle,
            opacity: connectable ? 1 : 0.5,
            cursor: connectable ? "pointer" : "not-allowed",
          }}
          title={
            connectable
              ? `Connect ${app.name}`
              : "Easy connect isn't configured on this instance yet"
          }
        >
          {connect.isPending ? "…" : "+ Connect"}
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
                <span style={connectedBadgeStyle}>
                  <CheckIcon /> CONNECTED
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
// Inline icons (self-contained SVG, theme-aware via currentColor / props)
// ---------------------------------------------------------------------------

function SearchIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={C.t3}
      strokeWidth={2}
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <circle cx={11} cy={11} r={7} />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 24 24"
      fill="none"
      stroke={C.green}
      strokeWidth={3.5}
      aria-hidden
    >
      <path d="m5 13 4 4 10-11" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const accentStyle: CSSProperties = {
  fontStyle: "italic",
  color: C.blue,
};

const segStyle: CSSProperties = {
  border: "none",
  borderRadius: 8,
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: "nowrap",
  cursor: "pointer",
  transition: "background .12s, color .12s, box-shadow .12s",
};

const chipStyle: CSSProperties = {
  border: `1px solid ${C.line2}`,
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 12.5,
  fontWeight: 500,
  cursor: "pointer",
  transition: "background .12s, color .12s, border-color .12s",
};

const searchWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  border: `1px solid ${C.line2}`,
  borderRadius: 12,
  padding: "11px 14px",
  background: C.bg,
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: "none",
  outline: "none",
  background: "transparent",
  fontSize: 14,
  color: C.t1,
  font: "inherit",
  padding: 0,
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
  maxHeight: 320,
  overflowY: "auto",
  paddingRight: 2,
};

const appCardStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  border: `1px solid ${C.line}`,
  borderRadius: 14,
  padding: "12px 14px",
  background: C.surface,
  minWidth: 0,
  transition: "border-color .16s, background .16s",
};

// Connected card — subtle green tint + green border (success green is used
// for connected state only, per the design tokens).
const connectedTint =
  "color-mix(in srgb, var(--mv1-green) 7%, var(--mv1-card))";
const connectedBorder =
  "color-mix(in srgb, var(--mv1-green) 32%, var(--mv1-line))";

const connectedBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontFamily: mono,
  fontSize: 10,
  letterSpacing: "0.04em",
  color: C.green,
  background: "color-mix(in srgb, var(--mv1-green) 16%, transparent)",
  padding: "5px 9px",
  borderRadius: 7,
  flexShrink: 0,
};

const connectCtaStyle: CSSProperties = {
  fontFamily: "inherit",
  fontSize: 12.5,
  fontWeight: 500,
  color: C.blueS,
  background: C.blueW,
  border: `1px solid color-mix(in srgb, var(--mv1-blue) 30%, transparent)`,
  borderRadius: 9,
  padding: "7px 13px",
  flexShrink: 0,
  transition: "background .16s",
};

const foundBandStyle: CSSProperties = {
  marginTop: 12,
  border: `1px solid var(--mv1-green)`,
  background: "color-mix(in srgb, var(--mv1-green) 8%, transparent)",
  borderRadius: 14,
  padding: "12px 14px",
};
