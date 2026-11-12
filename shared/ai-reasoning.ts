/**
 * Recipe-scan reasoning control.
 *
 * Reasoning ("thinking") models can spend their whole output budget before
 * writing an answer, and the right setting differs per model: some read
 * handwriting more accurately with thinking on, while hybrid models such as
 * Qwen3 need it turned off to answer at all. The setting is therefore a
 * per-house choice for recipe scans only; nothing else is affected.
 *
 * OpenRouter's unified API accepts `reasoning` on the request. Other
 * OpenAI-compatible endpoints may ignore it or reject it, so the server drops
 * the field and retries when an endpoint rejects it.
 */
export const RECIPE_REASONING_MODES = ["auto", "off", "low", "medium", "high"] as const;

export type RecipeReasoningMode = (typeof RECIPE_REASONING_MODES)[number];

/** The subset of OpenRouter's `reasoning` request object that SVault sends. */
export interface ReasoningRequest {
  enabled?: boolean;
  effort?: "low" | "medium" | "high";
}

/** Any stored or user-supplied value becomes a known mode; unknown values mean auto. */
export function normaliseRecipeReasoning(value: unknown): RecipeReasoningMode {
  return typeof value === "string" && (RECIPE_REASONING_MODES as readonly string[]).includes(value)
    ? (value as RecipeReasoningMode)
    : "auto";
}

/**
 * Request body fragment for a mode. `auto` returns null so the model's own
 * default is used and no provider-specific field is sent.
 */
export function reasoningRequestFor(mode: unknown): ReasoningRequest | null {
  switch (normaliseRecipeReasoning(mode)) {
    case "off":
      return { enabled: false };
    case "low":
      return { effort: "low" };
    case "medium":
      return { effort: "medium" };
    case "high":
      return { effort: "high" };
    default:
      return null;
  }
}

/**
 * True only for OpenRouter's own hosts. Used to decide whether a failed
 * reasoning-only answer can be retried with reasoning disabled when the user
 * left the setting on `auto`; an explicit mode is always honoured and falls
 * back on a 4xx rejection instead.
 */
export function supportsReasoningControl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * Whether a failed recipe attempt is worth retrying with reasoning disabled.
 *
 * Only OpenRouter is known to honour the field, so a retry elsewhere would send
 * the same photo twice and bill the user for the same, ignored setting.
 *
 * An explicit mode is the user's choice and is never overridden: retrying a
 * deliberate `low`/`medium`/`high` with reasoning off would silently ignore it,
 * and a request that already ran with `off` has nothing left to switch off. The
 * automatic mode sends no reason request (`null`), so switching it off is a
 * recovery rather than an override.
 */
export function canRetryRecipeReasoningOff(
  supportsReasoning: boolean,
  current: ReasoningRequest | null | undefined,
): boolean {
  if (!supportsReasoning) return false;
  return current == null;
}
