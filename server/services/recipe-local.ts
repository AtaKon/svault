import type { FoodIdea, IdeaResponse, RecipeIngredient, RecipeStep } from "../../shared/types.js";

const UNICODE_FRACTIONS: Record<string, number> = {
  "½": 0.5,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 0.25,
  "¾": 0.75,
  "⅕": 0.2,
  "⅖": 0.4,
  "⅗": 0.6,
  "⅘": 0.8,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
  "⅐": 1 / 7,
  "⅑": 1 / 9,
  "⅒": 0.1,
};

const UNIT_ALIASES: Record<string, string> = {
  cup: "cup",
  cups: "cup",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tbs: "tbsp",
  tbsp: "tbsp",
  tsp: "tsp",
  tspn: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  gram: "g",
  grams: "g",
  gr: "g",
  g: "g",
  kg: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  mg: "mg",
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  cl: "cl",
  l: "l",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  oz: "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  pcs: "pcs",
  pc: "pcs",
  piece: "pcs",
  pieces: "pcs",
  clove: "clove",
  cloves: "clove",
  slice: "slice",
  slices: "slice",
  sprig: "sprig",
  sprigs: "sprig",
  pinch: "pinch",
  pinches: "pinch",
  handful: "handful",
  handfuls: "handful",
  stick: "stick",
  sticks: "stick",
  head: "head",
  heads: "head",
  bunch: "bunch",
  bunches: "bunch",
  can: "can",
  cans: "can",
  jar: "jar",
  jars: "jar",
  pack: "pack",
  packs: "pack",
  packet: "pack",
  packets: "pack",
  box: "box",
  boxes: "box",
  bag: "bag",
  bags: "bag",
  dash: "dash",
  drop: "drop",
  drops: "drop",
  // Greek units (recipes are commonly handwritten in Greek).
  φλιτζάνι: "cup",
  φλιτζανι: "cup",
  φλιτζάνια: "cup",
  φλιτζανια: "cup",
  κούπα: "cup",
  κουπα: "cup",
  κούπες: "cup",
  κουπεσ: "cup",
  κουταλιά: "tbsp",
  κουταλια: "tbsp",
  κουταλιές: "tbsp",
  κουταλιεσ: "tbsp",
  κουτάλι: "tbsp",
  κουταλι: "tbsp",
  κουτάλια: "tbsp",
  κουταλάκι: "tsp",
  κουταλακι: "tsp",
  κουταλάκια: "tsp",
  κουταλακια: "tsp",
  γραμμάριο: "g",
  γραμμαριο: "g",
  γραμμάρια: "g",
  γραμμαρια: "g",
  γρ: "g",
  κιλό: "kg",
  κιλο: "kg",
  κιλά: "kg",
  κιλα: "kg",
  λίτρο: "l",
  λιτρο: "l",
  λίτρα: "l",
  λιτρα: "l",
  λ: "l",
  χιλιοστόλιτρο: "ml",
  χιλιοστολιτρο: "ml",
  χιλιοστόλιτρα: "ml",
  χιλιοστολιτρα: "ml",
  τεμάχιο: "pcs",
  τεμαχιο: "pcs",
  τεμάχια: "pcs",
  τεμαχια: "pcs",
  τεμ: "pcs",
  φέτα: "slice",
  φετα: "slice",
  φέτες: "slice",
  φετες: "slice",
  σκελίδα: "clove",
  σκελιδα: "clove",
  σκελίδες: "clove",
  σκελιδεσ: "clove",
  κλωνάρι: "sprig",
  κλωναρι: "sprig",
  κλωνάρια: "sprig",
  κλωναρια: "sprig",
  πρέζα: "pinch",
  πρεζα: "pinch",
  πρέζες: "pinch",
  πρεζεσ: "pinch",
  χούφτα: "handful",
  χουφτα: "handful",
  χούφτες: "handful",
  χουφτεσ: "handful",
  κονσέρβα: "can",
  κονσερβα: "can",
  κονσέρβες: "can",
  κονσερβεσ: "can",
  πακέτο: "pack",
  πακετο: "pack",
  πακέτα: "pack",
  πακετα: "pack",
  κουτί: "box",
  κουτι: "box",
  κουτιά: "box",
  κουτια: "box",
  σακουλάκι: "bag",
  σακουλακι: "bag",
  σακουλάκια: "bag",
  σακουλακια: "bag",
  ματσάκι: "bunch",
  ματσακι: "bunch",
  ματσάκια: "bunch",
  ματσακια: "bunch",
};

