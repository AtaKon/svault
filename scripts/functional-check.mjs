// Functional UI pass with Playwright (Edge). Runs mutations against a throwaway DB.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:4201";
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath: edge, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${String(error).slice(0, 300)}`));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("401")) problems.push(`console: ${message.text().slice(0, 300)}`);
});
page.on("response", (response) => {
  if (response.url().includes("/api/") && response.status() >= 400 && !(response.status() === 401 && response.url().includes("/api/auth/me"))) {
    problems.push(`http ${response.status()}: ${response.url()}`);
  }
});

function check(condition, label) {
  if (!condition) {
    problems.push(`FAILED: ${label}`);
    console.log(`FAIL ${label}`);
  } else {
    console.log(`PASS ${label}`);
  }
}

await page.goto(`${base}/login`, { waitUntil: "load" });
await page.fill('input[type="email"]', "demo@svault.local");
await page.fill('input[type="password"]', "demo1234");
await Promise.all([page.waitForURL((url) => !url.pathname.includes("login")), page.click('button[type="submit"]')]);
await page.waitForSelector("text=Running low");

// Dark mode toggle
await page.click("text=Dark mode");
check(await page.evaluate(() => document.documentElement.classList.contains("dark")), "theme toggles to dark");
await page.click("text=Light mode");

// Places
await page.goto(`${base}/settings?tab=places`, { waitUntil: "load" });
await page.waitForSelector("text=Fridges, shelves, cabins");
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.fill('input[placeholder*="Fridge, top shelf"]', "Test shelf");
await page.getByRole("button", { name: "Add place", exact: true }).click();
await page.waitForSelector("text=Test shelf");
check(true, "place created");
await page.getByRole("button", { name: "Delete place" }).last().click();
await page.getByRole("dialog").getByRole("button", { name: "Delete place", exact: true }).click();
await page.waitForTimeout(800);
check((await page.locator("text=Test shelf").count()) === 0, "place deleted");

// Categories
await page.goto(`${base}/settings?tab=categories`, { waitUntil: "load" });
await page.waitForSelector("text=Food, dairy, tools");
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.fill('input[maxlength="60"]', "Test category");
await page.getByRole("button", { name: "Add category", exact: true }).click();
await page.waitForSelector("text=Test category");
check(true, "category created");
const categoryRow = page
  .locator("div.rounded-xl.border")
  .filter({ hasText: "Test category" })
  .filter({ has: page.getByRole("button", { name: "Delete category" }) })
  .last();
await categoryRow.getByRole("button", { name: "Delete category" }).click();
await page.getByRole("dialog").getByRole("button", { name: "Delete category", exact: true }).click();
await page.waitForTimeout(800);
check((await page.locator("text=Test category").count()) === 0, "category deleted");
// Attributes
await page.goto(`${base}/settings?tab=attributes`, { waitUntil: "load" });
await page.waitForSelector("text=Custom attributes");
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.getByRole("dialog").waitFor();
await page.fill('input[placeholder="Flavour"]', "Test field");
await page.fill('input[placeholder="flavour"]', "test_field");
await page.getByRole("button", { name: "Add attribute", exact: true }).click();
await page.waitForSelector("text=Test field");
check(true, "attribute created");
await page.getByRole("button", { name: "Delete attribute" }).last().click();
await page.getByRole("dialog").getByRole("button", { name: "Delete attribute", exact: true }).click();
await page.waitForTimeout(800);
check((await page.locator("text=Test field").count()) === 0, "attribute deleted");

// Members invite
await page.goto(`${base}/settings?tab=members`, { waitUntil: "load" });
await page.waitForSelector("text=People in this house");
await page.fill('input[type="email"]', `ui-test-${Date.now()}@example.com`);
await page.getByRole("button", { name: "Invite", exact: true }).click();
await page.waitForSelector("text=Invite for", { timeout: 10000 });
check(true, "invite link created");

// CSV export
await page.goto(`${base}/settings?tab=data`, { waitUntil: "load" });
await page.waitForSelector("text=Inventory CSV");
const [download] = await Promise.all([page.waitForEvent("download"), page.click("text=Inventory CSV")]);
check(download.suggestedFilename().endsWith(".csv"), "inventory CSV downloads");

// Item edit
await page.goto(`${base}/items`, { waitUntil: "load" });
await page.click("text=Whole milk");
await page.waitForSelector("text=Price history");
await page.getByRole("button", { name: "Edit item" }).click();
await page.waitForSelector("h1:has-text('Whole milk')");
await page.locator("label").filter({ hasText: "Low-stock alert at" }).locator("input").fill("3");
await page.getByRole("button", { name: "Save changes", exact: true }).click();
await page.waitForURL(/\/items\/itm_/, { timeout: 15000 });
await page.waitForSelector("text=reorder point is 3");
check(true, "item edited and low-stock threshold saved");

// Recipe edit
await page.goto(`${base}/recipes`, { waitUntil: "load" });
await page.click("text=Grandma's lemon cake");
await page.waitForSelector("text=Method");
await page.getByRole("button", { name: "Edit recipe" }).click();
await page.waitForSelector("h1:has-text('Grandma')");
await page.locator("label").filter({ hasText: "Servings" }).locator("input").fill("10");
await page.getByRole("button", { name: "Save recipe", exact: true }).click();
await page.waitForURL(/\/recipes\/rcp_/, { timeout: 15000 });
await page.waitForSelector("text=10 servings");
check(true, "recipe edited");

// Photo upload + delete
await page.goto(`${base}/photos`, { waitUntil: "load" });
await page.waitForSelector("text=All photos");
const countBefore = await page.locator("img[alt]").count();
await page.setInputFiles('input[type="file"]', "C:\\Users\\PAOK-\\.t3\\projects\\svault\\assets\\demo-recipe-card.png");
await page.waitForSelector("text=1 photo uploaded", { timeout: 30000 });
await page.waitForTimeout(1000);
check((await page.locator("img[alt]").count()) > countBefore, "photo uploaded from the UI");

// Notification read all
await page.goto(`${base}/notifications`, { waitUntil: "load" });
await page.waitForSelector("text=Browser alerts");
await page.getByRole("button", { name: "Mark read", exact: true }).click();
await page.waitForTimeout(600);
check(true, "notifications marked read");

// Scan manual lookup
await page.goto(`${base}/scan`, { waitUntil: "load" });
await page.fill('input[placeholder="EAN, UPC or any code"]', "4006381333931");
await page.getByRole("button", { name: "Find", exact: true }).click();
await page.waitForSelector("text=4006381333931", { timeout: 15000 });
check((await page.locator("text=Whole milk").count()) > 0, "manual barcode lookup works");

console.log("\n--- problems ---");
console.log(problems.length ? [...new Set(problems)].join("\n") : "none");
await browser.close();
process.exit(problems.length ? 1 : 0);
