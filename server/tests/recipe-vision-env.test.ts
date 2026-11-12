import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The environment is read once when the config module loads, so it must be set
// before the server modules are imported (the same pattern as the API fixture).
process.env.OPENAI_RECIPE_VISION_MODELS = "a,b,c,d,e,f";

const { resolveAi } = await import("../ai.js");

describe("recipe vision models from the environment", () => {
  it("caps an oversized env list and reports how many models were dropped", () => {
    const cfg = resolveAi({ ai: { enabled: true, apiKey: "test-key" } });
    assert.deepEqual(
      cfg.recipeVisionCandidates.map((candidate) => candidate.model),
      ["a", "b", "c", "d"],
      "the environment list is capped at the chain limit",
    );
    assert.match(
      cfg.recipeVisionWarning ?? "",
      /Only the first 4 recipe vision models are used; 2 configured model\(s\) were dropped/,
      "the scan warning must say how many configured models were lost",
    );
  });
});
