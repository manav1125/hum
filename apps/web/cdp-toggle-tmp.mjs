import { chromium } from "playwright";
const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0].pages().find(p=>p.url().includes("cue-live")) || b.contexts()[0].pages()[0];
const before = await page.evaluate(async () => (await window.vellum.cueLive.status()).takeControl);
// Flip "Allow Cue to act" ON via the real IPC the toggle calls.
const after = await page.evaluate(async () => (await window.vellum.cueLive.setTakeControl(true)).takeControl);
await page.waitForTimeout(1500);
const ui = await page.evaluate(() => {
  const t = document.body.innerText;
  return { pill: (t.match(/running · [\w-]+/)||[null])[0],
           blocked: t.includes("Needs Screen Recording"),
           takeControlActive: /Take control[\s\S]{0,80}ACTIVE/.test(t) };
});
console.log(JSON.stringify({ takeControlBefore: before, takeControlAfter: after, ui }, null, 2));
await b.close();
