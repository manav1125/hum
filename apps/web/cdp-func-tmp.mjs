import { chromium } from "playwright";
const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0].pages().find(p=>p.url().includes("/assistant")) || b.contexts()[0].pages()[0];
// The banner should now be GONE and the act toggle un-blocked.
await page.goto("https://manav.justcue.app/assistant/cue-live", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const ui = await page.evaluate(() => {
  const t = document.body.innerText;
  return {
    bannerShown: t.includes("can't see or act yet"),
    screenRecNeeded: t.includes("Screen Recording") && t.includes("needed"),
    actBlockedMsg: t.includes("Needs Screen Recording"),
    pill: (t.match(/running · \w+[-\w]*/) || [null])[0],
    hasSummon: t.includes("Summon Cue"),
  };
});
console.log("UI:", JSON.stringify(ui, null, 2));
await b.close();
