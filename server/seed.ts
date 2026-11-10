/**
 * Seeds a demo vault so the app can be explored immediately.
 *   npm run seed
 * Demo login: demo@svault.local / demo1234
 */
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_DIR } from "./config.js";
import { all, get, initDb, newId, now, run } from "./db.js";
import { hashPassword } from "./auth.js";
import { createHouse } from "./services/houses.js";
import { addStock, removeStock } from "./services/stock.js";
import { syncHouseExpiry, syncItemLowStock } from "./services/notifications.js";
import { localIdeas } from "./services/recipe-local.js";
import { createCanvas, type Rgb } from "./lib/png.js";
import { round } from "./units.js";

const DEMO_EMAIL = "demo@svault.local";
const PASSWORD = "demo1234";

await initDb();

if (await get("SELECT id FROM users WHERE lower(email) = lower(?)", [DEMO_EMAIL])) {
  console.log("Demo data already present — nothing to do.");
  process.exit(0);
}

const day = 864e5;
const daysAgo = (n: number) => new Date(Date.now() - n * day).toISOString();
const dateOnly = (n: number) => daysAgo(n).slice(0, 10);

async function createUser(email: string, name: string, password: string) {
  const id = newId("usr");
  await run("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    email,
    name,
    hashPassword(password),
    0,
    now(),
  ]);
  return id;
}

const demoId = await createUser(DEMO_EMAIL, "Alex Moreau", PASSWORD);
const sofiaId = await createUser("sofia@svault.local", "Sofia Moreau", PASSWORD);

const lake = await createHouse({ userId: demoId, name: "Lake House", kind: "cabin", currency: "EUR", address: "Lakeside road 12" });
const flat = await createHouse({ userId: demoId, name: "City Flat", kind: "apartment", currency: "EUR" });
await run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", [lake, sofiaId, now()]);

async function houseName(houseId: string, type: "locations" | "categories") {
  const rows = await all<any>(`SELECT id, name FROM ${type} WHERE house_id = ?`, [houseId]);
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.name, row.id);
  return map;
}

const lakeLocations = await houseName(lake, "locations");
const lakeCategories = await houseName(lake, "categories");

interface ItemSpec {
  name: string;
  category: string;
  unit: string;
  reorder?: number;
  target?: number;
  brand?: string;
  description?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
  barcode?: string;
  espresso?: boolean;
  purchases: { qty: number; price: number; days: number; location: string; expiryDays?: number }[];
  keep: number;
}

