import { all, get, newId, now, parseJson, run } from "../db.js";

/**
 * A small reference catalogue of common shops, starting with Greece. House
 * vendors stay user-owned; this table is only used for suggestions and for
 * resolving the merchant printed on a receipt to a consistent name.
 */

export const CATALOG_COUNTRIES: Record<string, string> = {
  GR: "Greece",
};

interface CatalogSeed {
  name: string;
  kind: string;
  aliases: string[];
  sort: number;
}

export interface CatalogEntry {
  id: string;
  country: string;
  name: string;
  kind: string;
  aliases: string[];
  sort: number;
}

const GREEK_SHOPS: CatalogSeed[] = [
  {
    name: "Σκλαβενίτης",
    kind: "supermarket",
    aliases: ["Sklavenitis", "SKLAVENITIS", "ΣΚΛΑΒΕΝΙΤΗΣ", "Sklavenitis Hellas"],
    sort: 10,
  },
  {
    name: "ΑΒ Βασιλόπουλος",
    kind: "supermarket",
    aliases: ["AB Vassilopoulos", "AB VASSILOPOULOS", "AB", "ΑΒ", "Βασιλόπουλος", "AB Food Market"],
    sort: 20,
  },
  {
    name: "Lidl",
    kind: "supermarket",
    aliases: ["LIDL", "LIDL HELLAS", "Λιντλ", "ΛΙΝΤΛ"],
    sort: 30,
  },
  {
    name: "My Market",
    kind: "supermarket",
    aliases: ["MY MARKET", "Metro", "ΜΕΤΡΟ", "Metro AEBE"],
    sort: 40,
  },
  {
    name: "Μασούτης",
    kind: "supermarket",
    aliases: ["Masoutis", "MASOUTIS", "ΜΑΣΟΥΤΗΣ"],
    sort: 50,
  },
  {
    name: "Κρητικός",
    kind: "supermarket",
    aliases: ["Kritikos", "KRITIKOS", "ΚΡΗΤΙΚΟΣ"],
    sort: 60,
  },
  {
    name: "Γαλαξίας",
    kind: "supermarket",
    aliases: ["Galaxias", "GALAXIAS", "ΓΑΛΑΞΙΑΣ"],
    sort: 70,
  },
  {
    name: "Bazaar",
    kind: "supermarket",
    aliases: ["BAZAAR", "Bazaar Supermarket", "Μπαζάρ"],
    sort: 80,
  },
  {
    name: "The Mart",
    kind: "supermarket",
    aliases: ["THE MART", "TheMart"],
    sort: 90,
  },
  {
    name: "Discount Markt",
    kind: "supermarket",
    aliases: ["DISCOUNT MARKT", "Discount Markt Hellas", "Ντίσκαουντ Μάρκετ"],
    sort: 100,
  },
  {
    name: "Market In",
    kind: "supermarket",
    aliases: ["MARKET IN", "MARKET-IN", "Market In"],
    sort: 110,
  },
  {
    name: "ΣΥΝ.ΚΑ",
    kind: "supermarket",
    aliases: ["SYN.KA", "SYNKA", "ΣΥΝΚΑ", "ΣΥΝ.ΚΑ"],
    sort: 120,
  },
  {
    name: "Χαλκιαδάκης",
    kind: "supermarket",
    aliases: ["Chalkiadakis", "CHALKIADAKIS", "ΧΑΛΚΙΑΔΑΚΗΣ"],
    sort: 130,
  },
  {
    name: "METRO Cash & Carry",
    kind: "wholesale",
    aliases: ["METRO CASH & CARRY", "METRO CASH AND CARRY", "ΜΕΤΡΟ CASH & CARRY", "METRO"],
    sort: 140,
  },
  {
    name: "OK Market",
    kind: "convenience",
    aliases: ["OK MARKET", "OK! MARKET", "OK Market"],
    sort: 150,
  },
  {
    name: "e-food Market",
    kind: "online",
    aliases: ["E-FOOD", "EFOOD", "EFOOD.GR", "e-food.gr", "e-food"],
    sort: 160,
  },
  {
    name: "Skroutz Market",
    kind: "online",
    aliases: ["SKROUTZ MARKET", "SKROUTZ", "Skroutz"],
    sort: 170,
  },
  {
    name: "Wolt Market",
    kind: "online",
    aliases: ["WOLT MARKET", "WOLT", "Wolt"],
    sort: 180,
  },
  {
    name: "Βενέτης",
    kind: "deli",
    aliases: ["Venetis", "VENETIS", "ΒΕΝΕΤΗΣ"],
    sort: 190,
  },
  {
    name: "Τερκενλής",
    kind: "deli",
    aliases: ["Terkenlis", "TERKENLIS", "ΤΕΡΚΕΝΛΗΣ"],
    sort: 200,
  },
  {
    name: "Περίπτερο (kiosk)",
    kind: "kiosk",
    // Greek-only alias: "DELI"/"KIOSK" appear in product lines and would cause false matches.
    aliases: ["ΠΕΡΙΠΤΕΡΟ", "Periptero"],
    sort: 210,
  },
  {
    name: "Delicatessen (deli)",
    kind: "deli",
    aliases: ["ΝΤΕΛΙΚΑΤΕΣΕΝ", "Delicatessen"],
    sort: 220,
  },
  {
    name: "Μανάβικο (greengrocer)",
    kind: "market",
    aliases: ["ΜΑΝΑΒΙΚΟ", "Μανάβης", "ΜΑΝΑΒΗΣ"],
    sort: 230,
  },
  {
    name: "Λαϊκή αγορά (farmers' market)",
    kind: "market",
    aliases: ["ΛΑΪΚΗ", "ΛΑΙΚΗ", "Laiki"],
    sort: 240,
  },
];