const ING_HEADER =
  /^(ingredients?|ingredient list|you(?:'|’| wi)ll need|what you(?:'|’)?ll need|what you need|shopping list|υλικά|υλικα|συστατικά|συστατικα)\s*:?\s*$/i;
const STEP_HEADER =
  /^(instructions?|method|directions?|preparation|steps|how to (?:make|cook)|cooking|cooking method|procedure|εκτέλεση|εκτελεση|οδηγίες|οδηγιεσ|παρασκευή|παρασκευη|μέθοδος|μεθοδοσ|διαδικασία|διαδικασια)\s*:?\s*$/i;
const NOTES_HEADER =
  /^(notes?|tips?|variations?|serving suggestions?|storage|σημειώσεις|σημειωσεισ|συμβουλές|συμβουλεσ|παραλλαγές|παραλλαγεσ|διατήρηση|διατηρηση)\s*:?\s*$/i;

function normaliseFractions(text: string): string {
  let out = text;
  for (const [char, value] of Object.entries(UNICODE_FRACTIONS)) {
    out = out.replace(new RegExp(`(\\d)\\s*${char}`, "g"), (_m, d: string) => ` ${Number(d) + value} `);
    out = out.split(char).join(` ${value} `);
  }
  return out;
}

function parseNumber(token: string): number | null {
  const t = token.trim().replace(",", ".");
  if (!t) return null;
  if (t.includes(" ")) {
    const parts = t.split(/\s+/);
    let sum = 0;
    for (const part of parts) {
      const v = parseNumber(part);
      if (v == null) return null;
      sum += v;
    }
    return sum;
  }
  if (t.includes("/")) {
    const [a, b] = t.split("/").map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    return a / b;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface ParsedIngredient extends RecipeIngredient {
  raw: string;
}

export function parseIngredientLine(rawLine: string): ParsedIngredient | null {
  let line = rawLine.trim().replace(/^[-*•–—·]\s*/, "");
  if (!line || line.length > 220) return null;
  const qtyMatch = line.match(/^(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?)/);
  let quantity: number | null = null;
  if (qtyMatch) {
    quantity = parseNumber(qtyMatch[1]);
    line = line.slice(qtyMatch[1].length).trim();
  }
  let unit: string | null = null;
  const unitMatch = line.match(/^([a-zA-Zα-ωά-ώΑ-ΩΆ-Ώ.]+)(?=\s|$)/);
  if (unitMatch) {
    const candidate = unitMatch[1].toLowerCase().replace(/\.$/, "");
    if (UNIT_ALIASES[candidate]) {
      unit = UNIT_ALIASES[candidate];
      line = line.slice(unitMatch[0].length).trim();
    }
  }
  line = line.replace(/^of\s+/i, "").replace(/^[-–—:]\s*/, "").trim();
  if (!line) return null;

  let note: string | null = null;
  const noteMatch = line.match(/\(([^)]{2,80})\)/);
  if (noteMatch) {
    note = noteMatch[1].trim();
    line = line.replace(noteMatch[0], "").trim();
  }
  if (!line) return null;

  return {
    raw: rawLine.trim(),
    name: line.replace(/\s+/g, " ").replace(/[.,;]$/, "").trim(),
    quantity,
    unit,
    itemId: null,
    optional: /\b(optional|to taste|if you (?:like|want|have))\b/i.test(rawLine) || /(προαιρετικό|προαιρετικο|κατά βούληση|κατα βουληση)/i.test(rawLine),
    note,
  };
}

function stepTimer(text: string): number | null {
  const hours = text.match(/(\d+(?:[.,]\d+)?)\s*(?:hours?|hrs?|ώρες|ωρεσ|ώρα|ωρα)/i);
  if (hours) return Math.round(parseFloat(hours[1].replace(",", ".")) * 3600);
  const mins = text.match(/(\d+)\s*(?:minutes?|mins?|λεπτά|λεπτα|λεπτό|λεπτο)/i);
  if (mins) return Number(mins[1]) * 60;
  return null;
}

export interface ParsedRecipe {
  title: string;
  description: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  tags: string[];
  ingredients: ParsedIngredient[];
  steps: RecipeStep[];
  notes: string | null;
}

export function heuristicRecipe(rawText: string, fallbackTitle = "Scanned recipe"): ParsedRecipe {
  const text = normaliseFractions(rawText.replace(/\r\n?/g, "\n"));
  // OCR often prefixes lines with pipes, bullets or dashes. Strip them before
  // looking for section headers and quantities.
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[\s|¦•·*\-–—]+/, "").trim())
    .filter((line) => line.length > 0);

  const servingsMatch = text.match(/(?:serves|servings?|yields?|μερίδες|μεριδεσ|μεριδες|άτομα|ατομα)\s*[:\-]?\s*(\d+)/i);
  const prepMatch = text.match(
    /(?:prep(?:aration)?(?:\s*time)?|(?:χρόνος\s*)?προετοιμασίας?|προετοιμασιασ?|προετοιμασια)\s*[:\-]?\s*(\d+)/i,
  );
  const cookMatch = text.match(
    /(?:cook|bake|baking|roast|simmer|total|μαγείρεμα|μαγειρεμα|ψήσιμο|ψησιμο|συνολικός χρόνος|συνολικοσ χρονοσ)\s*(?:time)?\s*[:\-]?\s*(\d+)\s*(?:min|minutes|λεπτά|λεπτα|λεπτό|λεπτο)?/i,
  );

  let ingStart = -1;
  let stepStart = -1;
  let notesStart = -1;
  lines.forEach((line, i) => {
    if (ingStart < 0 && ING_HEADER.test(line)) ingStart = i;
    if (stepStart < 0 && STEP_HEADER.test(line)) stepStart = i;
    if (notesStart < 0 && NOTES_HEADER.test(line)) notesStart = i;
  });
  if (notesStart >= 0 && stepStart >= 0 && notesStart < stepStart) notesStart = -1;

  const titleCandidates = lines.filter(
    (line) =>
      line.length <= 90 &&
      !ING_HEADER.test(line) &&
      !STEP_HEADER.test(line) &&
      !NOTES_HEADER.test(line) &&
      !/^\d+[.)]\s+/.test(line) &&
      parseIngredientLine(line)?.quantity == null,
  );
  let title = (titleCandidates[0] ?? fallbackTitle).replace(/^(recipe\s*[:\-]\s*)/i, "").trim().slice(0, 120);
  const secondLine = titleCandidates[1];
  if (
    secondLine &&
    title.length <= 42 &&
    /['’]s?$/.test(title.split(" ").slice(-1)[0] ?? "") &&
    /^[A-Z]/.test(secondLine) &&
    secondLine.split(/\s+/).length <= 4 &&
    !/[.:!?]$/.test(title)
  ) {
    title = `${title} ${secondLine}`.slice(0, 120);
  }

  const titleLine = titleCandidates[0] ?? "";

  const description =
    ingStart > 1
      ? lines.slice(1, ingStart).filter((l) => l !== titleLine && l !== secondLine).join(" ").slice(0, 400) || null
      : null;

  const ingredients: ParsedIngredient[] = [];
  const steps: RecipeStep[] = [];

  const pushIngredient = (line: string) => {
    const parsed = parseIngredientLine(line);
    if (parsed) ingredients.push(parsed);
  };

  if (ingStart >= 0 || stepStart >= 0) {
    const ingEnd = stepStart >= 0 ? stepStart : notesStart >= 0 ? notesStart : lines.length;
    if (ingStart >= 0) {
      for (let i = ingStart + 1; i < ingEnd; i++) {
        const line = lines[i];
        if (NOTES_HEADER.test(line)) break;
        if (/^for the\b/i.test(line) && !parseIngredientLine(line)?.quantity) continue;
        if (line.length < 100) pushIngredient(line);
        else line.split(/;\s*/).forEach(pushIngredient);
      }
    }
    const stepEnd = notesStart > stepStart ? notesStart : lines.length;
    if (stepStart >= 0) {
      for (let i = stepStart + 1; i < stepEnd; i++) {
        const line = lines[i];
        if (/^\d+[.)]\s+/.test(line)) {
          const body = line.replace(/^\d+[.)]\s*/, "").trim();
          steps.push({ text: body, timerSeconds: stepTimer(body) });
        } else if (steps.length && line.length < 120) {
          const last = steps[steps.length - 1];
          last.text = `${last.text} ${line}`.trim();
        } else if (!/^(for the|serves|prep|total)\b/i.test(line)) {
          steps.push({ text: line, timerSeconds: stepTimer(line) });
        }
      }
    }
  }

  if (!ingredients.length) {
    // No ingredient section: use quantity-prefixed lines as ingredients.
    for (const line of lines) {
      if (/^\d+[.)]\s+/.test(line)) continue;
      if (/^\s*\d/.test(line)) pushIngredient(line);
    }
  }

  if (!steps.length) {
    const numbered = lines.filter((l) => /^\d+[.)]\s+/.test(l));
    if (numbered.length) {
      for (const line of numbered) {
        const body = line.replace(/^\d+[.)]\s*/, "").trim();
        steps.push({ text: body, timerSeconds: stepTimer(body) });
      }
    } else {
      let current: string[] = [];
      for (const line of lines) {
        if (parseIngredientLine(line)?.quantity && ingredients.some((i) => i.raw === line)) continue;
        if (line === titleLine || ING_HEADER.test(line) || STEP_HEADER.test(line) || NOTES_HEADER.test(line)) continue;
        if (line.length < 12 && current.length === 0) continue;
        current.push(line);
        if (/[.!?]$/.test(line) && current.join(" ").length > 80) {
          steps.push({ text: current.join(" "), timerSeconds: stepTimer(current.join(" ")) });
          current = [];
        }
      }
      if (current.length) steps.push({ text: current.join(" "), timerSeconds: stepTimer(current.join(" ")) });
    }
  }

  if (!ingredients.length && !steps.length) {
    steps.push({ text: text.slice(0, 600), timerSeconds: null });
  }

  const lower = text.toLowerCase();
  const tagRules: [RegExp, string][] = [
    [/vegan/, "vegan"],
    [/vegetarian/, "vegetarian"],
    [/gluten[- ]free/, "gluten-free"],
    [/baking|cake|cookies?|bread|pastry/, "baking"],
    [/dessert|sweet|pudding|cake/, "dessert"],
    [/soup|stew|broth/, "soup"],
    [/breakfast|brunch/, "breakfast"],
    [/salad/, "salad"],
    [/grandma|grandmother|nana|oma|yiayia/, "family"],
  ];
  const tags = tagRules.filter(([re]) => re.test(lower)).map(([, tag]) => tag);

  return {
    title,
    description,
    servings: servingsMatch ? Number(servingsMatch[1]) : null,
    prepMinutes: prepMatch ? Number(prepMatch[1]) : null,
    cookMinutes: cookMatch ? Number(cookMatch[1]) : null,
    tags,
    ingredients: ingredients.slice(0, 80),
    steps: steps.slice(0, 60),
    notes: notesStart >= 0 ? lines.slice(notesStart + 1).join(" ").slice(0, 600) || null : null,
  };
}

