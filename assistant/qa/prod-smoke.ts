/**
 * Production smoke suite for the Cue cloud deployment.
 *
 * Tests the REAL user surface from the outside: the Render-hosted gateway,
 * daemon API, and SPA — at both phone and desktop viewports. This exists
 * because unit tests and local-daemon verification cannot catch the failure
 * class that actually bites users: cloud workspace config drift, credential
 * stores wiped by restarts, stale background jobs, and mobile-only layout
 * breakage.
 *
 * Run:            bun run qa/prod-smoke.ts            (from assistant/)
 * Skip browser:   CUE_QA_SKIP_BROWSER=1 bun run qa/prod-smoke.ts
 * Auth token:     ~/.cue/qa-actor-token (an actor JWT for the cloud gateway)
 *
 * Exit code = number of failed checks. Failures also file a "QA smoke"
 * work item into the Cue queue (deduped by title) so they surface on the
 * user's Home feed and push to their phone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.CUE_QA_BASE_URL ?? "https://cue-app-3yne.onrender.com";
const API = `${BASE}/v1/assistants/self`;
const TOKEN_PATH = path.join(os.homedir(), ".cue", "qa-actor-token");
const ARTIFACTS = path.join(import.meta.dir, "artifacts");

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

const results: CheckResult[] = [];
function record(name: string, status: CheckResult["status"], detail: string) {
  results.push({ name, status, detail });
  const icon = status === "pass" ? "✅" : status === "warn" ? "⚠️ " : "❌";
  console.log(`${icon} ${name} — ${detail}`);
}

function token(): string {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(
      `No actor token at ${TOKEN_PATH}. Save a cloud actor JWT there (mode 600).`,
    );
  }
  return readFileSync(TOKEN_PATH, "utf8").trim();
}

async function api(
  route: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  return fetch(`${API}/${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// ---------------------------------------------------------------------------
// API checks
// ---------------------------------------------------------------------------

async function checkSpaServed() {
  const res = await fetch(`${BASE}/assistant/`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 200) {
    return record("spa-served", "fail", `GET /assistant/ → ${res.status}`);
  }
  const html = await res.text();
  const bundle = html.match(/assets\/index-[^"]+\.js/)?.[0];
  if (!bundle) return record("spa-served", "fail", "no index bundle in HTML");
  const js = await (await fetch(`${BASE}/assistant/${bundle}`)).text();
  const hasPush = js.includes("PushNotifications");
  record(
    "spa-served",
    hasPush ? "pass" : "warn",
    `200, bundle ${bundle}${hasPush ? ", push registration present" : ", PUSH REGISTRATION MISSING"}`,
  );
}

async function checkAuthApi() {
  const res = await api("home/state");
  record(
    "auth-api",
    res.status === 200 ? "pass" : "fail",
    `GET home/state → ${res.status}`,
  );
}

const REQUIRED_TOOLS = [
  "task_list_add",
  "spreadsheet_create",
  "document_export_pdf",
  "deck_export_pdf",
  "pdf_create",
  "video_compose",
  "replicate_run",
];

async function checkToolsRegistry() {
  const res = await api("tools");
  if (res.status !== 200)
    return record("tools-registry", "fail", `GET tools → ${res.status}`);
  const body = await res.text();
  const missing = REQUIRED_TOOLS.filter((t) => !body.includes(t));
  record(
    "tools-registry",
    missing.length === 0 ? "pass" : "fail",
    missing.length === 0
      ? `all ${REQUIRED_TOOLS.length} flagship tools registered`
      : `missing: ${missing.join(", ")}`,
  );
}

async function checkConnectorApps() {
  const res = await api("connector-apps");
  if (res.status !== 200)
    return record(
      "connector-apps",
      "fail",
      `GET connector-apps → ${res.status}`,
    );
  const body = (await res.json()) as {
    configured: boolean;
    source: string;
    apps: Array<{ slug: string }>;
  };
  record(
    "connector-apps",
    body.apps.length > 0 ? "pass" : "fail",
    `${body.apps.length} apps (source=${body.source}, configured=${body.configured})`,
  );
}

async function checkHeartbeat() {
  const cfg = (await (await api("heartbeat/config")).json()) as {
    enabled: boolean;
    intervalMs: number;
    nextRunAt: number | null;
    lastRunAt: number | null;
  };
  if (!cfg.enabled)
    return record("heartbeat", "fail", "heartbeat.enabled is FALSE on prod");
  const runs = (await (await api("heartbeat/runs?limit=10")).json()) as {
    runs: Array<{ status: string; finishedAt: number | null }>;
  };
  const lastCompleted = runs.runs.find((r) => r.status === "completed");
  const dayMs = 24 * 60 * 60 * 1000;
  if (!lastCompleted) {
    return record(
      "heartbeat",
      "warn",
      `enabled (interval ${cfg.intervalMs / 60000}m) but no completed run in last 10 — verify after first scheduled tick`,
    );
  }
  const age = Date.now() - (lastCompleted.finishedAt ?? 0);
  record(
    "heartbeat",
    age < dayMs ? "pass" : "fail",
    `last completed run ${(age / 3_600_000).toFixed(1)}h ago`,
  );
}

/** Credentials that must survive Render restarts (entrypoint re-seeds them). */
const REQUIRED_CREDENTIALS = ["openrouter", "replicate"];

