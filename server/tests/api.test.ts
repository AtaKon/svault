import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "svault-test-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "";
// Most tests register several independent accounts; the registration-mode tests switch this.
process.env.SV_REGISTRATION = "open";
process.env.SVAI_API_KEY = "";

const http = await import("node:http");

/* A local OpenID Connect provider for the SSO tests. The issuer is set before
   the app imports its config. */
const oidcKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const oidcJwk = oidcKeys.publicKey.export({ format: "jwk" }) as { n?: string; e?: string };
let oidcServer: import("node:http").Server;
let oidcIssuer = "";
await new Promise<void>((resolve) => {
  oidcServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      json({
        issuer: oidcIssuer,
        authorization_endpoint: `${oidcIssuer}/authorize`,
        token_endpoint: `${oidcIssuer}/token`,
        jwks_uri: `${oidcIssuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "email", "profile"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        claims_supported: ["sub", "email", "email_verified", "name"],
      });
      return;
    }
    if (url.pathname === "/jwks") {
      json({ keys: [{ kty: "RSA", kid: "test-key", use: "sig", alg: "RS256", n: oidcJwk.n, e: oidcJwk.e }] });
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const code = params.get("code") ?? "";
        const unverified = code.startsWith("unverified");
        const nonce = code.replace(/^unverified-/, "");
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
        const payload = Buffer.from(
          JSON.stringify({
            iss: oidcIssuer,
            sub: "oidc-test-subject",
            aud: "svault-test",
            exp: Math.floor(Date.now() / 1000) + 300,
            iat: Math.floor(Date.now() / 1000),
            nonce,
            email: "sso@example.com",
            email_verified: !unverified,
            name: "SSO User",
          }),
        ).toString("base64url");
        const signingInput = `${header}.${payload}`;
        const signature = createSign("RSA-SHA256").update(signingInput).sign(oidcKeys.privateKey).toString("base64url");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "test-access",
            token_type: "Bearer",
            expires_in: 300,
            id_token: `${signingInput}.${signature}`,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  oidcServer.listen(0, "127.0.0.1", () => {
    const address = oidcServer.address();
    if (!address || typeof address === "string") throw new Error("no oidc address");
    oidcIssuer = `http://127.0.0.1:${address.port}`;
    process.env.OIDC_ISSUER = oidcIssuer;
    process.env.OIDC_CLIENT_ID = "svault-test";
    process.env.OIDC_CLIENT_SECRET = "test-secret";
    process.env.OIDC_ALLOWED_DOMAINS = "example.com";
    process.env.OIDC_AUTO_PROVISION = "true";
    resolve();
  });
});

const { app } = await import("../index.js");
const { closeDb, get, run } = await import("../db.js");
const { heuristicRecipe, parseIngredientLine, localIdeas } = await import("../services/recipe-local.js");
const { heuristicReceipt } = await import("../services/receipt-local.js");
const { parseLidlReceipt } = await import("../services/receipt-lidl.js");
const { parseSklavenitisReceipt } = await import("../services/receipt-sklavenitis.js");
const { selectReceiptTemplate } = await import("../services/receipt-templates.js");
const { suggestProductMatches } = await import("../services/product-match.js");
const { mergeOcrTexts } = await import("../../client/ocr-merge.js");
const { parseWithTemplateRules } = await import("../services/receipt-template-engine.js");
const { LIDL_TEMPLATE_RULES, SKLAVENITIS_TEMPLATE_RULES } = await import("../../shared/receipt-template-example.js");
const { convert, pricePerUnit } = await import("../units.js");
const { parseOffNutrition } = await import("../services/nutrition.js");
const { parseCsv, parseCsvNumber } = await import("../services/csv.js");
const { totpCode, verifyTotp, generateTotpSecret, generateBackupCodes } = await import("../services/totp.js");
const { backupForTest, validateBackup } = await import("../services/backup.js");
const { inspectDataset, importDataset } = await import("../services/dataset-import.js");
const { encodePng } = await import("../lib/png.js");
const JSZip = (await import("jszip")).default;

let server: import("node:http").Server;
let aiServer: import("node:http").Server;
let base = "";
let aiBase = "";
let cookie = "";
const aiRequests: any[] = [];

async function request(
  pathname: string,
  options: { method?: string; body?: unknown; auth?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const useCookie = options.auth === undefined ? cookie : options.auth;
  if (useCookie) headers.cookie = useCookie;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const res = await fetch(base + pathname, { method: options.method ?? (body ? "POST" : "GET"), headers, body });
  const setCookie = res.headers.get("set-cookie");
  const nextCookie = setCookie ? setCookie.split(";")[0] : null;
  const text = await res.text();
  return {
    status: res.status,
    data: text ? JSON.parse(text) : null,
    cookie: nextCookie,
  };
}

let houseId = "";
let itemId = "";
let barcode = "0123456789012";
let secondUserCookie = "";

const LIDL_SAMPLE = [
  "LIDL",
  "Φτιάξ' αξίζει.",
  "",
  "ΛΙΝΤΑ ΕΛΛΑΣ ΚΑΙ ΣΙΑ Ο.Ε. ΥΠΕΡΑΓΟΡΑ",
  "ΑΛΕΞΑΝΔΡΟΥ ΠΑΠΑΝΑΣΤΑΣΙΟΥ 102",
  "54644, ΘΕΣΣΑΛΟΝΙΚΗ",
  "ΑΦΜ 093683423",
  "",
  "ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ ΕΝΑΡΞΗΣ",
  "",
  "ΑΠΟΓΥΜΝΩΤΗΣ -0523350 1,99 24,00%",
  "ΚΕΦΙΡ ΦΡΑΟΥΛΑ 500ML 3,96 13,00%",
  "4 x 0,99",
  "ΜΗΛΑ ΠΡΑΣΙΝΑ 1KG 1,45 13,00%",
  "ΜΠΑΝΑΝΕΣ 1,17 13,00%",
  "0,984 kg x 1,19 EUR/kg",
  "ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG 3,10 13,00%",
  "1,036 kg x 2,99 EUR/kg",
  "έκπτωση -0,73",
  "έκπτωση Lidl Plus -0,31",
  "ΣΑΚΟΥΛΑ.ΒΙΟΔ.25Μ1ΤΕΜ 0,10 24,00%",
  "ΣΥΝΟΛΟ 10,73",
  "",
  "ΚΑΡΤΑ 10,73",
  "ΦΠΑ%",
  "B 13,00% 7,64 + 0,99 = 8,63",
  "C 24,00% 1,69 + 0,41 = 2,10",
  "ΣΥΝΟΛΟ 9,33 1,40 10,73",
  "",
  "0087 990113/90/98 08.10.26 10:09",
].join("\n");

const SKLAVENITIS_SAMPLE = [
  "ΕΛΛΗΝΙΚΕΣ ΥΠΕΡΑΓΟΡΕΣ",
  "ΣΚΛΑΒΕΝΙΤΗΣ Α.Ε.Ε.",
  "SUPER MARKETS",
  "Υ/Α Λ.ΒΟΥΛΙΑΓΜΕΝΗΣ 140",
  "ΔΑΦΝΗ ΤΗΛ.210-9270972",
  "ΑΦΜ 800764388",
  "",
  "ΤΑΜΕΙΟ 01 ΚΑΤ: 1148    ΧΕΙΡΙΣΤΗΣ 59662",
  "",
  "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ",
  "5208046287576",
  "ΑΥΓΑ ΜΑΡΑΤΑ ΑΧΥΡΩΝΑ MEDIUM  2,70 13,00%",
  "4084500183067",
  "FAIRY ΠΙΑΤΩΝ ΚΑΝΟΝΙΚΟ 900ML 4,86 24,00%",
  "ΕΚΠΤΩΣΗ FAIRY ΠΙΑΤΩΝ ΚΑΝΟΝΙ -2,17 24,00%",
  "5201815153553",
  "SOYUΓIAPL WETTEX STRONG FAM 2,20 24,00%",
  "ΕΚΠΤΩΣΗ SOYUΓIAPL WETTEX ST -0,61 24,00%",
  "8606018619627",
  "ΠΑΡ.ΝΙRVANA PISTACHIO&ALMON 6,40 13,00%",
  "ΕΚΠΤΩΣΗ ΠΑΡ.ΝΙRVANA PISTACH -1,70 13,00%",
  "5202576302303",
  "ΜΑΡΑΤΑ ΤΟΡΤΕΛΙΝΙΑ ΜΕ ΤΥΡΙ 2 1,65 13,00%",
  "5010034015661",
  "ΡΥΖΙ BENUS ΜΕΣΙΚΑΝΙΚΟ 2U 22 2,35 13,00%",
  "5201415204174",
  "ΤΥΡΙ ΚΡΕΜΑ ADORO 200G 2,26 13,00%",
  "ΕΚΠΤΩΣΗ ΤΥΡΙ ΚΡΕΜΑ ADORO 20 -0,67 13,00%",
  "5201415204174",
  "ΤΥΡΙ ΚΡΕΜΑ ADORO 200G 2,26 13,00%",
  "ΕΚΠΤΩΣΗ ΤΥΡΙ ΚΡΕΜΑ ADORO 20 -0,67 13,00%",
  "5201301310781",
  "COTTAGE 4% ΛΙΠ.ΤΥΡΑΣ 180G 1,54 13,00%",
  "5202576099586",
  "ΤΟΝΟΣ ΜΑΡΑΤΑ ΣΕ ΝΕΡΟ ΣΤ.Β.1 2,48 13,00%",
  "5202187119239",
  "ΠΟΤΗΡΙΑ TEFACO ΧΑΡΤ.Μ.ΚΑΠ 2 0,96 24,00%",
  "5202576630499",
  "ΣΑΚΟΥΛΑ ΠΕΛΑΤΩΝ ΕΠΑΝΑΧΡ.ΠΕΡ 0,18 24,00%",
  "----------------",
  "ΣΥΝΟΛΟ 24,02 ΕΥΡΩ",
  "EFT-Πιστωτική κάρτα 24,02",
  "ΠΩΛΗΘΕΝΤΑ ΕΙΔΗ : 12",
  "",
  "ΗΜΕΡ:05/06/2026  ΩΡΑ:18:28:05",
  "Α/Α 372  ΣΕΙΡΑ: 01 / 209927",
  "** ΝΟΜΙΜΗ ΑΠΟΔΕΙΞΗ **",
].join("\n");

const SKLAVENITIS_WEIGHT_SAMPLE = [
  "ΕΛΛΗΝΙΚΕΣ ΥΠΕΡΑΓΟΡΕΣ",
  "ΣΚΛΑΒΕΝΙΤΗΣ Α.Ε.Ε.",
  "SUPER MARKETS",
  "Υ/Α ΠΙΚΕΡΜΙΟΥ Λ.ΜΑΡΑΘΩΝΟΣ 4",
  "ΑΦΜ 800764388",
  "",
  "ΤΑΜΕΙΟ 09 ΚΑΤ: 1801    ΧΕΙΡΙΣΤΗΣ 24123",
  "",
  "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ",
  "1111442",
  "ΝΕΡΟ ΘΕΩΝΗ ΦΥΣΙΚΟ ΜΕΤΑΛΛΙΚΟ 2,08 13,00%",
  "5201037510127",
  "ΡΟΦΗΜΑ ΑΜΥΓΔΑΛΟΥ Χ.ΓΛ ΔΕΛΤΑ 2,95 13,00%",
  "ΕΚΠΤΩΣΗ ΡΟΦΗΜΑ ΑΜΥΓΔΑΛΟΥ Χ. -0,59 13,00%",
  "5201005004443",
  "ΧΥΜΟΣ ΦΥΣΙΚΟΣ AMITA MOTION 2,55 13,00%",
  "ΕΚΠΤΩΣΗ ΧΥΜΟΣ ΦΥΣΙΚΟΣ AMITA -0,55 13,00%",
  "5201193112043",
  "ΜΕΛΙΣΣΑ ΠΕΝΝΕΣ ΡΙΓΕ 500ΓΡ. 1,46 13,00%",
  "ΕΚΠΤΩΣΗ ΜΕΛΙΣΣΑ ΠΕΝΝΕΣ ΡΙΓΕ -0,51 13,00%",
  "2220045000000",
  "ΑΓΓΟΥΡΑΚΙΑ ΕΓΧΩΡΙΑ",
  " 0,616      1,30      0,80 13,00%",
  "ΕΚΠΤΩΣΗ ΑΓΓΟΥΡΑΚΙΑ ΕΓΧΩΡΙΑ -0,18 13,00%",
  "5202576681330",
  "ΓΑΛΑ ΧΩΡΙΣ ΛΑΚΤΟΖΗ ΜΑΡΑΤΑ 1 1,75 13,00%",
  "2220540000000",
  "ΜΠΑΝΑΝΕΣ DOLE ΕΙΣΑΓΩΓΗΣ.",
  " 0,878      1,88      1,65 13,00%",
  "5200251590175",
  "ΓΑΛΑ ΦΡΕΣΚΟ ΚΑΛΑΒΡΥΤΩΝ 1,5% 1,98 13,00%",
  "5201193112043",
  "ΜΕΛΙΣΣΑ ΠΕΝΝΕΣ ΡΙΓΕ 500ΓΡ. 1,46 13,00%",
  "ΕΚΠΤΩΣΗ ΜΕΛΙΣΣΑ ΠΕΝΝΕΣ ΡΙΓΕ -0,51 13,00%",
  "2280756000300",
  "ΝΤΟΜΑΤΙΝΙΑ Τ.ΒΕΛΑΝΙΔΙ ΣΥΣΚ",
  " 0,820      2,60      2,13 13,00%",
  "----------------",
  "ΣΥΝΟΛΟ 16,47 ΕΥΡΩ",
  "EFT-Πιστωτική κάρτα 16,47",
  "ΠΩΛΗΘΕΝΤΑ ΕΙΔΗ : 10",
  "",
  "ΗΜΕΡ:12/08/2026  ΩΡΑ:18:10:51",
  "Α/Α 111  ΣΕΙΡΑ: 09 / 77953",
  "** ΝΟΜΙΜΗ ΑΠΟΔΕΙΞΗ **",
].join("\n");

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;

  // OpenAI-compatible mock so the AI code paths can be tested without a key.
  await new Promise<void>((resolve) => {
    aiServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        let body: any = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = {};
        }
        aiRequests.push({ headers: req.headers, body });
        const system = String(body?.messages?.[0]?.content ?? "");
        let payload: any;
        if (system.includes("receipt")) {
          payload = {
            vendorName: "Mock Mart",
            purchasedAt: "2026-10-12",
            currency: "EUR",
            total: 5.5,
            lines: [
              { description: "Milk", quantity: 2, unit: "l", unitPrice: 1.2, lineTotal: 2.4 },
              { description: "Bread", quantity: 1, unit: null, unitPrice: 3.1, lineTotal: 3.1 },
            ],
            notes: "Mock receipt",
          };
        } else if (system.includes("archivist")) {
          payload = {
            title: "AI pancakes",
            description: "Cleaned by the mock model",
            servings: 3,
            prepMinutes: 5,
            cookMinutes: 10,
            tags: ["breakfast"],
            ingredients: [{ name: "Flour", quantity: 200, unit: "g", optional: false }],
            steps: [{ text: "Mix everything." }, { text: "Fry until golden.", timerSeconds: 120 }],
            notes: "Mock cleanup",
          };
        } else if (system.includes("home cook")) {
          payload = {
            summary: "Mock ideas from stock",
            ideas: [
              {
                title: "Mock soup",
                rationale: "You have everything",
                timeMinutes: 20,
                servings: 2,
                uses: [{ name: "Milk", quantity: 1, unit: "l" }],
                missing: [],
                steps: ["Warm it up."],
              },
            ],
          };
        } else {
          payload = {
            title: "Pancakes improved",
            description: "Completed",
            servings: 4,
            prepMinutes: 10,
            cookMinutes: 15,
            tags: ["breakfast"],
            ingredients: [{ name: "Flour", quantity: 250, unit: "g", optional: false }],
            steps: [{ text: "Whisk the batter." }, { text: "Cook for 3 minutes." }],
            notes: "completed by mock",
          };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(payload) } }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 500,
              total_tokens: 1500,
              ...(body?.model === "priced-model" ? {} : { cost: 0.00125 }),
            },
          }),
        );
      });
    });
    aiServer.listen(0, "127.0.0.1", () => {
      const aiAddress = aiServer.address();
      if (!aiAddress || typeof aiAddress === "string") throw new Error("no ai address");
      aiBase = `http://127.0.0.1:${aiAddress.port}/v1`;
      resolve();
    });
  });

  const reg = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Test Owner", email: "owner@example.com", password: "test password" },
  });
  assert.equal(reg.status, 201);
  cookie = reg.cookie!;
  houseId = reg.data.houses[0].id;

  const second = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Test Stranger", email: "stranger@example.com", password: "test password" },
  });
  secondUserCookie = second.cookie!;
});

