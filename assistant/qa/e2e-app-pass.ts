/**
 * End-to-end pass over the REAL, authenticated Cue app via CDP.
 *
 * WHY THIS EXISTS: curl against the API and component tests with mocked data
 * both pass while the actual app is broken. Automations had been 401ing on
 * every call since it shipped — the endpoints return 200 to curl; only the app
 * failed. This drives the signed-in desktop app instead, which is the only
 * thing that reproduces what a user hits.
 *
 * Run it before claiming a surface works:
 *   1. relaunch the app with CDP:
 *        open -a /Applications/Cue.app --args --remote-debugging-port=9222
 *   2. bun run assistant/qa/e2e-app-pass.ts            # desktop, all surfaces
 *      bun run assistant/qa/e2e-app-pass.ts --mobile   # 390px
 *      bun run assistant/qa/e2e-app-pass.ts Settings   # one surface
 *
 * The dead-end detector deliberately looks only at alert/error elements or
 * very short pages: matching error words anywhere in the body flagged the
 * Marketplace ("what went wrong" inside a skill description) and Memory
 * ("couldn't" inside a memory entry) as broken when both were healthy.
 *
 * Drives the running desktop app (already signed in to the user's instance)
 * rather than mocks or curl: navigates each surface, waits for real render,
 * and records what a user would actually hit — console errors, failed
 * network requests, dead-end error text, and horizontal overflow.
 *
 * Usage: bun run e2e.ts [--mobile] [surface ...]
 */

const CDP = "http://127.0.0.1:9222";

interface Surface {
  name: string;
  path: string;
  /** Text that proves the surface actually rendered its content. */
  expect?: string[];
}

const DESKTOP: Surface[] = [
  { name: 'hq', path: '/assistant/hq' },
  { name: 'Chat home', path: '/assistant/' },
  { name: 'Library', path: '/assistant/library' },
  { name: 'Projects', path: '/assistant/projects' },
  { name: 'All work', path: '/assistant/work' },
  { name: 'Came in', path: '/assistant/came-in' },
  { name: 'Review queue', path: '/assistant/review-queue' },
  { name: 'Brief', path: '/assistant/brief' },
  { name: 'Create', path: '/assistant/create' },
  { name: 'Cue Live', path: '/assistant/cue-live' },
  { name: 'Desktop control', path: '/assistant/desktop-control' },
  { name: 'Plugins', path: '/assistant/plugins' },
  { name: 'Marketplace', path: '/assistant/marketplace' },
  { name: 'Skills', path: '/assistant/skills' },
  { name: 'Memory', path: '/assistant/memory' },
  { name: 'Connectors', path: '/assistant/connectors' },
  { name: 'Channels', path: '/assistant/channels' },
  { name: 'Agents', path: '/assistant/agents' },
  { name: 'Automations', path: '/assistant/automations' },
  { name: 'Guardrails', path: '/assistant/guardrails' },
  { name: 'Trust', path: '/assistant/trust' },
  { name: 'Workspace', path: '/assistant/workspace' },
  { name: 'Identity', path: '/assistant/identity' },
  { name: 'Brand', path: '/assistant/brand' },
  { name: 'Contacts', path: '/assistant/contacts' },
  { name: 'People', path: '/assistant/people' },
  { name: 'Explore', path: '/assistant/explore' },
  { name: 'Activity', path: '/assistant/activity' },
  { name: 'Mission control', path: '/assistant/mission-control' },
  { name: 'Documents', path: '/assistant/documents' },
  { name: 'Conversations', path: '/assistant/conversations' },
  { name: 'Meeting', path: '/assistant/meeting' },
  { name: 'Voice', path: '/assistant/voice' },
  { name: 'Dashboard', path: '/assistant/dashboard' },
  { name: 'Impact', path: '/assistant/impact' },
  { name: 'Logs usage', path: '/assistant/logs/usage' },
  { name: 'Settings', path: '/assistant/settings' },
  { name: 'Settings schedules', path: '/assistant/settings/schedules' },
  { name: 'Settings integrations', path: '/assistant/settings/integrations' },
  { name: 'Settings privacy', path: '/assistant/settings/privacy' },
];

/** The slice of a CDP command reply this script reads. Only `Runtime.evaluate`
 *  returns a payload we inspect; the rest are enable/override calls whose
 *  result is discarded. */
interface CdpReply {
  result?: { value?: unknown };
}

/** One entry from `/json/list` — the debugger targets the app exposes. */
interface CdpTarget {
  type: string;
  webSocketDebuggerUrl: string;
}

/** A console argument as CDP serialises it: primitives carry `value`, objects
 *  and errors only ever carry `description`. */
interface CdpConsoleArg {
  value?: unknown;
  description?: string;
}

/** What the in-page probe returns, parsed. Mirrors the object literal the
 *  evaluated expression stringifies below — keep the two in step. */
interface Probe {
  url: string;
  nodes: number;
  chars: number;
  scrollW: number;
  clientW: number;
  widestRight: number;
  widestTag: string;
  deadEnds: string[];
  blank: boolean;
  head: string;
}

/** A probe plus the surface it came from and what the page complained about
 *  while it rendered. */
interface SurfaceResult extends Probe {
  surface: string;
  consoleErrors: string[];
  failedRequests: string[];
}