interface InventoryEntry {
  name: string;
  quantity: number;
  unit: string;
  categoryName?: string | null;
}

interface RecipeInput {
  id: string;
  title: string;
  ingredients: { name: string; quantity: number | null; unit: string | null; optional: boolean }[];
  steps: { text: string }[];
}

function looseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(fresh|chopped|diced|minced|ground|large|small|medium|whole|organic|frozen|canned|tinned|dried)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matches(name: string, inventoryNames: string[]): boolean {
  const a = looseName(name);
  if (!a) return false;
  return inventoryNames.some((b) => a === b || a.includes(b) || b.includes(a));
}

export function localIdeas(inventory: InventoryEntry[], recipes: RecipeInput[], prompt: string): IdeaResponse {
  const inventoryNames = inventory.map((i) => looseName(i.name)).filter(Boolean);
  const ideas: FoodIdea[] = [];

  const scored = recipes
    .map((recipe) => {
      const ingredients = recipe.ingredients;
      const matched = ingredients.filter((i) => matches(i.name, inventoryNames));
      const missing = ingredients.filter((i) => !i.optional && !matches(i.name, inventoryNames));
      const total = ingredients.filter((i) => !i.optional).length || 1;
      return { recipe, matched, missing, coverage: matched.length / total };
    })
    .filter((r) => r.matched.length > 0 && r.coverage >= 0.5)
    .sort((a, b) => b.coverage - a.coverage || a.missing.length - b.missing.length)
    .slice(0, 4);

  for (const s of scored) {
    ideas.push({
      title: s.recipe.title,
      rationale: `You already have ${s.matched.length} of ${s.matched.length + s.missing.length} ingredients saved for this recipe.`,
      timeMinutes: null,
      servings: null,
      uses: s.matched.map((m) => ({ name: m.name, quantity: m.quantity, unit: m.unit })),
      missing: s.missing.map((m) => ({ name: m.name, quantity: m.quantity, unit: m.unit })),
      steps: s.recipe.steps.slice(0, 8).map((step) => step.text),
      source: "recipe",
      recipeId: s.recipe.id,
    });
  }

  const lowerPrompt = prompt.toLowerCase();
  const wantsVeg = /vegan|plant[- ]based|vegetarian|meat[- ]free/.test(lowerPrompt);
  const quick = /quick|fast|minute|hurry|easy/.test(lowerPrompt);

  const categories = (pattern: RegExp) =>
    inventory.filter((i) => pattern.test(`${i.categoryName ?? ""} ${i.name}`)).filter((i) => i.quantity > 0);
  const veg = categories(/produce|veg|tomato|pepper|onion|carrot|zucchini|courgette|spinach|mushroom|broccoli|potato|leek|bean/i).filter(
    (i) => !/lemon|lime|orange|fruit|apple|banana|berry|grape|pear|peach|plum|coffee|cocoa/i.test(i.name),
  );
  const protein = categories(/meat|chicken|beef|pork|fish|tuna|salmon|bacon|egg|bean|lentil|chickpea|tofu|tempeh|yogurt|cheese/i)
    .filter((i) => !/coffee|cocoa|vanilla|jam/i.test(i.name))
    .filter((i) => !wantsVeg || !/meat|chicken|beef|pork|fish|tuna|salmon|bacon|ham|sausage/i.test(i.name));
  const starch = categories(/rice|pasta|noodle|couscous|quinoa|bread|tortilla|flour|potato/i);
  const dairy = categories(/dairy|milk|cheese|yogurt|cream|butter/i);
  const sweet = categories(/fruit|apple|banana|berry|orange|pear|peach|plum|grape/i);
  const bread = categories(/bread|toast|baguette|pita|tortilla/i);

  if (veg.length || protein.length) {
    const foundation = (protein[0] ?? veg[0])?.name ?? "pantry";
    const companions = [veg[0], veg[1], starch[0]]
      .filter((entry): entry is InventoryEntry => Boolean(entry))
      .filter((entry) => entry.name !== foundation)
      .slice(0, 3);
    const uses = [protein[0] ?? veg[0], ...companions].filter(
      (entry): entry is InventoryEntry => Boolean(entry),
    ).map((entry) => ({
      name: entry.name,
      quantity: entry.quantity,
      unit: entry.unit,
    }));
    const lower = (value: string) => value.toLowerCase();
    ideas.push({
      title: `One-pan ${lower(foundation)}${companions[0] ? ` with ${lower(companions[0].name)}` : ""}`,
      rationale: "Uses what you already have and needs almost nothing extra.",
      timeMinutes: quick ? 15 : 30,
      servings: 2,
      uses,
      missing: [
        { name: "olive oil", quantity: 1, unit: "tbsp" },
        { name: "salt", quantity: null, unit: null },
        { name: "black pepper", quantity: null, unit: null },
      ].filter((m) => !matches(m.name, inventoryNames)),
      steps: [
        `Prep the ${lower(foundation)} and the other ingredients into bite-sized pieces.`,
        starch[0] ? `Start the ${lower(starch[0].name)} in salted water if it needs cooking.` : "Heat a wide pan over medium-high heat with a splash of oil.",
        protein[0] ? `Add the ${lower(protein[0].name)} first, then the vegetables, and cook until just tender.` : "Add the vegetables and cook until just tender.",
        "Season to taste, combine everything in the pan (or over the starch) and serve hot.",
      ],
      source: "inventory",
    });
  }

  if (bread.length && dairy.length) {
    ideas.push({
      title: "Loaded toast from the fridge",
      rationale: `You have ${bread[0].name} and ${dairy[0].name} — a five-minute meal.`,
      timeMinutes: 10,
      servings: 1,
      uses: [
        { name: bread[0].name, quantity: 2, unit: "slice" },
        { name: dairy[0].name, quantity: null, unit: null },
        ...veg.slice(0, 2).map((v) => ({ name: v.name, quantity: null, unit: null })),
      ],
      missing: [],
      steps: [
        "Toast the bread until crisp.",
        `Spread ${dairy[0].name} generously while still warm.`,
        veg.length ? `Top with ${veg.map((v) => v.name).slice(0, 2).join(" and ")} and a pinch of salt.` : "Finish with a pinch of salt and pepper.",
        "Add a drizzle of oil or a fried egg if you have one.",
      ],
      source: "inventory",
    });
  }

  if (sweet.length) {
    const extra = dairy.find((d) => /yogurt|milk|cream/i.test(d.name));
    ideas.push({
      title: extra ? "Fruit bowl with a spoonful of something creamy" : "Fresh fruit plate",
      rationale: "No cooking needed, uses up ripe fruit before it turns.",
      timeMinutes: 5,
      servings: 2,
      uses: sweet.slice(0, 3).map((s) => ({ name: s.name, quantity: null, unit: null })),
      missing: [],
      steps: extra
        ? ["Wash and cut the fruit into pieces.", `Spoon over the ${extra.name}.`, "Add honey, cinnamon or nuts if you have them."]
        : ["Wash and slice the fruit.", "Arrange on a plate and finish with a little sugar or lemon if available."],
      source: "inventory",
    });
  }

  if (!ideas.length) {
    const sample = inventory.slice(0, 5);
    ideas.push({
      title: "Pantry raid plate",
      rationale: inventory.length
        ? "You have the building blocks — this is a no-recipe plate to use them up."
        : "Start by adding a few items to your house and you will get better ideas.",
      timeMinutes: 15,
      servings: 2,
      uses: sample.map((s) => ({ name: s.name, quantity: null, unit: null })),
      missing: sample.length ? [] : [{ name: "anything in the fridge", quantity: null, unit: null }],
      steps: [
        "Collect a protein, a vegetable, something starchy and a sauce.",
        "Cook the protein and vegetable simply with salt and oil.",
        "Warm the starch and plate everything together with the sauce on the side.",
      ],
      source: "inventory",
    });
  }

  const summary = inventory.length
    ? `Built from ${inventory.length} items with stock in this house${questSuffix(prompt)}.`
    : "Add stock to your house for ideas based on what you actually own.";
  return { provider: "local", summary, ideas: ideas.slice(0, 5) };
}