/** Normalise a merchant name for comparison: accents, case, punctuation and final sigma. */
export function normalizeVendorName(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(/[^a-z0-9α-ω]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesAlias(text: string, alias: string): boolean {
  const hay = normalizeVendorName(text);
  const needle = normalizeVendorName(alias);
  if (!hay || !needle) return false;
  if (needle.length <= 3) return hay === needle || hay.startsWith(`${needle} `);
  return hay === needle || ` ${hay} `.includes(` ${needle} `);
}

export async function seedVendorCatalog() {
  for (const entry of GREEK_SHOPS) {
    await run(
      `INSERT INTO vendor_catalog (id, country, name, kind, aliases, sort, created_at)
       VALUES (?, 'GR', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [newId("vct"), entry.name, entry.kind, JSON.stringify(entry.aliases), entry.sort, now()],
    );
  }
}

export async function catalogEntries(country = "GR"): Promise<CatalogEntry[]> {
  return (await all<any>("SELECT * FROM vendor_catalog WHERE country = ? ORDER BY sort, name", [country.toUpperCase()])).map(
    (row) => ({
      id: row.id,
      country: row.country,
      name: row.name,
      kind: row.kind,
      aliases: parseJson<string[]>(row.aliases, []),
      sort: Number(row.sort ?? 100),
    }),
  );
}

export async function catalogById(catalogId: string): Promise<CatalogEntry | null> {
  const row = await get<any>("SELECT * FROM vendor_catalog WHERE id = ?", [catalogId]);
  if (!row) return null;
  return {
    id: row.id,
    country: row.country,
    name: row.name,
    kind: row.kind,
    aliases: parseJson<string[]>(row.aliases, []),
    sort: Number(row.sort ?? 100),
  };
}

export async function catalogCountries(): Promise<{ code: string; name: string }[]> {
  const rows = await all<{ country: string }>("SELECT DISTINCT country FROM vendor_catalog ORDER BY country");
  return rows.map((row) => ({ code: row.country, name: CATALOG_COUNTRIES[row.country] ?? row.country }));
}

/** Match a merchant name against the catalogue and return the canonical entry. */
export async function canonicalVendor(value: string | null | undefined, country = "GR"): Promise<CatalogEntry | null> {
  if (!value) return null;
  let best: { entry: CatalogEntry; length: number } | null = null;
  for (const entry of await catalogEntries(country)) {
    for (const alias of [entry.name, ...entry.aliases]) {
      if (!matchesAlias(value, alias)) continue;
      const length = normalizeVendorName(alias).length;
      if (!best || length > best.length) best = { entry, length };
    }
  }
  return best?.entry ?? null;
}

/** Look for a known shop in the header of a receipt. */
export async function detectCatalogVendor(text: string, country = "GR"): Promise<CatalogEntry | null> {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  for (const line of lines) {
    const entry = await canonicalVendor(line, country);
    if (entry) return entry;
  }
  return null;
}