async function createItem(houseId: string, locations: Map<string, string>, categories: Map<string, string>, spec: ItemSpec, userId = demoId) {
  const id = newId("itm");
  const stamp = now();
  await run(
    `INSERT INTO items (id, house_id, name, description, brand, category_id, unit, reorder_point, target_stock,
       attributes, tags, image, espresso, archived, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?)`,
    [
      id,
      houseId,
      spec.name,
      spec.description ?? null,
      spec.brand ?? null,
      categories.get(spec.category) ?? null,
      spec.unit,
      spec.reorder ?? 0,
      spec.target ?? null,
      JSON.stringify(spec.attributes ?? {}),
      JSON.stringify(spec.tags ?? []),
      spec.espresso ? 1 : 0,
      userId,
      stamp,
      stamp,
    ],
  );
  if (spec.barcode) {
    await run("INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, 'EAN_13', ?)", [
      newId("bar"),
      id,
      houseId,
      spec.barcode,
      stamp,
    ]);
  }
  let total = 0;
  for (const purchase of spec.purchases) {
    await addStock({
      itemId: id,
      houseId,
      userId,
      quantity: purchase.qty,
      unitPrice: purchase.price,
      locationId: locations.get(purchase.location) ?? null,
      purchasedAt: dateOnly(purchase.days),
      expiresAt: purchase.expiryDays != null ? dateOnly(-purchase.expiryDays) : null,
      note: "Demo purchase",
      reason: "Demo purchase",
    });
    const movement = await get<any>("SELECT id FROM stock_movements WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [id]);
    if (movement) await run("UPDATE stock_movements SET created_at = ? WHERE id = ?", [daysAgo(purchase.days), movement.id]);
    total += purchase.qty;
  }
  if (total > spec.keep) {
    const remaining = round(total - spec.keep);
    const discreteUnits = ["pcs", "pair", "bottle", "can", "jar", "pack", "box", "set", "slice", "roll"];
    let quantities: number[];
    if (discreteUnits.includes(spec.unit)) {
      quantities =
        remaining >= 2
          ? [Math.ceil(remaining / 2), Math.floor(remaining / 2)]
          : [remaining];
    } else {
      const fractions = remaining > 3 ? [0.4, 0.35] : remaining > 1 ? [0.6] : [];
      quantities = fractions.map((share) => round(remaining * share));
      quantities.push(round(remaining - quantities.reduce((sum, value) => sum + value, 0)));
    }
    for (const [index, quantity] of quantities.filter((value) => value > 0).entries()) {
      await removeStock({ itemId: id, houseId, userId, quantity, reason: index === 0 ? "Used at home" : index === 1 ? "Cooked dinner" : "Breakfast" });
      const movement = await get<any>("SELECT id FROM stock_movements WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [id]);
      if (movement) await run("UPDATE stock_movements SET created_at = ? WHERE id = ?", [daysAgo(3 + index * 9), movement.id]);
    }
  }
  return id;
}

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Whole milk",
  category: "Dairy",
  unit: "l",
  reorder: 2,
  target: 4,
  brand: "Farmhouse",
  tags: ["breakfast"],
  attributes: { size: "1 l" },
  barcode: "4006381333931",
  purchases: [
    { qty: 1.5, price: 1.29, days: 170, location: "Fridge" },
    { qty: 1.5, price: 1.35, days: 120, location: "Fridge" },
    { qty: 2, price: 1.49, days: 60, location: "Fridge" },
    { qty: 2, price: 1.49, days: 4, location: "Fridge", expiryDays: 4 },
  ],
  keep: 1.5,
});

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Free-range eggs",
  category: "Dairy",
  unit: "pcs",
  reorder: 6,
  brand: "Hilltop",
  barcode: "5201234500017",
  purchases: [{ qty: 12, price: 0.36, days: 8, location: "Fridge", expiryDays: 12 }],
  keep: 9,
});

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Sourdough bread",
  category: "Food",
  unit: "pcs",
  reorder: 1,
  brand: "Baker & Co",
  purchases: [{ qty: 2, price: 3.4, days: 2, location: "Pantry", expiryDays: 1 }],
  keep: 1,
});

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Salted butter",
  category: "Dairy",
  unit: "g",
  reorder: 100,
  brand: "Meadow",
  purchases: [{ qty: 500, price: 0.011, days: 15, location: "Fridge", expiryDays: 30 }],
  keep: 320,
});

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Greek yogurt",
  category: "Dairy",
  unit: "g",
  reorder: 200,
  purchases: [{ qty: 1000, price: 0.0042, days: 3, location: "Fridge", expiryDays: 5 }],
  keep: 650,
});

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Olive oil",
  category: "Food",
  unit: "l",
  reorder: 0.25,
  brand: "Kalamata",
  barcode: "5209876543210",
  purchases: [
    { qty: 1, price: 10.9, days: 200, location: "Pantry" },
    { qty: 1, price: 11.9, days: 90, location: "Pantry" },
    { qty: 1, price: 12.9, days: 20, location: "Pantry" },
  ],
  keep: 0.8,
});

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Spaghetti",
  category: "Food",
  unit: "g",
  reorder: 500,
  brand: "Rustica",
  barcode: "8076800195057",
  purchases: [
    { qty: 2000, price: 0.0021, days: 120, location: "Pantry" },
    { qty: 2000, price: 0.0025, days: 25, location: "Pantry" },
  ],
  keep: 2600,
});

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Tomatoes",
  category: "Produce",
  unit: "kg",
  reorder: 0.5,
  purchases: [{ qty: 1.4, price: 2.4, days: 3, location: "Fridge", expiryDays: 4 }],
  keep: 1.1,
});

await createItem(lake, lakeLocations, lakeCategories, { name: "Garlic", category: "Produce", unit: "pcs", purchases: [{ qty: 6, price: 0.45, days: 20, location: "Pantry" }], keep: 4 });
await createItem(lake, lakeLocations, lakeCategories, { name: "Onions", category: "Produce", unit: "kg", purchases: [{ qty: 2, price: 1.6, days: 18, location: "Pantry" }], keep: 1.4 });
await createItem(lake, lakeLocations, lakeCategories, { name: "Lemons", category: "Produce", unit: "pcs", purchases: [{ qty: 6, price: 0.55, days: 6, location: "Fridge", expiryDays: 9 }], keep: 4 });

