import type { ReceiptTemplateRules } from "./types.js";

/** Built-in Lidl Greece rules, also offered as a starting point in the builder. */
export const LIDL_TEMPLATE_RULES: ReceiptTemplateRules = {
  keywords: ["LIDL", "ΛΙΝΤΑ ΕΛΛΑΣ", "ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ", "lidlplus", "ΦΤΙΑΞ"],
  threshold: 0.7,
  sections: {
    start: ["ΦΟΡΟΛΟΓΙΚΗ\\s+ΑΠΟΔΕΙΞΗ"],
    end: ["^ΣΥΝΟΛΟ(?!\\s+ΕΚΠΤΩΣΕΩΝ)(?=\\s|$)"],
  },
  product: {
    pattern:
      "^(?<name>.+?)\\s+(?<total>-?\\d{1,4}[.,]\\d{2})\\s*(?:€|EUR)?(?:\\s+(?<rate>\\d{1,2}(?:[.,]\\d+)?)\\s*%)?(?:\\s*[A-ZΑ-Ω])?\\s*$",
    ignore: [
      "^ΤΣ\\.?Π\\.?ΧΡ",
      "^ΣΑΚΟΥ",
      "^ΠΕΡΙΒΑΝ\\.?ΤΕΛΟΣ",
      "^ΧΑΡΤΟΣΑΚΟΥΛ",
      "^ΕΝΟΙΚΙΑΣΗ",
      "^ΕΓΓΥΗΣΗ",
      "^ΚΑΡΤΑ",
      "^ΜΕΤΡΗΤΑ",
      "^ΡΕΣΤΑ",
      "^ΠΛΗΡΩΜ",
      "^ΦΠΑ",
      "^ΣΥΝΟΛΟ",
      "^ΠΩΛΗΘΕΝΤΑ",
      "^EFT",
    ],
  },
  quantity: ["^(?<qty>\\d+(?:[.,]\\d+)?)\\s*[x×]\\s*(?<unitPrice>\\d+[.,]\\d{2})\\s*$"],
  weight: [
    "^(?<qty>\\d+(?:[.,]\\d+)?)\\s*(?<unit>kg|g|l|ml)\\s*[x×]\\s*(?<unitPrice>\\d+[.,]\\d{2})(?:\\s*(?:EUR|€)\\s*\\/\\s*(?:kg|g|l|ml))?\\s*$",
  ],
  discount: { patterns: ["κπτωση", "discount"] },
  savings: {
    patterns: [
      "ΣΥΝΟΛΟ\\s+ΕΚΠΤΩΣΕΩΝ",
      "ΣΥΝΟΛΙΚΗ\\s+ΕΚΠΤΩΣΗ",
      "ΕΞΟΙΚΟΝΟΜΗΣ(?:Η|ΑΤΕ|ΗΚΕ)",
      "YOU\\s+SAVED",
      "TOTAL\\s+DISCOUNT",
    ],
  },
  tax: {
    start: ["^ΦΠΑ"],
    rowPattern: "^[A-ZΑ-Ω]\\s+(?<rate>\\d{1,2}(?:[.,]\\d+)?)\\s*%",
    summaryPattern: "^ΣΥΝΟΛΟ(?=\\s|$)",
  },
  total: { pattern: "^ΣΥΝΟΛΟ(?!\\s+ΕΚΠΤΩΣΕΩΝ)(?=\\s|$)" },
};

/**
 * Built-in Sklavenitis Greece rules, also offered as a starting point in the builder.
 *
 * Sklavenitis prints an optional barcode line, then either a product line with its total and
 * VAT rate, or a product name followed by a quantity/weight line with the unit price and total.
 * Discounts are printed as "ΕΚΠΤΩΣΗ <product> -amount VAT%".
 */
