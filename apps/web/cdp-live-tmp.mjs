import { chromium } from "playwright";
const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0].pages().find(p=>p.url().includes("/assistant")) || b.contexts()[0].pages()[0];
const r = await page.evaluate(async () => {
  const cl = window.vellum?.cueLive;
  return { permissions: await cl.permissions(), status: await cl.status() };
});
console.log(JSON.stringify(r, null, 2));
await b.close();
