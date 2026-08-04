/**
 * Targeted UAT probe for the Fly deployment:
 *  1. Authed load → capture every failed (4xx/5xx) network request URL to
 *     identify the console 404 seen in the smoke suite.
 *  2. Cold load (no token) → what does a fresh visitor actually see? Capture
 *     the rendered heading/text + a screenshot so we know the entry experience.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

const BASE = "https://manav.justcue.app";
const tok = readFileSync(
  path.join(os.homedir(), ".cue", "qa-actor-token"),
  "utf8",
).trim();

const browser = await chromium.launch();

async function run(label: string, withToken: boolean, route: string) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  const failed: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) =>
    failed.push(`ERR ${r.failure()?.errorText} ${r.url()}`),
  );
  if (withToken) {
    await page.addInitScript((t) => {
      localStorage.setItem("cue:selfHost", "1");
      localStorage.setItem("cue:selfHost:actorToken", t as string);
    }, tok);
  }
  await page.goto(`${BASE}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(6000);
  const title = await page.title();
  const bodyText = (await page.evaluate(() => document.body.innerText))
    .slice(0, 300)
    .replace(/\n+/g, " | ");
  const shot = `/tmp/probe-${label}.png`;
  await page.screenshot({ path: shot });
  console.log(`\n=== ${label} (token=${withToken}) ${route} ===`);
  console.log(`title: ${title}`);
  console.log(`body: ${bodyText}`);
  console.log(`failed requests (${failed.length}):`);
  for (const f of [...new Set(failed)].slice(0, 15)) console.log(`  ${f}`);
  console.log(`screenshot: ${shot}`);
  await ctx.close();
}

await run("authed-home", true, "/assistant/");
await run("cold-visitor", false, "/assistant/");
await browser.close();
