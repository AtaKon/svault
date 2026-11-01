import { newId, now, run, tx } from "../db.js";
import type { HouseSettings } from "../../shared/types.js";

const DEFAULT_LOCATIONS = [
  { name: "Pantry", kind: "pantry", icon: "🥫" },
  { name: "Fridge", kind: "fridge", icon: "🧊" },
  { name: "Freezer", kind: "freezer", icon: "❄️" },
  { name: "Cupboard", kind: "cupboard", icon: "🚪" },
  { name: "Closet", kind: "closet", icon: "👕" },
  { name: "Cabin", kind: "cabin", icon: "🏚️" },
  { name: "Garage", kind: "garage", icon: "🔧" },
  { name: "Bathroom", kind: "bathroom", icon: "🧴" },
];

const DEFAULT_CATEGORIES = [
  { name: "Food", icon: "🍎" },
  { name: "Dairy", icon: "🥛" },
  { name: "Produce", icon: "🥕" },
  { name: "Frozen", icon: "🧊" },
  { name: "Drinks", icon: "🧃" },
  { name: "Snacks", icon: "🍪" },
  { name: "Cleaning", icon: "🧼" },
  { name: "Clothing", icon: "👕" },
  { name: "Tools", icon: "🧰" },
  { name: "Medicine", icon: "💊" },
  { name: "Other", icon: "📦" },
];

const DEFAULT_ATTRIBUTES = [
  { key: "brand", label: "Brand", type: "text", sort: 1 },
  { key: "size", label: "Size", type: "text", sort: 2 },
  { key: "color", label: "Colour", type: "text", sort: 3 },
  { key: "warranty_until", label: "Warranty until", type: "date", sort: 4 },
];

export function createHouse(opts: {
  userId: string;
  name: string;
  kind?: string;
  address?: string | null;
  currency?: string;
  settings?: HouseSettings;
}): string {
  return tx(() => {
    const id = newId("hse");
    const stamp = now();
    run(
      "INSERT INTO houses (id, name, kind, address, currency, settings, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.name.trim(),
        opts.kind ?? "home",
        opts.address ?? null,
        opts.currency ?? "EUR",
        JSON.stringify(opts.settings ?? {}),
        opts.userId,
        stamp,
      ],
    );
    run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [
      id,
      opts.userId,
      stamp,
    ]);
    for (const loc of DEFAULT_LOCATIONS) {
      run(
        "INSERT INTO locations (id, house_id, name, kind, icon, parent_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
        [newId("loc"), id, loc.name, loc.kind, loc.icon, stamp],
      );
    }
    for (const cat of DEFAULT_CATEGORIES) {
      run("INSERT INTO categories (id, house_id, name, icon, parent_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)", [
        newId("cat"),
        id,
        cat.name,
        cat.icon,
        stamp,
      ]);
    }
    for (const attr of DEFAULT_ATTRIBUTES) {
      run(
        `INSERT INTO attribute_defs (id, house_id, key, label, type, unit, options, required, category_id, sort, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, '[]', 0, NULL, ?, ?)`,
        [newId("att"), id, attr.key, attr.label, attr.type, attr.sort, stamp],
      );
    }
    return id;
  });
}