const coffeeBeansId = await createItem(lake, lakeLocations, lakeCategories, {
  name: "Coffee beans",
  category: "Drinks",
  unit: "g",
  reorder: 250,
  brand: "Black River",
  barcode: "7350053850023",
  espresso: true,
  purchases: [
    { qty: 1000, price: 0.024, days: 150, location: "Pantry" },
    { qty: 1000, price: 0.026, days: 80, location: "Pantry" },
    { qty: 1000, price: 0.028, days: 10, location: "Pantry" },
  ],
  keep: 700,
});

/* Saved equipment so the shot form shows the dropdowns in the demo. */
const espressoMachineId = newId("eqp");
const espressoGrinderId = newId("eqp");
const espressoMachineName = "Lelit Mara X";
const espressoGrinderName = "Eureka Mignon";
await run(
  `INSERT INTO espresso_equipment (id, house_id, kind, name, brand, notes, created_at, updated_at)
   VALUES (?, ?, 'machine', ?, 'Lelit', NULL, ?, ?), (?, ?, 'grinder', ?, 'Eureka', NULL, ?, ?)`,
  [
    espressoMachineId,
    lake,
    espressoMachineName,
    daysAgo(200),
    daysAgo(200),
    espressoGrinderId,
    lake,
    espressoGrinderName,
    daysAgo(200),
    daysAgo(200),
  ],
);