let msgId = 0;
function rpc(
  ws: WebSocket,
  method: string,
  params: unknown = {},
): Promise<CdpReply> {
  const id = ++msgId;
  return new Promise((resolve) => {
    const onMsg = (ev: MessageEvent) => {
      const m = JSON.parse(ev.data as string);
      if (m.id === id) {
        ws.removeEventListener("message", onMsg);
        resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const evaluate = (ws: WebSocket, expression: string): Promise<string> =>
  rpc(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }).then((r) => String(r?.result?.value ?? ""));

const targets = (await (await fetch(`${CDP}/json/list`)).json()) as CdpTarget[];
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target — is Cue running with --remote-debugging-port=9222?");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
await rpc(ws, "Runtime.enable");
await rpc(ws, "Log.enable");
await rpc(ws, "Network.enable");

// Collect everything the page complains about, per surface.
let consoleErrors: string[] = [];
let failedRequests: string[] = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data as string);
  if (m.method === "Log.entryAdded" && m.params?.entry?.level === "error") {
    consoleErrors.push(String(m.params.entry.text).slice(0, 180));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
    const txt = ((m.params.args ?? []) as CdpConsoleArg[])
      .map((a) => String(a.value ?? a.description ?? ""))
      .join(" ");
    if (txt.trim()) consoleErrors.push(txt.slice(0, 180));
  }
  if (m.method === "Network.responseReceived") {
    const { status, url } = m.params.response;
    if (status >= 400) failedRequests.push(`${status} ${String(url).slice(0, 110)}`);
  }
  if (m.method === "Network.loadingFailed" && !m.params.canceled) {
    failedRequests.push(`ERR ${m.params.errorText}`);
  }
});

const mobile = process.argv.includes("--mobile");
if (mobile) {
  await rpc(ws, "Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const surfaces = only.length
  ? DESKTOP.filter((s) => only.some((o) => s.name.toLowerCase().includes(o.toLowerCase())))
  : DESKTOP;

const results: SurfaceResult[] = [];
for (const s of surfaces) {
  consoleErrors = [];
  failedRequests = [];
  await evaluate(ws, `history.pushState({}, "", ${JSON.stringify(s.path)}); window.dispatchEvent(new PopStateEvent("popstate"));`);
  await new Promise((r) => setTimeout(r, 3500));

  const probe = await evaluate(
    ws,
    `(() => {
       const de = document.documentElement;
       const root = document.getElementById("root") || document.body;
       const text = (root.innerText || "").replace(/\\s+/g, " ").trim();
       // Anything wider than the viewport is a real overflow a user sees.
       let widest = 0, widestTag = "";
       for (const el of root.querySelectorAll("*")) {
         const r = el.getBoundingClientRect();
         if (r.width > 0 && r.right > widest) { widest = r.right; widestTag = el.tagName + "." + (el.className||"").toString().slice(0,30); }
       }
       return JSON.stringify({
         url: location.pathname,
         nodes: root.querySelectorAll("*").length,
         chars: text.length,
         scrollW: de.scrollWidth, clientW: de.clientWidth,
         widestRight: Math.round(widest), widestTag,
         // Dead ends and honesty failures a user would report.
         // Only count an error phrase when it is the SURFACE talking, not
         // content that happens to contain the words: a skill description
         // saying "what went wrong", or a memory entry saying "couldn't",
         // are not dead ends. Look in alert/error elements, or on a page so
         // short it can only be an error screen.
         deadEnds: (() => {
           const PHRASES = [
             "Failed to open", "Something went wrong", "Not found",
             "Unable to", "Error loading", "Failed to load", "Try again",
           ];
           const zones = [
             ...root.querySelectorAll('[role="alert"],[data-error],[class*="error"],[class*="Error"]'),
           ].map((el) => el.textContent || "");
           if (text.length < 400) zones.push(text);
           const joined = zones.join(" ");
           return PHRASES.filter((p) => joined.includes(p));
         })(),
         blank: text.length < 40,
         head: text.slice(0, 220),
       });
     })()`,
  );
  const p = JSON.parse(probe) as Probe;
  results.push({ surface: s.name, ...p, consoleErrors: [...new Set(consoleErrors)], failedRequests: [...new Set(failedRequests)] });
  const flag =
    p.blank ? "BLANK" :
    p.deadEnds.length ? "DEAD-END" :
    p.scrollW > p.clientW ? "OVERFLOW" :
    consoleErrors.length ? "console" :
    failedRequests.length ? "net" : "ok";
  console.log(
    `${flag.padEnd(9)} ${s.name.padEnd(34)} nodes=${String(p.nodes).padStart(5)} chars=${String(p.chars).padStart(5)} sw/cw=${p.scrollW}/${p.clientW}` +
    (p.deadEnds.length ? `  deadEnds=${JSON.stringify(p.deadEnds)}` : "") +
    (consoleErrors.length ? `  err=${consoleErrors.length}` : "") +
    (failedRequests.length ? `  net=${failedRequests.length}` : ""),
  );
}

console.log("\n===== DETAIL =====");
for (const r of results) {
  if (r.blank || r.deadEnds.length || r.scrollW > r.clientW || r.consoleErrors.length || r.failedRequests.length) {
    console.log(`\n## ${r.surface}  (${r.url})`);
    if (r.blank) console.log("   BLANK / near-empty render");
    if (r.deadEnds.length) console.log("   dead-end text:", r.deadEnds.join(", "));
    if (r.scrollW > r.clientW) console.log(`   overflow: scrollWidth ${r.scrollW} > clientWidth ${r.clientW}; widest right edge ${r.widestRight} (${r.widestTag})`);
    for (const e of r.consoleErrors.slice(0, 6)) console.log("   console:", e);
    for (const f of r.failedRequests.slice(0, 6)) console.log("   net:", f);
    console.log("   head:", r.head.slice(0, 160));
  }
}
ws.close();