async function checkCredentials() {
  // credentials/list is a POST (it can reveal metadata, so it's not a safe GET).
  const res = await api("credentials/list", { method: "POST", body: "{}" });
  if (res.status !== 200)
    return record("credentials", "fail", `credentials/list → ${res.status}`);
  const body = await res.text();
  const missing = REQUIRED_CREDENTIALS.filter((s) => !body.includes(s));
  record(
    "credentials",
    missing.length === 0 ? "pass" : "fail",
    missing.length === 0
      ? "openrouter + replicate present in secure store"
      : `MISSING from store (restart wipe?): ${missing.join(", ")}`,
  );
}

async function checkPushDevices() {
  const res = await api("push-devices");
  // The GET list route ships after 2026-07-02; a 404 means prod predates it.
  if (res.status === 404)
    return record("push-devices", "warn", "GET route not deployed yet");
  if (res.status !== 200)
    return record("push-devices", "fail", `GET push-devices → ${res.status}`);
  const body = (await res.json()) as { devices?: unknown[] };
  const n = Array.isArray(body.devices) ? body.devices.length : 0;
  record(
    "push-devices",
    n > 0 ? "pass" : "warn",
    n > 0
      ? `${n} device(s) registered`
      : "no devices yet (install TestFlight build)",
  );
}

