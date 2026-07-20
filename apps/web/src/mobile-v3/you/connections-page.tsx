/**
 * Mv3ConnectionsPage — the mobile Connections screen (spec frame 11: where
 * your digital world plugs in).
 *
 * Layout (frame-verbatim): `‹ You` → "Connections" + "N live · everything
 * flows into the orbit" → 2-col glass tiles with REAL app logos + green
 * live-dots → "+ Add a connection" row → the say-so footer.
 *
 * DATA (all real): the daemon Composio connector-apps catalog
 * (`connectorappsGet`) — the same read the desktop Tools & Apps page and the
 * command-center tile trust. Logos are the catalog's brand `logoUrl`s
 * (ConnectorAppLogo falls back to a monogram only if an image fails).
 * Per-app "what flowed today" lines are NOT rendered — no per-connector
 * activity/health source exists yet (the daemon only exposes a boolean
 * "an ACTIVE Composio account exists"), so connected tiles carry an honest
 * "Linked" status line — never "live"/"working" — plus a footnote that
 * status reflects setup, not verified health.
 *
 * Leaves (extrapolation grant — frame 11's row grammar):
 *  · connector detail sheet — status, category, reconnect (real OAuth);
 *    per-tool scopes remain a desktop surface and the sheet says so.
 *  · add-a-connection sheet — search + Enable over the real catalog with the
 *    same OAuth redirect + poll-until-connected the desktop page uses.
 *  · a quiet messaging-channels row deep-links the existing channel setup
 *    workbench (Telegram/WhatsApp/email verification lives there).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ConnectorAppLogo } from "@/components/connector-app-logo";
import {
  connectorappsConnectPostMutation,
  connectorappsGetOptions,
  connectorappsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConnectorappsGetResponses } from "@/generated/daemon/types.gen";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { SheetShell } from "../sheet-shell";
import { microLabel, primaryBtn, rise } from "../mv3-kit";
import { YouScreen } from "./you-kit";

type ConnectorApp = ConnectorappsGetResponses[200]["apps"][number];

/** Friendlier blurbs for the classic category ids (mirrors the desktop page). */
const CATEGORY_DESC: Record<string, string> = {
  email: "Email and threads",
  calendar: "Events and scheduling",
  files: "Files and documents",
  docs: "Pages and databases",
  messaging: "Channels and direct messages",
  dev: "Repositories and issues",
  database: "Tables and records",
  crm: "CRM contacts and deals",
  tasks: "Tasks and projects",
  social: "Posts and direct messages",
};

const CONNECT_POLL_MS = 3_000;
const CONNECT_POLL_WINDOW_MS = 120_000;

function LiveDot() {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "var(--mv3-green)",
        boxShadow: "0 0 8px rgba(111,214,154,.8)",
        flexShrink: 0,
      }}
    />
  );
}

function ConnectedTile({
  app,
  delay,
  onPress,
}: {
  app: ConnectorApp;
  delay: number;
  onPress: () => void;
}) {
  const press = () => {
    haptic.light();
    onPress();
  };
  return (
    <GlassCard
      radius={18}
      padding="13px 14px"
      blur={delay < 0.4}
      // HONESTY (UAT P1): the daemon only knows a login exists (Composio
      // ACTIVE account) — it has no health/last-success signal, so this tile
      // says "Linked", never "live". a11y: the tile is a real button.
      role="button"
      tabIndex={0}
      aria-label={`${app.name} — linked. Open connection details`}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          press();
        }
      }}
      style={{
        border: "1px solid rgba(111,214,154,.3)",
        cursor: "pointer",
        ...rise(delay),
      }}
      onClick={press}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <ConnectorAppLogo
          name={app.name}
          logoUrl={app.logoUrl}
          size={32}
          imgSize={18}
          chipStyle={{ background: "#fff", fontSize: 14 }}
        />
        <LiveDot />
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 9 }}>
        {app.name}
      </div>
      <div
        style={{ fontSize: 10.5, color: "var(--mv3-muted)", marginTop: 2 }}
      >
        Linked
      </div>
    </GlassCard>
  );
}