/* A short dial-in history so the espresso log is populated in the demo. */
for (const shot of [
  { days: 1, rating: 4, grind: "2.4", dose: 18, yield: 36, time: 28, tds: 9.2, notes: "Cocoa and orange peel." },
  { days: 5, rating: 5, grind: "2.2", dose: 18, yield: 38, time: 31, tds: 9.8, notes: "Sweeter, syrupy finish." },
  { days: 12, rating: 3, grind: "2.8", dose: 17.5, yield: 32, time: 24, tds: 8.1, notes: "A little sour; grind finer." },
]) {
  await run(
    `INSERT INTO espresso_shots (id, house_id, item_id, user_id, brewed_at, rating, roast_level, grind_setting,
       grind_seconds, dose_grams, yield_grams, extraction_seconds, water_temp_c, pressure_bar, tds_percent,
       grinder_id, machine_id, grinder, machine, tasting_notes, tags, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'medium', ?, 12, ?, ?, ?, 93, 9, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      newId("esp"),
      lake,
      coffeeBeansId,
      demoId,
      daysAgo(shot.days),
      shot.rating,
      shot.grind,
      shot.dose,
      shot.yield,
      shot.time,
      shot.tds,
      espressoGrinderId,
      espressoMachineId,
      espressoGrinderName,
      espressoMachineName,
      shot.notes,
      JSON.stringify(["chocolate", "citrus"]),
      daysAgo(shot.days),
      daysAgo(shot.days),
    ],
  );
}

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Frozen peas",
  category: "Frozen",
  unit: "g",
  reorder: 300,
  purchases: [{ qty: 1000, price: 0.0024, days: 40, location: "Freezer", expiryDays: 200 }],
  keep: 800,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "Dark chocolate",
  category: "Snacks",
  unit: "g",
  purchases: [{ qty: 300, price: 0.017, days: 30, location: "Cupboard", expiryDays: 120 }],
  keep: 200,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "Laundry detergent",
  category: "Cleaning",
  unit: "l",
  reorder: 0.5,
  brand: "Nordic Clean",
  barcode: "7310865000648",
  purchases: [{ qty: 2, price: 4.5, days: 55, location: "Bathroom" }],
  keep: 1.2,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "Dish soap",
  category: "Cleaning",
  unit: "pcs",
  reorder: 1,
  purchases: [{ qty: 2, price: 2.1, days: 70, location: "Bathroom" }],
  keep: 1,
});

await createItem(lake, lakeLocations, lakeCategories, {
  name: "Hiking boots",
  category: "Clothing",
  unit: "pair",
  brand: "Trailhead",
  attributes: { size: "43", color: "brown", warranty_until: "2028-05-01" },
  tags: ["hiking", "winter"],
  purchases: [{ qty: 1, price: 129, days: 210, location: "Closet" }],
  keep: 1,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "Wool socks",
  category: "Clothing",
  unit: "pair",
  reorder: 2,
  attributes: { size: "39-42", color: "charcoal" },
  purchases: [{ qty: 3, price: 8.5, days: 120, location: "Closet" }],
  keep: 1,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "Headlamp",
  category: "Tools",
  unit: "pcs",
  brand: "Petzl",
  attributes: { color: "black" },
  purchases: [{ qty: 1, price: 39.9, days: 300, location: "Garage" }],
  keep: 1,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "Cast iron pan",
  category: "Tools",
  unit: "pcs",
  attributes: { size: "26 cm", warranty_until: "2040-01-01" },
  purchases: [{ qty: 1, price: 54, days: 400, location: "Cupboard" }],
  keep: 1,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "AA batteries",
  category: "Tools",
  unit: "pcs",
  reorder: 4,
  barcode: "5000394019137",
  purchases: [{ qty: 8, price: 0.6, days: 90, location: "Garage" }],
  keep: 4,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "First aid kit",
  category: "Medicine",
  unit: "pcs",
  purchases: [{ qty: 1, price: 24.5, days: 320, location: "Bathroom" }],
  keep: 1,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "Sunscreen SPF 50",
  category: "Medicine",
  unit: "pcs",
  reorder: 1,
  purchases: [{ qty: 1, price: 12.9, days: 100, location: "Bathroom", expiryDays: 240 }],
  keep: 1,
});
await createItem(lake, lakeLocations, lakeCategories, {
  name: "Red wine",
  category: "Drinks",
  unit: "bottle",
  reorder: 1,
  purchases: [{ qty: 3, price: 8.9, days: 35, location: "Cupboard" }],
  keep: 2,
});

// A few things in the second house.
const flatLocations = await houseName(flat, "locations");
const flatCategories = await houseName(flat, "categories");
await createItem(flat, flatLocations, flatCategories, {
  name: "Oat milk",
  category: "Dairy",
  unit: "l",
  reorder: 1,
  purchases: [{ qty: 2, price: 1.99, days: 4, location: "Fridge", expiryDays: 6 }],
  keep: 1,
});
await createItem(flat, flatLocations, flatCategories, {
  name: "Rice",
  category: "Food",
  unit: "kg",
  reorder: 0.5,
  purchases: [{ qty: 2, price: 2.2, days: 50, location: "Pantry" }],
  keep: 1.4,
});
await createItem(flat, flatLocations, flatCategories, {
  name: "Umbrella",
  category: "Other",
  unit: "pcs",
  purchases: [{ qty: 1, price: 18, days: 150, location: "Cupboard" }],
  keep: 1,
});

/* ------------------------------------------------------------------ recipes */

async function createRecipe(houseId: string, spec: {
  title: string;
  description: string;
  servings: number | null;
  prep: number | null;
  cook: number | null;
  tags: string[];
  favorite?: boolean;
  source?: "manual" | "scan" | "ai";
  sourceImage?: string | null;
  ocrText?: string | null;
  aiNotes?: string | null;
  steps: string[];
  ingredients: { name: string; qty: number | null; unit: string | null; optional?: boolean; note?: string }[];
}) {
  const id = newId("rcp");
  const stamp = now();
  await run(
    `INSERT INTO recipes (id, house_id, title, description, servings, prep_minutes, cook_minutes, steps, tags, image,
       source_image, ocr_text, source, ai_notes, favorite, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      houseId,
      spec.title,
      spec.description,
      spec.servings,
      spec.prep,
      spec.cook,
      JSON.stringify(spec.steps.map((text) => ({ text, timerSeconds: null }))),
      JSON.stringify(spec.tags),
      spec.sourceImage ?? null,
      spec.ocrText ?? null,
      spec.source ?? "manual",
      spec.aiNotes ?? null,
      spec.favorite ? 1 : 0,
      demoId,
      stamp,
      stamp,
    ],
  );
  for (const [index, ingredient] of spec.ingredients.entries()) {
    await run(
      "INSERT INTO recipe_ingredients (id, recipe_id, name, quantity, unit, item_id, optional, note, sort) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
      [
        newId("rin"),
        id,
        ingredient.name,
        ingredient.qty,
        ingredient.unit,
        ingredient.optional ? 1 : 0,
        ingredient.note ?? null,
        index,
      ],
    );
  }
  return id;
}