async function checkSse() {
  const started = Date.now();
  try {
    const res = await fetch(`${API}/events/`, {
      headers: { Authorization: `Bearer ${token()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200 || !res.body)
      return record("sse", "fail", `events/ → ${res.status}`);
    const reader = res.body.getReader();
    await reader.read();
    reader.cancel();
    record("sse", "pass", `first bytes in ${Date.now() - started}ms`);
  } catch (err) {
    record("sse", "fail", `no SSE bytes within 10s: ${String(err)}`);
  }
}

/**
 * End-to-end turn: send a trivial message to a dedicated QA conversation and
 * wait for the reply. Proves gateway → daemon → LLM key → agent loop → reply.
 */
async function checkLiveTurn() {
  const send = await api("messages", {
    method: "POST",
    body: JSON.stringify({
      conversationKey: "qa-prod-smoke",
      content:
        'This is an automated smoke test. Reply with exactly the word "OK" and do nothing else.',
      sourceChannel: "vellum",
      interface: "web",
    }),
  });
  if (send.status >= 300)
    return record("live-turn", "fail", `POST messages → ${send.status}`);
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await Bun.sleep(10_000);
    const res = await api("messages?conversationKey=qa-prod-smoke&limit=5");
    if (res.status !== 200) continue;
    const text = await res.text();
    if (/"role"\s*:\s*"assistant"/.test(text) && /OK/.test(text)) {
      return record("live-turn", "pass", "assistant replied");
    }
  }
  record("live-turn", "fail", "no assistant reply within 150s (hung turn?)");
}

/**
 * Triage health, from evidence: work items are created by tools/bridges (no
 * public create route), so instead verify that whatever sits in the queue has
 * been triaged — every queued item should carry a priorityTier stamped by the
 * flash-LLM triage pass. An untriaged backlog means the triage path is dead.
 */
async function checkWorkItemTriage() {
  const res = await api("work-items?status=pending");
  if (res.status !== 200)
    return record("workitem-triage", "fail", `GET work-items → ${res.status}`);
  const { items } = (await res.json()) as {
    items: Array<{ priorityTier?: number | null; title?: string }>;
  };
  if (items.length === 0)
    return record("workitem-triage", "pass", "queue empty — nothing to triage");
  const untriaged = items.filter((i) => i.priorityTier == null);
  record(
    "workitem-triage",
    untriaged.length === 0 ? "pass" : "fail",
    untriaged.length === 0
      ? `all ${items.length} queued item(s) triaged`
      : `${untriaged.length}/${items.length} queued item(s) missing priorityTier`,
  );
}

// ---------------------------------------------------------------------------
// Browser checks (phone + desktop viewports against the live SPA)
// ---------------------------------------------------------------------------

const VIEWPORTS = [
  { name: "iphone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];
const PAGES = ["/assistant/home", "/assistant/projects", "/assistant/work"];

async function checkBrowser() {
  if (process.env.CUE_QA_SKIP_BROWSER === "1") {
    return record("browser", "warn", "skipped (CUE_QA_SKIP_BROWSER=1)");
  }
  const { chromium } = await import("playwright");
  mkdirSync(ARTIFACTS, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const page = await ctx.newPage();
      // Authenticate the SPA the way the apps do: self-host actor token.
      await page.addInitScript(
        ([tok]) => {
          localStorage.setItem("cue:selfHost", "1");
          localStorage.setItem("cue:selfHost:actorToken", tok);
        },
        [token()],
      );
      for (const route of PAGES) {
        const errors: string[] = [];
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text().slice(0, 120));
        });
        const label = `${vp.name}:${route.split("/").pop()}`;
        try {
          // networkidle never settles (the SPA holds an SSE connection open);
          // use domcontentloaded + a fixed settle window, with one retry for
          // transient sandbox network flaps.
          try {
            await page.goto(`${BASE}${route}`, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
          } catch {
            await page.waitForTimeout(2_000);
            await page.goto(`${BASE}${route}`, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
          }
          await page.waitForTimeout(6_000);
          const overflow = await page.evaluate(
            () =>
              (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth,
          );
          await page.screenshot({
            path: path.join(
              ARTIFACTS,
              `${vp.name}-${route.split("/").pop()}.png`,
            ),
          });
          const hardErrors = errors.filter(
            (e) => !/favicon|feature-flags|_allauth/.test(e),
          );
          if (overflow > 4) {
            record(`ui:${label}`, "fail", `horizontal overflow ${overflow}px`);
          } else if (hardErrors.length > 0) {
            record(`ui:${label}`, "warn", `console errors: ${hardErrors[0]}`);
          } else {
            record(`ui:${label}`, "pass", "no overflow, no console errors");
          }
        } catch (err) {
          record(
            `ui:${label}`,
            "fail",
            `load failed: ${String(err).slice(0, 120)}`,
          );
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Failure filing: surface QA failures in Cue's own queue (pushes to phone)
// ---------------------------------------------------------------------------

async function fileFailures(failed: CheckResult[]) {
  if (failed.length === 0) return;
  try {
    // Dedupe: if a QA-smoke item is already sitting in the queue, don't spam.
    const existing = await (await api("work-items?status=pending")).text();
    if (existing.includes("QA smoke")) {
      console.log("↩︎ QA failure work item already queued — not duplicating");
      return;
    }
    // File through Cue's own capture loop: a message to the QA thread gets
    // action-item-bridged into a triaged work item and surfaces on Home.
    await api("messages", {
      method: "POST",
      body: JSON.stringify({
        conversationKey: "qa-prod-smoke",
        sourceChannel: "vellum",
        interface: "web",
        content:
          `Automated QA smoke run found ${failed.length} failing production check(s). ` +
          `Add a work item titled "QA smoke: investigate prod failures" capturing these, then reply briefly:\n` +
          failed.map((f) => `- ${f.name}: ${f.detail}`).join("\n"),
      }),
    });
    console.log(`📮 filed ${failed.length} failure(s) via the QA thread`);
  } catch (err) {
    console.log(`could not file failure report: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------

const checks: Array<[string, () => Promise<void>]> = [
  ["spa-served", checkSpaServed],
  ["auth-api", checkAuthApi],
  ["tools-registry", checkToolsRegistry],
  ["connector-apps", checkConnectorApps],
  ["heartbeat", checkHeartbeat],
  ["credentials", checkCredentials],
  ["push-devices", checkPushDevices],
  ["sse", checkSse],
  ["workitem-triage", checkWorkItemTriage],
  ["live-turn", checkLiveTurn],
  ["browser", checkBrowser],
];

console.log(`Cue prod smoke — ${BASE} — ${new Date().toISOString()}\n`);
for (const [name, fn] of checks) {
  try {
    await fn();
  } catch (err) {
    record(name, "fail", `threw: ${String(err).slice(0, 160)}`);
  }
}

const failed = results.filter((r) => r.status === "fail");
const warned = results.filter((r) => r.status === "warn");
console.log(
  `\n${results.length - failed.length - warned.length} pass · ${warned.length} warn · ${failed.length} fail`,
);
mkdirSync(ARTIFACTS, { recursive: true });
writeFileSync(
  path.join(ARTIFACTS, "last-report.json"),
  JSON.stringify(
    { at: new Date().toISOString(), base: BASE, results },
    null,
    2,
  ),
);
await fileFailures(failed);
process.exit(failed.length);