function questSuffix(prompt: string): string {
  return prompt ? `, following your request “${prompt.slice(0, 80)}”` : "";
}

/** Coerce AI output into the shapes the client expects. */
function compact<T>(items: (T | null | undefined)[]): T[] {
  return items.filter((item): item is T => item != null);
}

export function normaliseRecipeDraft(raw: Record<string, any>, fallbackTitle: string): ParsedRecipe {
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const rawIngredients = Array.isArray(raw.ingredients)
    ? raw.ingredients.map((ing: any): ParsedIngredient | null => {
        const name = String(ing?.name ?? "").trim();
        if (!name) return null;
        return {
          raw: name,
          name,
          quantity: num(ing.quantity),
          unit: ing.unit ? String(ing.unit).trim() : null,
          itemId: null,
          optional: Boolean(ing.optional),
          note: ing.note ? String(ing.note) : null,
        };
      })
    : [];
  const ingredients: ParsedIngredient[] = compact(rawIngredients);

  const rawSteps = Array.isArray(raw.steps)
    ? raw.steps.map((step: any): RecipeStep | null => {
        const text = typeof step === "string" ? step : String(step?.text ?? "");
        if (!text.trim()) return null;
        return {
          text: text.trim(),
          timerSeconds: num(typeof step === "object" ? step?.timerSeconds : null),
        };
      })
    : [];
  const steps: RecipeStep[] = compact(rawSteps);

  return {
    title: String(raw.title ?? fallbackTitle).trim().slice(0, 160) || fallbackTitle,
    description: raw.description ? String(raw.description).slice(0, 1200) : null,
    servings: num(raw.servings),
    prepMinutes: num(raw.prepMinutes),
    cookMinutes: num(raw.cookMinutes),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t: any) => String(t).toLowerCase().slice(0, 30)).slice(0, 8) : [],
    ingredients,
    steps,
    notes: raw.notes ? String(raw.notes).slice(0, 1200) : null,
  };
}