const recipeCardPath = path.join(process.cwd(), "assets", "demo-recipe-card.png");
if (!fs.existsSync(recipeCardPath)) {
  console.warn("assets/demo-recipe-card.png missing — recipe scans will have no example image.");
}

const recipeDir = path.join(UPLOAD_DIR, "recipes");
fs.mkdirSync(recipeDir, { recursive: true });
const recipeCardFile = "demo-grandma-card.png";
if (fs.existsSync(recipeCardPath)) fs.copyFileSync(recipeCardPath, path.join(recipeDir, recipeCardFile));

await createRecipe(lake, {
  title: "Grandma's lemon cake",
  description: "The cake that appeared every Sunday afternoon, wrapped in a tea towel.",
  servings: 8,
  prep: 20,
  cook: 45,
  tags: ["dessert", "family", "baking"],
  favorite: true,
  source: "scan",
  sourceImage: `/uploads/recipes/${recipeCardFile}`,
  ocrText:
    "GRANDMA MARGOT LEMON CAKE\n3 eggs\n200 g sugar\n250 g flour\n150 g butter\n2 lemons zest and juice\n1 tsp baking powder\nbake 180 for 45 min",
  aiNotes:
    "OCR read '180 for 45 min' without a unit; interpreted as 180 °C. Added a glaze from the note in the margin and clarified the resting step. No extra ingredients invented.",
  steps: [
    "Heat the oven to 180 °C and butter a 24 cm cake tin.",
    "Whisk the eggs with the sugar until pale and thick, about 5 minutes.",
    "Melt the butter and fold it in with the lemon zest and half of the juice.",
    "Sift in the flour and baking powder, fold gently until just combined.",
    "Pour into the tin and bake for 40–45 minutes, until a skewer comes out clean.",
    "Cool for 10 minutes in the tin, then turn out onto a rack.",
    "Mix the remaining lemon juice with icing sugar and spoon over the cooled cake.",
  ],
  ingredients: [
    { name: "Eggs", qty: 3, unit: "pcs" },
    { name: "Sugar", qty: 200, unit: "g" },
    { name: "Flour", qty: 250, unit: "g" },
    { name: "Butter", qty: 150, unit: "g" },
    { name: "Lemons", qty: 2, unit: "pcs" },
    { name: "Baking powder", qty: 1, unit: "tsp" },
    { name: "Icing sugar", qty: 100, unit: "g", optional: true, note: "for the glaze" },
  ],
});

await createRecipe(lake, {
  title: "Sunday pancakes",
  description: "Thick, fluffy pancakes with whatever fruit is around.",
  servings: 4,
  prep: 10,
  cook: 15,
  tags: ["breakfast", "family"],
  favorite: true,
  steps: [
    "Whisk the eggs, milk and a pinch of salt in a jug.",
    "Fold in the flour until just combined — lumps are fine.",
    "Melt a little butter in a non-stick pan over medium heat.",
    "Cook ladlefuls for 2 minutes per side until golden.",
    "Keep warm under a tea towel and serve with yogurt and fruit.",
  ],
  ingredients: [
    { name: "Eggs", qty: 3, unit: "pcs" },
    { name: "Milk", qty: 0.4, unit: "l" },
    { name: "Flour", qty: 250, unit: "g" },
    { name: "Butter", qty: 30, unit: "g" },
    { name: "Greek yogurt", qty: 200, unit: "g", optional: true },
  ],
});

await createRecipe(lake, {
  title: "Weeknight tomato pasta",
  description: "Twenty minutes, one pan of sauce, almost no washing up.",
  servings: 2,
  prep: 5,
  cook: 15,
  tags: ["pasta", "quick", "vegetarian"],
  steps: [
    "Bring a large pan of salted water to the boil and cook the spaghetti.",
    "Meanwhile, warm the olive oil and gently cook the sliced garlic.",
    "Add the chopped tomatoes and a pinch of sugar, simmer for 8 minutes.",
    "Drain the pasta, keeping a splash of water, and toss everything together.",
    "Finish with olive oil, pepper and a little lemon zest if you have it.",
  ],
  ingredients: [
    { name: "Spaghetti", qty: 200, unit: "g" },
    { name: "Tomatoes", qty: 0.6, unit: "kg" },
    { name: "Garlic", qty: 2, unit: "pcs" },
    { name: "Olive oil", qty: 0.04, unit: "l" },
    { name: "Lemons", qty: 0.5, unit: "pcs", optional: true },
  ],
});

