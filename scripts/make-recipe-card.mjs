// Renders the demo recipe card used by `npm run seed`.
// Requires Playwright + Edge/Chrome locally; the PNG is committed so seeding
// works anywhere.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const out = path.join(process.cwd(), "assets", "demo-recipe-card.png");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { margin: 0 }
  html, body { margin: 0; }
  .card {
    width: 900px; height: 1200px; box-sizing: border-box; padding: 76px 84px;
    background:
      radial-gradient(circle at 78% 12%, rgba(150, 110, 60, 0.08), transparent 28%),
      radial-gradient(circle at 12% 88%, rgba(150, 110, 60, 0.09), transparent 30%),
      repeating-linear-gradient(transparent 0 45px, rgba(120, 140, 165, 0.22) 45px 46px),
      #f7f0df;
    color: #26364d;
    font-family: "Segoe Script", "Bradley Hand", "Comic Sans MS", cursive;
    position: relative;
  }
  .margin { position: absolute; left: 52px; top: 60px; bottom: 60px; width: 3px; background: rgba(190, 110, 100, 0.5); }
  h1 { font-size: 52px; line-height: 1.1; margin: 0 0 4px; transform: rotate(-1.4deg); letter-spacing: 0.5px; }
  .sub { font-size: 24px; opacity: 0.65; margin-bottom: 34px; transform: rotate(-0.6deg); }
  h2 { font-size: 31px; margin: 26px 0 10px; letter-spacing: 1px; opacity: 0.85; }
  ul, ol { margin: 0; padding-left: 40px; font-size: 28px; line-height: 46px; }
  li { margin: 0; }
  .note { position: absolute; right: 64px; bottom: 72px; font-size: 24px; transform: rotate(2deg); opacity: 0.7; }
  .stain { position: absolute; right: 78px; top: 74px; width: 132px; height: 132px; border-radius: 50%;
    background: radial-gradient(circle, rgba(180, 130, 60, 0.16), rgba(180, 130, 60, 0.05) 62%, transparent 70%); }
</style></head>
<body><div class="card">
  <div class="margin"></div><div class="stain"></div>
  <h1>Grandma Margot's<br>Lemon Cake</h1>
  <div class="sub">for Sunday afternoons</div>
  <h2>INGREDIENTS</h2>
  <ul>
    <li>3 eggs</li>
    <li>200 g sugar</li>
    <li>250 g plain flour</li>
    <li>150 g butter, melted</li>
    <li>2 lemons — zest and juice</li>
    <li>1 tsp baking powder</li>
  </ul>
  <h2>METHOD</h2>
  <ol>
    <li>Oven 180 °C. Butter a 24 cm tin.</li>
    <li>Whisk eggs and sugar until pale.</li>
    <li>Fold in butter, zest, half the juice.</li>
    <li>Sift flour and baking powder, fold gently.</li>
    <li>Bake 40–45 minutes.</li>
    <li>Cool, glaze with icing sugar and lemon.</li>
  </ol>
  <div class="note">serves 8 · keeps 3 days</div>
</div></body></html>`;

const browser = await chromium.launch({ executablePath: edge, headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log(`wrote ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`);