export function normaliseIdeas(raw: Record<string, any>): IdeaResponse {
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const list = Array.isArray(raw.ideas) ? raw.ideas : [];
  const rawIdeas = list.map((idea: any): FoodIdea | null => {
    const title = String(idea?.title ?? "").trim();
    if (!title) return null;
    const mapItems = (arr: any) =>
      Array.isArray(arr)
        ? arr
            .map((x: any) => ({
              name: String(x?.name ?? "").trim(),
              quantity: num(x?.quantity),
              unit: x?.unit ? String(x.unit) : null,
            }))
            .filter((x: any) => x.name)
            .slice(0, 20)
        : [];
    return {
      title,
      rationale: String(idea.rationale ?? "").slice(0, 400),
      timeMinutes: num(idea.timeMinutes),
      servings: num(idea.servings),
      uses: mapItems(idea.uses),
      missing: mapItems(idea.missing),
      steps: Array.isArray(idea.steps) ? idea.steps.map((s: any) => String(s)).filter(Boolean).slice(0, 15) : [],
      source: "ai",
      recipeId: idea.recipeId ? String(idea.recipeId) : null,
    };
  });
  const ideas = compact(rawIdeas).slice(0, 6);
  return {
    provider: "ai",
    summary: String(raw.summary ?? "Fresh ideas based on your inventory.").slice(0, 500),
    ideas,
  };
}