await createRecipe(lake, {
  title: "Roast chicken with lemons",
  description: "A Sunday roast for when the whole family turns up.",
  servings: 4,
  prep: 15,
  cook: 80,
  tags: ["dinner", "family"],
  steps: [
    "Heat the oven to 200 °C.",
    "Rub the chicken with olive oil, salt and pepper and stuff the cavity with lemon halves.",
    "Roast for 50 minutes, then add the potatoes and garlic.",
    "Continue roasting for 30 minutes until the skin is crisp and the juices run clear.",
    "Rest for 10 minutes before carving.",
  ],
  ingredients: [
    { name: "Chicken", qty: 1.6, unit: "kg" },
    { name: "Potatoes", qty: 1, unit: "kg" },
    { name: "Garlic", qty: 4, unit: "pcs" },
    { name: "Olive oil", qty: 0.05, unit: "l" },
    { name: "Lemons", qty: 2, unit: "pcs" },
  ],
});

await createRecipe(lake, {
  title: "Whatever-is-left soup",
  description: "A forgiving soup for the end of the week.",
  servings: 4,
  prep: 10,
  cook: 30,
  tags: ["soup", "quick", "use-it-up"],
  steps: [
    "Soften the onions and garlic in olive oil with a good pinch of salt.",
    "Add the tomatoes and any other vegetables and cook for 5 minutes.",
    "Cover with stock or water and simmer for 20 minutes.",
    "Blend or leave chunky, then taste and adjust the seasoning.",
  ],
  ingredients: [
    { name: "Onions", qty: 2, unit: "pcs" },
    { name: "Garlic", qty: 2, unit: "pcs" },
    { name: "Tomatoes", qty: 0.5, unit: "kg" },
    { name: "Olive oil", qty: 0.03, unit: "l" },
    { name: "Frozen peas", qty: 150, unit: "g", optional: true },
  ],
});

/* ------------------------------------------------------------------- photos */

const photoDir = path.join(UPLOAD_DIR, "photos");
fs.mkdirSync(photoDir, { recursive: true });

type Label = { label: string; x: number; y: number; w: number; h: number };

function fridgeShot(variant: number): { png: Buffer; labels: Label[] } {
  const W = 800;
  const H = 600;
  const canvas = createCanvas(W, H);
  canvas.gradient(variant % 2 ? [224, 231, 235] : [214, 224, 229], [186, 198, 205]);
  canvas.noise(7);
  canvas.rect(0, 200, W, 16, [146, 158, 165]);
  canvas.rect(0, 430, W, 16, [146, 158, 165]);
  canvas.rect(0, 0, W, 26, [120, 132, 140]);

  const labels: Label[] = [];
  const milk: [number, number, number, number] = [80, 60, 140, 240];
  canvas.rect(...milk, [246, 246, 242]);
  canvas.rect(80, 60, 140, 30, [236, 240, 244]);
  canvas.rect(112, 40, 76, 26, [235, 238, 242]);
  canvas.rect(120, 44, 60, 14, [58, 108, 168]);
  canvas.rect(96, 130, 108, 70, [58, 108, 168]);
  labels.push({ label: "milk carton", x: 80 / W, y: 60 / H, w: 140 / W, h: 240 / H });

  const butter: [number, number, number, number] = [270, 120, 150, 90];
  canvas.rect(...butter, [241, 205, 92]);
  canvas.rect(270, 120, 150, 26, [226, 183, 61]);
  labels.push({ label: "butter", x: 270 / W, y: 120 / H, w: 150 / W, h: 90 / H });

  canvas.rect(470, 160, 110, 50, [186, 62, 48]);
  canvas.ellipse(525, 160, 55, 12, [186, 62, 48]);
  canvas.rect(478, 82, 94, 26, [92, 70, 52]);
  labels.push({ label: "jam jar", x: 470 / W, y: 82 / H, w: 110 / W, h: 128 / H });

  const eggs: [number, number, number, number] = [640, 350, 120, 90];
  canvas.rect(...eggs, [214, 204, 178]);
  for (let i = 0; i < 3; i++) canvas.ellipse(665 + i * 34, 395, 14, 18, [238, 228, 202]);
  labels.push({ label: "egg box", x: 640 / W, y: 350 / H, w: 120 / W, h: 90 / H });

  canvas.rect(230, 380, 180, 60, [120, 168, 132]);
  canvas.rect(250, 330, 60, 52, [230, 236, 228]);
  return { png: canvas.png(), labels };
}

