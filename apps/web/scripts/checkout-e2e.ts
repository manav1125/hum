/**
 * Live test-checkout E2E (Stripe TEST mode): drives justcue.ai/redeem with a
 * real invite through Stripe's hosted checkout using the public 4242 test
 * card, and lands back on /welcome. Run from apps/web:
 *   bun scripts/checkout-e2e.ts <inviteCode> <email> <name>
 * Prints REDEEM_OK / CHECKOUT_URL / PAID_REDIRECT lines the caller parses.
 */
import { chromium } from "playwright";

const [code, email, name] = process.argv.slice(2);
if (!code || !email) throw new Error("usage: checkout-e2e.ts <code> <email> <name>");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(45_000);

await page.goto("https://justcue.ai/redeem?plan=chief_of_staff", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500); // DC runtime settle

await page.fill('input[name="code"]', code);
await page.fill('input[name="name"]', name ?? "Test Founder");
await page.fill('input[name="email"]', email);
console.log("REDEEM_FILLED");
await page.click('#redeem-form button[type="submit"], #redeem-form button');

await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
console.log("CHECKOUT_URL", page.url().slice(0, 80));
await page.waitForTimeout(4000); // Stripe form hydrate

// Stripe hosted checkout (test mode) — public test fixture card.
await page.fill("#cardNumber", "4242 4242 4242 4242");
await page.fill("#cardExpiry", "12 / 34");
await page.fill("#cardCvc", "123");
await page.fill("#billingName", name ?? "Test Founder");
// Country-dependent postal field
const postal = page.locator("#billingPostalCode");
if (await postal.isVisible().catch(() => false)) await postal.fill("10001");
console.log("CARD_FILLED");

await page.click('button[type="submit"].SubmitButton, button.SubmitButton');
await page.waitForURL(/justcue\.ai\/(welcome|checkout\/success)/, { timeout: 90_000 });
console.log("PAID_REDIRECT", page.url());
await page.screenshot({ path: "/tmp/checkout-welcome.png" });
await browser.close();
console.log("E2E_DONE");