after(async () => {
  server?.close();
  aiServer?.close();
  oidcServer?.close();
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("units", () => {
  it("converts mass and volume", () => {
    assert.equal(convert(2, "kg", "g"), 2000);
    assert.equal(convert(1, "l", "ml"), 1000);
    assert.equal(convert(1, "pcs", "kg"), null);
  });
  it("normalises price per base unit", () => {
    assert.equal(pricePerUnit(10, "kg", "g"), 0.01);
    assert.equal(pricePerUnit(3, "pcs", "pcs"), 3);
  });
});

describe("nutrition", () => {
  it("normalises per-serving OpenFoodFacts nutrition to 100 ml", () => {
    const nutrition = parseOffNutrition({
      quantity: "330 ml",
      serving_size: "1 can (330 ml)",
      serving_quantity: 330,
      nutrition_data_per: "serving",
      nutriments: {
        "energy-kj_serving": 200,
        proteins_serving: 3.3,
        salt_serving: 0.33,
      },
    });
    assert.ok(nutrition);
    assert.equal(nutrition.basis, "100ml");
    assert.equal(nutrition.servingQuantity, 330);
    assert.equal(nutrition.energyKcal, Math.round((200 / 4.184) * (100 / 330)));
    assert.equal(nutrition.proteins, 1);
    assert.equal(nutrition.salt, 0.1);
    assert.equal(nutrition.sodium, 0.04);
  });

  it("reads per-100 values and derives salt from sodium", () => {
    const nutrition = parseOffNutrition({
      quantity: "500 g",
      nutriments: {
        "energy-kcal_100g": 120,
        fat_100g: 3.2,
        "saturated-fat_100g": 1.1,
        carbohydrates_100g: 20,
        sugars_100g: 4,
        fiber_100g: 2,
        proteins_100g: 5,
        sodium_100g: 0.4,
      },
    });
    assert.equal(nutrition?.basis, "100g");
    assert.equal(nutrition?.energyKcal, 120);
    assert.equal(nutrition?.energyKj, 502);
    assert.equal(nutrition?.salt, 1);
  });
});

describe("recipe text parsing", () => {
  it("reads an ingredient line", () => {
    const parsed = parseIngredientLine("1 1/2 cups plain flour");
    assert.equal(parsed?.quantity, 1.5);
    assert.equal(parsed?.unit, "cup");
    assert.equal(parsed?.name, "plain flour");
  });

  it("splits headers, ingredients and steps", () => {
    const draft = heuristicRecipe(
      "GRANDMA'S LEMON CAKE\n\nIngredients\n2 eggs\n½ cup sugar\n\nInstructions\n1. Whisk the eggs.\n2. Bake for 30 minutes.\n\nServes 6",
    );
    assert.equal(draft.title, "GRANDMA'S LEMON CAKE");
    assert.equal(draft.ingredients.length, 2);
    assert.equal(draft.steps.length, 2);
    assert.equal(draft.servings, 6);
    assert.equal(draft.steps[1].timerSeconds, 1800);
  });

  it("handles OCR noise and two-line titles", () => {
    const draft = heuristicRecipe(
      "Grandmae Margot's\nLemon Cake\n| for Sunday afternoons\n| INGREDIENTS\n| * 3 eggs\n| * 200 g smgor\n| * 2 lemons - zest and juice\n| METHOD\n| 1. Oven 180 C. Butter a tin.\n| 2. Whisk eggs.\n| serves 8",
    );
    assert.equal(draft.title, "Grandmae Margot's Lemon Cake");
    assert.equal(draft.ingredients.length, 3);
    assert.equal(draft.steps.length, 2);
    assert.equal(draft.servings, 8);
  });

  it("reads a Greek recipe", () => {
    const draft = heuristicRecipe(
      [
        "ΓΙΑΓΙΑΣ ΚΕΙΚ",
        "",
        "ΥΛΙΚΑ",
        "2 φλιτζάνια αλεύρι",
        "3 αυγά",
        "",
        "ΕΚΤΕΛΕΣΗ",
        "1. Χτυπάμε τα αυγά.",
        "2. Ψήνουμε για 30 λεπτά.",
        "",
        "ΜΕΡΙΔΕΣ 8",
      ].join("\n"),
    );
    assert.equal(draft.title, "ΓΙΑΓΙΑΣ ΚΕΙΚ");
    assert.equal(draft.ingredients.length, 2);
    assert.equal(draft.ingredients[0].quantity, 2);
    assert.equal(draft.ingredients[0].unit, "cup");
    assert.equal(draft.ingredients[0].name, "αλεύρι");
    assert.equal(draft.steps.length, 2);
    assert.equal(draft.steps[1].timerSeconds, 1800);
    assert.equal(draft.servings, 8);
  });

  it("suggests recipes from stock", () => {
    const ideas = localIdeas(
      [
        { name: "eggs", quantity: 4, unit: "pcs", categoryName: "Dairy" },
        { name: "flour", quantity: 500, unit: "g", categoryName: "Food" },
        { name: "milk", quantity: 1, unit: "l", categoryName: "Dairy" },
      ],
      [{ id: "r1", title: "Pancakes", ingredients: [{ name: "eggs", quantity: 2, unit: "pcs", optional: false }, { name: "flour", quantity: 200, unit: "g", optional: false }, { name: "sugar", quantity: 10, unit: "g", optional: false }], steps: [{ text: "Mix" }] }],
      "",
    );
    assert.equal(ideas.ideas[0].title, "Pancakes");
    assert.equal(ideas.ideas[0].source, "recipe");
    assert.ok(ideas.ideas[0].missing.some((entry) => entry.name === "sugar"));
  });
});

describe("receipt text parsing", () => {
  it("reads quantities, units and multipliers", () => {
    const draft = heuristicReceipt(
      ["LIDL", "01.11.2026", "MILK 1,5% 2 x 1,19 2,38 A", "BANANAS 1,234 kg x 1,49 1,84", "TOTAL 6,21"].join("\n"),
    );
    assert.equal(draft.vendorName, "Lidl");
    assert.equal(draft.purchasedAt, "2026-11-01");
    assert.equal(draft.total, 6.21);
    assert.equal(draft.lines.length, 2);
    assert.equal(draft.lines[0].quantity, 2);
    assert.equal(draft.lines[0].unitPrice, 1.19);
    assert.equal(draft.lines[1].quantity, 1.234);
    assert.equal(draft.lines[1].unit, "kg");
    assert.equal(draft.lines[1].lineTotal, 1.84);
  });

  it("reads a Greek receipt", () => {
    const draft = heuristicReceipt(
      ["ΣΚΛΑΒΕΝΙΤΗΣ", "12/10/2026", "ΓΑΛΑ 1,5 Λ 2,40", "ΨΩΜΙ 3,10", "ΣΥΝΟΛΟ 5,50", "ΜΕΤΡΗΤΑ 10,00", "ΡΕΣΤΑ 4,50"].join(
        "\n",
      ),
    );
    assert.equal(draft.vendorName, "Σκλαβενιτης");
    assert.equal(draft.total, 5.5);
    assert.equal(draft.lines.length, 2);
    assert.equal(draft.lines[0].description, "ΓΑΛΑ");
    assert.equal(draft.lines[0].quantity, 1.5);
    assert.equal(draft.lines[0].unit, "l");
  });

  it("reads the net and tax split", () => {
    const english = heuristicReceipt(
      ["WHOLE FOODS MARKET", "10/12/2026", "Organic Milk 5.99", "SUBTOTAL 10.49", "TAX 0.84", "TOTAL 11.33"].join("\n"),
    );
    assert.equal(english.total, 11.33);
    assert.equal(english.subtotal, 10.49);
    assert.equal(english.tax, 0.84);

    const greek = heuristicReceipt(
      ["ΣΚΛΑΒΕΝΙΤΗΣ", "12/10/2026", "ΓΑΛΑ 8,75", "ΦΠΑ 24% 2,10", "ΣΥΝΟΛΟ 10,85"].join("\n"),
    );
    assert.equal(greek.total, 10.85);
    assert.equal(greek.tax, 2.1);
    assert.equal(greek.subtotal, 8.75);
    assert.equal(greek.taxBreakdown.length, 1);
    assert.equal(greek.taxBreakdown[0].rate, 24);
    assert.equal(greek.taxBreakdown[0].net, 8.75);
  });

  it("ignores savings lines when reading the total", () => {
    const draft = heuristicReceipt(
      ["ΣΚΛΑΒΕΝΙΤΗΣ", "12/10/2026", "ΓΑΛΑ 5,00", "ΣΥΝΟΛΙΚΗ ΕΚΠΤΩΣΗ -1,00", "ΣΥΝΟΛΟ 4,00"].join("\n"),
    );
    assert.equal(draft.total, 4);
    assert.equal(draft.savings, 1);
    assert.equal(draft.lines.length, 1);
  });
});

describe("Lidl receipt template", () => {
  it("recognises the legal name when OCR reads its initial lambda as delta", async () => {
    const template = await selectReceiptTemplate("ΔΙΝΤΑ ΕΛΛΑΣ\nΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ\nΓΑΛΑ 2,00 13%\nΣΥΝΟΛΟ 2,00", "");
    assert.equal(template?.id, "lidl-gr");
  });

  it("detects the template and parses quantities, weights and discounts", async () => {
    const template = await selectReceiptTemplate(LIDL_SAMPLE, "");
    assert.equal(template?.id, "lidl-gr");
    assert.ok((template?.confidence ?? 0) >= 0.7);

    const draft = parseLidlReceipt(LIDL_SAMPLE, "EUR");
    assert.equal(draft.vendorName, "Lidl");
    assert.equal(draft.purchasedAt, "2026-10-08");
    assert.equal(draft.total, 10.73);
    assert.equal(draft.subtotal, 9.33);
    assert.equal(draft.tax, 1.4);
    assert.deepEqual(
      draft.taxBreakdown.map((entry) => entry.rate),
      [13, 24],
    );
    assert.equal(draft.lines.length, 5);

    const kefir = draft.lines.find((line) => line.description.includes("ΚΕΦΙΡ"));
    assert.ok(kefir);
    assert.equal(kefir.quantity, 4);
    assert.equal(kefir.unitPrice, 0.99);
    assert.equal(kefir.lineTotal, 3.96);

    const bananas = draft.lines.find((line) => line.description.includes("ΜΠΑΝΑΝΕΣ"));
    assert.ok(bananas);
    assert.equal(bananas.quantity, 0.984);
    assert.equal(bananas.unit, "kg");
    assert.equal(bananas.unitPrice, 1.19);

    const flour = draft.lines.find((line) => line.description.includes("ΑΛΕΞ"));
    assert.ok(flour);
    assert.equal(flour.discount, 1.04);
    assert.equal(flour.lineTotal, 2.06);
    assert.equal(flour.quantity, 1.036);
    assert.ok(Math.abs((flour.unitPrice ?? 0) - 1.99) < 0.01);

    assert.equal(draft.lines[0].rawDescription, "ΑΠΟΓΥΜΝΩΤΗΣ -0523350");
    assert.equal(draft.lines[0].description, "ΑΠΟΓΥΜΝΩΤΗΣ");
    assert.equal(draft.savings, 1.04);
    assert.ok(!draft.lines.some((line) => line.description.includes("ΣΑΚΟΥΛΑ")));
  });

  it("keeps products when OCR drops the VAT column or confuses Greek zeros", () => {
    const sample = [
      "LIDL",
      "ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ",
      "ΚΕΦΙΡ ΦΡΑΟΥΛΑ 500ML 3,96",
      "4 x 0,99",
      "ΑΠΟΓΥΜΝΩΤΗΣ -0523350 1,99 24,OO%",
      "ΣYNOΛO 5,95",
    ].join("\n");

    const draft = parseLidlReceipt(sample, "EUR");
    assert.equal(draft.total, 5.95);
    assert.equal(draft.lines.length, 2);
    assert.equal(draft.lines[0].description, "ΚΕΦΙΡ ΦΡΑΟΥΛΑ 500ML");
    assert.equal(draft.lines[0].quantity, 4);
    assert.equal(draft.lines[0].unitPrice, 0.99);
    assert.equal(draft.lines[0].taxRate, null);
    assert.equal(draft.lines[1].description, "ΑΠΟΓΥΜΝΩΤΗΣ");
    assert.equal(draft.lines[1].taxRate, 24);
  });

  it("can be rebuilt from the generic template rules", () => {
    const draft = parseWithTemplateRules(LIDL_SAMPLE, LIDL_TEMPLATE_RULES, {
      id: "lidl-gr",
      name: "Lidl Greece",
      confidence: 0.99,
      vendorName: "Lidl",
    });
    assert.equal(draft.total, 10.73);
    assert.equal(draft.subtotal, 9.33);
    assert.equal(draft.tax, 1.4);
    assert.equal(draft.taxBreakdown.length, 2);
    assert.equal(draft.lines.length, 5);
    const flour = draft.lines.find((line) => line.description.includes("ΑΛΕΞ"));
    assert.ok(flour);
    assert.equal(flour.discount, 1.04);
    assert.equal(flour.lineTotal, 2.06);
  });

  it("accepts OCR'd amounts without a VAT column in the template engine", () => {
    const sample = ["LIDL", "ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ", "ΚΑΦΕΣ 1O,OO", "ΣΥΝΟΛΟ 10,00"].join("\n");
    const draft = parseWithTemplateRules(sample, LIDL_TEMPLATE_RULES, {
      id: "lidl-gr",
      name: "Lidl Greece",
      confidence: 0.99,
      vendorName: "Lidl",
    });

    assert.equal(draft.total, 10);
    assert.equal(draft.lines.length, 1);
    assert.equal(draft.lines[0].description, "ΚΑΦΕΣ");
    assert.equal(draft.lines[0].lineTotal, 10);
    assert.equal(draft.lines[0].taxRate, null);
  });
});

describe("receipt OCR product crop", () => {
  it("includes the first product name and barcode before a priced row", async () => {
    const { detectProductRegion, spliceProductText } = await import("../../client/ocr.js");
    const line = (text: string, y: number) => ({ text, bbox: { x0: 0, x1: 200, y0: y, y1: y + 10 } });
    const page = { text: "", blocks: [{ paragraphs: [{ lines: [
      line("ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ", 10), line("5208046287576", 30),
      line("ΓΑΛΑ", 50), line("1 x 2,00 2,00 13%", 70), line("ΣΥΝΟΛΟ 2,00", 100),
    ] }] }] };
    assert.equal(detectProductRegion(page, 200, 120)?.top, 22);
    const full = "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ\n5208046287576\nΓΑΛΑ\n1 x 2,00 2,00 13%\nΣΥΝΟΛΟ 2,00";
    const result = spliceProductText(full, "5208046287576\nΓΑΛΑ\n1 x 2,00 2,00 13%");
    assert.equal(result, full);
  });
});

describe("My market receipt template", () => {
  it("reads the two-line basket, weighted products and total from the photographed layout", async () => {
    const text = [
      "ΜΕΤΡΟ ΑΕΒΕ - ΣΟΥΠΕΡ ΜΑΡΚΕΤ",
      "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ 5893/534084",
      "COCA COLA ZERO 1,5L 3/(2ΤΕΜ)", "1 x 3,70 3,70 13%",
      'ΤΣΑΝΤΑ ΤΑΜΕΙΟΥ ΒΙΟ "MY MARKET" 35X60CM', "1 x 0,17 0,17 24%",
      "ΜΠΡΟΚΟΛΟ ΕΓΧΩΡΙΟ (ΤΙΜΗ ΚΙΛ.)", "1,226 x 2,99 3,67 13%",
      "ALPILAND COTTAGE ΜΕ ΓΛΥΚΟ ΤΣΙΛΙ 200GR", "4 x 2,58 10,32 13%",
      "ΑΒΟΚΑΝΤΟ ΩΡΙΜΑΣΜΕΝΟ ΕΙΣΑΓ. (ΤΙΜΗ ΚΙΛΟΥ)", "0,686 x 8,49 5,82 13%",
      "BABYCARE 99% WAT.ΜΩΡ/ΛΑ TRIPLE 8/(3X72T)", "1 x 2,35 2,35 6%",
      "MENTOS PURE FRESH ROCK.BOTTLE LEMONADE", "1 x 1,49 1,49 13%",
      "ΣΥΝΟΛΟ ΕΥΡΩ 27,52", "ΠΙΣΤΩΤΙΚΗ ΚΑΡΤΑ 27,52", "ΗΜΕΡ: 04/11/2026",
    ].join("\n");
    const template = await selectReceiptTemplate(text, "");
    assert.equal(template?.id, "my-market-gr");
    const draft = template!.parse(text, "EUR");
    assert.equal(draft.vendorName, "My market");
    assert.equal(draft.purchasedAt, "2026-11-04");
    assert.equal(draft.total, 27.52);
    assert.equal(draft.lines.length, 7);
    assert.equal(draft.lines[1].lineTotal, 0.17);
    assert.equal(draft.lines[2].quantity, 1.226);
    assert.equal(draft.lines[2].unit, "kg");
    assert.equal(draft.lines[2].unitPrice, 2.99);
    assert.equal(draft.lines[3].quantity, 4);
    assert.equal(draft.lines[3].lineTotal, 10.32);
    assert.equal(draft.lines[5].taxRate, 6);
    assert.equal(Math.round(draft.lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0) * 100), 2752);
  });

  it("does not identify a product mentioning My market as the merchant", async () => {
    const template = await selectReceiptTemplate('ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ\nΤΣΑΝΤΑ "MY MARKET" 0,17\nΣΥΝΟΛΟ 0,17', "");
    assert.notEqual(template?.id, "my-market-gr");
  });
});

describe("Sklavenitis receipt template", () => {
  it("detects the template and parses compact lines, barcodes and discounts", async () => {
    const template = await selectReceiptTemplate(SKLAVENITIS_SAMPLE, "");
    assert.equal(template?.id, "sklavenitis-gr");
    assert.ok((template?.confidence ?? 0) >= 0.7);

    const draft = parseSklavenitisReceipt(SKLAVENITIS_SAMPLE, "EUR");
    assert.equal(draft.vendorName, "Σκλαβενίτης");
    assert.equal(draft.purchasedAt, "2026-06-05");
    assert.equal(draft.total, 24.02);
    assert.equal(draft.currency, "EUR");
    assert.equal(draft.lines.length, 12);
    assert.equal(draft.savings, 5.82);

    const eggs = draft.lines[0];
    assert.equal(eggs.description, "ΑΥΓΑ ΜΑΡΑΤΑ ΑΧΥΡΩΝΑ MEDIUM");
    assert.equal(eggs.barcode, "5208046287576");
    assert.equal(eggs.lineTotal, 2.7);

    const fairy = draft.lines.find((line) => line.description.includes("FAIRY"));
    assert.ok(fairy);
    assert.equal(fairy.discount, 2.17);
    assert.equal(fairy.lineTotal, 2.69);
    assert.equal(fairy.taxRate, 24);
  });

  it("keeps a compact product line when OCR drops its VAT rate", () => {
    const sample = [
      "ΕΛΛΗΝΙΚΕΣ ΥΠΕΡΑΓΟΡΕΣ",
      "ΣΚΛΑΒΕΝΙΤΗΣ Α.Ε.Ε.",
      "SUPER MARKETS",
      "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ",
      "ΚΑΦΕΣ ΕΛΛΗΝΙΚΟΣ 3,20",
      "ΣYNOΛO 3,20",
    ].join("\n");

    const draft = parseSklavenitisReceipt(sample, "EUR");
    assert.equal(draft.total, 3.2);
    assert.equal(draft.lines.length, 1);
    assert.equal(draft.lines[0].description, "ΚΑΦΕΣ ΕΛΛΗΝΙΚΟΣ");
    assert.equal(draft.lines[0].lineTotal, 3.2);
    assert.equal(draft.lines[0].taxRate, null);
  });

  it("parses weight and quantity follow-up lines", () => {
    const draft = parseSklavenitisReceipt(SKLAVENITIS_WEIGHT_SAMPLE, "EUR");
    assert.equal(draft.purchasedAt, "2026-08-12");
    assert.equal(draft.total, 16.47);
    assert.equal(draft.lines.length, 10);
    assert.equal(draft.savings, 2.34);

    const cucumber = draft.lines.find((line) => line.description.includes("ΑΓΓΟΥΡΑΚΙΑ"));
    assert.ok(cucumber);
    assert.equal(cucumber.quantity, 0.616);
    assert.equal(cucumber.unit, "kg");
    assert.equal(cucumber.lineTotal, 0.62);
    assert.equal(cucumber.discount, 0.18);
    assert.equal(cucumber.barcode, "2220045000000");

    const bananas = draft.lines.find((line) => line.description.includes("ΜΠΑΝΑΝΕΣ"));
    assert.ok(bananas);
    assert.equal(bananas.quantity, 0.878);
    assert.equal(bananas.unit, "kg");
    assert.equal(bananas.unitPrice, 1.88);
    assert.equal(bananas.lineTotal, 1.65);
  });

  it("parses piece quantity follow-up lines", () => {
    const sample = [
      "ΕΛΛΗΝΙΚΕΣ ΥΠΕΡΑΓΟΡΕΣ",
      "ΣΚΛΑΒΕΝΙΤΗΣ Α.Ε.Ε.",
      "SUPER MARKETS",
      "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ",
      "5202576644537",
      "ΣΟΚΟΛΑΤΑ LILA PAUSE ΦΡΟΥΑΡ",
      " 4 x 1,08 4,32 13,00%",
      "ΣΥΝΟΛΟ 4,32 ΕΥΡΩ",
      "ΗΜΕΡ:25/09/2026  ΩΡΑ:18:49:26",
    ].join("\n");
    const draft = parseSklavenitisReceipt(sample, "EUR");
    assert.equal(draft.lines.length, 1);
    const chocolate = draft.lines[0];
    assert.equal(chocolate.description, "ΣΟΚΟΛΑΤΑ LILA PAUSE ΦΡΟΥΑΡ");
    assert.equal(chocolate.barcode, "5202576644537");
    assert.equal(chocolate.quantity, 4);
    assert.equal(chocolate.unitPrice, 1.08);
    assert.equal(chocolate.lineTotal, 4.32);
    assert.equal(chocolate.unit, null);
  });

  it("treats an OCR-negative amount as a discount on the previous line", () => {
    const sample = [
      "ΕΛΛΗΝΙΚΕΣ ΥΠΕΡΑΓΟΡΕΣ",
      "ΣΚΛΑΒΕΝΙΤΗΣ Α.Ε.Ε.",
      "SUPER MARKETS",
      "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ",
      "2220045000000",
      "ΑΓΓΟΥΡΑΚΙΑ ΕΓΧΩΡΙΑ",
      " 0,616      1,30      0,80 13,00%",
      "-0,18 13,00%",
      "ΣΥΝΟΛΟ 0,62 ΕΥΡΩ",
      "ΗΜΕΡ:12/08/2026  ΩΡΑ:18:10:51",
    ].join("\n");
    const draft = parseSklavenitisReceipt(sample, "EUR");
    const cucumber = draft.lines[0];
    assert.equal(draft.lines.length, 1);
    assert.equal(cucumber.lineTotal, 0.62);
    assert.equal(cucumber.discount, 0.18);
  });

  it("does not create products from savings summary lines", () => {
    const sample = [
      "ΕΛΛΗΝΙΚΕΣ ΥΠΕΡΑΓΟΡΕΣ",
      "ΣΚΛΑΒΕΝΙΤΗΣ Α.Ε.Ε.",
      "SUPER MARKETS",
      "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ",
      "5202576681330",
      "ΓΑΛΑ ΧΩΡΙΣ ΛΑΚΤΟΖΗ ΜΑΡΑΤΑ 1 5,00 13,00%",
      "ΕΚΠΤΩΣΗ ΓΑΛΑ ΧΩΡΙΣ ΛΑΚΤΟΖΗ -1,00",
      "ΣΥΝΟΛΙΚΗ ΕΚΠΤΩΣΗ -1,00",
      "ΣΥΝΟΛΟ 4,00 ΕΥΡΩ",
      "ΗΜΕΡ:12/08/2026  ΩΡΑ:18:10:51",
    ].join("\n");
    const parsed = parseSklavenitisReceipt(sample, "EUR");
    assert.equal(parsed.lines.length, 1);
    assert.equal(parsed.lines[0].description, "ΓΑΛΑ ΧΩΡΙΣ ΛΑΚΤΟΖΗ ΜΑΡΑΤΑ 1");
    assert.equal(parsed.lines[0].lineTotal, 4);
    assert.equal(parsed.savings, 1);

    const templated = parseWithTemplateRules(sample, SKLAVENITIS_TEMPLATE_RULES, {
      id: "sklavenitis-gr",
      name: "Sklavenitis Greece",
      confidence: 0.99,
      vendorName: "Σκλαβενίτης",
    });
    assert.equal(templated.lines.length, 1);
    assert.equal(templated.savings, 1);
  });

  it("can be rebuilt from the generic template rules", () => {
    const draft = parseWithTemplateRules(SKLAVENITIS_WEIGHT_SAMPLE, SKLAVENITIS_TEMPLATE_RULES, {
      id: "sklavenitis-gr",
      name: "Sklavenitis Greece",
      confidence: 0.99,
      vendorName: "Σκλαβενίτης",
    });
    assert.equal(draft.total, 16.47);
    assert.equal(draft.lines.length, 10);
    assert.equal(draft.savings, 2.34);
    const cucumber = draft.lines.find((line) => line.description.includes("ΑΓΓΟΥΡΑΚΙΑ"));
    assert.ok(cucumber);
    assert.equal(cucumber.quantity, 0.616);
    assert.equal(cucumber.lineTotal, 0.62);
    assert.equal(cucumber.discount, 0.18);
  });
});

describe("auth and houses", () => {
  it("rejects unauthenticated access", async () => {
    const res = await request("/api/houses", { auth: "" });
    assert.equal(res.status, 401);
  });

  it("signs in with a username or an email", async () => {
    const registered = await request("/api/auth/register", {
      method: "POST",
      body: {
        name: "Username User",
        email: "user.name@example.com",
        username: "user.name",
        password: "test password",
      },
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.data.user.username, "user.name");

    const byUsername = await request("/api/auth/login", {
      method: "POST",
      body: { identifier: "USER.NAME", password: "test password" },
    });
    assert.equal(byUsername.status, 200);
    assert.equal(byUsername.data.user.username, "user.name");

    const byEmail = await request("/api/auth/login", {
      method: "POST",
      body: { email: "user.name@example.com", password: "test password" },
    });
    assert.equal(byEmail.status, 200);

    // Accounts registered before usernames existed get one derived from the email.
    const derived = await request("/api/auth/login", {
      method: "POST",
      body: { identifier: "owner", password: "test password" },
    });
    assert.equal(derived.status, 200);
    assert.equal(derived.data.user.username, "owner");
  });

  it("rejects duplicate usernames", async () => {
    const res = await request("/api/auth/register", {
      method: "POST",
      body: {
        name: "Another Owner",
        email: "another-owner@example.com",
        username: "owner",
        password: "test password",
      },
    });
    assert.equal(res.status, 409);
  });

  it("creates default places, categories and attributes", async () => {
    const locations = await request(`/api/houses/${houseId}/locations`);
    assert.equal(locations.status, 200);
    assert.ok(locations.data.length >= 6);

    const categories = await request(`/api/houses/${houseId}/categories`);
    assert.ok(categories.data.some((category: any) => category.name === "Food"));

    const attributes = await request(`/api/houses/${houseId}/attributes`);
    assert.ok(attributes.data.some((attribute: any) => attribute.key === "size"));
    assert.ok(!attributes.data.some((attribute: any) => attribute.key === "brand"));
  });

  it("keeps houses private", async () => {
    const res = await request(`/api/houses/${houseId}`, { auth: secondUserCookie });
    assert.equal(res.status, 404);
  });

  it("creates extra houses per user", async () => {
    const created = await request("/api/houses", { method: "POST", body: { name: "Cabin", kind: "cabin", currency: "EUR" } });
    assert.equal(created.status, 201);
    assert.equal(created.data.name, "Cabin");
    const list = await request("/api/houses");
    assert.equal(list.data.length, 2);
  });

  it("adds unique dynamic attributes", async () => {
    const attribute = await request(`/api/houses/${houseId}/attributes`, {
      method: "POST",
      body: { key: "flavour", label: "Flavour", type: "select", options: ["vanilla", "chocolate"] },
    });
    assert.equal(attribute.status, 201);
    const duplicate = await request(`/api/houses/${houseId}/attributes`, {
      method: "POST",
      body: { key: "flavour", label: "Other", type: "text" },
    });
    assert.equal(duplicate.status, 409);
  });

  it("rejects custom attributes that shadow built-in item fields", async () => {
    const res = await request(`/api/houses/${houseId}/attributes`, {
      method: "POST",
      body: { key: "brand", label: "Brand", type: "text" },
    });
    assert.equal(res.status, 400);
  });
});

describe("inventory and stock", () => {
  it("creates an item with attributes, barcode and initial stock", async () => {
    const locations = await request(`/api/houses/${houseId}/locations`);
    const fridge = locations.data.find((entry: any) => entry.name === "Fridge");
    const res = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: {
        name: "Milk",
        unit: "l",
        reorderPoint: 2,
        brand: "Acme",
        attributes: { flavour: "vanilla", brand: "Legacy" },
        tags: ["breakfast"],
        barcodes: [barcode],
        initialStock: { quantity: 1.5, unitPrice: 1.2, locationId: fridge.id, expiresAt: "2030-01-01" },
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.quantity, 1.5);
    assert.equal(res.data.attributes.flavour, "vanilla");
    assert.equal(res.data.attributes.brand, undefined);
    assert.equal(res.data.brand, "Acme");
    assert.equal(res.data.barcodes.length, 1);
    assert.equal(res.data.priceStats.latest, 1.2);
    itemId = res.data.id;
  });

  it("rejects duplicate barcodes", async () => {
    const res = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Other milk", unit: "l", barcodes: [barcode] },
    });
    assert.equal(res.status, 409);
  });

  it("scans barcodes locally", async () => {
    const res = await request(`/api/houses/${houseId}/scan?code=${barcode}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.match, "local");
    assert.equal(res.data.item.id, itemId);
  });

  it("adds stock in another unit and keeps price history", async () => {
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "add", quantity: 0.5, unit: "l", unitPrice: 0.8 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.quantity, 2);
    assert.equal(res.data.priceHistory.length, 2);
    assert.equal(res.data.priceHistory[1].price, 0.8);
  });

  it("consumes FIFO and recalculates totals", async () => {
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "remove", quantity: 1, reason: "Breakfast" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.quantity, 1);
    assert.equal(res.data.movements[0].type, "out");
  });

  it("cannot remove more than available", async () => {
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "remove", quantity: 99 },
    });
    assert.equal(res.status, 400);
  });

  it("adjusts to an absolute count", async () => {
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "set", target: 4 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.quantity, 4);
  });

  it("moves stock between places", async () => {
    const locations = await request(`/api/houses/${houseId}/locations`);
    const fridge = locations.data.find((entry: any) => entry.name === "Fridge");
    const pantry = locations.data.find((entry: any) => entry.name === "Pantry");
    // Put one unit in the fridge, then move it to the pantry.
    const added = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "add", quantity: 1, locationId: fridge.id },
    });
    assert.equal(added.status, 200);
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "move", quantity: 1, fromLocationId: fridge.id, toLocationId: pantry.id },
    });
    assert.equal(res.status, 200);
    const after = await request(`/api/items/${itemId}`);
    const atPantry = after.data.lots
      .filter((lot: any) => lot.locationId === pantry.id)
      .reduce((sum: number, lot: any) => sum + lot.quantity, 0);
    assert.equal(Math.round(atPantry * 1000) / 1000, 1);
  });

  it("creates low-stock reminders after a change", async () => {
    await request(`/api/items/${itemId}/stock`, { method: "POST", body: { action: "remove", quantity: 3 } });
    const res = await request(`/api/houses/${houseId}/notifications`);
    assert.ok(res.data.notifications.some((entry: any) => entry.type === "low_stock" && entry.data.itemId === itemId));
  });

  it("removes reminders when their item is deleted", async () => {
    const created = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: {
        name: "Reminder to delete",
        unit: "pcs",
        reorderPoint: 2,
        initialStock: { quantity: 1 },
      },
    });
    assert.equal(created.status, 201);
    const deletedItemId = created.data.id;

    const before = await request(`/api/houses/${houseId}/notifications`);
    assert.ok(before.data.notifications.some((entry: any) => entry.data.itemId === deletedItemId));

    const deleted = await request(`/api/items/${deletedItemId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);

    const after = await request(`/api/houses/${houseId}/notifications`);
    assert.ok(!after.data.notifications.some((entry: any) => entry.data.itemId === deletedItemId));
  });

  it("filters items by search and category", async () => {
    const bySearch = await request(`/api/houses/${houseId}/items?q=milk`);
    assert.equal(bySearch.data.items.length, 1);
    const byBarcode = await request(`/api/houses/${houseId}/items?q=${barcode}`);
    assert.equal(byBarcode.data.items.length, 1);
  });

  it("validates stock updates", async () => {
    const res = await request(`/api/items/${itemId}/stock`, { method: "POST", body: { action: "add", quantity: -1 } });
    assert.equal(res.status, 400);
    assert.equal(res.data.error, "Invalid request");
  });
});

describe("OpenFoodFacts links and shared catalogue", () => {
  const fetaCode = "5201704054183";
  const dodoniCode = "5201168218114";

  async function seedProduct(code: string, name: string, brand: string, quantity: string, image: string) {
    const timestamp = new Date().toISOString();
    const summary = {
      code,
      name,
      brand,
      genericName: `${name} PDO`,
      quantity,
      categories: ["cheeses", "feta"],
      image,
      ingredients: "milk, salt, rennet",
      allergens: ["milk"],
      labels: ["PDO"],
      nutriscore: "e",
      novaGroup: 3,
      countries: ["greece"],
      packaging: "plastic",
      servingSize: "30 g",
      nutrition: {
        energyKcal: 264,
        energyKj: 1104,
        fat: 21.3,
        saturatedFat: 14.9,
        carbohydrates: 0.5,
        sugars: 0.5,
        fiber: 0,
        proteins: 14.2,
        salt: 2.5,
        sodium: 1,
        basis: "100g",
        servingSize: "30 g",
        servingQuantity: 30,
        source: "openfoodfacts",
      },
      source: "openfoodfacts",
      fetchedAt: timestamp,
    };
    await run(
      `INSERT INTO catalog_products
         (code, name, brand, quantity, image, categories, summary, payload, source, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'openfoodfacts', ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name, brand = excluded.brand, quantity = excluded.quantity,
         image = excluded.image, categories = excluded.categories, summary = excluded.summary,
         source = excluded.source, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`,
      [code, name, brand, quantity, image, JSON.stringify(["cheeses", "feta"]), JSON.stringify(summary), timestamp, timestamp],
    );
  }

  before(async () => {
    await seedProduct(fetaCode, "Feta", "Kolios", "150 g", "https://example.test/feta.png");
    await seedProduct(dodoniCode, "Feta cheese (P.D.O.)", "Dodoni", "1 kg", "https://example.test/dodoni.png");
  });

  it("searches the shared cache without going online", async () => {
    const res = await request("/api/catalog/search?q=feta&online=0");
    assert.equal(res.status, 200);
    assert.equal(res.data.online, false);
    assert.equal(res.data.warning, null);
    assert.equal(res.data.warningCode, null);
    assert.ok(res.data.products.some((product: any) => product.code === fetaCode));
  });

  it("returns a stable code and human-readable warning for an empty online search", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://search.openfoodfacts.org/")) {
        return Promise.resolve(new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const res = await request("/api/catalog/search?q=svault-warning-contract-unique&online=1");
      assert.equal(res.status, 200);
      assert.equal(res.data.warningCode, "NOTHING_FOUND");
      assert.equal(res.data.warning, "Nothing found on OpenFoodFacts. Check the name or paste a barcode.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not warn when an online search has cached matches", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://search.openfoodfacts.org/")) {
        return Promise.resolve(new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const res = await request("/api/catalog/search?q=feta&online=1");
      assert.equal(res.status, 200);
      assert.equal(res.data.warning, null);
      assert.equal(res.data.warningCode, null);
      assert.ok(res.data.products.length > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves a cached product for an unknown barcode", async () => {
    const res = await request(`/api/houses/${houseId}/scan?code=${dodoniCode}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.match, "external");
    assert.equal(res.data.product.name, "Feta cheese (P.D.O.)");
    assert.equal(res.data.product.brand, "Dodoni");
  });

  it("links an item and fills only empty fields", async () => {
    const created = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "My feta", brand: "Local brand", unit: "pcs" },
    });
    assert.equal(created.status, 201);
    const linked = await request(`/api/items/${created.data.id}/off/link`, {
      method: "POST",
      body: { code: fetaCode },
    });
    assert.equal(linked.status, 200);
    assert.equal(linked.data.item.name, "My feta");
    assert.equal(linked.data.item.brand, "Local brand");
    assert.ok(linked.data.filled.includes("description"));
    assert.ok(linked.data.filled.includes("image"));
    assert.ok(linked.data.filled.includes("nutrition"));
    assert.equal(linked.data.item.nutrition.energyKcal, 264);
    assert.equal(linked.data.item.off.code, fetaCode);
    assert.equal(linked.data.item.off.product.brand, "Kolios");
    assert.ok(linked.data.item.barcodes.some((entry: any) => entry.code === fetaCode));

    const patched = await request(`/api/items/${created.data.id}`, {
      method: "PATCH",
      body: { brand: "Still local" },
    });
    assert.equal(patched.status, 200);
    const filled = await request(`/api/items/${created.data.id}/off/fill`, { method: "POST" });
    assert.equal(filled.status, 200);
    assert.equal(filled.data.item.brand, "Still local");
    assert.equal(filled.data.item.name, "My feta");
  });

  it("refuses to link the same OFF product to two items", async () => {
    const created = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Second feta", unit: "pcs" },
    });
    const linked = await request(`/api/items/${created.data.id}/off/link`, {
      method: "POST",
      body: { code: fetaCode },
    });
    assert.equal(linked.status, 409);
  });

  it("enriches a receipt-created item and learns a shared mapping", async () => {
    const receipt = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Lidl",
        currency: "EUR",
        lines: [
          {
            description: "ΦΕΤΑ ΔΩΔΩΝΗ 1KG",
            rawDescription: "ΦΕΤΑ ΔΩΔΩΝΗ 1KG",
            quantity: 1,
            unit: "pcs",
            unitPrice: 9.9,
            lineTotal: 9.9,
            offCode: dodoniCode,
          },
        ],
      },
    });
    assert.equal(receipt.status, 201);
    const line = receipt.data.lines[0];
    assert.equal(line.offCode, dodoniCode);
    const item = await request(`/api/items/${line.itemId}`);
    assert.equal(item.status, 200);
    assert.equal(item.data.name, "ΦΕΤΑ ΔΩΔΩΝΗ 1KG");
    assert.equal(item.data.brand, "Dodoni");
    assert.equal(item.data.off.code, dodoniCode);
    assert.ok(item.data.image?.startsWith("https://example.test/"));

    const mappings = await request(`/api/catalog/mappings?q=${encodeURIComponent("ΔΩΔΩΝΗ")}`);
    assert.ok(mappings.data.some((mapping: any) => mapping.offCode === dodoniCode));

    // A mapping learned from this house's receipt stays with this house. The
    // text above also has a bundled seed row (shared by design), so use a
    // shop shorthand that only this receipt teaches.
    const privateRaw = "DODONI HOUSE ONLY 1KG";
    const learned = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Lidl",
        currency: "EUR",
        purchasedAt: "2026-01-02",
        lines: [{ description: privateRaw, rawDescription: privateRaw, quantity: 1, unit: "pcs", lineTotal: 9.9, offCode: dodoniCode }],
      },
    });
    assert.equal(learned.status, 201);
    const { findCatalogMapping } = await import("../services/product-catalog.js");
    const own = await findCatalogMapping({ houseId, country: "GR", vendorName: "Lidl", rawDescription: privateRaw });
    assert.equal(own?.offCode, dodoniCode);
    const other = await findCatalogMapping({
      houseId: "hse_someoneelse",
      country: "GR",
      vendorName: "Lidl",
      rawDescription: privateRaw,
    });
    assert.equal(other, null);
  });

  it("exports and imports the catalogue", async () => {
    const exported = await request("/api/catalog/export");
    assert.equal(exported.status, 200);
    assert.ok(exported.data.mappings.some((mapping: any) => mapping.offCode === dodoniCode));

    const imported = await request("/api/catalog/import", {
      method: "POST",
      body: {
        version: 1,
        mappings: [
          {
            country: "GR",
            vendor: null,
            rawText: "TEST IMPORT PRODUCT",
            offCode: dodoniCode,
            name: "Imported feta",
            brand: "Dodoni",
          },
        ],
      },
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.data.imported, 1);
    const mappings = await request(`/api/catalog/mappings?q=${encodeURIComponent("TEST IMPORT PRODUCT")}`);
    assert.ok(mappings.data.some((mapping: any) => mapping.offCode === dodoniCode));
  });
});

describe("receipts and shops", () => {
  let receiptId = "";

  it("creates and lists shops", async () => {
    const created = await request(`/api/houses/${houseId}/vendors`, {
      method: "POST",
      body: { name: "Corner Market", kind: "supermarket", note: "Around the block" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.name, "Corner Market");

    const duplicate = await request(`/api/houses/${houseId}/vendors`, {
      method: "POST",
      body: { name: "corner market" },
    });
    assert.equal(duplicate.status, 409);

    const list = await request(`/api/houses/${houseId}/vendors`);
    assert.ok(list.data.some((vendor: any) => vendor.name === "Corner Market"));
  });

  it("suggests Greek shops and adds one from the catalogue", async () => {
    const suggestions = await request(`/api/houses/${houseId}/vendor-suggestions`);
    assert.equal(suggestions.status, 200);
    assert.equal(suggestions.data.country, "GR");
    assert.deepEqual(suggestions.data.countries.map((country: any) => country.code), ["GR"]);

    const sklavenitis = suggestions.data.entries.find((entry: any) => entry.name === "Σκλαβενίτης");
    assert.ok(sklavenitis);
    assert.equal(sklavenitis.kind, "supermarket");
    assert.equal(sklavenitis.added, false);

    const added = await request(`/api/houses/${houseId}/vendors`, {
      method: "POST",
      body: { catalogId: sklavenitis.id },
    });
    assert.equal(added.status, 201);
    assert.equal(added.data.name, "Σκλαβενίτης");
    assert.equal(added.data.kind, "supermarket");

    const duplicate = await request(`/api/houses/${houseId}/vendors`, {
      method: "POST",
      body: { catalogId: sklavenitis.id },
    });
    assert.equal(duplicate.status, 409);

    const refreshed = await request(`/api/houses/${houseId}/vendor-suggestions`);
    assert.equal(refreshed.data.entries.find((entry: any) => entry.id === sklavenitis.id).added, true);
  });

  it("parses a receipt locally without an AI provider", async () => {
    const res = await request(`/api/houses/${houseId}/receipts/scan`, {
      method: "POST",
      body: {
        text: [
          "CORNER MARKET",
          "12/10/2026",
          "Milk 1.5 l 2.40",
          "SOURDOUGH BREAD 3.10",
          "TOTAL 5.50",
        ].join("\n"),
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "local");
    assert.ok(res.data.warning.includes("No AI provider"));
    assert.equal(res.data.draft.vendorName, "Corner Market");
    assert.equal(res.data.draft.purchasedAt, "2026-10-12");
    assert.equal(res.data.draft.total, 5.5);
    assert.equal(res.data.draft.lines.length, 2);
    assert.equal(res.data.draft.lines[0].description, "Milk");
    assert.equal(res.data.draft.lines[0].quantity, 1.5);
    assert.equal(res.data.draft.lines[0].unit, "l");
    assert.equal(res.data.draft.lines[0].unitPrice, 1.6);
  });

  it("pulls a known shop from the receipt header", async () => {
    const res = await request(`/api/houses/${houseId}/receipts/scan`, {
      method: "POST",
      body: { text: "LIDL HELLAS\n12/10/2026\nMilk 1.5 l 2.40\nTOTAL 2.40" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.draft.vendorName, "Lidl");
  });

  it("uses the Lidl template on a full Lidl receipt", async () => {
    const res = await request(`/api/houses/${houseId}/receipts/scan`, {
      method: "POST",
      body: { text: LIDL_SAMPLE },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "template");
    assert.equal(res.data.draft.templateId, "lidl-gr");
    assert.equal(res.data.draft.lines.length, 5);
    assert.equal(res.data.draft.total, 10.73);
    assert.equal(res.data.draft.tax, 1.4);
  });

  it("uses the Sklavenitis template on a full Sklavenitis receipt", async () => {
    const res = await request(`/api/houses/${houseId}/receipts/scan`, {
      method: "POST",
      body: { text: SKLAVENITIS_SAMPLE },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "template");
    assert.equal(res.data.draft.templateId, "sklavenitis-gr");
    assert.equal(res.data.draft.vendorName, "Σκλαβενίτης");
    assert.equal(res.data.draft.lines.length, 12);
    assert.equal(res.data.draft.total, 24.02);
    assert.equal(res.data.draft.lines[0].barcode, "5208046287576");
  });

  it("imports a Sklavenitis scan draft into stock", async () => {
    const scan = await request(`/api/houses/${houseId}/receipts/scan`, {
      method: "POST",
      body: { text: SKLAVENITIS_SAMPLE },
    });
    assert.equal(scan.status, 200);
    const draft = scan.data.draft;
    const res = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorName: draft.vendorName,
        purchasedAt: draft.purchasedAt,
        currency: draft.currency,
        total: draft.total,
        subtotal: draft.subtotal,
        tax: draft.tax,
        taxBreakdown: draft.taxBreakdown,
        scanId: scan.data.scanId,
        savings: draft.savings,
        ocrText: SKLAVENITIS_SAMPLE,
        lines: draft.lines.map((line: any) => ({
          description: line.description,
          rawDescription: line.rawDescription,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
          taxRate: line.taxRate,
          discount: line.discount,
          barcode: line.barcode,
        })),
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.vendorName, "Σκλαβενίτης");
    assert.equal(res.data.provider, "template");
    assert.equal(res.data.savings, 5.82);
    assert.equal(res.data.lines.length, 12);
  });

  it("normalizes oversized and out-of-range receipt lines instead of rejecting them", async () => {
    const longText = "x".repeat(400);
    const res = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Normalize Mart",
        purchasedAt: "2026-10-12",
        currency: "EUR",
        total: 1,
        lines: [
          {
            description: longText,
            rawDescription: longText,
            quantity: 0,
            unit: "kgkgkgkgkgkg",
            unitPrice: -2,
            lineTotal: -3,
            taxRate: 150,
            discount: -4,
            barcode: "9".repeat(100),
          },
        ],
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const line = res.data.lines[0];
    assert.equal(line.description.length, 160);
    assert.equal(line.rawDescription.length, 200);
    assert.equal(line.quantity, 1);
    assert.equal(line.unit, "kgkgkgkgkg");
    assert.equal(line.unitPrice, 0);
    assert.equal(line.lineTotal, 0);
    assert.equal(line.taxRate, 100);
    assert.equal(line.discount, 0);
    assert.equal(line.barcode.length, 80);
  });

  it("imports a receipt into stock, matching and creating items", async () => {
    const before = await request(`/api/items/${itemId}`);
    const res = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Corner Market",
        purchasedAt: "2026-10-12",
        currency: "EUR",
        total: 5.5,
        ocrText: "CORNER MARKET\nMilk 1.5 l 2.40\nSOURDOUGH BREAD 3.10",
        provider: "ai",
        aiCost: 0.0012,
        lines: [
          { description: "Milk", quantity: 2, unit: "l", unitPrice: 1.2, lineTotal: 2.4 },
          { description: "Sourdough bread", quantity: 1, unitPrice: 3.1, lineTotal: 3.1 },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.vendorName, "Corner Market");
    assert.equal(res.data.lines.length, 2);
    // Provenance comes from a server-side scan record; client-sent values are ignored.
    assert.equal(res.data.provider, null);
    assert.equal(res.data.aiCost, null);
    assert.equal(res.data.lines[0].itemName, "Milk");
    assert.equal(res.data.lines[1].itemName, "Sourdough bread");
    receiptId = res.data.id;

    const after = await request(`/api/items/${itemId}`);
    assert.equal(after.data.quantity, before.data.quantity + 2);
    const vendorLot = after.data.lots.find((lot: any) => lot.vendorName === "Corner Market" && lot.quantity === 2);
    assert.ok(vendorLot, "the new batch remembers the shop");
    assert.equal(vendorLot.receiptId, receiptId);
    assert.equal(vendorLot.purchasedAt, "2026-10-12");

    const purchase = after.data.priceHistory.find((point: any) => point.receiptId === receiptId);
    assert.ok(purchase, "the purchase appears in the item price history");
    assert.equal(purchase.vendorName, "Corner Market");
    assert.equal(purchase.quantity, 2);
    assert.equal(purchase.unitPrice, 1.2);

    const newItem = await request(`/api/houses/${houseId}/items?q=sourdough`);
    assert.equal(newItem.data.items.length, 1);
    assert.equal(newItem.data.items[0].unit, "pcs");
    assert.equal(newItem.data.items[0].quantity, 1);
  });

  it("reuses the catalog shop when a receipt prints its local name", async () => {
    const res = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorName: "SKLAVENITIS",
        purchasedAt: "2026-10-14",
        currency: "EUR",
        lines: [{ description: "Olive oil", quantity: 1, unitPrice: 7.5, lineTotal: 7.5 }],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.vendorName, "Σκλαβενίτης");

    const shops = await request(`/api/houses/${houseId}/vendors`);
    const matches = shops.data.filter((vendor: any) => vendor.name === "Σκλαβενίτης");
    assert.equal(matches.length, 1);
  });

  it("learns product aliases from corrected Lidl lines", async () => {
    const flour = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Lidl flour", unit: "kg" },
    });
    assert.equal(flour.status, 201);
    const flourId = flour.data.id;

    const first = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Lidl",
        purchasedAt: "2026-10-16",
        currency: "EUR",
        total: 3.1,
        lines: [
          {
            description: "ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG",
            rawDescription: "ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG",
            quantity: 1.036,
            unit: "kg",
            unitPrice: 2.99,
            lineTotal: 3.1,
            itemId: flourId,
          },
        ],
      },
    });
    assert.equal(first.status, 201);
    assert.equal(first.data.lines[0].itemId, flourId);
    assert.equal(first.data.lines[0].rawDescription, "ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG");

    const second = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Lidl",
        purchasedAt: "2026-10-17",
        currency: "EUR",
        total: 3.1,
        lines: [
          {
            description: "ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG",
            rawDescription: "ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG -0523350",
            quantity: 1.036,
            unit: "kg",
            unitPrice: 2.99,
            lineTotal: 3.1,
          },
        ],
      },
    });
    assert.equal(second.status, 201);
    assert.equal(second.data.lines[0].itemId, flourId);
    assert.equal(second.data.lines[0].itemName, "Lidl flour");

    const detail = await request(`/api/items/${flourId}`);
    assert.equal(detail.data.quantity, 2.072);
    assert.equal(detail.data.priceHistory.length, 2);
    assert.ok(detail.data.priceHistory.every((point: any) => point.vendorName === "Lidl"));

    const aliasList = await request(`/api/items/${flourId}/aliases`);
    assert.equal(aliasList.status, 200);
    assert.equal(aliasList.data.length, 1);
    assert.ok(String(aliasList.data[0].rawName).includes("ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG"));

    const extraAlias = await request(`/api/items/${flourId}/aliases`, {
      method: "POST",
      body: { rawName: "LIDL FLOUR 1KG" },
    });
    assert.equal(extraAlias.status, 201);
    const twoAliases = await request(`/api/items/${flourId}/aliases`);
    assert.equal(twoAliases.data.length, 2);

    const lidl = (await request(`/api/houses/${houseId}/vendors`)).data.find((vendor: any) => vendor.name === "Lidl");
    const suggestions = await suggestProductMatches(houseId, lidl.id, "ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG");
    assert.equal(suggestions[0].itemId, flourId);
    assert.equal(suggestions[0].source, "alias");
    assert.ok(suggestions[0].score >= 0.99);

    const fuzzy = await suggestProductMatches(houseId, lidl.id, "FLOUR LIDL");
    assert.ok(fuzzy.some((entry) => entry.itemId === flourId && entry.score >= 0.7));

    const scan = await request(`/api/houses/${houseId}/receipts/scan`, {
      method: "POST",
      body: { text: LIDL_SAMPLE },
    });
    const flourLine = scan.data.draft.lines.find((line: any) => line.description.includes("ΑΛΕΞ"));
    assert.ok(flourLine);
    assert.equal(flourLine.suggestedItemId, flourId);
    assert.ok(flourLine.suggestedItemScore >= 0.99);
  });

  it("stores tax splits and reports spending analytics", async () => {
    const created = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Analytics Mart",
        purchasedAt: "2026-10-15",
        currency: "EUR",
        total: 12.4,
        subtotal: 10,
        tax: 2.4,
        taxBreakdown: [{ rate: 24, net: 10, tax: 2.4, gross: 12.4 }],
        lines: [{ description: "Analytics item", quantity: 1, unitPrice: 12.4, lineTotal: 12.4 }],
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.subtotal, 10);
    assert.equal(created.data.tax, 2.4);
    assert.equal(created.data.taxBreakdown[0].rate, 24);

    const analytics = await request(`/api/houses/${houseId}/purchases/analytics`);
    assert.equal(analytics.status, 200);
    assert.ok(analytics.data.totals.receipts >= 2);
    assert.ok(analytics.data.totals.tax >= 2.4);
    assert.ok(analytics.data.totals.savings >= 5.82);
    const vendor = analytics.data.byVendor.find((entry: any) => entry.vendorName === "Analytics Mart");
    assert.ok(vendor);
    assert.equal(vendor.total, 12.4);
    assert.equal(vendor.net, 10);
    assert.equal(vendor.tax, 2.4);
    const vat = analytics.data.taxRates.find((entry: any) => entry.rate === 24);
    assert.ok(vat);
    assert.equal(vat.tax, 2.4);
    assert.ok(analytics.data.monthly.some((entry: any) => entry.month === "2026-10"));
    assert.ok(analytics.data.byCategory.some((entry: any) => entry.categoryName === "Uncategorised"));
  });

  it("creates, tests, scans with and deletes a custom template", async () => {
    const sample = [
      "TEST MART",
      "ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ",
      "MILK 1.50 13%",
      "BREAD 2.00 13%",
      "ΣΥΝΟΛΟ 3.50",
    ].join("\n");
    const rules = {
      keywords: ["TEST MART"],
      threshold: 0.7,
      sections: { start: ["ΦΟΡΟΛΟΓΙΚΗ"], end: ["^ΣΥΝΟΛΟ"] },
      product: {
        pattern: "^(?<name>.+?)\\s+(?<total>\\d+[.,]\\d{2})\\s+(?<rate>\\d{1,2})\\s*%$",
        ignore: [],
      },
      total: { pattern: "^ΣΥΝΟΛΟ" },
    };

    const test = await request(`/api/houses/${houseId}/receipt-templates/test`, {
      method: "POST",
      body: { rules, text: sample, name: "Test Mart", vendorName: "Test Mart" },
    });
    assert.equal(test.status, 200);
    assert.equal(test.data.draft.lines.length, 2);
    assert.equal(test.data.draft.total, 3.5);
    assert.ok(test.data.template.confidence >= 0.7);

    const created = await request(`/api/houses/${houseId}/receipt-templates`, {
      method: "POST",
      body: { name: "Test Mart", country: "GR", vendorName: "Test Mart", active: true, rules },
    });
    assert.equal(created.status, 201);
    const templateId = created.data.id;
    assert.equal(created.data.builtIn, false);

    const list = await request(`/api/houses/${houseId}/receipt-templates`);
    assert.ok(list.data.some((entry: any) => entry.id === "lidl-gr" && entry.builtIn));
    assert.ok(list.data.some((entry: any) => entry.id === "sklavenitis-gr" && entry.builtIn));
    assert.ok(list.data.some((entry: any) => entry.id === templateId));

    const scan = await request(`/api/houses/${houseId}/receipts/scan`, { method: "POST", body: { text: sample } });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "template");
    assert.equal(scan.data.draft.templateId, templateId);
    assert.equal(scan.data.draft.lines.length, 2);

    const updated = await request(`/api/houses/${houseId}/receipt-templates/${templateId}`, {
      method: "PATCH",
      body: { name: "Test Mart v2", active: false },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.name, "Test Mart v2");
    assert.equal(updated.data.active, false);
    assert.equal(updated.data.version, 2);

    const removed = await request(`/api/houses/${houseId}/receipt-templates/${templateId}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const after = await request(`/api/houses/${houseId}/receipt-templates`);
    assert.ok(!after.data.some((entry: any) => entry.id === templateId));
  });

  it("lists receipts and exposes their lines", async () => {
    const list = await request(`/api/houses/${houseId}/receipts`);
    assert.equal(list.status, 200);
    const summary = list.data.find((entry: any) => entry.id === receiptId);
    assert.ok(summary);
    assert.equal(summary.lineCount, 2);
    assert.equal(summary.total, 5.5);

    const detail = await request(`/api/receipts/${receiptId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.lines.length, 2);
    assert.equal(detail.data.lines[0].unitPrice, 1.2);
    assert.ok(detail.data.image === null);

    const vendors = await request(`/api/houses/${houseId}/vendors`);
    const corner = vendors.data.find((vendor: any) => vendor.name === "Corner Market");
    assert.ok(corner.purchaseCount >= 2);
  });

  it("keeps stock when a receipt record is deleted", async () => {
    const created = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      body: {
        vendorId: (await request(`/api/houses/${houseId}/vendors`)).data[0].id,
        purchasedAt: "2026-10-13",
        currency: "EUR",
        lines: [{ description: "Milk", quantity: 1, unit: "l", unitPrice: 1.1, lineTotal: 1.1 }],
      },
    });
    assert.equal(created.status, 201);
    const stockBefore = (await request(`/api/items/${itemId}`)).data.quantity;

    const removed = await request(`/api/receipts/${created.data.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);

    const stockAfter = (await request(`/api/items/${itemId}`)).data.quantity;
    assert.equal(stockAfter, stockBefore);
    const detail = await request(`/api/receipts/${created.data.id}`);
    assert.equal(detail.status, 404);
  });
});

describe("recipes", () => {
  it("parses a scan without an AI provider", async () => {
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n\nIngredients\n2 eggs\n100 g flour\n\nMethod\n1. Mix.\n2. Fry for 5 minutes." },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "local");
    assert.ok(res.data.warning.includes("No AI provider"));
    assert.equal(res.data.draft.ingredients.length, 2);
  });

  it("saves recipes and matches stock", async () => {
    const res = await request(`/api/houses/${houseId}/recipes`, {
      method: "POST",
      body: {
        title: "Pancakes",
        steps: [{ text: "Mix" }, { text: "Fry" }],
        ingredients: [
          { name: "Milk", quantity: 0.2, unit: "l" },
          { name: "Sugar", quantity: 10, unit: "g" },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.match.available, 1);
    assert.equal(res.data.match.total, 2);
  });

  it("rejects AI completion without config", async () => {
    const list = await request(`/api/houses/${houseId}/recipes`);
    const res = await request(`/api/recipes/${list.data[0].id}/ai`, { method: "POST", body: { action: "complete" } });
    assert.equal(res.status, 400);
  });

  it("patches every recipe field", async () => {
    const list = await request(`/api/houses/${houseId}/recipes`);
    const id = list.data[0].id;
    const res = await request(`/api/recipes/${id}`, {
      method: "PATCH",
      body: {
        servings: 10,
        description: "Updated description",
        prepMinutes: 12,
        cookMinutes: 34,
        tags: "edited, breakfast",
        favorite: true,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.servings, 10);
    assert.equal(res.data.description, "Updated description");
    assert.equal(res.data.prepMinutes, 12);
    assert.equal(res.data.cookMinutes, 34);
    assert.deepEqual(res.data.tags, ["edited", "breakfast"]);
    assert.equal(res.data.favorite, true);
    assert.equal(res.data.ingredients.length, list.data[0].ingredients.length);
  });

  it("estimates nutrition per recipe and portion", async () => {
    const flour = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: {
        name: "Nutrition flour",
        unit: "g",
        nutrition: {
          basis: "100g",
          energyKcal: 364,
          energyKj: 1523,
          fat: 1,
          saturatedFat: 0.2,
          carbohydrates: 76,
          sugars: 0.3,
          fiber: 2.7,
          proteins: 10,
          salt: 0.01,
          sodium: 0.004,
          servingSize: "100 g",
          servingQuantity: 100,
        },
      },
    });
    assert.equal(flour.status, 201);
    assert.equal(flour.data.nutrition.energyKcal, 364);
    assert.equal(flour.data.nutrition.source, "manual");

    const recipe = await request(`/api/houses/${houseId}/recipes`, {
      method: "POST",
      body: {
        title: "Nutrition pancakes",
        servings: 2,
        ingredients: [
          { name: "Nutrition flour", quantity: 200, unit: "g" },
          { name: "Something without nutrition", quantity: 1, unit: "pcs" },
        ],
      },
    });
    assert.equal(recipe.status, 201);
    assert.ok(recipe.data.nutrition);
    assert.equal(recipe.data.nutrition.total.energyKcal, 728);
    assert.equal(recipe.data.nutrition.perServing.energyKcal, 364);
    assert.equal(recipe.data.nutrition.matched, 1);
    assert.equal(recipe.data.nutrition.ingredients, 2);
    assert.equal(recipe.data.nutrition.coverage, 0.5);
  });
});

describe("ideas", () => {
  it("falls back to local suggestions", async () => {
    const res = await request(`/api/houses/${houseId}/ideas`, { method: "POST", body: { prompt: "quick" } });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "local");
    assert.ok(Array.isArray(res.data.ideas));
    assert.ok(res.data.ideas.length > 0);
  });
});

describe("ai integration", () => {
  it("saves a per-house provider and masks the key", async () => {
    const res = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: { ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model" } },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.settings.ai.apiKey, "***");
    assert.equal(res.data.settings.ai.model, "mock-model");
  });

  it("cleans scans through the provider", async () => {
    aiRequests.length = 0;
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "ai");
    assert.equal(res.data.draft.title, "AI pancakes");
    assert.equal(res.data.aiCost, 0.00125);
    assert.equal(res.data.draft.aiCost, 0.00125);
    assert.equal(res.data.warning, null);
    assert.ok(aiRequests.some((entry) => entry.headers.authorization === "Bearer test-key"));
  });

  it("reads receipts through the provider", async () => {
    aiRequests.length = 0;
    const res = await request(`/api/houses/${houseId}/receipts/scan`, {
      method: "POST",
      body: { text: "MOCK MART\nMilk 2 x 1.20\nTOTAL 2.40", preferAi: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "ai");
    assert.equal(res.data.draft.vendorName, "Mock Mart");
    assert.equal(res.data.aiCost, 0.00125);
    assert.equal(res.data.draft.lines.length, 2);
    assert.ok(aiRequests.some((entry) => entry.headers.authorization === "Bearer test-key"));
  });

  it("tests the saved connection", async () => {
    const res = await request(`/api/houses/${houseId}/ai/test`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.model, "mock-model");
  });

  it("records successful and failed AI calls for the developer page", async () => {
    const setup = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model" } } },
    });
    assert.equal(setup.status, 200);

    const me = await request("/api/auth/me", { method: "PATCH", body: { developerMode: true } });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.developerMode, true);

    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");

    const page = await request(`/api/houses/${houseId}/ai/logs?scope=mine`);
    assert.equal(page.status, 200);
    assert.ok(page.data.logs.length > 0);
    assert.equal(page.data.logs[0].operation, "recipe.scan");
    assert.equal(page.data.logs[0].status, "ok");
    assert.equal(page.data.logs[0].model, "mock-model");
    assert.equal(page.data.logs[0].cost, 0.00125);
    assert.ok(page.data.logs[0].totalTokens > 0);
    assert.ok(page.data.summary.calls >= 1);

    const detail = await request(`/api/houses/${houseId}/ai/logs/${page.data.logs[0].id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.data.requestPreview.includes("flour eggs milk"));
    assert.ok(detail.data.responsePreview.includes("AI pancakes"));
    assert.equal(detail.data.metadata.json, true);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { baseUrl: "http://127.0.0.1:1/v1" } } },
    });
    const failedScan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk" },
    });
    assert.equal(failedScan.status, 200);
    assert.equal(failedScan.data.provider, "local");

    const failures = await request(`/api/houses/${houseId}/ai/logs?scope=mine&status=error`);
    assert.equal(failures.status, 200);
    assert.ok(
      failures.data.logs.some(
        (entry: any) => entry.operation === "recipe.scan" && entry.status === "error" && entry.error,
      ),
    );

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { baseUrl: aiBase, apiKey: "test-key", model: "mock-model" } } },
    });
  });

  it("hides the AI log when developer mode is off", async () => {
    await request("/api/auth/me", { method: "PATCH", body: { developerMode: false } });
    const res = await request(`/api/houses/${houseId}/ai/logs`);
    assert.equal(res.status, 403);
    await request("/api/auth/me", { method: "PATCH", body: { developerMode: true } });
  });

  it("estimates the price from configured token prices when the provider omits it", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "priced-model", inputPrice: 1, outputPrice: 2 } } },
    });
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "ai");
    assert.equal(res.data.aiCost, 0.002);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", inputPrice: null, outputPrice: null } } },
    });
  });

  it("only sends scan images when a vision model is configured", async () => {
    const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
    const bytes = new ArrayBuffer(png.length);
    new Uint8Array(bytes).set(png);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "card.png");
    const upload = await fetch(`${base}/api/houses/${houseId}/recipes/upload`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    assert.equal(upload.status, 201);
    const { path: imagePath } = await upload.json();
    assert.ok(imagePath.startsWith("/uploads/recipes/"));

    aiRequests.length = 0;
    const withoutVision = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk", image: imagePath },
    });
    assert.equal(withoutVision.status, 200);
    assert.equal(withoutVision.data.provider, "ai");
    assert.equal(typeof aiRequests[0].body.messages[1].content, "string");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { visionModel: "mock-vision" } } },
    });
    aiRequests.length = 0;
    const withVision = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk", image: imagePath },
    });
    assert.equal(withVision.data.provider, "ai");
    const content = aiRequests[0].body.messages[1].content;
    assert.ok(Array.isArray(content));
    assert.ok(content.some((part: any) => part.type === "image_url"));

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { visionModel: null } } },
    });
    const noText = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { image: imagePath },
    });
    assert.equal(noText.data.provider, "local");
    assert.match(noText.data.warning, /vision-capable model/);
  });

  it("generates ideas through the provider", async () => {
    const res = await request(`/api/houses/${houseId}/ideas`, { method: "POST", body: { prompt: "dinner" } });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "ai");
    assert.equal(res.data.ideas[0].title, "Mock soup");
  });

  it("completes a recipe through the provider", async () => {
    const list = await request(`/api/houses/${houseId}/recipes`);
    const res = await request(`/api/recipes/${list.data[0].id}/ai`, { method: "POST", body: { action: "complete" } });
    assert.equal(res.status, 200);
    assert.equal(res.data.title, "Pancakes improved");
    assert.equal(res.data.aiNotes, "completed by mock");
    assert.equal(res.data.aiCost, 0.00125);
    assert.ok(res.data.steps.length >= 2);
  });

  it("falls back to local parsing when the provider is unreachable", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { enabled: true, baseUrl: "http://127.0.0.1:1/v1", apiKey: "bad", model: "x" } } },
    });
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\nIngredients\n2 eggs\nMethod\n1. Fry." },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "local");
    assert.ok(res.data.warning?.includes("AI cleanup failed"));
  });
});

describe("photos and datasets", () => {
  let photoId = "";

  it("creates folders", async () => {
    const res = await request(`/api/houses/${houseId}/collections`, { method: "POST", body: { name: "Shelf" } });
    assert.equal(res.status, 201);
  });

  it("uploads a photo and labels it", async () => {
    const png = encodePng(8, 8, Buffer.alloc(8 * 8 * 4, 220));
    const imageBytes = new ArrayBuffer(png.length);
    new Uint8Array(imageBytes).set(png);
    const form = new FormData();
    form.append("photos", new Blob([imageBytes], { type: "image/png" }), "unit.png");
    form.append("meta", JSON.stringify([{ width: 8, height: 8, originalName: "unit.png" }]));
    const upload = await fetch(`${base}/api/houses/${houseId}/photos`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    assert.equal(upload.status, 201);
    const body = await upload.json();
    photoId = body.photos[0].id;
    assert.ok(photoId);

    const label = await request(`/api/photos/${photoId}/labels`, {
      method: "POST",
      body: { label: "milk", x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
    });
    assert.equal(label.status, 201);

    const split = await request(`/api/photos/${photoId}`, { method: "PATCH", body: { split: "train" } });
    assert.equal(split.status, 200);
    assert.equal(split.data.split, "train");
  });

  it("exports an empty dataset", async () => {
    const res = await fetch(`${base}/api/houses/${houseId}/photos/export?format=yolo`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
  });

  it("exports images, labels and classes as a YOLO zip", async () => {
    const res = await fetch(`${base}/api/houses/${houseId}/photos/export?format=yolo`, { headers: { cookie } });
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    assert.ok(zip.file("svault-dataset/classes.txt"));
    assert.ok(zip.file("svault-dataset/data.yaml"));
    assert.ok(zip.file("svault-dataset/manifest.csv"));
    assert.ok(zip.file("svault-dataset/annotations.coco.json"));
    const labelFile = zip.file(/svault-dataset\/labels\/train\/.+\.txt/)[0];
    assert.ok(labelFile, "a training label file exists");
    const labelText = await labelFile.async("string");
    assert.match(labelText.trim(), /^0 0\.300000 0\.250000 0\.400000 0\.300000$/);
    const images = zip.file(/svault-dataset\/images\/train\/.+\.png/);
    assert.ok(images.length >= 1);

    const cocoRes = await fetch(`${base}/api/houses/${houseId}/photos/export?format=coco`, { headers: { cookie } });
    const cocoZip = await JSZip.loadAsync(Buffer.from(await cocoRes.arrayBuffer()));
    const cocoFile = cocoZip.file("svault-dataset/annotations.coco.json");
    assert.ok(cocoFile);
    const coco = JSON.parse(await cocoFile.async("string"));
    assert.equal(coco.categories[0].name, "milk");
    assert.equal(coco.annotations[0].bbox.length, 4);
  });
});

describe("dashboard", () => {
  it("summarises stock with batch counts", async () => {
    const res = await request(`/api/houses/${houseId}/dashboard`);
    assert.equal(res.status, 200);
    assert.ok(res.data.itemCount >= 1);
    assert.ok(res.data.batchCount >= 1);
    assert.ok(Array.isArray(res.data.lowStock));
  });
});

describe("web shell", () => {
  it("serves the SPA for client routes", async () => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);
    const deep = await fetch(`${base}/items/new`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /<div id="root">/);
  });
});

describe("multi-user membership", () => {
  it("invites and joins a house by link", async () => {
    const invite = await request(`/api/houses/${houseId}/members`, {
      method: "POST",
      body: { email: "stranger@example.com", role: "viewer" },
    });
    assert.equal(invite.status, 201);
    // Existing accounts get an invite to accept instead of being added silently.
    assert.ok(invite.data.invite);
    assert.equal(invite.data.invite.existingAccount, true);
    assert.equal((await request(`/api/houses/${houseId}`, { auth: secondUserCookie })).status, 404);
    const accepted = await request(`/api/auth/invites/${invite.data.invite.code}/accept`, {
      method: "POST",
      auth: secondUserCookie,
    });
    assert.equal(accepted.status, 200);

    const access = await request(`/api/houses/${houseId}`, { auth: secondUserCookie });
    assert.equal(access.status, 200);
    assert.equal(access.data.role, "viewer");

    const houseReminders = await request(`/api/houses/${houseId}/notifications`, { auth: secondUserCookie });
    assert.ok(
      houseReminders.data.notifications.some(
        (entry: any) => entry.type === "house" && entry.data.houseId === houseId,
      ),
    );

    const globalReminders = await request("/api/notifications", { auth: secondUserCookie });
    assert.ok(
      globalReminders.data.notifications.some(
        (entry: any) => entry.type === "house" && entry.houseId === houseId && entry.houseName,
      ),
    );

    const forbidden = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      auth: secondUserCookie,
      body: { name: "Sneaky item" },
    });
    assert.equal(forbidden.status, 403);

    const forbiddenReceipt = await request(`/api/houses/${houseId}/receipts`, {
      method: "POST",
      auth: secondUserCookie,
      body: { vendorName: "Nowhere", lines: [{ description: "Ghost", quantity: 1 }] },
    });
    assert.equal(forbiddenReceipt.status, 403);
  });

  it("prevents the owner from being removed", async () => {
    const house = await request(`/api/houses/${houseId}`);
    const owner = house.data.members.find((member: any) => member.role === "owner");
    const res = await request(`/api/houses/${houseId}/members/${owner.id}`, { method: "DELETE" });
    assert.equal(res.status, 400);
  });
});

describe("security hardening", () => {
  let strangerHouseId = "";

  before(async () => {
    const me = await request("/api/auth/me", { auth: secondUserCookie });
    strangerHouseId = me.data.houses.find((house: any) => house.role === "owner").id;
  });

  it("limits backup and restore to the instance administrator", async () => {
    // Every user owns a house, so house ownership alone must not unlock a whole-instance backup.
    const download = await request(`/api/houses/${strangerHouseId}/backup`, { auth: secondUserCookie });
    assert.equal(download.status, 403);
    const list = await request(`/api/houses/${strangerHouseId}/backups`, { auth: secondUserCookie });
    assert.equal(list.status, 403);
    const form = new FormData();
    form.append("backup", new Blob([Buffer.from("not a zip")], { type: "application/zip" }), "backup.zip");
    form.append("houseName", "whatever");
    const restore = await fetch(`${base}/api/houses/${strangerHouseId}/restore`, {
      method: "POST",
      headers: { cookie: secondUserCookie },
      body: form,
    });
    assert.equal(restore.status, 403);

    const adminList = await request(`/api/houses/${houseId}/backups`);
    assert.equal(adminList.status, 200);
  });

  async function uploadImage(path: string, bytes: Uint8Array, type: string, name: string, auth = cookie) {
    const copy = new ArrayBuffer(bytes.length);
    new Uint8Array(copy).set(bytes);
    const form = new FormData();
    form.append("image", new Blob([copy], { type }), name);
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { cookie: auth }, body: form });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }

  it("only stores real images under their mapped extension", async () => {
    const html = Buffer.from("<html><script>alert(document.cookie)</script></html>");
    const spoofed = await uploadImage(`/api/houses/${houseId}/recipes/upload`, html, "image/png", "evil.html");
    assert.equal(spoofed.status, 400);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const vector = await uploadImage(`/api/houses/${houseId}/recipes/upload`, svg, "image/svg+xml", "evil.svg");
    assert.equal(vector.status, 400);
    const unknown = await uploadImage(`/api/houses/${houseId}/recipes/upload`, html, "image/x-html", "evil.html");
    assert.equal(unknown.status, 400);

    const png = encodePng(4, 4, Buffer.alloc(4 * 4 * 4, 90));
    const ok = await uploadImage(`/api/houses/${houseId}/recipes/upload`, new Uint8Array(png), "image/png", "photo.html");
    assert.equal(ok.status, 201);
    assert.match(ok.data.path, /^\/uploads\/recipes\/[\w-]+\.png$/);
    const served = await fetch(`${base}${ok.data.path}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(served.headers.get("content-disposition"), null);
  });

  it("serves non-image files under /uploads as sandboxed downloads", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.join(dataDir, "uploads", "recipes"), { recursive: true });
    writeFileSync(path.join(dataDir, "uploads", "recipes", "legacy.html"), "<script>alert(1)</script>");
    const res = await fetch(`${base}/uploads/recipes/legacy.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-disposition"), "attachment");
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);
  });

  it("checks house access before accepting any upload bytes", async () => {
    const { readdirSync } = await import("node:fs");
    const count = (dir: string) => readdirSync(path.join(dataDir, "uploads", dir)).length;
    const png = new Uint8Array(encodePng(4, 4, Buffer.alloc(4 * 4 * 4, 30)));
    const before = { recipes: count("recipes"), receipts: count("receipts"), items: count("items") };

    const recipe = await uploadImage(`/api/houses/${houseId}/recipes/upload`, png, "image/png", "a.png", secondUserCookie);
    assert.equal(recipe.status, 403);
    const receipt = await uploadImage(`/api/houses/${houseId}/receipts/upload`, png, "image/png", "a.png", secondUserCookie);
    assert.equal(receipt.status, 403);
    const intake = await uploadImage(`/api/houses/${houseId}/intake/upload`, png, "image/png", "a.png", secondUserCookie);
    assert.equal(intake.status, 403);
    const item = await uploadImage(`/api/items/${itemId}/image`, png, "image/png", "a.png", secondUserCookie);
    assert.equal(item.status, 403);
    const outsider = await uploadImage(`/api/houses/${strangerHouseId}/recipes/upload`, png, "image/png", "a.png");
    assert.equal(outsider.status, 404);
    assert.deepEqual({ recipes: count("recipes"), receipts: count("receipts"), items: count("items") }, before);

    const form = new FormData();
    form.append("dataset", new Blob([Buffer.from("PK not really")], { type: "application/zip" }), "d.zip");
    const dataset = await fetch(`${base}/api/houses/${strangerHouseId}/photos/dataset/import`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    assert.equal(dataset.status, 404);
  });

  it("never sends the server's AI key to a house-configured endpoint", async () => {
    const { AI_ENV } = await import("../config.js");
    const { resolveAi } = await import("../ai.js");
    const saved = { apiKey: AI_ENV.apiKey, baseUrl: AI_ENV.baseUrl };
    AI_ENV.apiKey = "server-secret";
    AI_ENV.baseUrl = "https://api.openai.com/v1";
    try {
      assert.equal(resolveAi({ ai: {} }).apiKey, "server-secret");
      assert.equal(resolveAi({ ai: { baseUrl: "HTTPS://API.OPENAI.COM/v1/" } }).apiKey, "server-secret");
      const custom = resolveAi({ ai: { baseUrl: "https://attacker.example/v1" } });
      assert.equal(custom.apiKey, "");
      assert.equal(custom.enabled, false);
      const local = resolveAi({ ai: { enabled: true, baseUrl: "http://192.168.1.20:11434/v1" } });
      assert.equal(local.enabled, true);
      assert.equal(local.apiKey, "");
      assert.equal(resolveAi({ ai: { baseUrl: "https://other.example/v1", apiKey: "own" } }).apiKey, "own");

      const saveSettings = await request(`/api/houses/${strangerHouseId}`, {
        method: "PATCH",
        auth: secondUserCookie,
        body: { settings: { ai: { enabled: true, baseUrl: aiBase, model: "mock-model" } } },
      });
      assert.equal(saveSettings.status, 200);
      aiRequests.length = 0;
      const probe = await request(`/api/houses/${strangerHouseId}/ai/test`, { method: "POST", auth: secondUserCookie });
      assert.equal(probe.status, 200);
      assert.ok(aiRequests.length > 0);
      assert.ok(aiRequests.every((entry) => entry.headers.authorization === undefined));
    } finally {
      AI_ENV.apiKey = saved.apiKey;
      AI_ENV.baseUrl = saved.baseUrl;
    }
  });

  it("can refuse house-configured URLs on private networks", async () => {
    const { isPrivateAddress } = await import("../lib/outbound.js");
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.10", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:7f00:1"]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
      assert.equal(isPrivateAddress(address), false, address);
    }

    process.env.SV_OUTBOUND_ALLOW_PRIVATE = "false";
    try {
      aiRequests.length = 0;
      const probe = await request(`/api/houses/${strangerHouseId}/ai/test`, { method: "POST", auth: secondUserCookie });
      assert.equal(probe.status, 400);
      assert.match(probe.data.error, /private or local network/);
      assert.equal(aiRequests.length, 0);

      const channel = await request(`/api/houses/${strangerHouseId}/notifications/test`, {
        method: "POST",
        auth: secondUserCookie,
        body: { channel: { id: "new", type: "webhook", name: "Local", enabled: true, url: "http://localhost:9/hook" } },
      });
      assert.equal(channel.status, 502);
      assert.match(channel.data.error, /private or local network/);
    } finally {
      delete process.env.SV_OUTBOUND_ALLOW_PRIVATE;
    }
  });

  it("limits wrong TOTP codes per challenge and rejects a reused code", async () => {
    const login = async () => {
      const res = await request("/api/auth/login", {
        method: "POST",
        auth: "",
        body: { identifier: "totp.user@example.com", password: "test password" },
      });
      assert.equal(res.data.twoFactorRequired, true);
      return res.data.challenge as string;
    };
    const registered = await request("/api/auth/register", {
      method: "POST",
      auth: "",
      body: { name: "Totp User", email: "totp.user@example.com", password: "test password" },
    });
    assert.equal(registered.status, 201);
    const auth = registered.cookie!;
    const setup = await request("/api/auth/2fa/setup", { method: "POST", auth, body: { password: "test password" } });
    const secret = setup.data.secret as string;
    const enabled = await request("/api/auth/2fa/enable", { method: "POST", auth, body: { code: totpCode(secret) } });
    assert.equal(enabled.status, 200);

    const challenge = await login();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const wrong = await request("/api/auth/2fa/verify", {
        method: "POST",
        auth: "",
        body: { challenge, code: "000000" },
      });
      assert.equal(wrong.status, 401);
      if (attempt === 5) assert.match(wrong.data.error, /Too many wrong codes/);
    }
    // The challenge is gone after five misses, even with the right code.
    const burned = await request("/api/auth/2fa/verify", {
      method: "POST",
      auth: "",
      body: { challenge, code: totpCode(secret) },
    });
    assert.equal(burned.status, 401);
    assert.match(burned.data.error, /expired/);

    const code = totpCode(secret);
    const first = await request("/api/auth/2fa/verify", {
      method: "POST",
      auth: "",
      body: { challenge: await login(), code },
    });
    assert.equal(first.status, 200);
    const replay = await request("/api/auth/2fa/verify", {
      method: "POST",
      auth: "",
      body: { challenge: await login(), code },
    });
    assert.equal(replay.status, 401);
  });

  it("rate-limits invite lookups and failed sign-ins with Retry-After", async () => {
    process.env.SV_RATE_LIMIT = "on";
    process.env.SV_RATE_LIMIT_INVITE = "3/60";
    process.env.SV_RATE_LIMIT_LOGIN_ACCOUNT = "2/60";
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        statuses.push((await request("/api/auth/invites/not-a-real-code", { auth: "" })).status);
      }
      assert.deepEqual(statuses, [404, 404, 404, 429]);
      const limited = await fetch(`${base}/api/auth/invites/not-a-real-code`);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);

      const attempt = (password: string) =>
        request("/api/auth/login", { method: "POST", auth: "", body: { identifier: "Totp.User@example.com", password } });
      assert.equal((await attempt("wrong one")).status, 401);
      assert.equal((await attempt("wrong two")).status, 401);
      // Even the right password waits once the account is locked.
      assert.equal((await attempt("test password")).status, 429);
    } finally {
      delete process.env.SV_RATE_LIMIT;
      delete process.env.SV_RATE_LIMIT_INVITE;
      delete process.env.SV_RATE_LIMIT_LOGIN_ACCOUNT;
    }
  });

  it("removes uploaded files with their item, recipe and house", async () => {
    const { existsSync, writeFileSync, utimesSync } = await import("node:fs");
    const fileOf = (url: string) => path.join(dataDir, url.replace(/^\//, ""));
    const png = new Uint8Array(encodePng(4, 4, Buffer.alloc(4 * 4 * 4, 140)));

    const item = await request(`/api/houses/${houseId}/items`, { method: "POST", body: { name: "Doomed jar" } });
    assert.equal(item.status, 201);
    const itemImage = await uploadImage(`/api/items/${item.data.id}/image`, png, "image/png", "jar.png");
    assert.equal(itemImage.status, 200);
    assert.ok(existsSync(fileOf(itemImage.data.image)));
    assert.equal((await request(`/api/items/${item.data.id}`, { method: "DELETE" })).status, 200);
    assert.equal(existsSync(fileOf(itemImage.data.image)), false);

    const recipeImage = await uploadImage(`/api/houses/${houseId}/recipes/upload`, png, "image/png", "dish.png");
    const recipe = await request(`/api/houses/${houseId}/recipes`, {
      method: "POST",
      body: { title: "Doomed dish", image: recipeImage.data.path, ingredients: [], steps: [] },
    });
    assert.equal(recipe.status, 201);
    assert.equal((await request(`/api/recipes/${recipe.data.id}`, { method: "DELETE" })).status, 200);
    assert.equal(existsSync(fileOf(recipeImage.data.path)), false);

    const house = await request("/api/houses", { method: "POST", body: { name: "Doomed house" } });
    assert.equal(house.status, 201);
    const houseImage = await uploadImage(`/api/houses/${house.data.id}/recipes/upload`, png, "image/png", "h.png");
    await request(`/api/houses/${house.data.id}/recipes`, {
      method: "POST",
      body: { title: "House dish", image: houseImage.data.path, ingredients: [], steps: [] },
    });
    const receiptImage = await uploadImage(`/api/houses/${house.data.id}/receipts/upload`, png, "image/png", "r.png");
    const receipt = await request(`/api/houses/${house.data.id}/receipts`, {
      method: "POST",
      body: { vendorName: "Shop", image: receiptImage.data.path, lines: [{ description: "Bread", quantity: 1 }] },
    });
    assert.equal(receipt.status, 201);
    assert.ok(existsSync(fileOf(receiptImage.data.path)));
    assert.equal((await request(`/api/houses/${house.data.id}`, { method: "DELETE" })).status, 200);
    assert.equal(existsSync(fileOf(houseImage.data.path)), false);
    assert.equal(existsSync(fileOf(receiptImage.data.path)), false);

    // The sweep removes old unreferenced files and keeps fresh or referenced ones.
    const { sweepOrphanUploads } = await import("../services/upload-cleanup.js");
    const kept = await uploadImage(`/api/items/${itemId}/image`, png, "image/png", "kept.png");
    const old = new Date(Date.now() - 3 * 864e5);
    utimesSync(fileOf(kept.data.image), old, old);
    const orphan = path.join(dataDir, "uploads", "receipts", "orphan.jpg");
    const fresh = path.join(dataDir, "uploads", "receipts", "fresh.jpg");
    writeFileSync(orphan, "x");
    writeFileSync(fresh, "x");
    utimesSync(orphan, old, old);
    assert.ok((await sweepOrphanUploads()) >= 1);
    assert.equal(existsSync(orphan), false);
    assert.ok(existsSync(fresh));
    assert.ok(existsSync(fileOf(kept.data.image)));
  });

  it("closes registration to invite-only or entirely", async () => {
    const signUp = (email: string, inviteCode?: string) =>
      request("/api/auth/register", {
        method: "POST",
        auth: "",
        body: { name: "Late Comer", email, password: "test password", ...(inviteCode ? { inviteCode } : {}) },
      });
    try {
      process.env.SV_REGISTRATION = "invite";
      const status = await request("/api/auth/registration", { auth: "" });
      assert.equal(status.status, 200);
      assert.equal(status.data.mode, "invite");
      assert.equal(status.data.inviteRequired, true);
      assert.equal((await signUp("no.invite@example.com")).status, 403);

      const invite = await request(`/api/houses/${houseId}/members`, {
        method: "POST",
        body: { email: "invited.person@example.com", role: "viewer" },
      });
      assert.equal(invite.status, 201);
      const joined = await signUp("invited.person@example.com", invite.data.invite.code);
      assert.equal(joined.status, 201);
      assert.ok(joined.data.houses.some((house: any) => house.id === houseId));

      process.env.SV_REGISTRATION = "closed";
      assert.equal((await request("/api/auth/registration", { auth: "" })).data.mode, "closed");
      assert.equal((await signUp("closed.out@example.com")).status, 403);

      // OIDC auto-provisioning follows the same rule.
      const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: "manual" });
      const authorize = new URL(start.headers.get("location")!);
      const callback = await fetch(
        `${base}/api/auth/oidc/callback?code=${encodeURIComponent(authorize.searchParams.get("nonce")!)}&state=${encodeURIComponent(
          authorize.searchParams.get("state")!,
        )}`,
        { redirect: "manual" },
      );
      assert.equal(callback.status, 302);
      assert.match(callback.headers.get("location") ?? "", /oidc_error=.*invite/);

      // Unset falls back to invite-only once accounts exist.
      delete process.env.SV_REGISTRATION;
      assert.equal((await request("/api/auth/registration", { auth: "" })).data.mode, "invite");
    } finally {
      process.env.SV_REGISTRATION = "open";
    }
    // Signed-in users can still create houses.
    const house = await request("/api/houses", { method: "POST", auth: secondUserCookie, body: { name: "Shed" } });
    assert.equal(house.status, 201);
  });

  it("requires the current password to change email or username", async () => {
    const registered = await request("/api/auth/register", {
      method: "POST",
      auth: "",
      body: { name: "Profile User", email: "profile.user@example.com", password: "test password" },
    });
    const auth = registered.cookie!;
    assert.equal(registered.data.user.hasPassword, true);

    const renameOnly = await request("/api/auth/me", { method: "PATCH", auth, body: { name: "Renamed", email: "profile.user@example.com" } });
    assert.equal(renameOnly.status, 200);
    const noPassword = await request("/api/auth/me", { method: "PATCH", auth, body: { email: "hijacked@example.com" } });
    assert.equal(noPassword.status, 400);
    const wrongPassword = await request("/api/auth/me", {
      method: "PATCH",
      auth,
      body: { username: "hijacked", currentPassword: "nope nope" },
    });
    assert.equal(wrongPassword.status, 400);
    const changed = await request("/api/auth/me", {
      method: "PATCH",
      auth,
      body: { email: "profile.moved@example.com", currentPassword: "test password" },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.user.email, "profile.moved@example.com");
  });

  it("blocks cross-site state changes and sends a CSP", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/houses`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify({ name: "CSRF house" }),
      });
    assert.equal((await post({ origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post({ origin: "null" })).status, 403);
    const sameOrigin = await post({ origin: base });
    assert.equal(sameOrigin.status, 201);
    const fetchMeta = await post({ origin: "https://proxy.example", "sec-fetch-site": "same-origin" });
    assert.equal(fetchMeta.status, 201);
    await request(`/api/houses/${(await sameOrigin.json() as any).id}`, { method: "DELETE" });
    await request(`/api/houses/${(await fetchMeta.json() as any).id}`, { method: "DELETE" });
    // Reads are never blocked.
    assert.equal((await fetch(`${base}/api/houses`, { headers: { cookie, origin: "https://evil.example" } })).status, 200);

    const csp = (await fetch(`${base}/api/health`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.match(csp, /worker-src 'self' blob:/);
    assert.match(csp, /frame-ancestors 'self'/);
    const { existsSync } = await import("node:fs");
    const { CLIENT_DIR } = await import("../config.js");
    if (existsSync(path.join(CLIENT_DIR, "index.html"))) {
      // The theme bootstrap is the only inline script and is allowed by hash.
      assert.match((await fetch(`${base}/`)).headers.get("content-security-policy") ?? "", /'sha256-[A-Za-z0-9+/=]+'/);
    }
  });

  it("keeps catalogue mappings learned by one house out of other houses", async () => {
    const { learnCatalogMapping, findCatalogMapping, exportCatalogMappings } = await import("../services/product-catalog.js");
    const raw = "PRIVATE HOUSE BLEND 250G";
    await learnCatalogMapping({ houseId, country: "GR", rawDescription: raw, name: "Owner's coffee", offCode: "5200000000001" });

    const own = await findCatalogMapping({ houseId, country: "GR", rawDescription: raw });
    assert.equal(own?.name, "Owner's coffee");
    assert.equal(await findCatalogMapping({ houseId: strangerHouseId, country: "GR", rawDescription: raw }), null);
    // Callers that do not pass a house only see shared rows.
    assert.equal(await findCatalogMapping({ country: "GR", rawDescription: raw }), null);

    const outsider = await request("/api/auth/register", {
      method: "POST",
      auth: "",
      body: { name: "Outsider", email: "catalog.outsider@example.com", password: "test password" },
    });
    const leaked = await request(`/api/catalog/resolve?raw=${encodeURIComponent(raw)}`, { auth: outsider.cookie! });
    assert.equal(leaked.data.mapping, null);
    const probing = await request(`/api/catalog/resolve?raw=${encodeURIComponent(raw)}&houseId=${houseId}`, {
      auth: outsider.cookie!,
    });
    assert.equal(probing.data.mapping, null);
    const member = await request(`/api/catalog/resolve?raw=${encodeURIComponent(raw)}&houseId=${houseId}`);
    assert.equal(member.data.mapping.name, "Owner's coffee");

    // A second house can learn its own answer for the same text.
    await learnCatalogMapping({ houseId: strangerHouseId, country: "GR", rawDescription: raw, name: "Stranger's coffee" });
    assert.equal((await findCatalogMapping({ houseId: strangerHouseId, country: "GR", rawDescription: raw }))?.name, "Stranger's coffee");
    assert.equal((await findCatalogMapping({ houseId, country: "GR", rawDescription: raw }))?.name, "Owner's coffee");

    // Rows learned without a house stay shared, and the admin export still works.
    await learnCatalogMapping({ country: "GR", rawDescription: "SHARED OAT DRINK 1L", name: "Oat drink" });
    assert.equal((await findCatalogMapping({ houseId: strangerHouseId, country: "GR", rawDescription: "SHARED OAT DRINK 1L" }))?.name, "Oat drink");
    const exported = await exportCatalogMappings();
    assert.equal(exported.mappings.filter((entry) => entry.rawText === raw).length, 1);
    assert.equal((await request("/api/catalog/export")).status, 200);
  });

  it("expires invites and spends the same work on unknown accounts", async () => {
    const created = await request(`/api/houses/${houseId}/members`, {
      method: "POST",
      body: { email: "slow.joiner@example.com", role: "member" },
    });
    assert.equal(created.status, 201);
    assert.ok(Date.parse(created.data.invite.expiresAt) > Date.now() + 13 * 864e5);
    const code = created.data.invite.code;
    assert.equal((await request(`/api/auth/invites/${code}`, { auth: "" })).status, 200);

    await run("UPDATE house_invites SET expires_at = ? WHERE code = ?", [new Date(Date.now() - 1000).toISOString(), code]);
    assert.equal((await request(`/api/auth/invites/${code}`, { auth: "" })).status, 404);
    const register = await request("/api/auth/register", {
      method: "POST",
      auth: "",
      body: { name: "Slow", email: "slow.joiner@example.com", password: "test password", inviteCode: code },
    });
    assert.equal(register.status, 400);
    const list = await request(`/api/houses/${houseId}/invites`);
    assert.equal(list.data.find((entry: any) => entry.code === code).expired, true);

    // Invites from before expiry existed count from their creation date.
    await run("UPDATE house_invites SET expires_at = NULL, created_at = ? WHERE code = ?", [
      new Date(Date.now() - 30 * 864e5).toISOString(),
      code,
    ]);
    assert.equal((await request(`/api/auth/invites/${code}`, { auth: "" })).status, 404);

    // A login for an unknown account still runs a password hash (no fast path).
    const time = async (identifier: string) => {
      const started = performance.now();
      await request("/api/auth/login", { method: "POST", auth: "", body: { identifier, password: "wrong password" } });
      return performance.now() - started;
    };
    await time("owner");
    const missing = Math.min(await time("nobody-here"), await time("nobody-here"));
    const known = Math.min(await time("owner"), await time("owner"));
    assert.ok(missing > known * 0.4, `unknown ${missing.toFixed(1)}ms vs known ${known.toFixed(1)}ms`);
  });

  it("masks card numbers, IDs and contact details in AI log previews", async () => {
    const { maskSensitiveText, isValidGtin } = await import("../lib/redact.js");
    const receipt = [
      "ΣΚΛΑΒΕΝΙΤΗΣ ΤΗΛ.210-9270972",
      "5208046287576",
      "ΑΥΓΑ ΜΑΡΑΤΑ 2,70 13,00%",
      "VISA 4111 1111 1111 1234",
      "CARD 5500005555555559",
      "ΚΑΡΤΑ ΠΙΣΤΟΤΗΤΑΣ 99887766554",
      "IBAN GR16 0110 1250 0000 0001 2300 695",
      "mail me: jane.doe@example.com, +30 694 123 4567",
      "ΣΥΝΟΛΟ 24,02 ΕΥΡΩ",
    ].join("\n");
    const masked = maskSensitiveText(receipt);
    assert.ok(isValidGtin("5208046287576"));
    assert.match(masked, /5208046287576/); // product barcode kept
    assert.match(masked, /2,70 13,00%/);
    assert.match(masked, /ΣΥΝΟΛΟ 24,02/);
    assert.match(masked, /\[card \*\*\*\*1234\]/);
    assert.match(masked, /\[card \*\*\*\*5559\]/);
    assert.match(masked, /\[id \*\*\*\*6554\]/);
    assert.match(masked, /\[iban \*\*\*\*0695\]/);
    assert.match(masked, /\[email\]/);
    for (const secret of ["4111 1111", "5500005555555559", "99887766554", "GR16", "jane.doe", "694 123", "9270972"]) {
      assert.ok(!masked.includes(secret), `${secret} leaked: ${masked}`);
    }

    const saved = await request(`/api/houses/${strangerHouseId}`, {
      method: "PATCH",
      auth: secondUserCookie,
      body: { settings: { ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model" } } },
    });
    assert.equal(saved.status, 200);
    const scan = await request(`/api/houses/${strangerHouseId}/receipts/scan`, {
      method: "POST",
      auth: secondUserCookie,
      body: { text: "MOCK MART\nMilk 2 x 1.20\nLOYALTY 9876543210123456\nTOTAL 2.40", preferAi: true },
    });
    assert.equal(scan.status, 200);
    const { all } = await import("../db.js");
    const rows = await all<any>("SELECT request_preview FROM ai_call_logs WHERE house_id = ?", [strangerHouseId]);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => !String(row.request_preview).includes("9876543210123456")));
    assert.ok(rows.some((row) => String(row.request_preview).includes("[card ****3456]")));
  });
});

describe("multi-photo receipt OCR", () => {
  it("uses only complete alternative page sets and preserves manual edits", async () => {
    const { mergeOcrCandidates } = await import("../../client/ocr-merge.js");
    const first = { text: "MILK 1.50", candidates: ["MILK 1.50", "MILK 1.80"] };
    const second = { text: "BREAD 2.00", candidates: ["BREAD 2.00", "BREAD 2.20"] };
    assert.deepEqual(mergeOcrCandidates([first, { text: second.text }], "MILK 1.50\nBREAD 2.00"), []);
    assert.deepEqual(mergeOcrCandidates([first, second], "MILK 1.50\nBREAD 2.00"), ["MILK 1.80\nBREAD 2.20"]);
    assert.deepEqual(mergeOcrCandidates([first, second], "MILK 1.50\nBREAD 2.10"), []);
  });

  it("drops the lines two overlapping pages share", () => {
    const merged = mergeOcrTexts([
      "MILK 1.50\nBREAD 2.00\nTOTAL 3.50",
      "BREAD 2.00\nTOTAL 3.50\nCHEESE 4.20",
    ]);
    assert.equal(merged.text, "MILK 1.50\nBREAD 2.00\nTOTAL 3.50\nCHEESE 4.20");
    assert.equal(merged.removedLines, 2);
  });

  it("drops a page that repeats the previous shot exactly", () => {
    const merged = mergeOcrTexts(["MILK 1.50\nBREAD 2.00", "MILK 1.50\nBREAD 2.00"]);
    assert.equal(merged.text, "MILK 1.50\nBREAD 2.00");
    assert.equal(merged.removedLines, 2);
  });

  it("tolerates small OCR differences inside the overlap", () => {
    const merged = mergeOcrTexts([
      "MILK 1.50\nBREAD WHOLE 2.00\nTOTAL 3.50",
      "BREAD WHOLE 2.05\nTOTAL 3.50\nCHEESE 4.20",
    ]);
    assert.equal(merged.text, "MILK 1.50\nBREAD WHOLE 2.00\nTOTAL 3.50\nCHEESE 4.20");
  });

  it("keeps pages with no overlap, including a repeated short total line", () => {
    const merged = mergeOcrTexts(["MILK 1.50\nTOTAL 1.50", "TOTAL 1.50\nCHEESE 4.20"]);
    assert.equal(merged.text, "MILK 1.50\nTOTAL 1.50\nTOTAL 1.50\nCHEESE 4.20");
    assert.equal(merged.removedLines, 0);
  });

  it("does not mistake two structured but different pages for an overlap", () => {
    const first = Array.from({ length: 30 }, (_, index) => `PRODUCT A-${index} ${(index + 1).toFixed(2)}`).join("\n");
    const second = Array.from({ length: 30 }, (_, index) => `PRODUCT B-${index} ${(index + 1).toFixed(2)}`).join("\n");
    const merged = mergeOcrTexts([first, second]);
    assert.equal(merged.text, `${first}\n${second}`);
    assert.equal(merged.removedLines, 0);
  });
});

describe("CSV parsing", () => {
  it("handles a BOM, CRLF, semicolons, quoting and decimal commas", () => {
    const csv = "\uFEFFName;Brand;Quantity;Price\r\n\"Rice, long\";\"Acme; Ltd\";\"1.234,5\";\"2,50\"\r\n";
    const parsed = parseCsv(csv);
    assert.equal(parsed.delimiter, ";");
    assert.deepEqual(parsed.headers, ["Name", "Brand", "Quantity", "Price"]);
    assert.equal(parsed.rows[0].Name, "Rice, long");
    assert.equal(parsed.rows[0].Brand, "Acme; Ltd");
    assert.equal(parseCsvNumber(parsed.rows[0].Quantity), 1234.5);
    assert.equal(parseCsvNumber(parsed.rows[0].Price), 2.5);
  });

  it("reads a quoted newline and comma decimals in a comma file", () => {
    const csv = 'Name,Quantity,Notes\n"Flour","1,5","Soft, fine"\n';
    const parsed = parseCsv(csv);
    assert.equal(parsed.delimiter, ",");
    assert.equal(parsed.rows[0].Name, "Flour");
    assert.equal(parseCsvNumber(parsed.rows[0].Quantity), 1.5);
    assert.equal(parsed.rows[0].Notes, "Soft, fine");
    assert.equal(parseCsvNumber("1,5"), 1.5);
    assert.equal(parseCsvNumber("€ 2,40"), 2.4);
  });
});

describe("shopping list", () => {
  it("merges compatible units and keeps incompatible ones separate", async () => {
    const first = await request(`/api/houses/${houseId}/shopping`, {
      method: "POST",
      body: { name: "Olive oil test", quantity: 1, unit: "l" },
    });
    assert.equal(first.status, 201);
    const second = await request(`/api/houses/${houseId}/shopping`, {
      method: "POST",
      body: { name: "olive oil TEST", quantity: 500, unit: "ml" },
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.item.quantity, 1.5);

    const separate = await request(`/api/houses/${houseId}/shopping`, {
      method: "POST",
      body: { name: "Olive oil test", quantity: 1, unit: "kg" },
    });
    assert.equal(separate.status, 201);
    const list = await request(`/api/houses/${houseId}/shopping`);
    assert.equal(list.data.items.filter((entry: any) => entry.name.toLowerCase() === "olive oil test").length, 2);
  });

  it("adds low-stock items once, up to target stock", async () => {
    const item = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: {
        name: "Low coffee test",
        unit: "pcs",
        reorderPoint: 5,
        targetStock: 10,
        initialStock: { quantity: 1 },
      },
    });
    assert.equal(item.status, 201);

    const first = await request(`/api/houses/${houseId}/shopping/from-low-stock`, { method: "POST", body: {} });
    assert.ok(first.data.added >= 1);
    const line = first.data.items.find((entry: any) => entry.itemId === item.data.id);
    assert.equal(line.quantity, 9);

    const again = await request(`/api/houses/${houseId}/shopping/from-low-stock`, { method: "POST", body: {} });
    assert.equal(again.data.added, 0);
    assert.ok(again.data.skipped >= 1);
  });

  it("adds only the missing amount from a recipe and records the purchase", async () => {
    const flour = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Flour test", unit: "g", initialStock: { quantity: 200 } },
    });
    const recipe = await request(`/api/houses/${houseId}/recipes`, {
      method: "POST",
      body: {
        title: "Shopping flour test",
        servings: 2,
        ingredients: [{ name: "Flour test", quantity: 500, unit: "g", itemId: flour.data.id }],
      },
    });
    assert.equal(recipe.status, 201);

    const added = await request(`/api/houses/${houseId}/shopping/from-recipe`, {
      method: "POST",
      body: { recipeId: recipe.data.id, missingOnly: true },
    });
    assert.equal(added.status, 200);
    const line = added.data.items.find((entry: any) => entry.name === "Flour test");
    assert.equal(line.quantity, 300);

    const checked = await request(`/api/houses/${houseId}/shopping/${line.id}/check`, {
      method: "POST",
      body: { quantity: 300, unit: "g", unitPrice: 0.002 },
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.data.item.checked, true);
    const detail = await request(`/api/items/${flour.data.id}`);
    assert.equal(detail.data.quantity, 500);
    assert.ok(detail.data.priceHistory.some((point: any) => point.price === 0.002));

    const cleared = await request(`/api/houses/${houseId}/shopping?checked=1`, { method: "DELETE" });
    assert.equal(cleared.status, 200);
    const remaining = await request(`/api/houses/${houseId}/shopping`);
    assert.ok(!remaining.data.items.some((entry: any) => entry.id === line.id));
  });
});

describe("weekly meal planner", () => {
  let riceItemId = "";
  let recipeId = "";

  it("creates, reads and duplicates a planned meal", async () => {
    const rice = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Plan rice test", unit: "g", initialStock: { quantity: 100 } },
    });
    riceItemId = rice.data.id;
    const recipe = await request(`/api/houses/${houseId}/recipes`, {
      method: "POST",
      body: {
        title: "Plan rice bowl",
        servings: 2,
        ingredients: [{ name: "Plan rice test", quantity: 200, unit: "g", itemId: riceItemId }],
      },
    });
    recipeId = recipe.data.id;

    const entry = await request(`/api/houses/${houseId}/plan`, {
      method: "POST",
      body: { day: "2026-11-02", slot: "dinner", recipeId, servings: 4 },
    });
    assert.equal(entry.status, 201);
    assert.equal(entry.data.title, "Plan rice bowl");
    assert.equal(entry.data.servings, 4);

    const week = await request(`/api/houses/${houseId}/plan?week=2026-11-04`);
    assert.equal(week.data.weekStart, "2026-11-02");
    assert.equal(week.data.weekEnd, "2026-11-08");
    assert.equal(week.data.entries.length, 1);

    const duplicate = await request(`/api/houses/${houseId}/plan/${entry.data.id}/duplicate`, {
      method: "POST",
      body: { day: "2026-11-03" },
    });
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.data.day, "2026-11-03");
  });

  it("scales the week's ingredients and subtracts stock once", async () => {
    const result = await request(`/api/houses/${houseId}/plan/shopping-list`, {
      method: "POST",
      body: { week: "2026-11-02" },
    });
    assert.equal(result.status, 200);
    const line = result.data.items.find((entry: any) => entry.name === "Plan rice test");
    // 200 g × 4/2 servings × two identical meals = 800 g, minus 100 g in stock.
    assert.equal(line.quantity, 700);

    const again = await request(`/api/houses/${houseId}/plan/shopping-list`, {
      method: "POST",
      body: { week: "2026-11-02" },
    });
    assert.equal(again.data.added, 0);

    const recipe = await request(`/api/recipes/${recipeId}`);
    assert.equal(recipe.data.ingredients[0].quantity, 200);
  });

  it("reports planned meals on the dashboard", async () => {
    const dashboard = await request(`/api/houses/${houseId}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.ok(dashboard.data.plan.week >= 2);
  });
});

describe("bulk intake", () => {
  it("parses receipt text without writing anything", async () => {
    const milk = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Intake milk test", unit: "pcs", initialStock: { quantity: 1 } },
    });
    const beforeCount = (await request(`/api/houses/${houseId}/items?limit=1000`)).data.total;
    const parsed = await request(`/api/houses/${houseId}/intake/parse`, {
      method: "POST",
      body: { text: "INTAKE MILK TEST 1.50\nBREAD LOAF 2.00\nTOTAL 3.50" },
    });
    assert.equal(parsed.status, 200);
    assert.ok(parsed.data.rows.length >= 1);
    const afterCount = (await request(`/api/houses/${houseId}/items?limit=1000`)).data.total;
    assert.equal(afterCount, beforeCount);

    const row = parsed.data.rows[0];
    const committed = await request(`/api/houses/${houseId}/intake/commit`, {
      method: "POST",
      body: {
        rows: [
          {
            description: milk.data.name,
            quantity: 2,
            unit: "pcs",
            itemId: milk.data.id,
            action: "update",
          },
        ],
      },
    });
    assert.equal(committed.status, 200);
    assert.equal(committed.data.updated[0].quantity, 3);
    void row;
  });

  it("rolls back every row when one is invalid", async () => {
    const fail = await request(`/api/houses/${houseId}/intake/commit`, {
      method: "POST",
      body: {
        rows: [
          { description: "Intake rollback good", quantity: 1, unit: "pcs", action: "create" },
          { description: "Intake rollback bad", quantity: 1, unit: "zzz", action: "create" },
        ],
      },
    });
    assert.equal(fail.status, 400);
    const search = await request(`/api/houses/${houseId}/items?q=Intake rollback`);
    assert.equal(search.data.items.length, 0);
  });

  it("rejects duplicate barcodes in one queue", async () => {
    const res = await request(`/api/houses/${houseId}/intake/commit`, {
      method: "POST",
      body: {
        rows: [
          { description: "Queue one", quantity: 1, unit: "pcs", barcode: "queue-dup-1", action: "create" },
          { description: "Queue two", quantity: 1, unit: "pcs", barcode: "queue-dup-1", action: "create" },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.data.details.rows.length >= 1);
  });

  it("turns a scanned barcode queue into updates without writing during parse", async () => {
    const parsed = await request(`/api/houses/${houseId}/intake/parse`, {
      method: "POST",
      body: { barcodes: [barcode, barcode] },
    });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.data.rows.length, 1);
    assert.equal(parsed.data.rows[0].itemId, itemId);
  });
});

describe("CSV inventory import", () => {
  it("previews and commits a spreadsheet with categories and places", async () => {
    const csv = [
      "\uFEFFName;Unit;Quantity;Price;Barcodes;Category;Place",
      '"Csv apples";kg;"1,5";"2,50";csv-apple-1;Food;Pantry',
    ].join("\r\n");
    const preview = await request(`/api/houses/${houseId}/import/csv/preview`, {
      method: "POST",
      body: { csv },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.rows[0].quantity, 1.5);
    assert.equal(preview.data.rows[0].price, 2.5);
    assert.equal(preview.data.summary.create, 1);

    const commit = await request(`/api/houses/${houseId}/import/csv/commit`, {
      method: "POST",
      body: { csv, mode: "create" },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.data.created, 1);
    const item = commit.data.items[0];
    assert.equal(item.quantity, 1.5);
    assert.equal(item.categoryName, "Food");
    assert.equal(item.priceStats.latest, 2.5);
    const detail = await request(`/api/items/${item.id}`);
    assert.ok(detail.data.lots.some((lot: any) => lot.locationName === "Pantry"));
  });

  it("updates by barcode without duplicating the item", async () => {
    const csv = 'Name;Unit;Quantity;Barcodes\n"Csv apples";kg;"0,5";csv-apple-1\n';
    const preview = await request(`/api/houses/${houseId}/import/csv/preview`, {
      method: "POST",
      body: { csv, mode: "update" },
    });
    assert.equal(preview.data.rows[0].action, "update");
    const commit = await request(`/api/houses/${houseId}/import/csv/commit`, {
      method: "POST",
      body: { csv, mode: "update" },
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.data.updated, 1);
    assert.equal(commit.data.created, 0);
    assert.equal(commit.data.items[0].quantity, 2);
  });

  it("writes nothing when any row has an unknown unit", async () => {
    const csv = 'Name;Unit;Quantity\n"Csv good row";pcs;1\n"Csv bad row";zzz;2\n';
    const res = await request(`/api/houses/${houseId}/import/csv/commit`, {
      method: "POST",
      body: { csv },
    });
    assert.equal(res.status, 400);
    const search = await request(`/api/houses/${houseId}/items?q=Csv good row`);
    assert.equal(search.data.items.length, 0);
  });

  it("skips ambiguous name matches with a warning", async () => {
    for (const suffix of ["A", "B"]) {
      await request(`/api/houses/${houseId}/items`, {
        method: "POST",
        body: { name: "Ambiguous csv", unit: "pcs", brand: suffix },
      });
    }
    const preview = await request(`/api/houses/${houseId}/import/csv/preview`, {
      method: "POST",
      body: { csv: 'Name;Unit;Quantity\n"Ambiguous csv";pcs;1\n', mode: "update" },
    });
    assert.equal(preview.data.rows[0].action, "skip");
    assert.match(preview.data.rows[0].warnings.join(" "), /ambiguous/i);
  });
});

describe("ownership transfer", () => {
  it("requires confirmation and a member target", async () => {
    const house = await request(`/api/houses/${houseId}`);
    const owner = house.data.members.find((member: any) => member.role === "owner");
    const stranger = house.data.members.find((member: any) => member.role === "viewer");
    assert.ok(owner && stranger);

    const self = await request(`/api/houses/${houseId}/members/${owner.id}/transfer-ownership`, {
      method: "POST",
      body: { houseName: house.data.name },
    });
    assert.equal(self.status, 400);

    const wrong = await request(`/api/houses/${houseId}/members/${stranger.id}/transfer-ownership`, {
      method: "POST",
      body: { houseName: "not the house" },
    });
    assert.equal(wrong.status, 400);
    const unchanged = await request(`/api/houses/${houseId}`);
    assert.equal(unchanged.data.members.find((member: any) => member.id === owner.id).role, "owner");
    assert.equal(unchanged.data.members.find((member: any) => member.id === stranger.id).role, "viewer");

    const missing = await request(`/api/houses/${houseId}/members/usr_missing/transfer-ownership`, {
      method: "POST",
      body: { houseName: house.data.name },
    });
    assert.equal(missing.status, 404);

    const nonOwner = await request(`/api/houses/${houseId}/members/${owner.id}/transfer-ownership`, {
      method: "POST",
      auth: secondUserCookie,
      body: { houseName: house.data.name },
    });
    assert.equal(nonOwner.status, 403);
  });

  it("moves exactly one owner and notifies the new one", async () => {
    const house = await request(`/api/houses/${houseId}`);
    const stranger = house.data.members.find((member: any) => member.role === "viewer");
    const transferred = await request(`/api/houses/${houseId}/members/${stranger.id}/transfer-ownership`, {
      method: "POST",
      body: { houseName: house.data.name },
    });
    assert.equal(transferred.status, 200);
    const owners = transferred.data.members.filter((member: any) => member.role === "owner");
    assert.equal(owners.length, 1);
    assert.equal(owners[0].id, stranger.id);
    const previous = transferred.data.members.find((member: any) => member.id !== stranger.id);
    assert.equal(previous.role, "admin");

    const notifications = await request("/api/notifications", { auth: secondUserCookie });
    assert.ok(notifications.data.notifications.some((entry: any) => /now own/i.test(entry.title)));

    // The new owner can hand it back, so later tests keep a stable owner.
    const back = await request(`/api/houses/${houseId}/members/${previous.id}/transfer-ownership`, {
      method: "POST",
      auth: secondUserCookie,
      body: { houseName: house.data.name },
    });
    assert.equal(back.status, 200);
  });
});

describe("reminder delivery channels", () => {
  let channelServer: import("node:http").Server;
  let channelBase = "";
  const channelRequests: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];

  before(async () => {
    await new Promise<void>((resolve) => {
      channelServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          channelRequests.push({ body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      channelServer.listen(0, "127.0.0.1", () => {
        const address = channelServer.address();
        if (!address || typeof address === "string") throw new Error("no channel address");
        channelBase = `http://127.0.0.1:${address.port}/hook`;
        resolve();
      });
    });
  });

  after(() => {
    channelServer?.close();
  });

  it("masks channel secrets and keeps them when saving the placeholder", async () => {
    const saved = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          notifications: {
            channels: [
              {
                id: "ch_test",
                type: "webhook",
                name: "Test hook",
                url: channelBase,
                enabled: true,
                secret: "topsecret",
                events: { lowStock: true, expiring: true, weeklySummary: false },
              },
            ],
          },
        },
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.settings.notifications.channels[0].secret, "***");

    const resent = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          notifications: {
            channels: [
              {
                id: "ch_test",
                type: "webhook",
                name: "Test hook",
                url: channelBase,
                enabled: true,
                secret: "***",
                events: { lowStock: true, expiring: true, weeklySummary: false },
              },
            ],
          },
        },
      },
    });
    assert.equal(resent.status, 200);

    const test = await request(`/api/houses/${houseId}/notifications/test`, {
      method: "POST",
      body: { channelId: "ch_test" },
    });
    assert.equal(test.status, 200);
    assert.equal(test.data.ok, true);
    const last = channelRequests.at(-1)!;
    const expected = `sha256=${createHmac("sha256", "topsecret").update(last.body).digest("hex")}`;
    assert.equal(last.headers["x-svault-signature"], expected);
    assert.match(last.body, /test reminder/i);
  });

  it("delivers one low-stock message per dedupe key", async () => {
    const item = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Delivery tea test", unit: "pcs", reorderPoint: 5, initialStock: { quantity: 1 } },
    });
    assert.equal(item.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const first = await request(`/api/houses/${houseId}/reminder-deliveries`);
    const key = `low:${item.data.id}`;
    assert.equal(first.data.deliveries.filter((entry: any) => entry.dedupeKey === key).length, 1);

    await request(`/api/houses/${houseId}/notifications/scan`, { method: "POST", body: {} });
    await request(`/api/houses/${houseId}/notifications/scan`, { method: "POST", body: {} });
    const second = await request(`/api/houses/${houseId}/reminder-deliveries`);
    assert.equal(second.data.deliveries.filter((entry: any) => entry.dedupeKey === key).length, 1);

    // Restock to resolve the reminder, then drop below the threshold again.
    // The in-app reminder reopens, but the channel must not see it twice.
    await request(`/api/items/${item.data.id}/stock`, { method: "POST", body: { action: "add", quantity: 10 } });
    await request(`/api/items/${item.data.id}/stock`, { method: "POST", body: { action: "remove", quantity: 10 } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await request(`/api/houses/${houseId}/reminder-deliveries`);
    assert.equal(third.data.deliveries.filter((entry: any) => entry.dedupeKey === key).length, 1);
  });

  it("reports a failed delivery without blocking the trigger", async () => {
    const saved = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          notifications: {
            channels: [
              {
                id: "ch_test",
                type: "webhook",
                name: "Test hook",
                url: "http://127.0.0.1:1/unreachable",
                enabled: true,
                secret: "***",
                events: { lowStock: false, expiring: false, weeklySummary: false },
              },
            ],
          },
        },
      },
    });
    assert.equal(saved.status, 200);
    const res = await request(`/api/houses/${houseId}/notifications/test`, {
      method: "POST",
      body: { channelId: "ch_test" },
    });
    assert.equal(res.status, 502);
    assert.equal(res.data.ok, false);
  });
});

