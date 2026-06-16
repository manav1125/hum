import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plug,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ConnectorStatus, ConnectorTool } from "@vellumai/ipc-contract";

import {
  connectConnector,
  connectorsAvailable,
  disconnectConnector,
  listConnectorTools,
  listConnectors,
  setConnectorTool,
  toolTogglesSupported,
} from "@/runtime/connectors";

const CATEGORY_LABEL: Record<string, string> = {
  email: "Email",
  calendar: "Calendar",
  files: "Files",
  docs: "Docs & Notes",
  messaging: "Messaging",
  dev: "Development",
  database: "Databases",
  crm: "CRM",
};

function ToolToggle({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-sky-500" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block size-4 transform rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </span>
  );
}

function ToolList({ slug }: { slug: string }) {
  const [tools, setTools] = useState<ConnectorTool[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    void (async () => setTools(await listConnectorTools(slug)))();
  }, [slug]);

  const toggle = async (tool: ConnectorTool) => {
    setPending(tool.slug);
    setTools(await setConnectorTool(slug, tool.slug, !tool.enabled));
    setPending(null);
  };

  if (tools === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading tools…
      </div>
    );
  }
  if (tools.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        No tools available.
      </div>
    );
  }
  const onCount = tools.filter((t) => t.enabled).length;
  return (
    <div className="flex flex-col">
      <div className="px-4 pb-1 pt-2 text-xs text-muted-foreground">
        {onCount} of {tools.length} tools enabled — toggles apply instantly.
      </div>
      <div className="grid grid-cols-1 gap-px sm:grid-cols-2">
        {tools.map((t) => (
          <button
            key={t.slug}
            type="button"
            disabled={pending === t.slug}
            onClick={() => void toggle(t)}
            className="flex items-center justify-between gap-2 px-4 py-2 text-left transition-colors hover:bg-muted/40 disabled:opacity-60"
          >
            <span className="truncate text-sm text-foreground">{t.name}</span>
            {pending === t.slug ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <ToolToggle on={t.enabled} />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectorRow({
  connector,
  busy,
  onConnect,
  onDisconnect,
}: {
  connector: ConnectorStatus;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = connector.connected && toolTogglesSupported();

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex items-center justify-between gap-3 p-4">
        <button
          type="button"
          disabled={!canExpand}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Plug className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {connector.name}
            </div>
            <div className="text-xs text-muted-foreground">
              {CATEGORY_LABEL[connector.category] ?? connector.category}
            </div>
          </div>
          {canExpand &&
            (expanded ? (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            ))}
        </button>
        {connector.connected ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-sky-500">
              <Check className="size-3.5" /> Connected
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={onDisconnect}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onConnect}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Connect
          </button>
        )}
      </div>
      {canExpand && expanded && (
        <div className="border-t border-border bg-muted/20 pb-2">
          <ToolList slug={connector.slug} />
        </div>
      )}
    </div>
  );
}

export function ConnectorsPage() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setConnectors(await listConnectors());
  }, []);

  useEffect(() => {
    void (async () => {
      const ok = await connectorsAvailable();
      setAvailable(ok);
      if (ok) await refresh();
    })();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const handleConnect = async (slug: string) => {
    setBusySlug(slug);
    setNote(null);
    const url = await connectConnector(slug);
    setBusySlug(null);
    if (!url) {
      setNote("Couldn't start the connection — try again.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    setNote(
      "A login tab opened — sign in and authorize, then this list updates automatically.",
    );
    // Poll for the connection to flip to Connected.
    if (pollRef.current) clearInterval(pollRef.current);
    let ticks = 0;
    pollRef.current = setInterval(() => {
      ticks += 1;
      void refresh();
      if (ticks > 40 && pollRef.current) clearInterval(pollRef.current);
    }, 3000);
  };

  const handleDisconnect = async (slug: string) => {
    setBusySlug(slug);
    setConnectors(await disconnectConnector(slug));
    setBusySlug(null);
  };

  if (available === null) return null;

  if (!available) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-5">
          <Plug className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Connectors are a macOS desktop feature and aren't set up on this
            install yet.
          </p>
        </div>
      </div>
    );
  }

  // Group by category.
  const groups = new Map<string, ConnectorStatus[]>();
  for (const c of connectors) {
    const arr = groups.get(c.category) ?? [];
    arr.push(c);
    groups.set(c.category, arr);
  }
  const connectedCount = connectors.filter((c) => c.connected).length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-2">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-500">
          <Plug className="size-3.5" />
          Connectors
        </span>
        <h1 className="text-2xl font-semibold text-foreground">
          Plug in your apps
        </h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          Connect your own accounts so Cue can pull and write data on your
          behalf. Each connection is yours alone — authorized to your account
          and never shared with other users.{" "}
          {connectedCount > 0 && (
            <span className="text-foreground">{connectedCount} connected.</span>
          )}
        </p>
      </header>

      {note && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {note}
        </div>
      )}

      {[...groups.entries()].map(([category, items]) => (
        <section key={category} className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {CATEGORY_LABEL[category] ?? category}
          </h2>
          <div className="flex flex-col gap-2">
            {items.map((c) => (
              <ConnectorRow
                key={c.slug}
                connector={c}
                busy={busySlug === c.slug}
                onConnect={() => void handleConnect(c.slug)}
                onDisconnect={() => void handleDisconnect(c.slug)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