export function Mv3ConnectionsPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [detail, setDetail] = useState<ConnectorApp | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(0);

  const appsQuery = useQuery({
    ...connectorappsGetOptions({
      path: { assistant_id: assistantId },
      query: {},
    }),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: () => (Date.now() < pollUntil ? CONNECT_POLL_MS : false),
  });

  const connectMutation = useMutation({
    ...connectorappsConnectPostMutation(),
    onSettled: () => {
      setBusySlug(null);
      void queryClient.invalidateQueries({
        queryKey: connectorappsGetQueryKey({
          path: { assistant_id: assistantId },
          query: {},
        }),
      });
    },
  });

  const connect = (slug: string) => {
    haptic.medium();
    setBusySlug(slug);
    setNote(null);
    connectMutation.mutate(
      { path: { assistant_id: assistantId }, body: { slug } },
      {
        onSuccess: (data) => {
          const url = (data as { redirectUrl?: string }).redirectUrl;
          if (!url) {
            setNote("Couldn't start the connection — try again.");
            return;
          }
          window.open(url, "_blank", "noopener,noreferrer");
          setNote("A login tab opened — authorize, and this updates itself.");
          setPollUntil(Date.now() + CONNECT_POLL_WINDOW_MS);
        },
        onError: () => setNote("Couldn't start the connection — try again."),
      },
    );
  };

  const apps = useMemo(
    () => appsQuery.data?.apps ?? [],
    [appsQuery.data],
  );
  const connectable = appsQuery.data?.configured === true;
  const connected = apps.filter((a) => a.connected);
  const total = apps.length;

  const availableMatches = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    return apps
      .filter((a) => !a.connected)
      .filter(
        (a) =>
          q === "" ||
          a.name.toLowerCase().includes(q) ||
          a.slug.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q),
      )
      .slice(0, 40);
  }, [apps, addQuery]);

  return (
    <YouScreen
      tint="teal"
      testId="mv3-connections"
      back={routes.channels}
      title="Connections"
      sub={
        appsQuery.isLoading
          ? "Checking what's plugged in…"
          : `${connected.length} linked · everything flows into the orbit`
      }
    >
      {appsQuery.isError ? (
        <GlassCard padding="16px">
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>
            Couldn't load the app catalog
          </div>
          <div
            style={{ fontSize: 12.5, color: "var(--mv3-muted)", marginTop: 4 }}
          >
            The assistant may be unreachable.
          </div>
          <button
            type="button"
            onClick={() => void appsQuery.refetch()}
            style={{ ...primaryBtn, flex: "none", marginTop: 12, padding: "10px 18px" }}
          >
            Retry
          </button>
        </GlassCard>
      ) : (
        <>
          {connected.length > 0 ? (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 9,
                }}
              >
                {connected.map((app, i) => (
                  <ConnectedTile
                    key={app.slug}
                    app={app}
                    delay={0.1 + Math.min(i, 3) * 0.12}
                    onPress={() => setDetail(app)}
                  />
                ))}
              </div>
              {/* The honest line: linked ≠ verified healthy (no probe yet). */}
              <div
                style={{
                  fontSize: 11,
                  color: "var(--mv3-faint)",
                  textAlign: "center",
                  padding: "0 8px",
                  lineHeight: 1.5,
                }}
              >
                Status reflects setup, not live health — if an app
                misbehaves, open it and Reconnect.
              </div>
            </>
          ) : !appsQuery.isLoading ? (
            <GlassCard padding="18px 16px">
              <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
                Nothing plugged in yet — connect your first app and Cue starts
                pulling its weight.
              </div>
            </GlassCard>
          ) : null}

          {/* + Add a connection (frame 11's row). */}
          <GlassCard
            radius={18}
            padding="13px 15px"
            style={{ cursor: "pointer", ...rise(0.4) }}
            onClick={() => {
              haptic.light();
              setAddOpen(true);
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span
                aria-hidden
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  background: "var(--mv3-btn2-bg)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 15,
                  color: "var(--mv3-muted)",
                  flexShrink: 0,
                }}
              >
                +
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                  Add a connection
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--mv3-muted)",
                    marginTop: 1,
                  }}
                >
                  {total > 0 ? `${total}+ apps` : "Hundreds of apps"} · nothing
                  leaves without your say-so
                </div>
              </div>
              <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
                ›
              </span>
            </div>
          </GlassCard>

          {/* Messaging channels — the existing setup workbench (leaf-row grant). */}
          <GlassCard
            radius={18}
            padding="13px 15px"
            blur={false}
            style={{ cursor: "pointer", ...rise(0.5) }}
            onClick={() => {
              haptic.light();
              navigate(routes.contacts.root);
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span
                aria-hidden
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  background: "rgba(61,110,232,.16)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  color: "var(--mv3-micro)",
                  flexShrink: 0,
                }}
              >
                ✉
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                  Messaging channels
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--mv3-muted)",
                    marginTop: 1,
                  }}
                >
                  Telegram · WhatsApp · email — verify once, reach Cue anywhere
                </div>
              </div>
              <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
                ›
              </span>
            </div>
          </GlassCard>

          {note ? (
            <div
              role="status"
              style={{
                fontSize: 11.5,
                color: "var(--mv3-muted)",
                textAlign: "center",
                padding: "2px 8px",
              }}
            >
              {note}
            </div>
          ) : null}
        </>
      )}

      {/* Connector detail leaf (sheet). */}
      <SheetShell
        open={detail !== null}
        onClose={() => setDetail(null)}
        label={detail ? `${detail.name} connection` : "Connection"}
      >
        {detail ? (
          <div style={{ padding: "2px 2px 8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <ConnectorAppLogo
                name={detail.name}
                logoUrl={detail.logoUrl}
                size={44}
                imgSize={26}
                chipStyle={{ background: "#fff", fontSize: 18 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 700 }}>
                  {detail.name}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--mv3-muted)",
                    marginTop: 1,
                  }}
                >
                  {CATEGORY_DESC[detail.category] ?? detail.category}
                </div>
              </div>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11.5,
                  color: "var(--mv3-green)",
                }}
              >
                <LiveDot /> linked
              </span>
            </div>

            <div
              style={{
                marginTop: 14,
                background: "var(--mv3-btn2-bg)",
                border: "1px solid var(--mv3-btn2-border)",
                borderRadius: 12,
                padding: "11px 13px",
                fontSize: 12.5,
                color: "var(--mv3-muted)",
                lineHeight: 1.5,
              }}
            >
              Linked means the sign-in is set up — it doesn&rsquo;t verify
              recent calls are succeeding. If this app has stopped working,
              Reconnect re-runs the sign-in. Everything it shares flows into
              your instance only — nothing leaves without your say-so.
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                type="button"
                disabled={!connectable || busySlug === detail.slug}
                onClick={() => connect(detail.slug)}
                style={{
                  ...primaryBtn,
                  opacity:
                    !connectable || busySlug === detail.slug ? 0.6 : 1,
                }}
              >
                {busySlug === detail.slug ? "Opening…" : "Reconnect"}
              </button>
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--mv3-faint)",
                marginTop: 12,
                textAlign: "center",
                lineHeight: 1.5,
              }}
            >
              Per-tool scopes are managed from the desktop app for now.
            </div>
          </div>
        ) : null}
      </SheetShell>

      {/* Add-a-connection leaf (sheet over the real catalog). */}
      <SheetShell
        open={addOpen}
        onClose={() => setAddOpen(false)}
        label="Add a connection"
      >
        <div style={{ padding: "2px 2px 8px" }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Add a connection</div>
          <div
            style={{ ...microLabel, color: "var(--mv3-muted)", marginTop: 4 }}
          >
            {total} apps · OAuth only — Cue never sees your password
          </div>
          <input
            type="search"
            value={addQuery}
            onChange={(e) => setAddQuery(e.target.value)}
            placeholder="Search apps"
            aria-label="Search connectable apps"
            style={{
              width: "100%",
              fontSize: 16,
              fontFamily: "inherit",
              color: "var(--mv3-text)",
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 12,
              padding: "12px 14px",
              minHeight: 44,
              outline: "none",
              marginTop: 12,
            }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: 8,
            }}
          >
            {availableMatches.map((app, i) => (
              <div
                key={app.slug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: "10px 2px",
                  minHeight: 52,
                  borderBottom:
                    i === availableMatches.length - 1
                      ? "none"
                      : "1px solid var(--mv3-line)",
                }}
              >
                <ConnectorAppLogo
                  name={app.name}
                  logoUrl={app.logoUrl}
                  size={32}
                  imgSize={18}
                  chipStyle={{ background: "#fff", fontSize: 14 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                    {app.name}
                  </div>
                  <div
                    style={{ fontSize: 10.5, color: "var(--mv3-muted)" }}
                  >
                    {CATEGORY_DESC[app.category] ?? app.category}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busySlug === app.slug || !connectable}
                  onClick={() => connect(app.slug)}
                  title={
                    connectable
                      ? `Connect ${app.name}`
                      : "Easy connect isn't configured on this instance yet"
                  }
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    color: "#fff",
                    background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
                    border: "none",
                    borderRadius: 10,
                    padding: "10px 16px",
                    minHeight: 40,
                    cursor:
                      busySlug === app.slug || !connectable
                        ? "default"
                        : "pointer",
                    opacity: connectable ? 1 : 0.5,
                  }}
                >
                  {busySlug === app.slug ? "Opening…" : "Enable"}
                </button>
              </div>
            ))}
            {availableMatches.length === 0 ? (
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--mv3-muted)",
                  padding: "16px 2px",
                }}
              >
                No apps match that search.
              </div>
            ) : null}
          </div>
          {note ? (
            <div
              role="status"
              style={{
                fontSize: 11.5,
                color: "var(--mv3-muted)",
                marginTop: 8,
              }}
            >
              {note}
            </div>
          ) : null}
        </div>
      </SheetShell>
    </YouScreen>
  );
}
