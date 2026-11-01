// Visual + functional check with a real Chromium (Edge) using Playwright core.
// Usage: node scripts/visual-check.mjs [baseUrl] [outDir]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:4200";
const outDir = process.argv[3] ?? path.join(process.cwd(), "docs", "screenshots");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: edge, headless: true });
const problems = [];

const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await desktop.newPage();
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text().slice(0, 300)}`);
});
page.on("pageerror", (error) => problems.push(`pageerror: ${String(error).slice(0, 300)}`));
page.on("response", (response) => {
  if (response.url().includes("/api/") && response.status() >= 400) {
    problems.push(`http ${response.status()}: ${response.url()}`);
  }
});

async function shot(target, name, fullPage = true) {
  await target.screenshot({ path: path.join(outDir, name), fullPage });
  console.log(`shot ${name}`);
}

async function login(target) {
  await target.goto(`${base}/login`, { waitUntil: "load" });
  await target.fill('input[type="email"]', "demo@svault.local");
  await target.fill('input[type="password"]', "demo1234");
  await Promise.all([target.waitForURL((url) => !url.pathname.includes("login"), { timeout: 20000 }), target.click('button[type="submit"]')]);
  await target.waitForSelector("text=Running low", { timeout: 20000 });
}

await page.goto(`${base}/login`, { waitUntil: "load" });
await shot(page, "desktop-login.png");
await login(page);
await page.waitForTimeout(600);
await shot(page, "desktop-dashboard.png");

await page.goto(`${base}/items`, { waitUntil: "load" });
await page.waitForSelector("text=Whole milk");
await shot(page, "desktop-inventory.png");

await page.goto(`${base}/items`, { waitUntil: "load" });
await page.waitForSelector("text=Whole milk");
await page.click("text=Whole milk");
await page.waitForSelector("text=Price history");
const itemUrl = page.url();
await page.waitForTimeout(400);
await shot(page, "desktop-item.png");

await page.goto(`${base}/recipes`, { waitUntil: "load" });
await page.waitForSelector("text=Grandma's lemon cake");
await shot(page, "desktop-recipes.png");

await page.click("text=Grandma's lemon cake");
await page.waitForSelector("text=Method");
await page.waitForTimeout(400);
await shot(page, "desktop-recipe.png");

await page.goto(`${base}/ideas`, { waitUntil: "load" });
await page.click("text=Something quick for tonight");
await page.waitForSelector("text=Local suggestions", { timeout: 20000 });
await page.waitForTimeout(500);
await shot(page, "desktop-ideas.png");

await page.goto(`${base}/photos`, { waitUntil: "load" });
await page.waitForSelector("text=Fridge shelf");
await shot(page, "desktop-photos.png");

await page.goto(`${base}/photos`, { waitUntil: "load" });
await page.waitForSelector("text=Fridge shelf");
await page.click("text=Fridge shelf");
await page.waitForTimeout(500);
await page.locator("img[alt='demo-fridge-1.png']").first().click();
await page.waitForSelector("text=Dataset split");
await page.waitForTimeout(400);
await shot(page, "desktop-photo-label.png", false);
await page.keyboard.press("Escape");

await page.goto(`${base}/scan`, { waitUntil: "load" });
await page.waitForTimeout(1200);
await shot(page, "desktop-scan.png", false);
const manual = page.locator('input[inputmode="numeric"]').first();
await manual.fill("4006381333931");
await page.click("text=Find");
await page.waitForSelector("text=Whole milk", { timeout: 15000 });
await page.waitForTimeout(500);
await shot(page, "desktop-scan-result.png", false);
await page.keyboard.press("Escape");

await page.goto(`${base}/settings?tab=ai`, { waitUntil: "load" });
await page.waitForSelector("text=AI provider");
await shot(page, "desktop-settings-ai.png");

await page.goto(`${base}/recipes/scan`, { waitUntil: "load" });
await page.waitForSelector("text=Take a photo of the recipe");
await shot(page, "desktop-recipe-scan.png");
await page.setInputFiles(
  'input[type="file"]',
  "C:\\Users\\PAOK-\\AppData\\Local\\Temp\\svault-demo\\uploads\\recipes\\demo-grandma-card.png",
);
try {
  await page.waitForFunction(
    () => {
      const area = document.querySelector("textarea");
      return area && area.value.trim().length > 40;
    },
    { timeout: 120000 },
  );
} catch (error) {
  problems.push(`OCR did not produce text: ${String(error).slice(0, 200)}`);
}
await page.waitForTimeout(400);
await shot(page, "desktop-recipe-ocr.png");

try {
  await page.click("text=Digitise recipe");
  await page.waitForSelector("text=Ready to save", { timeout: 30000 });
  await page.waitForTimeout(400);
  await shot(page, "desktop-recipe-draft.png");
} catch (error) {
  problems.push(`recipe draft failed: ${String(error).slice(0, 200)}`);
}

await page.emulateMedia({ colorScheme: "dark" });
await page.goto(`${base}/`, { waitUntil: "load" });
await page.waitForSelector("text=Running low");
await page.waitForTimeout(500);
await shot(page, "desktop-dark.png");
await page.emulateMedia({ colorScheme: "light" });

// mobile
const storage = await desktop.storageState();
const mobile = await browser.newContext({
  storageState: storage,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});
const m = await mobile.newPage();
m.on("pageerror", (error) => problems.push(`mobile pageerror: ${String(error).slice(0, 300)}`));

await m.goto(`${base}/`, { waitUntil: "load" });
await m.waitForSelector("text=Running low", { timeout: 20000 });
await m.waitForTimeout(500);
await shot(m, "mobile-dashboard.png");

await m.goto(`${base}/items`, { waitUntil: "load" });
await m.waitForSelector("text=Whole milk");
await shot(m, "mobile-inventory.png");

await m.goto(itemUrl, { waitUntil: "load" });
await m.waitForSelector("text=Price history");
await m.waitForTimeout(400);
await shot(m, "mobile-item.png");

await m.goto(`${base}/recipes`, { waitUntil: "load" });
await m.waitForSelector("text=Grandma's lemon cake");
await shot(m, "mobile-recipes.png");

await m.goto(`${base}/ideas`, { waitUntil: "load" });
await m.waitForSelector("text=What can I cook?");
await shot(m, "mobile-ideas.png");

await m.goto(`${base}/photos`, { waitUntil: "load" });
await m.waitForSelector("text=Fridge shelf");
await m.waitForTimeout(400);
await shot(m, "mobile-photos.png");

await m.goto(`${base}/settings`, { waitUntil: "load" });
await m.waitForSelector("text=General");
await shot(m, "mobile-settings.png");

await m.goto(`${base}/more`, { waitUntil: "load" });
await m.waitForSelector("text=SVault 1.0");
await shot(m, "mobile-more.png");

async function getFirstItemId(p) {
  const href = await p.locator('a[href^="/recipes/"]').first().getAttribute("href");
  return href?.split("/").pop() ?? "";
}

void getFirstItemId;

console.log("\n--- problems ---");
if (problems.length === 0) console.log("none");
else console.log([...new Set(problems)].join("\n"));

await browser.close();