function pantryShot(variant: number): { png: Buffer; labels: Label[] } {
  const W = 800;
  const H = 600;
  const canvas = createCanvas(W, H);
  canvas.gradient([236, 219, 194], [206, 178, 140]);
  canvas.noise(10);
  for (let y = 180; y < H; y += 200) canvas.rect(0, y, W, 22, [162, 126, 86]);
  const labels: Label[] = [];
  const colors: Rgb[] = [
    [181, 150, 94],
    [141, 84, 62],
    [110, 138, 104],
  ];
  colors.forEach((color, index) => {
    const x = 120 + index * 190 + variant * 18;
    const y = 60 + (index % 2) * 30;
    canvas.rect(x, y + 30, 110, 120, [232, 224, 208]);
    canvas.rect(x + 8, y + 40, 94, 100, color);
    canvas.rect(x + 20, y, 70, 30, [196, 190, 178]);
    labels.push({ label: ["jar of pasta", "jam jar", "jar of beans"][index], x: x / W, y: y / H, w: 110 / W, h: 150 / H });
  });
  return { png: canvas.png(), labels };
}

function bootsShot(): { png: Buffer; labels: Label[] } {
  const W = 800;
  const H = 600;
  const canvas = createCanvas(W, H);
  canvas.gradient([206, 198, 184], [174, 162, 145]);
  canvas.noise(12);
  const labels: Label[] = [];
  const boot = (x: number, y: number) => {
    canvas.rect(x, y, 130, 170, [94, 66, 46]);
    canvas.ellipse(x + 65, y + 190, 100, 40, [78, 54, 38]);
    canvas.rect(x + 8, y + 168, 184, 24, [60, 42, 30]);
    for (let i = 0; i < 4; i++) canvas.rect(x + 30 + i * 22, y + 70, 10, 8, [220, 202, 164]);
    labels.push({ label: "hiking boot", x: (x - 20) / W, y: y / H, w: 200 / W, h: 230 / H });
  };
  boot(160, 200);
  boot(460, 190);
  return { png: canvas.png(), labels };
}

function headlampShot(): { png: Buffer; labels: Label[] } {
  const W = 800;
  const H = 600;
  const canvas = createCanvas(W, H);
  canvas.gradient([46, 52, 58], [26, 30, 34]);
  canvas.noise(5);
  canvas.rect(240, 240, 320, 100, [60, 66, 72]);
  canvas.ellipse(400, 290, 160, 60, [88, 96, 104]);
  canvas.rect(300, 260, 90, 60, [236, 232, 214]);
  canvas.ellipse(345, 290, 28, 28, [250, 244, 190]);
  canvas.rect(470, 262, 34, 54, [180, 60, 44]);
  canvas.rect(200, 270, 44, 40, [70, 76, 82]);
  return {
    png: canvas.png(),
    labels: [{ label: "headlamp", x: 200 / W, y: 220 / H, w: 360 / W, h: 140 / H }],
  };
}

async function insertPhoto(
  houseId: string,
  collectionId: string,
  shot: { png: Buffer; labels: Label[] },
  filename: string,
  split: "train" | "val" | "test" | "unassigned",
  labelsOverride?: Label[] | "none",
) {
  fs.writeFileSync(path.join(photoDir, filename), shot.png);
  const id = newId("pho");
  await run(
    `INSERT INTO photos (id, house_id, collection_id, filename, original_name, mime, size, width, height, notes,
       item_id, split, captured_at, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'image/png', ?, 800, 600, NULL, NULL, ?, ?, ?, ?)`,
    [id, houseId, collectionId, filename, filename, shot.png.length, split, daysAgo(Math.floor(Math.random() * 20)), demoId, daysAgo(Math.floor(Math.random() * 20))],
  );
  const labels = labelsOverride === "none" ? [] : (labelsOverride ?? shot.labels);
  for (const label of labels) {
    await run("INSERT INTO photo_labels (id, photo_id, house_id, label, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      newId("lbl"),
      id,
      houseId,
      label.label,
      label.x,
      label.y,
      label.w,
      label.h,
      now(),
    ]);
  }
  return id;
}

