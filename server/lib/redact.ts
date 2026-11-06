/**
 * Mask personal data in text that is stored for diagnostics (AI call previews).
 *
 * Receipt OCR often contains card numbers, loyalty IDs, IBANs, emails and
 * phone numbers. These are replaced before the text is written to the AI log.
 * Product barcodes (EAN-8/UPC-A/EAN-13/GTIN-14 with a valid check digit),
 * prices, quantities and short numbers are left alone because they are what
 * makes the log useful.
 */

const tail = (digits: string) => digits.slice(-4);

/** GS1 check digit test for 8, 12, 13 and 14 digit codes. */
export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let index = digits.length - 1, weight = 3; index >= 0; index--, weight = weight === 3 ? 1 : 3) {
    sum += digits[index] * weight;
  }
  return (10 - (sum % 10)) % 10 === check;
}

export function maskSensitiveText(text: string): string;
export function maskSensitiveText(text: string | null | undefined): string | null | undefined;
export function maskSensitiveText(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  let out = text;

  // Email addresses.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]");

  // IBANs: country code, check digits, then 11-30 alphanumerics, optionally grouped.
  out = out.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, (match) => {
    const compact = match.replace(/\s+/g, "");
    if (compact.length < 15 || compact.length > 34 || !/\d{6,}/.test(compact.slice(4))) return match;
    return `[iban ****${tail(compact)}]`;
  });

  // Card numbers printed in groups (4-4-4-4, 4-6-5, ...), 13 to 19 digits in total.
  out = out.replace(/(?<![\d.,])\d{4}(?:[ -]\d{3,6}){2,4}(?![\d.,]?\d)/g, (match) => {
    const digits = match.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 ? `[card ****${tail(digits)}]` : match;
  });

  // Phone numbers: international form, or anything after a phone label.
  out = out.replace(/(?<![\w])\+\d[\d ().-]{7,}\d/g, "[phone]");
  out = out.replace(
    /((?:tel|phone|mobile|fax|τηλ|κιν|τηλέφωνο|τηλεφωνο)\.?\s*:?\s*)(\+?\d[\d ()./-]{6,}\d)/giu,
    (_match, label: string) => `${label}[phone]`,
  );

  // Long digit runs: card numbers, loyalty and customer IDs. Valid GTINs stay.
  out = out.replace(/(?<![\d.,])\d{10,}(?![\d.,]?\d)/g, (digits) => {
    if (isValidGtin(digits)) return digits;
    if (digits.length >= 13 && digits.length <= 19) return `[card ****${tail(digits)}]`;
    return `[id ****${tail(digits)}]`;
  });

  return out;
}