export const SKLAVENITIS_TEMPLATE_RULES: ReceiptTemplateRules = {
  keywords: ["ΣΚΛΑΒΕΝΙΤΗΣ", "ΕΛΛΗΝΙΚΕΣ ΥΠΕΡΑΓΟΡΕΣ", "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ"],
  threshold: 0.7,
  sections: {
    start: ["ΑΠΟΔΕΙΞΗ\\s+ΛΙΑΝΙΚΗΣ\\s+ΠΩΛΗΣΗΣ"],
    end: ["^ΣΥΝΟΛΟ(?!\\s+ΕΚΠΤΩΣΕΩΝ)(?=\\s|$)"],
  },
  product: {
    pattern:
      "^(?!ΕΚΠΤΩΣΗ)(?<name>[\\p{L}][\\p{L}\\p{N} .,%/&+*()'\\-–]*?)(?:\\s+(?<total>-?\\d{1,4}[.,]\\d{2})\\s*(?:€|EUR)?(?:\\s+(?<rate>\\d{1,2}(?:[.,]\\d+)?)\\s*%)?)?\\s*$",
    ignore: [
      "^ΕΛΛΗΝΙΚΕΣ(?:\\s|$)",
      "^ΣΚΛΑΒΕΝΙΤΗΣ(?:\\s|$)",
      "^SUPER(?:\\s|$)",
      "^Υ/Α(?:\\s|$)",
      "^ΑΦΜ(?:\\s|$)",
      "^ΤΑΜΕΙΟ(?:\\s|$)",
      "^ΑΠΟΔΕΙΞΗ(?:\\s|$)",
      "^ΗΜΕΡ(?:\\s|$)",
      "^ΠΩΛΗΘΕΝΤΑ(?:\\s|$)",
      "^EFT(?:\\s|$)",
      "^ΜΕΤΡΗΤΑ(?:\\s|$)",
      "^ΚΑΡΤΑ(?:\\s|$)",
    ],
  },
  quantity: [
    "^(?<qty>\\d+(?:[.,]\\d+)?)\\s*[x×]\\s*(?<unitPrice>\\d+[.,]\\d{2})(?:\\s+(?<total>\\d+[.,]\\d{2}))?(?:\\s+(?<rate>\\d{1,2}(?:[.,]\\d+)?)\\s*%)?\\s*$",
  ],
  weight: [
    "^(?<qty>\\d+(?:[.,]\\d+)?)\\s*(?<unit>kg|g|l|ml)?\\s*[x×]\\s*(?<unitPrice>\\d+[.,]\\d{2})(?:\\s+(?<total>\\d+[.,]\\d{2}))?(?:\\s+(?<rate>\\d{1,2}(?:[.,]\\d+)?)\\s*%)?\\s*$",
    "^(?<qty>\\d+(?:[.,]\\d+)?)\\s+(?<unitPrice>\\d+[.,]\\d{2})\\s+(?<total>\\d+[.,]\\d{2})(?:\\s+(?<rate>\\d{1,2}(?:[.,]\\d+)?)\\s*%)?\\s*$",
    "^(?<qty>\\d+[.,]\\d{3})\\s+(?<unitPrice>\\d+[.,]\\d{2})\\s*$",
  ],
  discount: {
    patterns: ["ΕΚΠΤΩΣΗ.*?(?<amount>-\\d+[.,]\\d{2})(?:\\s+\\d{1,2}(?:[.,]\\d+)?\\s*%)?\\s*$"],
  },
  savings: {
    patterns: [
      "ΣΥΝΟΛΟ\\s+ΕΚΠΤΩΣΕΩΝ",
      "ΣΥΝΟΛΙΚΗ\\s+ΕΚΠΤΩΣΗ",
      "ΕΞΟΙΚΟΝΟΜΗΣ(?:Η|ΑΤΕ|ΗΚΕ)",
      "YOU\\s+SAVED",
      "TOTAL\\s+DISCOUNT",
    ],
  },
  total: { pattern: "^ΣΥΝΟΛΟ(?!\\s+ΕΚΠΤΩΣΕΩΝ)(?=\\s|$)" },
};