const fridgeCollection = newId("col");
await run("INSERT INTO photo_collections (id, house_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
  fridgeCollection,
  lake,
  "Fridge shelf",
  "Front shelf, photographed every Sunday before shopping",
  demoId,
  now(),
]);
await insertPhoto(lake, fridgeCollection, fridgeShot(0), "demo-fridge-1.png", "train");
await insertPhoto(lake, fridgeCollection, fridgeShot(1), "demo-fridge-2.png", "train");
await insertPhoto(lake, fridgeCollection, fridgeShot(2), "demo-fridge-3.png", "val");
await insertPhoto(lake, fridgeCollection, fridgeShot(3), "demo-fridge-4.png", "unassigned", "none");

const pantryCollection = newId("col");
await run("INSERT INTO photo_collections (id, house_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
  pantryCollection,
  lake,
  "Pantry jars",
  "Labelled pantry reference shots",
  demoId,
  now(),
]);
await insertPhoto(lake, pantryCollection, pantryShot(0), "demo-pantry-1.png", "train");
await insertPhoto(lake, pantryCollection, pantryShot(1), "demo-pantry-2.png", "test");

const gearCollection = newId("col");
await run("INSERT INTO photo_collections (id, house_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
  gearCollection,
  lake,
  "Boots & gear",
  "Closet and garage gear for the vision model",
  demoId,
  now(),
]);
await insertPhoto(lake, gearCollection, bootsShot(), "demo-boots-1.png", "train");
await insertPhoto(lake, gearCollection, headlampShot(), "demo-headlamp-1.png", "val");

/* ----------------------------------------------------------------- ideas + alerts */

const inventory = (await all<any>(
  `SELECT i.name, i.unit, c.name AS category_name,
     COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity
   FROM items i LEFT JOIN categories c ON c.id = i.category_id
   WHERE i.house_id = ? AND i.archived = 0`,
  [lake],
))
  .filter((row) => Number(row.quantity) > 0)
  .map((row) => ({ name: row.name, unit: row.unit, quantity: Number(row.quantity), categoryName: row.category_name }));

const savedRecipes = await Promise.all((await all<any>("SELECT id, title, steps FROM recipes WHERE house_id = ?", [lake])).map(async (recipe) => ({
  id: recipe.id,
  title: recipe.title,
  steps: JSON.parse(recipe.steps || "[]"),
  ingredients: (await all<any>("SELECT name, quantity, unit, optional FROM recipe_ingredients WHERE recipe_id = ?", [recipe.id])).map(
    (ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.quantity,
      unit: ingredient.unit,
      optional: Boolean(ingredient.optional),
    }),
  ),
})));

const ideaResult = localIdeas(inventory, savedRecipes, "Something quick using what we have");
await run("INSERT INTO food_ideas (id, house_id, user_id, prompt, result, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
  newId("ida"),
  lake,
  demoId,
  "Something quick using what we have",
  JSON.stringify(ideaResult),
  daysAgo(1),
]);

for (const item of await all<any>("SELECT id FROM items WHERE house_id = ?", [lake])) await syncItemLowStock(item.id);
await syncHouseExpiry(lake, 7);

/* --------------------------------------------------------------------- done */

const counts = {
  items: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE house_id = ?", [lake]))?.n ?? 0),
  recipes: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM recipes WHERE house_id = ?", [lake]))?.n ?? 0),
  photos: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM photos WHERE house_id = ?", [lake]))?.n ?? 0),
  reminders: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE house_id = ?", [lake]))?.n ?? 0),
};

console.log("Demo vault ready.");
console.log(`  Login:    ${DEMO_EMAIL} / ${PASSWORD}`);
console.log(`  Also:     sofia@svault.local / ${PASSWORD} (member of Lake House)`);
console.log(`  Houses:   Lake House, City Flat`);
console.log(`  Contents: ${counts.items} items, ${counts.recipes} recipes, ${counts.photos} photos, ${counts.reminders} reminders`);