/**
 * Ultra-short dynamic patterns such as "{count}d" would match unrelated English
 * copy (for example any server message ending in "d"). They are only used
 * through literal t("{count}d") calls, where DYNAMIC_EL is not needed.
 */
export const DYNAMIC_KEY_MIN_LITERAL_LENGTH = 2;

export function isDynamicTranslationKey(key: string): boolean {
  const placeholders = key.match(/\{[A-Za-z_$][\w$]*\}/g) ?? [];
  if (!placeholders.length) return false;
  // Trim matters: "{a} {b}" leaves a single space, which trims to length 0 and
  // is therefore rejected, while "{field}: {message}" keeps ":" (length 1).
  const literalLength = key.replace(/\{[A-Za-z_$][\w$]*\}/g, "").trim().length;
  return literalLength >= DYNAMIC_KEY_MIN_LITERAL_LENGTH || (placeholders.length >= 2 && literalLength >= 1);
}

export function buildDynamicMatcher(key: string): { regex: RegExp; names: string[] } | null {
  if (!isDynamicTranslationKey(key)) return null;
  const names: string[] = [];
  let pattern = "";
  for (const part of key.split(/(\{[A-Za-z_$][\w$]*\})/g)) {
    const placeholder = /^\{([A-Za-z_$][\w$]*)\}$/.exec(part);
    if (placeholder) {
      names.push(placeholder[1]);
      pattern += "([\\s\\S]*?)";
    } else {
      pattern += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return { regex: new RegExp("^" + pattern + "$"), names };
}