describe("two-factor authentication", () => {
  it("generates and verifies TOTP codes and backup codes", () => {
    const secret = generateTotpSecret();
    const code = totpCode(secret);
    assert.equal(code.length, 6);
    assert.equal(verifyTotp(secret, code), true);
    assert.equal(verifyTotp(secret, "000000"), false);
    const backup = generateBackupCodes(3);
    assert.equal(backup.plain.length, 3);
    assert.equal(new Set(backup.hashed).size, 3);
  });

  it("enables 2FA, requires the second step at login and disables it again", async () => {
    const setup = await request("/api/auth/2fa/setup", {
      method: "POST",
      body: { password: "test password" },
    });
    assert.equal(setup.status, 200);
    assert.ok(setup.data.secret);

    const wrong = await request("/api/auth/2fa/enable", { method: "POST", body: { code: "000000" } });
    assert.equal(wrong.status, 400);

    const enabled = await request("/api/auth/2fa/enable", {
      method: "POST",
      body: { code: totpCode(setup.data.secret) },
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.data.backupCodes.length, 8);

    const login = await request("/api/auth/login", {
      method: "POST",
      body: { identifier: "owner", password: "test password" },
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.twoFactorRequired, true);
    assert.ok(login.data.challenge);

    const rejected = await request("/api/auth/2fa/verify", {
      method: "POST",
      body: { challenge: login.data.challenge, code: "000000" },
    });
    assert.equal(rejected.status, 401);

    const verified = await request("/api/auth/2fa/verify", {
      method: "POST",
      body: { challenge: login.data.challenge, code: totpCode(setup.data.secret) },
    });
    assert.equal(verified.status, 200);
    assert.ok(verified.cookie);

    // A code is accepted once per time step, so disabling needs the next code.
    const disabled = await request("/api/auth/2fa/disable", {
      method: "POST",
      body: { password: "test password", code: totpCode(setup.data.secret, Date.now() + 30_000) },
    });
    assert.equal(disabled.status, 200);
    const status = await request("/api/auth/2fa");
    assert.equal(status.data.enabled, false);
  });

  it("exposes passkey options and rejects an unknown assertion", async () => {
    const options = await request("/api/auth/passkeys/login/options", { method: "POST", body: {} });
    assert.equal(options.status, 200);
    assert.ok(options.data.challengeId);
    assert.ok(options.data.options.challenge);
    const bad = await request("/api/auth/passkeys/login/verify", {
      method: "POST",
      body: { challengeId: options.data.challengeId, response: { id: "missing" } },
    });
    assert.equal(bad.status, 401);
  });

  it("reports OIDC enabled and auto-provisions a verified email", async () => {
    const status = await request("/api/auth/oidc/status", { auth: "" });
    assert.equal(status.status, 200);
    assert.equal(status.data.enabled, true);

    const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    const nonce = authorize.searchParams.get("nonce")!;
    assert.ok(state && nonce);

    const callback = await fetch(`${base}/api/auth/oidc/callback?code=${encodeURIComponent(nonce)}&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get("location") ?? "", /sso=1/);
    const setCookie = callback.headers.get("set-cookie")!.split(";")[0];
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: setCookie } });
    assert.equal(me.status, 200);
    const meData = (await me.json()) as any;
    assert.equal(meData.user.email, "sso@example.com");
    assert.ok(meData.houses.length >= 1);
  });

  it("rejects invalid state and an unverified OIDC email", async () => {
    const badState = await fetch(`${base}/api/auth/oidc/callback?code=x&state=missing`, { redirect: "manual" });
    assert.equal(badState.status, 302);
    assert.match(badState.headers.get("location") ?? "", /oidc_error=/);

    const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: "manual" });
    const authorize = new URL(start.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    const nonce = authorize.searchParams.get("nonce")!;
    const callback = await fetch(
      `${base}/api/auth/oidc/callback?code=${encodeURIComponent(`unverified-${nonce}`)}&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get("location") ?? "", /oidc_error=/);
  });
});

describe("offline mutation idempotency", () => {
  it("replays the same stock mutation only once", async () => {
    const item = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Idempotent rice", unit: "g", initialStock: { quantity: 100 } },
    });
    const key = `offline-${Date.now()}`;
    const first = await request(`/api/items/${item.data.id}/stock`, {
      method: "POST",
      body: { action: "add", quantity: 25, unit: "g", idempotencyKey: key },
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.quantity, 125);
    const replay = await request(`/api/items/${item.data.id}/stock`, {
      method: "POST",
      body: { action: "add", quantity: 25, unit: "g", idempotencyKey: key },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.quantity, 125);
  });

  it("rejects a stale count instead of silently overwriting", async () => {
    const item = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Conflict lentils", unit: "g", initialStock: { quantity: 50 } },
    });
    const stale = await request(`/api/items/${item.data.id}/stock`, {
      method: "POST",
      body: { action: "set", target: 10, baseUpdatedAt: "2000-01-01T00:00:00.000Z" },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.details.conflict, true);
  });
});

describe("backup usability", () => {
  const backupDir = path.join(dataDir, "backups");
  const preRestoreDir = path.join(backupDir, "pre-restore");
  const zips = async (dir: string, pattern: RegExp) => {
    const fs = await import("node:fs");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => pattern.test(name)) : [];
  };

  it("gives backups taken together distinct names and clears stale scratch files", async () => {
    const { createBackupArchive } = await import("../services/backup.js");
    const fs = await import("node:fs");
    fs.mkdirSync(backupDir, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const staleSnapshot = path.join(backupDir, ".snapshot-crashed.db");
    const stalePartial = path.join(backupDir, "svault-backup-crashed.zip.partial");
    const freshPartial = path.join(backupDir, "svault-backup-running.zip.partial");
    for (const file of [staleSnapshot, stalePartial, freshPartial]) fs.writeFileSync(file, "x");
    fs.utimesSync(staleSnapshot, old, old);
    fs.utimesSync(stalePartial, old, old);

    const [first, second] = await Promise.all([createBackupArchive(), createBackupArchive()]);
    assert.notEqual(first.name, second.name);
    assert.ok(fs.existsSync(first.path) && fs.existsSync(second.path));
    assert.ok(!fs.existsSync(staleSnapshot), "a crashed backup's snapshot is removed");
    assert.ok(!fs.existsSync(stalePartial), "a crashed backup's partial zip is removed");
    assert.ok(fs.existsSync(freshPartial), "a backup still running keeps its partial zip");
    fs.rmSync(freshPartial, { force: true });
  });

  it("keeps a pre-restore safety copy through more than five regular backups", async () => {
    const { createBackupArchive, createPreRestoreCopy, listBackups } = await import("../services/backup.js");
    const fs = await import("node:fs");
    const copy = await createPreRestoreCopy();
    assert.equal(path.dirname(copy.path), preRestoreDir);
    assert.match(copy.name, /^pre-restore-.*\.zip$/);

    for (let i = 0; i < 7; i++) await createBackupArchive();

    assert.ok(fs.existsSync(copy.path), "the pre-restore copy must not be rotated by regular backups");
    assert.equal((await zips(backupDir, /^svault-backup-.*\.zip$/)).length, 5);
    assert.deepEqual(await zips(backupDir, /^pre-restore-/), [], "safety copies never sit in the regular folder");

    const listed = listBackups();
    assert.equal(listed.filter((entry) => entry.kind === "backup").length, 5);
    const safety = listed.filter((entry) => entry.kind === "pre-restore");
    assert.ok(safety.some((entry) => entry.name === copy.name));
    for (const entry of listed) {
      assert.ok(entry.kind === "backup" || entry.kind === "pre-restore");
      assert.ok(entry.size > 0);
      assert.ok(!Number.isNaN(Date.parse(entry.createdAt)));
    }
    // The safety copy is a complete, restorable archive.
    const validation = await validateBackup(fs.readFileSync(copy.path));
    assert.ok(validation.manifest.checksums.database);
  });

  it("rotates pre-restore copies separately, keeping the newest three", async () => {
    const { createPreRestoreCopy } = await import("../services/backup.js");
    const fs = await import("node:fs");
    const regularBefore = (await zips(backupDir, /^svault-backup-.*\.zip$/)).sort();
    const copies = [];
    for (let i = 0; i < 4; i++) copies.push(await createPreRestoreCopy());
    const kept = (await zips(preRestoreDir, /^pre-restore-.*\.zip$/)).sort();
    assert.equal(kept.length, 3);
    for (const copy of copies.slice(-3)) assert.ok(fs.existsSync(copy.path));
    assert.deepEqual((await zips(backupDir, /^svault-backup-.*\.zip$/)).sort(), regularBefore);
  });

  it("streams uploads into an archive that validates, without backup folders inside", async () => {
    const { createBackupArchive } = await import("../services/backup.js");
    const fs = await import("node:fs");
    const { randomBytes } = await import("node:crypto");
    const uploadDir = path.join(dataDir, "uploads", "photos");
    const large = path.join(uploadDir, "streaming-test-large.bin");
    // Incompressible and large enough that the zip writer falls behind the
    // reader many times over, so the pause/resume path really runs.
    const payload = randomBytes(24 * 1024 * 1024);
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(large, payload);
    const empty = path.join(uploadDir, "streaming-test-empty.bin");
    fs.writeFileSync(empty, "");
    // A CLI --out folder is the user's: an old .partial there is never touched.
    const userPartial = path.join(mkdtempSync(path.join(tmpdir(), "svault-out-")), "download.zip.partial");
    fs.writeFileSync(userPartial, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(userPartial, twoHoursAgo, twoHoursAgo);
    const outDir = mkdtempSync(path.join(tmpdir(), "svault-stream-"));
    try {
      const archive = await createBackupArchive({ outFile: path.join(outDir, "out.zip") });
      assert.equal(archive.path, path.join(outDir, "out.zip"));
      assert.equal(archive.size, fs.statSync(archive.path).size);
      assert.deepEqual(fs.readdirSync(outDir), ["out.zip"], "no .partial file is left behind");

      const buffer = fs.readFileSync(archive.path);
      const validation = await validateBackup(buffer);
      const upload = validation.uploads.find((entry) => entry.name === "photos/streaming-test-large.bin");
      assert.ok(upload, "the large upload is in the archive");
      assert.ok(upload.data.equals(payload));
      const emptyUpload = validation.uploads.find((entry) => entry.name === "photos/streaming-test-empty.bin");
      assert.ok(emptyUpload, "an empty upload is archived without hanging");
      assert.equal(emptyUpload.data.length, 0);
      assert.ok(validation.manifest.checksums.uploads["photos/streaming-test-large.bin"]);

      const names = Object.keys((await JSZip.loadAsync(buffer)).files);
      assert.ok(names.includes("manifest.json"));
      assert.ok(!names.some((name) => /backups\/|pre-restore|svault-backup-/.test(name)), names.join(", "));
      const userOut = await createBackupArchive({ outFile: path.join(path.dirname(userPartial), "out.zip") });
      assert.ok(fs.existsSync(userPartial), "files beside a CLI --out path are left alone");
      fs.rmSync(userOut.path, { force: true });
    } finally {
      fs.rmSync(large, { force: true });
      fs.rmSync(empty, { force: true });
      rmSync(path.dirname(userPartial), { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("serves the backup download as a valid streamed zip", async () => {
    const res = await fetch(`${base}/api/houses/${houseId}/backup`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /zip/);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="?svault-backup-.*\.zip"?/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(Number(res.headers.get("content-length")), bytes.length);
    const validation = await validateBackup(bytes);
    assert.ok(validation.manifest.checksums.database);

    const list = await request(`/api/houses/${houseId}/backups`);
    assert.equal(list.status, 200);
    assert.ok(list.data.backups.some((entry: { kind: string }) => entry.kind === "backup"));
    assert.ok(list.data.backups.some((entry: { kind: string }) => entry.kind === "pre-restore"));
  });
});

describe("backup and restore", () => {
  it("creates a valid zip with a manifest and checksums", async () => {
    const { buffer, validation } = await backupForTest();
    assert.ok(buffer.length > 0);
    assert.ok(validation.manifest.format === 1 || validation.manifest.format === 2);
    assert.ok(validation.manifest.checksums.database);
    assert.ok((validation.database?.length ?? 0) > 0 || Object.keys(validation.dump?.tables ?? {}).length > 0);
  });

  it("serves the backup download to an owner", async () => {
    const res = await fetch(`${base}/api/houses/${houseId}/backup`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /zip/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
  });

  it("rejects corrupt archives, unsafe paths and newer schemas", async () => {
    await assert.rejects(() => validateBackup(Buffer.from("not a zip")));

    const unsafe = new JSZip();
    unsafe.file("../escape.txt", "nope");
    unsafe.file("manifest.json", JSON.stringify({ format: 1, schemaVersion: 1, checksums: {} }));
    unsafe.file("svault.db", Buffer.from("x"));
    const unsafeBuffer = await unsafe.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => validateBackup(unsafeBuffer), /Unsafe archive path/);

    const { buffer } = await backupForTest();
    const newer = await JSZip.loadAsync(buffer);
    const manifest = JSON.parse(await newer.file("manifest.json")!.async("string"));
    manifest.schemaVersion = 999;
    newer.file("manifest.json", JSON.stringify(manifest));
    const newerBuffer = await newer.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => validateBackup(newerBuffer), /supports up to/);
  });
});

describe("dataset import", () => {
  const png = () => encodePng(8, 8, Buffer.alloc(8 * 8 * 4, 180));

  it("parses YOLO labels, classes and splits", async () => {
    const zip = new JSZip();
    zip.file("classes.txt", "apple\npear\n");
    zip.file("train/images/a.png", png());
    zip.file("train/labels/a.txt", "0 0.5 0.5 0.2 0.2\n1 0.2 0.2 0.1 0.1\n");
    zip.file("val/images/b.png", png());
    zip.file("val/labels/b.txt", "0 0.3 0.3 0.1 0.1\n");
    const inspection = await inspectDataset(await zip.generateAsync({ type: "nodebuffer" }));
    assert.equal(inspection.kind, "yolo");
    assert.deepEqual(inspection.classes, ["apple", "pear"]);
    assert.equal(inspection.images.length, 2);
    assert.equal(inspection.splits.train, 1);
    assert.equal(inspection.splits.val, 1);
  });

  it("imports boxes while merging and skipping classes", async () => {
    const zip = new JSZip();
    zip.file("classes.txt", "apple\npear\n");
    zip.file("train/images/a.png", png());
    zip.file("train/labels/a.txt", "0 0.5 0.5 0.2 0.2\n1 0.2 0.2 0.1 0.1\n");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await importDataset({
      houseId,
      userId: (await request("/api/auth/me")).data.user.id,
      buffer,
      mapping: { apple: "Imported apple", pear: "__skip" },
      collectionName: "Test dataset",
    });
    assert.equal(result.imported, 1);
    assert.equal(result.labels, 1);
    const collection = (await request(`/api/houses/${houseId}/collections`)).data.find(
      (entry: any) => entry.id === result.collectionId,
    );
    assert.equal(collection.photoCount, 1);
    const review = await request(`/api/houses/${houseId}/photos/review`);
    assert.ok(review.data.photos.some((photo: any) => photo.collectionId === result.collectionId && photo.labels[0].label === "Imported apple"));
  });

  it("rejects path traversal in a dataset archive", async () => {
    const zip = new JSZip();
    zip.file("../evil.png", png());
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => inspectDataset(buffer), /Unsafe archive path/);
  });

  it("reads COCO annotations with absolute boxes", async () => {
    const zip = new JSZip();
    zip.file("images/c.png", png());
    zip.file(
      "annotations.json",
      JSON.stringify({
        images: [{ id: 1, file_name: "c.png", width: 8, height: 8 }],
        categories: [{ id: 7, name: "crate" }],
        annotations: [{ id: 1, image_id: 1, category_id: 7, bbox: [1, 2, 4, 4] }],
      }),
    );
    const inspection = await inspectDataset(await zip.generateAsync({ type: "nodebuffer" }));
    assert.equal(inspection.kind, "coco");
    assert.deepEqual(inspection.classes, ["crate"]);
    assert.equal(inspection.images[0].labels[0].w, 0.5);
  });
});

describe("receipt scan fixes", () => {
  let plainHouse = "";
  let aiHouse = "";
  let fixAiServer: import("node:http").Server;
  let fixAiBase = "";
  const fixAiRequests: any[] = [];
  let fixReceiptPayload: any = null;
  let fridgeId = "";

  async function uploadReceiptPng(targetHouse: string, size = 16) {
    const png = encodePng(size, size, Buffer.alloc(size * size * 4, 180));
    const bytes = new ArrayBuffer(png.length);
    new Uint8Array(bytes).set(png);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "receipt.png");
    const res = await fetch(`${base}/api/houses/${targetHouse}/receipts/upload`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    assert.equal(res.status, 201);
    return (await res.json()).path as string;
  }

  function uploadFile(imagePath: string) {
    return path.join(dataDir, "uploads", "receipts", imagePath.split("/").pop()!);
  }

  before(async () => {
    await new Promise<void>((resolve) => {
      fixAiServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          fixAiRequests.push(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(fixReceiptPayload ?? { lines: [] }) } }],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.004 },
            }),
          );
        });
      });
      fixAiServer.listen(0, "127.0.0.1", () => {
        const address = fixAiServer.address();
        if (!address || typeof address === "string") throw new Error("no address");
        fixAiBase = `http://127.0.0.1:${address.port}/v1`;
        resolve();
      });
    });

    const plain = await request("/api/houses", { method: "POST", body: { name: "Receipt fixes", currency: "EUR" } });
    assert.equal(plain.status, 201);
    plainHouse = plain.data.id;
    const withAi = await request("/api/houses", { method: "POST", body: { name: "Receipt fixes AI", currency: "EUR" } });
    assert.equal(withAi.status, 201);
    aiHouse = withAi.data.id;
    const configured = await request(`/api/houses/${aiHouse}`, {
      method: "PATCH",
      body: { settings: { ai: { enabled: true, baseUrl: fixAiBase, apiKey: "fix-key", model: "fix-model" } } },
    });
    assert.equal(configured.status, 200);

    const locations = await request(`/api/houses/${plainHouse}/locations`);
    fridgeId = locations.data.find((entry: any) => entry.name === "Fridge").id;
  });

  after(() => {
    fixAiServer?.close();
  });

  it("reports whether the lines add up to the printed total", async () => {
    const matching = await request(`/api/houses/${plainHouse}/receipts/scan`, {
      method: "POST",
      body: { text: "CORNER SHOP\nMilk 2.40\nBread 3.10\nDiscount -0.50\nTOTAL 5.00" },
    });
    assert.equal(matching.status, 200);
    assert.deepEqual(matching.data.reconciliation, {
      linesTotal: 5.5,
      savings: 0.5,
      printedTotal: 5,
      difference: 0,
      ok: true,
    });
    assert.equal(matching.data.aiAvailable, false);
    assert.match(matching.data.scanId, /^scn_/);

    const short = await request(`/api/houses/${plainHouse}/receipts/scan`, {
      method: "POST",
      body: { text: "CORNER SHOP\nMilk 2.40\nBread 3.10\nTOTAL 9.99" },
    });
    assert.equal(short.data.reconciliation.ok, false);
    assert.equal(short.data.reconciliation.difference, 4.49);

    // Lidl folds discounts into the line totals; the tolerance absorbs the 0.10 bag fee.
    const lidl = await request(`/api/houses/${plainHouse}/receipts/scan`, { method: "POST", body: { text: LIDL_SAMPLE } });
    assert.equal(lidl.data.provider, "template");
    assert.equal(lidl.data.reconciliation.ok, true);
    assert.equal(lidl.data.reconciliation.savings, 1.04);
  });

  it("reports when a requested AI re-read is unavailable for a recognized template", async () => {
    const result = await request(`/api/houses/${plainHouse}/receipts/scan`, {
      method: "POST", body: { text: LIDL_SAMPLE, preferAi: true },
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.provider, "template");
    assert.match(result.data.warning, /AI re-read is unavailable/);
  });

  it("keeps a lower-confidence template without AI when its lines add up", async () => {
    fixAiRequests.length = 0;
    fixReceiptPayload = {
      vendorName: "Lidl",
      total: 3.5,
      lines: [{ description: "Γάλα", quantity: 1, lineTotal: 3.5 }],
    };
    // Only the logo and the fiscal header match: 0.7 confidence, below the 0.75 bar.
    const text = ["LIDL", "ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ", "ΓΑΛΑ 1,50 13,00%", "ΨΩΜΙ 2,00 13,00%", "ΣΥΝΟΛΟ 3,50"].join("\n");
    const res = await request(`/api/houses/${aiHouse}/receipts/scan`, { method: "POST", body: { text } });
    assert.equal(res.status, 200);
    assert.equal(fixAiRequests.length, 0);
    assert.equal(res.data.provider, "template");
    assert.equal(res.data.draft.templateId, "lidl-gr");
    assert.equal(res.data.draft.lines.length, 2);
    assert.equal(res.data.aiCost, null);
  });

  it("recognises excluded Lidl charges before deciding to call AI", async () => {
    fixAiRequests.length = 0;
    const text = ["ΛΙΝΤΑ ΕΛΛΑΣ", "ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ ΕΝΑΡΞΗ",
      "ΤΣ.Π.ΧΡ.ΜΕΓ.38Λ.1ΤΕΜ 0,80 24.00%", "ΠΕΡΙΒΑΝ.ΤΕΛΟΣ 0,09 24.00%",
      "ΓΙΑΟΥΡΤΙ 2,55 13.00%", "ΣΥΝΟΛΟ 3,44"].join("\n");
    const result = await request(`/api/houses/${aiHouse}/receipts/scan`, { method: "POST", body: { text } });
    assert.equal(result.data.provider, "template");
    assert.equal(fixAiRequests.length, 0);
    assert.equal(result.data.reconciliation.difference, 0.89);
    assert.match(result.data.warning, /0\.89/);
    fixReceiptPayload = { lines: [] };
    const reread = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST", body: { text, preferAi: true },
    });
    assert.equal(reread.data.provider, "template");
    assert.match(reread.data.warning, /0\.89/);
    assert.match(reread.data.warning, /AI did not find any product lines/);
    fixAiRequests.length = 0;
    const incomplete = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST", body: { text: text.replace("3,44", "5,44") },
    });
    assert.equal(fixAiRequests.length, 0);
    assert.equal(incomplete.status, 200);
    assert.match(incomplete.data.warning, /do not match/);
  });

  it("selects a better OCR candidate locally without discarding products or barcodes", async () => {
    fixAiRequests.length = 0;
    const baseline = ["ΕΛΛΗΝΙΚΕΣ ΥΠΕΡΑΓΟΡΕΣ", "ΣΚΛΑΒΕΝΙΤΗΣ", "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ",
      "5208046287576", "ΓΑΛΑ 2,00 13%", "ΨΩΜΙ 4,00 13%", "ΣΥΝΟΛΟ 5,00"].join("\n");
    const incomplete = baseline.replace("5208046287576\nΓΑΛΑ 2,00 13%\n", "").replace("4,00", "5,00");
    const better = baseline.replace("ΨΩΜΙ 4,00", "ΨΩΜΙ 3,00");
    const res = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST", body: { text: baseline, candidates: [incomplete, better] },
    });
    assert.equal(res.data.provider, "template");
    assert.equal(res.data.selectedText, better);
    assert.equal(res.data.reconciliation.difference, 0);
    assert.equal(res.data.draft.lines.length, 2);
    assert.equal(res.data.draft.lines[0].barcode, "5208046287576");
    assert.equal(fixAiRequests.length, 0);
    assert.match(res.data.warning, /different OCR reading/);
    const rejected = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST", body: { text: baseline, candidates: [incomplete, better.replace("ΣΥΝΟΛΟ 5,00", "ΣΥΝΟΛΟ 6,00")] },
    });
    assert.equal(rejected.data.selectedText, undefined);
    assert.equal(rejected.data.reconciliation.difference, -1);
    assert.match(rejected.data.warning, /OCR readings disagree/);
    const noTotal = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST", body: { text: baseline.replace("ΣΥΝΟΛΟ 5,00", ""), candidates: [better] },
    });
    assert.equal(noTotal.data.selectedText, undefined);
    assert.match(noTotal.data.warning, /total was not recognised/);
  });

  it("uses AI only when a re-read is requested", async () => {
    fixAiRequests.length = 0;
    fixReceiptPayload = {
      vendorName: "Lidl",
      purchasedAt: "2026-10-08",
      currency: "EUR",
      total: 15.73,
      lines: [
        { description: "Apples", quantity: 1, lineTotal: 10.63 },
        { description: "Olive oil", quantity: 1, lineTotal: 5.1 },
      ],
    };
    const text = LIDL_SAMPLE.replaceAll("10,73", "15,73");
    const res = await request(`/api/houses/${aiHouse}/receipts/scan`, { method: "POST", body: { text } });
    assert.equal(res.status, 200);
    assert.equal(fixAiRequests.length, 0);
    assert.equal(res.data.provider, "template");
    assert.equal(res.data.reconciliation.ok, false);

    // "Re-read with AI" bypasses a confident template on request.
    fixReceiptPayload = { total: 10.73, lines: [{ description: "Everything", quantity: 1, lineTotal: 10.73 }] };
    const forced = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST",
      body: { text: LIDL_SAMPLE, preferAi: true },
    });
    assert.equal(forced.data.provider, "ai");
    assert.equal(forced.data.draft.lines[0].description, "Everything");
  });

  it("keeps bulk receipt intake local until AI is requested", async () => {
    fixAiRequests.length = 0;
    fixReceiptPayload = { vendorName: "Corner Market", total: 2, lines: [{ description: "Tea", quantity: 1, lineTotal: 2 }] };
    const text = "CORNER MARKET\nTea 2.00\nTOTAL 2.00";
    const local = await request(`/api/houses/${aiHouse}/intake/parse`, { method: "POST", body: { text } });
    assert.equal(local.data.provider, "local");
    assert.equal(local.data.aiAvailable, true);
    assert.equal(fixAiRequests.length, 0);
    const ai = await request(`/api/houses/${aiHouse}/intake/parse`, { method: "POST", body: { text, preferAi: true } });
    assert.equal(ai.data.provider, "ai");
    assert.equal(fixAiRequests.length, 1);
    fixReceiptPayload = { lines: [] };
    const empty = await request(`/api/houses/${aiHouse}/intake/parse`, { method: "POST", body: { text, preferAi: true } });
    assert.equal(empty.data.provider, "local");
    assert.ok(empty.data.rows.length > 0);
    assert.match(empty.data.warning, /local result was kept/);
  });

  it("keeps generic local receipt lines when an AI re-read finds none", async () => {
    fixReceiptPayload = { lines: [] };
    const result = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST", body: { text: "CORNER MARKET\nTea 2.00\nTOTAL 2.00", preferAi: true },
    });
    assert.equal(result.data.provider, "local");
    assert.ok(result.data.draft.lines.length > 0);
    assert.match(result.data.warning, /local result was kept/);
  });

  it("does not offer an AI reread for image-only input without a vision model", async () => {
    const image = await uploadReceiptPng(aiHouse);
    const receipt = await request(`/api/houses/${aiHouse}/receipts/scan`, { method: "POST", body: { image } });
    const intake = await request(`/api/houses/${aiHouse}/intake/parse`, { method: "POST", body: { image } });
    assert.equal(receipt.data.aiAvailable, false);
    assert.equal(intake.data.aiAvailable, false);
  });

  it("sends every page photo to the vision model with its real mime type", async () => {
    await request(`/api/houses/${aiHouse}`, { method: "PATCH", body: { settings: { ai: { visionModel: "fix-vision" } } } });
    const first = await uploadReceiptPng(aiHouse);
    const second = await uploadReceiptPng(aiHouse);
    fixReceiptPayload = { total: 2, lines: [{ description: "Tea", quantity: 1, lineTotal: 2 }] };
    fixAiRequests.length = 0;
    const res = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST",
      body: { text: "", images: [first, second, "/uploads/receipts/missing-page.jpg"], preferAi: true },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.provider, "ai");
    const parts = fixAiRequests[0].messages[1].content;
    const images = parts.filter((part: any) => part.type === "image_url");
    assert.equal(images.length, 2);
    assert.ok(images.every((part: any) => part.image_url.url.startsWith("data:image/png;base64,")));
    assert.match(res.data.warning, /1 of 3 photos could not be sent/);

    const invalid = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST",
      body: { images: ["https://tracker.example/pixel.gif"] },
    });
    assert.equal(invalid.status, 400);
    await request(`/api/houses/${aiHouse}`, { method: "PATCH", body: { settings: { ai: { visionModel: null } } } });
  });

  it("copies provenance from the scan record instead of trusting the client", async () => {
    fixReceiptPayload = {
      vendorName: "Provenance Mart",
      purchasedAt: "2026-09-01",
      total: 4,
      lines: [{ description: "Provenance tea", quantity: 1, lineTotal: 4 }],
    };
    const scan = await request(`/api/houses/${aiHouse}/receipts/scan`, {
      method: "POST",
      body: { text: "PROVENANCE MART\nTea 4.00\nTOTAL 4.00", preferAi: true },
    });
    assert.equal(scan.data.provider, "ai");
    const body = {
      vendorName: "Provenance Mart",
      purchasedAt: "2026-09-01",
      total: 4,
      provider: "template",
      aiCost: 99,
      templateId: "lidl-gr",
      templateConfidence: 1,
      lines: [{ description: "Provenance tea", quantity: 1, lineTotal: 4 }],
    };
    const saved = await request(`/api/houses/${aiHouse}/receipts`, { method: "POST", body: { ...body, scanId: scan.data.scanId } });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.equal(saved.data.provider, "ai");
    assert.equal(saved.data.aiCost, 0.004);
    assert.equal(saved.data.templateId, null);
    assert.equal(saved.data.source, "scan");

    const unknown = await request(`/api/houses/${aiHouse}/receipts`, {
      method: "POST",
      body: { ...body, purchasedAt: "2026-09-02", scanId: "scn_doesnotexist" },
    });
    assert.equal(unknown.status, 201);
    assert.equal(unknown.data.provider, null);
    assert.equal(unknown.data.aiCost, null);
    assert.equal(unknown.data.templateId, null);
    assert.equal(unknown.data.source, "manual");

    // A scan from one house cannot lend its provenance to another.
    const foreign = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { ...body, scanId: scan.data.scanId },
    });
    assert.equal(foreign.status, 201);
    assert.equal(foreign.data.provider, null);
  });

  it("only stores receipt images that were uploaded as receipt scans", async () => {
    const body = {
      vendorName: "Image Mart",
      purchasedAt: "2026-09-03",
      lines: [{ description: "Image soap", quantity: 1, lineTotal: 1 }],
    };
    const external = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { ...body, image: "https://tracker.example/pixel.gif" },
    });
    assert.equal(external.status, 400);
    const traversal = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { ...body, image: "/uploads/receipts/../photos/x.jpg" },
    });
    assert.equal(traversal.status, 400);
    const missing = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { ...body, image: "/uploads/receipts/not-there.jpg" },
    });
    assert.equal(missing.status, 400);

    const image = await uploadReceiptPng(plainHouse);
    const saved = await request(`/api/houses/${plainHouse}/receipts`, { method: "POST", body: { ...body, image } });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.image, image);
  });

  it("deletes superseded uploads but never one a saved receipt uses", async () => {
    const { existsSync } = await import("node:fs");
    const draftImage = await uploadReceiptPng(plainHouse);
    assert.ok(existsSync(uploadFile(draftImage)));

    const foreign = await request(`/api/houses/${aiHouse}/receipts/upload`, { method: "DELETE", body: { path: draftImage } });
    assert.equal(foreign.status, 404);
    const bad = await request(`/api/houses/${plainHouse}/receipts/upload`, {
      method: "DELETE",
      body: { path: "/uploads/photos/x.jpg" },
    });
    assert.equal(bad.status, 400);

    const removed = await request(`/api/houses/${plainHouse}/receipts/upload`, { method: "DELETE", body: { path: draftImage } });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.deleted, true);
    assert.ok(!existsSync(uploadFile(draftImage)));

    const kept = await uploadReceiptPng(plainHouse);
    const saved = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { vendorName: "Kept Mart", purchasedAt: "2026-09-04", image: kept, lines: [{ description: "Kept soap", lineTotal: 1 }] },
    });
    assert.equal(saved.status, 201);
    const refused = await request(`/api/houses/${plainHouse}/receipts/upload`, { method: "DELETE", body: { path: kept } });
    assert.equal(refused.status, 409);
    assert.ok(existsSync(uploadFile(kept)));
  });

  it("refuses an identical receipt unless the duplicate is confirmed", async () => {
    const body = {
      vendorName: "Twice Mart",
      purchasedAt: "2026-09-05",
      total: 7.5,
      lines: [{ description: "Twice coffee", quantity: 1, lineTotal: 7.5 }],
    };
    const first = await request(`/api/houses/${plainHouse}/receipts`, { method: "POST", body });
    assert.equal(first.status, 201);
    const itemId = first.data.lines[0].itemId;

    const again = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { ...body, vendorName: "TWICE  mart", total: 7.505 },
    });
    assert.equal(again.status, 409);
    assert.equal(again.data.duplicateOf.id, first.data.id);
    assert.equal(again.data.duplicateOf.total, 7.5);
    assert.equal(again.data.duplicateOf.vendorName, "Twice Mart");
    assert.equal((await request(`/api/items/${itemId}`)).data.quantity, 1);

    const validated = await request(`/api/houses/${plainHouse}/receipts/validate`, { method: "POST", body });
    assert.equal(validated.data.duplicateOf.id, first.data.id);

    const otherDay = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { ...body, purchasedAt: "2026-09-06" },
    });
    assert.equal(otherDay.status, 201);

    const confirmed = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { ...body, allowDuplicate: true },
    });
    assert.equal(confirmed.status, 201);
    assert.equal((await request(`/api/items/${itemId}`)).data.quantity, 3);
  });

  it("validates every line without writing and reports all errors on import", async () => {
    const oil = await request(`/api/houses/${plainHouse}/items`, { method: "POST", body: { name: "Validate oil", unit: "l" } });
    assert.equal(oil.status, 201);
    const itemsBefore = (await request(`/api/houses/${plainHouse}/items?limit=1000`)).data.total;
    const receiptsBefore = (await request(`/api/houses/${plainHouse}/receipts?limit=300`)).data.length;
    const vendorsBefore = (await request(`/api/houses/${plainHouse}/vendors`)).data.length;

    const body = {
      vendorName: "Validate Mart",
      purchasedAt: "2026-09-07",
      lines: [
        { description: "Validate oil", quantity: 2, unit: "pcs", lineTotal: 9 },
        { description: "Validate brand new thing", quantity: 1, lineTotal: 1 },
        { description: "Validate brand new thing", quantity: 1, lineTotal: 1 },
        { description: "Chosen", quantity: 1, itemId: "itm_missing" },
        { description: "Validate oil", quantity: 1, unit: "ml", lineTotal: 2, locationId: "loc_missing" },
        { description: "Validate oil", quantity: 500, unit: "ml", lineTotal: 2 },
      ],
    };
    const res = await request(`/api/houses/${plainHouse}/receipts/validate`, { method: "POST", body });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.newItems, 1);
    const [unitError, created, sameNew, chosen, place, fine] = res.data.lines;
    assert.match(unitError.error, /Cannot add “Validate oil” in pcs to an item stocked in l/);
    assert.equal(unitError.itemId, oil.data.id);
    assert.equal(created.willCreate, true);
    assert.equal(created.error, null);
    assert.equal(sameNew.willCreate, false);
    assert.equal(sameNew.itemName, "Validate brand new thing");
    assert.match(chosen.error, /not in this house/);
    assert.match(place.error, /place is not in this house/);
    assert.equal(fine.error, null);
    assert.equal(fine.itemId, oil.data.id);
    assert.equal(fine.match, "name");

    assert.equal((await request(`/api/houses/${plainHouse}/items?limit=1000`)).data.total, itemsBefore);
    assert.equal((await request(`/api/houses/${plainHouse}/vendors`)).data.length, vendorsBefore);

    const imported = await request(`/api/houses/${plainHouse}/receipts`, { method: "POST", body });
    assert.equal(imported.status, 400);
    assert.deepEqual(
      imported.data.details.lines.map((entry: any) => entry.index),
      [0, 3, 4],
    );
    assert.equal((await request(`/api/houses/${plainHouse}/receipts?limit=300`)).data.length, receiptsBefore);
    assert.equal((await request(`/api/houses/${plainHouse}/items?limit=1000`)).data.total, itemsBefore);
  });

  it("puts each line in its own place with its own expiry date", async () => {
    const res = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Expiry Mart",
        purchasedAt: "2026-09-08",
        lines: [
          { description: "Expiry yoghurt", quantity: 2, lineTotal: 3, locationId: fridgeId, expiresAt: "2026-09-20" },
          { description: "Expiry rice", quantity: 1, lineTotal: 2 },
        ],
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const yoghurt = await request(`/api/items/${res.data.lines[0].itemId}`);
    assert.equal(yoghurt.data.lots[0].locationId, fridgeId);
    assert.equal(yoghurt.data.lots[0].expiresAt, "2026-09-20");
    const rice = await request(`/api/items/${res.data.lines[1].itemId}`);
    assert.equal(rice.data.lots[0].locationId, null);
    assert.equal(rice.data.lots[0].expiresAt, null);

    const badDate = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { vendorName: "Expiry Mart", lines: [{ description: "Expiry rice", expiresAt: "20/09/2026" }] },
    });
    assert.equal(badDate.status, 400);
  });

  it("deletes the receipt image and can revert the stock it added", async () => {
    const { existsSync } = await import("node:fs");
    const image = await uploadReceiptPng(plainHouse);
    const created = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Revert Mart",
        purchasedAt: "2026-09-09",
        image,
        lines: [
          { description: "Revert apples", quantity: 3, lineTotal: 3 },
          { description: "Revert pears", quantity: 2, lineTotal: 2 },
        ],
      },
    });
    assert.equal(created.status, 201);
    const [applesId, pearsId] = created.data.lines.map((line: any) => line.itemId);
    const eaten = await request(`/api/items/${applesId}/stock`, { method: "POST", body: { action: "remove", quantity: 1 } });
    assert.equal(eaten.status, 200);
    // Stock added by hand is not part of the receipt and must stay.
    await request(`/api/items/${pearsId}/stock`, { method: "POST", body: { action: "add", quantity: 5 } });

    const removed = await request(`/api/receipts/${created.data.id}?revertStock=true`, { method: "DELETE" });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(removed.data.imageRemoved, true);
    assert.ok(!existsSync(uploadFile(image)));
    const apples = removed.data.reverted.find((entry: any) => entry.itemId === applesId);
    assert.deepEqual(
      { added: apples.added, reverted: apples.reverted, consumed: apples.consumed },
      { added: 3, reverted: 2, consumed: 1 },
    );
    const pears = removed.data.reverted.find((entry: any) => entry.itemId === pearsId);
    assert.equal(pears.reverted, 2);

    const applesAfter = await request(`/api/items/${applesId}`);
    assert.equal(applesAfter.data.quantity, 0);
    const adjustment = applesAfter.data.movements.find((movement: any) => movement.type === "adjust");
    assert.ok(adjustment);
    assert.equal(adjustment.delta, -2);
    assert.equal((await request(`/api/items/${pearsId}`)).data.quantity, 5);
    assert.equal((await request(`/api/receipts/${created.data.id}`)).status, 404);

    // Without the flag the stock stays.
    const kept = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: { vendorName: "Revert Mart", purchasedAt: "2026-09-10", lines: [{ description: "Revert apples", quantity: 1, lineTotal: 1 }] },
    });
    const plainDelete = await request(`/api/receipts/${kept.data.id}`, { method: "DELETE" });
    assert.equal(plainDelete.status, 200);
    assert.deepEqual(plainDelete.data.reverted, []);
    assert.equal((await request(`/api/items/${applesId}`)).data.quantity, 1);
  });

  it("matches items by whole words, respects units and learns only confirmed links", async () => {
    const milk = await request(`/api/houses/${plainHouse}/items`, { method: "POST", body: { name: "Oat milk", unit: "l" } });
    const bread = await request(`/api/houses/${plainHouse}/items`, {
      method: "POST",
      body: { name: "Sourdough rye bread", unit: "pcs" },
    });
    const greek = await request(`/api/houses/${plainHouse}/items`, { method: "POST", body: { name: "Γάλα φρέσκο", unit: "l" } });
    const flour = await request(`/api/houses/${plainHouse}/items`, { method: "POST", body: { name: "Stoneground rye flour", unit: "kg" } });

    const res = await request(`/api/houses/${plainHouse}/receipts/validate`, {
      method: "POST",
      body: {
        vendorName: "Match Mart",
        lines: [
          { description: "Oat milk chocolate", quantity: 1 },
          { description: "Sourdough rye bread loaf", quantity: 1 },
          { description: "ΓΑΛΑ ΦΡΕΣΚΟ 1L", quantity: 1, unit: "l" },
          { description: "Stoneground rye flour sack", quantity: 1, unit: "pcs" },
        ],
      },
    });
    assert.equal(res.status, 200);
    const [chocolate, loaf, gala, sack] = res.data.lines;
    assert.equal(chocolate.willCreate, true, "“oat milk chocolate” is not oat milk");
    assert.notEqual(chocolate.itemId, milk.data.id);
    assert.equal(loaf.itemId, bread.data.id);
    assert.equal(loaf.match, "fuzzy");
    assert.equal(gala.itemId, greek.data.id);
    // Close name, but pieces cannot be stocked as kilograms: a new item instead.
    assert.notEqual(sack.itemId, flour.data.id);
    assert.equal(sack.willCreate, true);

    const imported = await request(`/api/houses/${plainHouse}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Match Mart",
        purchasedAt: "2026-09-11",
        lines: [
          { description: "Sourdough rye bread loaf", quantity: 1, lineTotal: 2 },
          { description: "MILK FRESH 1L", rawDescription: "MILK FRESH 1L", quantity: 1, unit: "l", lineTotal: 1, itemId: milk.data.id },
        ],
      },
    });
    assert.equal(imported.status, 201, JSON.stringify(imported.data));
    assert.equal(imported.data.lines[0].itemId, bread.data.id);
    assert.equal((await request(`/api/items/${bread.data.id}/aliases`)).data.length, 0, "fuzzy matches are not learned");
    const milkAliases = await request(`/api/items/${milk.data.id}/aliases`);
    assert.equal(milkAliases.data.length, 1, "a chosen item is learned");
    assert.equal(milkAliases.data[0].rawName, "MILK FRESH 1L");
  });
});

describe("insights, household split and admin console", () => {
  let insightHouse = "";
  let secondUserId = "";
  let milkId = "";
  let latestReceiptId = "";
  const month = new Date().toISOString().slice(0, 7);
  const at = (day: number) => `${month}-${String(day).padStart(2, "0")}`;

  it("creates a house and puts a second member in it", async () => {
    const created = await request("/api/houses", { method: "POST", body: { name: "Insight House", currency: "EUR" } });
    assert.equal(created.status, 201);
    insightHouse = created.data.id;
    const me = await request("/api/auth/me", { auth: secondUserCookie });
    secondUserId = me.data.user.id;
    await run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
      insightHouse,
      secondUserId,
      "member",
      new Date().toISOString(),
    ]);
  });

  it("imports receipts that feed spend, price alerts and the household split", async () => {
    const milk = await request(`/api/houses/${insightHouse}/items`, {
      method: "POST",
      body: { name: "Insight milk", unit: "l", reorderPoint: 1 },
    });
    assert.equal(milk.status, 201);
    milkId = milk.data.id;

    for (const [day, total] of [
      [1, 1],
      [2, 1],
      [3, 1.5],
    ] as const) {
      const imported = await request(`/api/houses/${insightHouse}/receipts`, {
        method: "POST",
        body: {
          vendorName: "Price Mart",
          purchasedAt: at(day),
          currency: "EUR",
          total,
          lines: [{ description: "Insight milk", itemId: milkId, quantity: 1, unit: "l", lineTotal: total }],
        },
      });
      assert.equal(imported.status, 201, JSON.stringify(imported.data));
      if (day === 3) latestReceiptId = imported.data.id;
    }
  });

  it("tracks the budget and monthly spend", async () => {
    const saved = await request(`/api/houses/${insightHouse}/insights/settings`, {
      method: "PATCH",
      body: { monthlyBudget: 10, priceAlertPercent: 20 },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));

    assert.equal(
      (
        await request(`/api/houses/${insightHouse}/insights/settings`, {
          method: "PATCH",
          body: { priceAlertPercent: 0 },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/houses/${insightHouse}/insights/settings`, {
          method: "PATCH",
          body: { monthlyBudget: -1 },
        })
      ).status,
      400,
    );

    const spend = await request(`/api/houses/${insightHouse}/insights/spend?months=6`);
    assert.equal(spend.status, 200);
    assert.equal(spend.data.monthTotal, 3.5);
    assert.equal(spend.data.budget, 10);
    assert.equal(spend.data.budgetPercent, 35);
    assert.equal(spend.data.byShop[0].vendorName, "Price Mart");
  });

  it("keeps insights inside the house and settings admin-only", async () => {
    const forbidden = await request(`/api/houses/${insightHouse}/insights/settings`, {
      auth: secondUserCookie,
      method: "PATCH",
      body: { monthlyBudget: 1 },
    });
    assert.equal(forbidden.status, 403);

    const foreign = await request("/api/houses", {
      auth: secondUserCookie,
      method: "POST",
      body: { name: "Private insights house", currency: "EUR" },
    });
    assert.equal(foreign.status, 201);
    for (const path of ["spend", "waste", "household", "use-it-up", "shopping-prices", "price-alerts"]) {
      assert.equal((await request(`/api/houses/${foreign.data.id}/insights/${path}`)).status, 404, path);
    }
  });

  it("finds purchases that are clearly above the usual price", async () => {
    const alerts = await request(`/api/houses/${insightHouse}/insights/price-alerts`);
    assert.equal(alerts.status, 200);
    const milkAlert = alerts.data.alerts.find((alert: any) => alert.itemId === milkId);
    assert.ok(milkAlert, JSON.stringify(alerts.data));
    assert.equal(milkAlert.price, 1.5);
    assert.equal(milkAlert.averagePrice, 1);
    assert.equal(milkAlert.percent, 50);
    assert.equal(milkAlert.vendorName, "Price Mart");

    const scanned = await request(`/api/houses/${insightHouse}/insights/price-alerts/scan`, { method: "POST", body: {} });
    assert.equal(scanned.status, 200);
    // The import that introduced the price already created the reminder.
    assert.ok(scanned.data.created === 0 || scanned.data.created === 1);
    const reminders = await request(`/api/houses/${insightHouse}/notifications`);
    const priceReminders = reminders.data.notifications.filter((entry: any) => entry.type === "price_alert");
    assert.equal(priceReminders.length, 1, "one reminder per item and month");

    // A purchase exactly at the threshold is not "above" it.
    const stricter = await request(`/api/houses/${insightHouse}/insights/settings`, {
      method: "PATCH",
      body: { priceAlertPercent: 50 },
    });
    assert.equal(stricter.status, 200);
    const none = await request(`/api/houses/${insightHouse}/insights/price-alerts`);
    assert.ok(!none.data.alerts.some((alert: any) => alert.itemId === milkId));
    await request(`/api/houses/${insightHouse}/insights/settings`, {
      method: "PATCH",
      body: { priceAlertPercent: 20 },
    });
  });

  it("suggests recipes and items to use up before they expire", async () => {
    const soon = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
    const yoghurt = await request(`/api/houses/${insightHouse}/items`, {
      method: "POST",
      body: {
        name: "Useup yoghurt",
        unit: "pcs",
        initialStock: { quantity: 1, expiresAt: soon, unitPrice: 2 },
      },
    });
    assert.equal(yoghurt.status, 201);
    const result = await request(`/api/houses/${insightHouse}/insights/use-it-up?days=7`);
    assert.equal(result.status, 200);
    assert.ok(result.data.items.some((item: any) => item.name === "Useup yoghurt"));
  });

  it("prices open shopping lines from recent receipts", async () => {
    const line = await request(`/api/houses/${insightHouse}/shopping`, {
      method: "POST",
      body: { name: "Insight milk", itemId: milkId, quantity: 1, unit: "l" },
    });
    assert.equal(line.status, 201, JSON.stringify(line.data));
    const hints = await request(`/api/houses/${insightHouse}/insights/shopping-prices`);
    assert.equal(hints.status, 200);
    const hint = hints.data.hints.find((entry: any) => entry.itemId === milkId);
    assert.ok(hint, JSON.stringify(hints.data));
    assert.equal(hint.cheapest.vendorName, "Price Mart");
    assert.equal(hint.cheapest.price, 1);
  });

  it("values wasted stock", async () => {
    const bread = await request(`/api/houses/${insightHouse}/items`, {
      method: "POST",
      body: { name: "Waste bread", unit: "pcs", initialStock: { quantity: 2, unitPrice: 1.5 } },
    });
    assert.equal(bread.status, 201);
    // A second, cheaper batch: wasting three takes both and must be valued at
    // the weighted average (2 × 1.50 + 1 × 0.50 = 3.50).
    const cheaper = await request(`/api/items/${bread.data.id}/stock`, {
      method: "POST",
      body: { action: "add", quantity: 2, unitPrice: 0.5 },
    });
    assert.equal(cheaper.status, 200);
    const wasted = await request(`/api/items/${bread.data.id}/stock`, {
      method: "POST",
      body: { action: "waste", quantity: 3 },
    });
    assert.equal(wasted.status, 200, JSON.stringify(wasted.data));
    // An unpriced batch contributes nothing.
    const peel = await request(`/api/houses/${insightHouse}/items`, {
      method: "POST",
      body: { name: "Unpriced peel", unit: "pcs", initialStock: { quantity: 1 } },
    });
    assert.equal(peel.status, 201);
    await request(`/api/items/${peel.data.id}/stock`, { method: "POST", body: { action: "waste", quantity: 1 } });
    const waste = await request(`/api/houses/${insightHouse}/insights/waste?months=6`);
    assert.equal(waste.status, 200);
    assert.equal(waste.data.totalCost, 3.5, JSON.stringify(waste.data));
    assert.equal(waste.data.byMonth[waste.data.byMonth.length - 1].events, 2);
    assert.ok(waste.data.topItems.some((item: any) => item.itemName === "Waste bread"));
  });

  it("splits receipts between the people who paid", async () => {
    const changed = await request(`/api/receipts/${latestReceiptId}`, {
      method: "PATCH",
      body: { paidBy: secondUserId },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.equal(changed.data.paidBy, secondUserId);

    const household = await request(`/api/houses/${insightHouse}/insights/household`);
    assert.equal(household.status, 200);
    const second = household.data.balances.find((entry: any) => entry.userId === secondUserId);
    const first = household.data.balances.find((entry: any) => entry.userId !== secondUserId);
    assert.ok(second && first);
    // Owner paid 2.00 and the second member paid 1.50; each owes 1.75.
    assert.equal(first.balance, 0.25);
    assert.equal(second.balance, -0.25);
    assert.deepEqual(
      household.data.settlements.map((entry: any) => [entry.fromUserId, entry.toUserId, entry.amount]),
      [[secondUserId, first.userId, 0.25]],
    );
    // Everybody in the house shares a receipt, including a member with no
    // balance of their own yet.
    assert.deepEqual([...household.data.receipts[0].splitWith].sort(), [first.userId, secondUserId].sort());
    assert.deepEqual(
      [...household.data.members.map((member: any) => member.userId)].sort(),
      [first.userId, secondUserId].sort(),
    );
    const outsider = await request(`/api/receipts/${latestReceiptId}`, {
      method: "PATCH",
      body: { paidBy: "usr_not_in_this_house" },
    });
    assert.equal(outsider.status, 400);
    const outsiderSplit = await request(`/api/receipts/${latestReceiptId}`, {
      method: "PATCH",
      body: { splitWith: [secondUserId, "usr_not_in_this_house"] },
    });
    assert.equal(outsiderSplit.status, 400);
    const unassigned = await request(`/api/receipts/${latestReceiptId}`, {
      method: "PATCH",
      body: { paidBy: null },
    });
    assert.equal(unassigned.status, 200);
    // Clearing the payer stores the receipt creator, never null.
    assert.equal(unassigned.data.paidBy, first.userId);
    // Omitting paidBy leaves the current payer alone.
    const untouched = await request(`/api/receipts/${latestReceiptId}`, {
      method: "PATCH",
      body: { splitWith: [secondUserId, first.userId] },
    });
    assert.equal(untouched.status, 200);
    assert.equal(untouched.data.paidBy, first.userId);
  });

  it("settles a three-person house with the smallest set of transfers", async () => {
    const house = await request("/api/houses", { method: "POST", body: { name: "Split House", currency: "EUR" } });
    assert.equal(house.status, 201);
    const thirdId = "usr_third_saver";
    await run(
      `INSERT INTO users (id, email, username, name, password_hash, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [thirdId, "third@example.com", "third", "Third Saver", "s1$00$00", 0, new Date().toISOString()],
    );
    for (const userId of [secondUserId, thirdId]) {
      await run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
        house.data.id,
        userId,
        "member",
        new Date().toISOString(),
      ]);
    }
    const paid = await request(`/api/houses/${house.data.id}/receipts`, {
      method: "POST",
      body: {
        vendorName: "Split Mart",
        purchasedAt: at(5),
        currency: "EUR",
        total: 30,
        paidBy: thirdId,
        lines: [{ description: "Shared groceries", quantity: 1, lineTotal: 30 }],
      },
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.data));

    const household = await request(`/api/houses/${house.data.id}/insights/household`);
    assert.equal(household.status, 200);
    const total = household.data.balances.reduce((sum: number, entry: any) => sum + entry.balance, 0);
    assert.ok(Math.abs(total) < 0.01, JSON.stringify(household.data.balances));
    const third = household.data.balances.find((entry: any) => entry.userId === thirdId);
    assert.equal(third.balance, 20);
    assert.equal(household.data.settlements.length, 2);
    assert.ok(household.data.settlements.every((entry: any) => entry.toUserId === thirdId));
    assert.equal(
      household.data.settlements.reduce((sum: number, entry: any) => sum + entry.amount, 0),
      20,
    );
  });

  it("reads an e-receipt without writing anything", async () => {
    const parsed = await request(`/api/houses/${insightHouse}/receipts/e-receipt/parse`, {
      method: "POST",
      body: { text: "Price Mart\nMilk 1.50\nBread 2.20\nTOTAL 3.70" },
    });
    assert.equal(parsed.status, 200, JSON.stringify(parsed.data));
    assert.ok(parsed.data.draft.lines.length >= 2);
    assert.equal(parsed.data.draft.total, 3.7);
    const json = await request(`/api/houses/${insightHouse}/receipts/e-receipt/parse`, {
      method: "POST",
      body: { text: JSON.stringify({ vendorName: "JSON Mart", total: 4, lines: [{ name: "Rice", quantity: 2, price: 2 }] }) },
    });
    assert.equal(json.status, 200, JSON.stringify(json.data));
    assert.equal(json.data.format, "json");
    assert.equal(json.data.draft.lines[0].lineTotal, 4);

    // A printed total that does not match the lines is still returned as a
    // draft, with a reconciliation warning; the normal import decides.
    const mismatch = await request(`/api/houses/${insightHouse}/receipts/e-receipt/parse`, {
      method: "POST",
      body: { text: "Mismatch Mart\nMilk 1.50\nTOTAL 100.00" },
    });
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.data.reconciliation.ok, false);
    assert.ok(mismatch.data.reconciliation.difference > 0);

    assert.equal(
      (await request(`/api/houses/${insightHouse}/receipts/e-receipt/parse`, { method: "POST", body: { text: "" } })).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/houses/${insightHouse}/receipts/e-receipt/parse`, {
          method: "POST",
          body: { text: "{not json" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/houses/${insightHouse}/receipts/e-receipt/parse`, {
          method: "POST",
          body: { text: "{\"lines\":[]}" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/houses/${insightHouse}/receipts/e-receipt/parse`, {
          method: "POST",
          body: { text: "x".repeat(100_001) },
        })
      ).status,
      400,
    );
  });

  it("warns on a duplicate e-receipt before importing it twice", async () => {
    const text = "Duplicate Mart\nDup rice 9.99\nTOTAL 9.99";
    const parsed = await request(`/api/houses/${insightHouse}/receipts/e-receipt/parse`, {
      method: "POST",
      body: { text },
    });
    assert.equal(parsed.status, 200);
    const body = {
      vendorName: "Duplicate Mart",
      purchasedAt: at(4),
      currency: "EUR",
      lines: parsed.data.draft.lines,
    };
    const first = await request(`/api/houses/${insightHouse}/receipts`, { method: "POST", body });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const again = await request(`/api/houses/${insightHouse}/receipts`, { method: "POST", body });
    assert.equal(again.status, 409);
    assert.equal(again.data.duplicateOf.total, 9.99);
    const forced = await request(`/api/houses/${insightHouse}/receipts`, {
      method: "POST",
      body: { ...body, allowDuplicate: true },
    });
    assert.equal(forced.status, 201, JSON.stringify(forced.data));
  });

  it("gives instance administrators a console and keeps it private", async () => {
    for (const path of ["overview", "users", "sessions", "files", "ai", "registration"]) {
      const forbidden = await request(`/api/admin/${path}`, { auth: secondUserCookie });
      assert.equal(forbidden.status, 403, path);
    }
    const overview = await request("/api/admin/overview");
    assert.equal(overview.status, 200);
    assert.ok(overview.data.users >= 2);
    assert.equal(overview.data.database, "sqlite");
    assert.equal((await request("/api/admin/files/sweep", { auth: secondUserCookie, method: "POST", body: {} })).status, 403);
    const sweep = await request("/api/admin/files/sweep", { method: "POST", body: {} });
    assert.equal(sweep.status, 200);
    assert.equal(typeof sweep.data.removed, "number");

    const budget = await request("/api/admin/ai/budget", { method: "PATCH", body: { monthlyBudget: 5 } });
    assert.equal(budget.status, 200);
    assert.equal(budget.data.budget, 5);
    assert.equal((await request("/api/admin/ai/budget", { method: "PATCH", body: { monthlyBudget: 0 } })).data.budget, 0);

    const me = await request("/api/auth/me");
    const demoteSelf = await request(`/api/admin/users/${me.data.user.id}`, {
      method: "PATCH",
      body: { isAdmin: false },
    });
    assert.equal(demoteSelf.status, 400, "an admin cannot lock themselves out");

    for (const mode of ["closed", "invite", "open"] as const) {
      const changed = await request("/api/admin/registration", { method: "PATCH", body: { mode } });
      assert.equal(changed.status, 200);
      assert.equal(changed.data.source, "admin");
      assert.equal((await request("/api/auth/registration", { auth: "" })).data.mode, mode);
    }
    const invalid = await request("/api/admin/registration", { method: "PATCH", body: { mode: "sometimes" } });
    assert.equal(invalid.status, 400);
    const reset = await request("/api/admin/registration", { method: "PATCH", body: { mode: "environment" } });
    assert.equal(reset.status, 200);
    assert.notEqual(reset.data.source, "admin");
    const status = await request("/api/admin/registration");
    assert.equal(status.data.override, null);
    assert.equal((await request("/api/auth/registration", { auth: "" })).data.mode, "open");
  });

  it("pauses AI calls when the instance budget is spent", async () => {
    // Exactly at the budget is already over the line.
    const spent = await request("/api/admin/ai/budget", { method: "PATCH", body: { monthlyBudget: 1 } });
    assert.equal(spent.status, 200);
    await run(
      `INSERT INTO ai_call_logs (id, operation, status, cost, created_at) VALUES (?, ?, ?, ?, ?)`,
      ["ail_budget_test", "test", "ok", 1, new Date().toISOString()],
    );
    const aiPaths = [
      "receipts/scan",
      "recipes/scan",
      "intake/parse",
      "ideas",
      "ai/test",
    ];
    for (const path of aiPaths) {
      const blocked = await request(`/api/houses/${insightHouse}/${path}`, { method: "POST", body: {} });
      assert.equal(blocked.status, 429, `${path}: ${JSON.stringify(blocked.data)}`);
    }
    const blockedRecipe = await request("/api/recipes/rcp_missing/ai", { method: "POST", body: {} });
    assert.equal(blockedRecipe.status, 429, JSON.stringify(blockedRecipe.data));

    // One dollar under the line lets the request reach the normal config check.
    const under = await request("/api/admin/ai/budget", { method: "PATCH", body: { monthlyBudget: 2 } });
    assert.equal(under.data.budget, 2);
    assert.equal((await request(`/api/houses/${insightHouse}/ai/test`, { method: "POST", body: {} })).status, 400);

    const unlimited = await request("/api/admin/ai/budget", { method: "PATCH", body: { monthlyBudget: 0 } });
    assert.equal(unlimited.data.budget, 0);
    const allowed = await request(`/api/houses/${insightHouse}/ai/test`, { method: "POST", body: {} });
    assert.equal(allowed.status, 400, "without a budget the endpoint reaches the AI configuration check");
    await run("DELETE FROM ai_call_logs WHERE id = ?", ["ail_budget_test"]);
  });

  it("issues read-only API tokens", async () => {
    const created = await request("/api/tokens", { method: "POST", body: { name: "Test dashboard" } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.ok(created.data.token.startsWith("svt_"));
    const storedRow = await get<{ token_hash: string }>("SELECT token_hash FROM api_tokens WHERE id = ?", [
      created.data.id,
    ]);
    assert.notEqual(storedRow?.token_hash, created.data.token, "the plain token is never stored");
    assert.equal(storedRow?.token_hash?.length, 64);
    const bearer = { authorization: `Bearer ${created.data.token}` };

    const read = await request("/api/houses", { auth: "", headers: bearer });
    assert.equal(read.status, 200);
    assert.equal((await request("/api/houses", { auth: "", headers: bearer, method: "HEAD" })).status, 200);
    assert.ok(read.data.some((house: any) => house.id === insightHouse));
    // A house created by the other user: the owner's token is not a member.
    const foreign = await request("/api/houses", {
      auth: secondUserCookie,
      method: "POST",
      body: { name: "Second user house", currency: "EUR" },
    });
    assert.equal(foreign.status, 201);
    assert.equal((await request(`/api/houses/${foreign.data.id}`, { auth: "", headers: bearer })).status, 404);

    const write = await request("/api/houses", { auth: "", headers: bearer, method: "POST", body: { name: "Token house" } });
    assert.equal(write.status, 403);
    const patch = await request(`/api/houses/${insightHouse}`, {
      auth: "",
      headers: bearer,
      method: "PATCH",
      body: { name: "Token rename" },
    });
    assert.equal(patch.status, 403);
    const remove = await request(`/api/tokens/${created.data.id}`, { auth: "", headers: bearer, method: "DELETE" });
    assert.equal(remove.status, 403);
    assert.equal((await request("/api/admin/overview", { auth: "", headers: bearer })).status, 403);
    assert.equal((await request("/api/tokens", { auth: "", headers: bearer })).status, 403);

    const list = await request("/api/tokens");
    assert.equal(list.status, 200);
    assert.equal(list.data.tokens[0].name, "Test dashboard");
    assert.equal(list.data.tokens[0].token, undefined);
    assert.ok(list.data.tokens[0].lastUsedAt, "using a token records when it was last used");
    const revoked = await request(`/api/tokens/${created.data.id}`, { method: "DELETE" });
    assert.equal(revoked.status, 200);
    assert.equal((await request("/api/houses", { auth: "", headers: bearer })).status, 401);
  });
});
