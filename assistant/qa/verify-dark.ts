/**
 * Dark-mode verification (temporary QA script).
 * Screenshots key routes with device:theme=dark and measures content-canvas
 * luminance + People-page column count.
 */
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

const BASE = "https://cue-app-3yne.onrender.com";
const TOKEN = readFileSync(
  path.join(os.homedir(), ".cue", "qa-actor-token"),
  "utf8",
).trim();
const OUT = path.join(import.meta.dir, "artifacts", "verify-final");
mkdirSync(OUT, { recursive: true });

interface Shot {
  route: string;
  width: number;
  height: number;
  name: string;
}
const SHOTS: Shot[] = [
  { route: "/assistant/home", width: 1440, height: 900, name: "desktop-home-dark" },
  { route: "/assistant/projects", width: 1440, height: 900, name: "desktop-projects-dark" },
  { route: "/assistant/work", width: 1440, height: 900, name: "desktop-work-dark" },
  { route: "/assistant/people", width: 390, height: 844, name: "iphone-people-dark" },
];

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const browser = await chromium.launch();
for (const shot of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  await page.addInitScript(
    ([tok]) => {
      localStorage.setItem("cue:selfHost", "1");
      localStorage.setItem("cue:selfHost:actorToken", tok);
      localStorage.setItem("device:theme", "dark");
    },
    [TOKEN],
  );
  try {
    await page.goto(`${BASE}${shot.route}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  } catch {
    await page.waitForTimeout(2_000);
    await page.goto(`${BASE}${shot.route}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  }
  await page.waitForTimeout(8_000);
  const file = path.join(OUT, `${shot.name}.png`);
  await page.screenshot({ path: file });

  // Sample the CENTER of the page (content canvas, away from sidebar chrome)
  // by reading computed background colors up the stack from the midpoint.
  const probe = await page.evaluate(() => {
    const x = Math.floor(window.innerWidth * 0.6);
    const y = Math.floor(window.innerHeight * 0.5);
    let el = document.elementFromPoint(x, y);
    const stack: string[] = [];
    let bg: string | null = null;
    while (el) {
      const c = getComputedStyle(el).backgroundColor;
      stack.push(`${el.tagName}.${(el as HTMLElement).className?.toString?.().slice(0, 40) ?? ""}=${c}`);
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent" && !bg) bg = c;
      el = el.parentElement;
    }
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    return { bg, bodyBg, htmlBg, stack: stack.slice(0, 6) };
  });

  // People single-column check (phone viewport): count distinct card x-offsets.
  let peopleCols: number | null = null;
  if (shot.route.includes("people")) {
    peopleCols = await page.evaluate(() => {
      // find repeated card-like siblings and count distinct left offsets
      const candidates = Array.from(
        document.querySelectorAll("main [class], [role=main] [class]"),
      );
      const groups = new Map<Element, Element[]>();
      for (const el of candidates) {
        const p = el.parentElement;
        if (!p) continue;
        if (!groups.has(p)) groups.set(p, []);
      }
      let best: Element[] = [];
      for (const [p] of groups) {
        const kids = Array.from(p.children).filter(
          (k) => k.getBoundingClientRect().height > 40,
        );
        if (kids.length >= 3 && kids.length > best.length) best = kids;
      }
      if (best.length === 0) return -1;
      const lefts = new Set(
        best.map((k) => Math.round(k.getBoundingClientRect().left / 10)),
      );
      return lefts.size;
    });
  }

  const parse = (c: string | null) => {
    const m = c?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? luminance(+m[1], +m[2], +m[3]) : null;
  };
  const lumCanvas = parse(probe.bg);
  const lumBody = parse(probe.bodyBg);
  console.log(
    JSON.stringify({
      name: shot.name,
      file,
      canvasBg: probe.bg,
      canvasLuminance: lumCanvas,
      bodyBg: probe.bodyBg,
      bodyLuminance: lumBody,
      darkCanvas: lumCanvas !== null ? lumCanvas < 80 : null,
      peopleCols,
      stack: probe.stack,
    }),
  );
  await ctx.close();
}
await browser.close();
