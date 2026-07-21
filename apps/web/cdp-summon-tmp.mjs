import { chromium } from "playwright";
const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0].pages().find(p=>p.url().includes("cue-live")) || b.contexts()[0].pages()[0];
const r = await page.evaluate(async () => {
  try { await window.vellum.cueLive.summon(); return "summon invoked"; }
  catch (e) { return "ERR " + (e?.message || e); }
});
console.log(r);
await b.close();
