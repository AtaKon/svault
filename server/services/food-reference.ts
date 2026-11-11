/**
 * A small built-in food reference used when a recipe ingredient does not
 * resolve to an inventory item with a nutrition panel.
 *
 * Values are typical per-100 g figures for common cooking ingredients. They are
 * estimates, not label data: a specific product linked in the inventory always
 * wins, and the recipe UI reports how many ingredients could be estimated.
 */

export interface ReferenceFacts {
  energyKcal: number;
  proteins?: number;
  fat?: number;
  carbohydrates?: number;
  fiber?: number;
  salt?: number;
}

/** Most specific entries first: "peanut butter" must beat "butter". */
const FOODS: [RegExp, ReferenceFacts][] = [
  [/peanut butter|φυστικοβούτυρο/i, { energyKcal: 588, proteins: 25, fat: 50, carbohydrates: 20, fiber: 6, salt: 1.1 }],
  [/coconut milk|γάλα καρύδας/i, { energyKcal: 230, proteins: 2.3, fat: 24, carbohydrates: 5.5 }],
  [/icing sugar|powdered sugar|ζάχαρη άχνη/i, { energyKcal: 389, proteins: 0, fat: 0, carbohydrates: 100 }],
  [/brown sugar|μαύρη ζάχαρη/i, { energyKcal: 380, proteins: 0, fat: 0, carbohydrates: 98 }],
  [/sweet potato|γλυκοπατάτα/i, { energyKcal: 86, proteins: 1.6, fat: 0.1, carbohydrates: 20, fiber: 3 }],
  [/cherry tomato|grape tomato|ντοματίνι/i, { energyKcal: 18, proteins: 0.9, fat: 0.2, carbohydrates: 3.9, fiber: 1.2 }],
  [/tomato paste|τοματοπελτές|πελτές/i, { energyKcal: 82, proteins: 4.3, fat: 0.5, carbohydrates: 19, fiber: 4.1, salt: 0.1 }],
  [/bell pepper|red pepper|green pepper|yellow pepper|πιπεριά/i, { energyKcal: 31, proteins: 1, fat: 0.3, carbohydrates: 6, fiber: 2.1 }],
  [/chicken breast|στήθος κοτόπουλο/i, { energyKcal: 165, proteins: 31, fat: 3.6, carbohydrates: 0 }],
  [/chicken thigh|μπούτι κοτόπουλο/i, { energyKcal: 209, proteins: 26, fat: 10.9, carbohydrates: 0 }],
  [/olive oil|ελαιόλαδο/i, { energyKcal: 884, proteins: 0, fat: 100, carbohydrates: 0 }],
  [/soy sauce|σόγια/i, { energyKcal: 53, proteins: 8, fat: 0.1, carbohydrates: 4.9, salt: 15 }],
  [/baking powder|baking soda|μαγειρική σόδα/i, { energyKcal: 53, proteins: 0, fat: 0, carbohydrates: 28 }],
  [/breadcrumb|φρυγανιά/i, { energyKcal: 395, proteins: 13, fat: 5.3, carbohydrates: 72 }],
  [/flour|αλεύρι/i, { energyKcal: 364, proteins: 10.3, fat: 1, carbohydrates: 76.3, fiber: 2.7, salt: 0.01 }],
  [/sugar|ζάχαρη/i, { energyKcal: 400, proteins: 0, fat: 0, carbohydrates: 100 }],
  [/rice|ρύζι/i, { energyKcal: 365, proteins: 7.1, fat: 0.7, carbohydrates: 80, fiber: 1.3 }],
  [/pasta|spaghetti|macaroni|noodle|ζυμαρικά|μακαρόνια/i, { energyKcal: 371, proteins: 13, fat: 1.5, carbohydrates: 75, fiber: 3.2 }],
  [/oats|βρώμη/i, { energyKcal: 389, proteins: 16.9, fat: 6.9, carbohydrates: 66, fiber: 10.6 }],
  [/bread|ψωμί/i, { energyKcal: 265, proteins: 9, fat: 3.2, carbohydrates: 49, fiber: 2.7, salt: 1.2 }],
  [/egg|αβγό/i, { energyKcal: 143, proteins: 12.6, fat: 9.5, carbohydrates: 0.7, salt: 0.36 }],
  [/parmesan|παρμεζάνα/i, { energyKcal: 392, proteins: 36, fat: 26, carbohydrates: 3.2, salt: 3.2 }],
  [/feta|φέτα/i, { energyKcal: 264, proteins: 14, fat: 21, carbohydrates: 4.1, salt: 2.9 }],
  [/mozzarella|μοτσαρέλα/i, { energyKcal: 280, proteins: 28, fat: 17, carbohydrates: 3.1, salt: 1.3 }],
  [/cheese|τυρί/i, { energyKcal: 350, proteins: 25, fat: 27, carbohydrates: 2, salt: 1.8 }],
  [/yogurt|yoghurt|γιαούρτι/i, { energyKcal: 59, proteins: 10, fat: 0.4, carbohydrates: 3.6, salt: 0.1 }],
  [/cream|κρέμα/i, { energyKcal: 340, proteins: 2.1, fat: 36, carbohydrates: 2.8 }],
  [/milk|γάλα/i, { energyKcal: 61, proteins: 3.2, fat: 3.3, carbohydrates: 4.8, salt: 0.1 }],
  [/butter|βούτυρο/i, { energyKcal: 717, proteins: 0.9, fat: 81, carbohydrates: 0.1, salt: 1.5 }],
  [/honey|syrup|molasses|μέλι|σιρόπι/i, { energyKcal: 304, proteins: 0.3, fat: 0, carbohydrates: 82 }],
  [/jam|marmalade|μαρμελάδα/i, { energyKcal: 278, proteins: 0.4, fat: 0.1, carbohydrates: 69 }],
  [/mayonnaise|mayo|μαγιονέζα/i, { energyKcal: 680, proteins: 1, fat: 75, carbohydrates: 0.6, salt: 1.2 }],
  [/ketchup|κέτσαπ/i, { energyKcal: 101, proteins: 1.2, fat: 0.1, carbohydrates: 24, salt: 2.5 }],
  [/mustard|μουστάρδα/i, { energyKcal: 66, proteins: 4, fat: 3.3, carbohydrates: 5.8, salt: 2.4 }],
  [/cocoa|κακάο/i, { energyKcal: 228, proteins: 19.6, fat: 13.7, carbohydrates: 57.9, fiber: 33 }],
  [/chocolate|σοκολάτα/i, { energyKcal: 546, proteins: 5, fat: 31, carbohydrates: 61 }],
  [/almond|αμύγδαλο/i, { energyKcal: 579, proteins: 21, fat: 50, carbohydrates: 22, fiber: 12.5 }],
  [/walnut|καρύδι/i, { energyKcal: 654, proteins: 15, fat: 65, carbohydrates: 14, fiber: 6.7 }],
  [/nuts|ξηροί καρποί/i, { energyKcal: 600, proteins: 20, fat: 52, carbohydrates: 20, fiber: 8 }],
  [/lentil|φακή/i, { energyKcal: 352, proteins: 25, fat: 1.1, carbohydrates: 63, fiber: 10.7 }],
  [/chickpea|ρεβύθι/i, { energyKcal: 364, proteins: 19, fat: 6, carbohydrates: 61, fiber: 17 }],
  [/bean|φασόλι/i, { energyKcal: 347, proteins: 21, fat: 1.2, carbohydrates: 63, fiber: 16 }],
  [/tofu|τόφου/i, { energyKcal: 76, proteins: 8, fat: 4.8, carbohydrates: 1.9 }],
  [/salmon|σολομός/i, { energyKcal: 208, proteins: 20, fat: 13, carbohydrates: 0 }],
  [/tuna|τόνος/i, { energyKcal: 132, proteins: 28, fat: 1, carbohydrates: 0 }],
  [/shrimp|prawn|γαρίδα/i, { energyKcal: 99, proteins: 24, fat: 0.3, carbohydrates: 0.2 }],
  [/fish|ψάρι/i, { energyKcal: 96, proteins: 18, fat: 2, carbohydrates: 0 }],
  [/bacon|μπέικον/i, { energyKcal: 541, proteins: 37, fat: 42, carbohydrates: 1.4, salt: 1.7 }],
  [/sausage|λουκάνικο/i, { energyKcal: 300, proteins: 12, fat: 27, carbohydrates: 2, salt: 2 }],
  [/chicken|κοτόπουλο/i, { energyKcal: 190, proteins: 27, fat: 8, carbohydrates: 0 }],
  [/beef|μοσχάρι/i, { energyKcal: 250, proteins: 26, fat: 15, carbohydrates: 0 }],
  [/pork|χοιρινό/i, { energyKcal: 242, proteins: 27, fat: 14, carbohydrates: 0 }],
  [/lamb|αρνί/i, { energyKcal: 294, proteins: 25, fat: 21, carbohydrates: 0 }],
  [/onion|κρεμμύδι/i, { energyKcal: 40, proteins: 1.1, fat: 0.1, carbohydrates: 9.3, fiber: 1.7 }],
  [/garlic|σκόρδο/i, { energyKcal: 149, proteins: 6.4, fat: 0.5, carbohydrates: 33, fiber: 2.1 }],
  [/potato|πατάτα/i, { energyKcal: 77, proteins: 2, fat: 0.1, carbohydrates: 17, fiber: 2.2 }],
  [/carrot|καρότο/i, { energyKcal: 41, proteins: 0.9, fat: 0.2, carbohydrates: 9.6, fiber: 2.8 }],
  [/cucumber|αγγούρι/i, { energyKcal: 15, proteins: 0.7, fat: 0.1, carbohydrates: 3.6, fiber: 0.5 }],
  [/zucchini|courgette|κολοκυθάκι/i, { energyKcal: 17, proteins: 1.2, fat: 0.3, carbohydrates: 3.1, fiber: 1 }],
  [/eggplant|aubergine|μελιτζάνα/i, { energyKcal: 25, proteins: 1, fat: 0.2, carbohydrates: 5.9, fiber: 3 }],
  [/tomato|τομάτα|ντάτα/i, { energyKcal: 18, proteins: 0.9, fat: 0.2, carbohydrates: 3.9, fiber: 1.2 }],
  [/spinach|σπανάκι/i, { energyKcal: 23, proteins: 2.9, fat: 0.4, carbohydrates: 3.6, fiber: 2.2 }],
  [/mushroom|μανιτάρι/i, { energyKcal: 22, proteins: 3.1, fat: 0.3, carbohydrates: 3.3, fiber: 1 }],
  [/broccoli|μπρόκολο/i, { energyKcal: 34, proteins: 2.8, fat: 0.4, carbohydrates: 6.6, fiber: 2.6 }],
  [/cauliflower|κουνουπίδι/i, { energyKcal: 25, proteins: 1.9, fat: 0.3, carbohydrates: 5, fiber: 2 }],
  [/cabbage|λάχανο/i, { energyKcal: 25, proteins: 1.3, fat: 0.1, carbohydrates: 5.8, fiber: 2.5 }],
  [/lettuce|μαρούλι/i, { energyKcal: 15, proteins: 1.4, fat: 0.2, carbohydrates: 2.9, fiber: 1.3 }],
  [/peas|αρακάς/i, { energyKcal: 81, proteins: 5.4, fat: 0.4, carbohydrates: 14, fiber: 5.7 }],
  [/green bean|φασολάκι/i, { energyKcal: 31, proteins: 1.8, fat: 0.2, carbohydrates: 7, fiber: 3.4 }],
  [/corn|καλαμπόκι/i, { energyKcal: 86, proteins: 3.3, fat: 1.4, carbohydrates: 19, fiber: 2.7 }],
  [/lemon|λεμόνι/i, { energyKcal: 29, proteins: 1.1, fat: 0.3, carbohydrates: 9.3, fiber: 2.8 }],
  [/lime/i, { energyKcal: 30, proteins: 0.7, fat: 0.2, carbohydrates: 11, fiber: 2.8 }],
  [/orange|πορτοκάλι/i, { energyKcal: 47, proteins: 0.9, fat: 0.1, carbohydrates: 12, fiber: 2.4 }],
  [/apple|μήλο/i, { energyKcal: 52, proteins: 0.3, fat: 0.2, carbohydrates: 14, fiber: 2.4 }],
  [/banana|μπανάνα/i, { energyKcal: 89, proteins: 1.1, fat: 0.3, carbohydrates: 23, fiber: 2.6 }],
  [/pear|αχλάδι/i, { energyKcal: 57, proteins: 0.4, fat: 0.1, carbohydrates: 15, fiber: 3.1 }],
  [/peach|ροδάκινο/i, { energyKcal: 39, proteins: 0.9, fat: 0.3, carbohydrates: 10, fiber: 1.5 }],
  [/strawberr|φράουλα/i, { energyKcal: 32, proteins: 0.7, fat: 0.3, carbohydrates: 7.7, fiber: 2 }],
  [/grape|σταφύλι/i, { energyKcal: 69, proteins: 0.7, fat: 0.2, carbohydrates: 18, fiber: 0.9 }],
  [/avocado|αβοκάντο/i, { energyKcal: 160, proteins: 2, fat: 15, carbohydrates: 9, fiber: 7 }],
  [/wine|κρασί/i, { energyKcal: 83, proteins: 0.1, fat: 0, carbohydrates: 2.6 }],
  [/stock|broth|ζωμός/i, { energyKcal: 5, proteins: 0.5, fat: 0.2, carbohydrates: 0.5, salt: 1 }],
  [/juice|χυμός/i, { energyKcal: 45, proteins: 0.7, fat: 0.2, carbohydrates: 10 }],
  [/vinegar|ξίδι/i, { energyKcal: 21, proteins: 0, fat: 0, carbohydrates: 0.9 }],
  [/cinnamon|κανέλα/i, { energyKcal: 247, proteins: 4, fat: 1.2, carbohydrates: 81, fiber: 53 }],
  [/pepper|πιπέρι/i, { energyKcal: 251, proteins: 10, fat: 3.3, carbohydrates: 64, fiber: 25 }],
  [/salt|αλάτι/i, { energyKcal: 0, proteins: 0, fat: 0, carbohydrates: 0, salt: 100 }],
];

function normalise(name: string): string {
  return String(name ?? "").toLowerCase().trim();
}

/** Look up typical per-100 g facts for an ingredient name. */
export function referenceNutrition(name: string): ReferenceFacts | null {
  const key = normalise(name);
  if (!key) return null;
  for (const [pattern, facts] of FOODS) {
    if (pattern.test(key)) return facts;
  }
  return null;
}

/** How many reference foods are available, handy for docs and tests. */
export const REFERENCE_FOOD_COUNT = FOODS.length;
