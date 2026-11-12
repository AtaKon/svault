import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canRetryRecipeReasoningOff,
  normaliseRecipeReasoning,
  reasoningRequestFor,
  supportsReasoningControl,
} from "../../shared/ai-reasoning.js";

describe("recipe reasoning configuration", () => {
  it("treats missing or unknown values as auto", () => {
    assert.equal(normaliseRecipeReasoning(undefined), "auto");
    assert.equal(normaliseRecipeReasoning(null), "auto");
    assert.equal(normaliseRecipeReasoning(""), "auto");
    assert.equal(normaliseRecipeReasoning("maximum"), "auto");
    assert.equal(normaliseRecipeReasoning(3), "auto");
  });

  it("keeps every known mode", () => {
    for (const mode of ["auto", "off", "low", "medium", "high"]) {
      assert.equal(normaliseRecipeReasoning(mode), mode);
    }
  });

  it("sends nothing for auto and a precise object otherwise", () => {
    assert.equal(reasoningRequestFor("auto"), null);
    assert.equal(reasoningRequestFor(undefined), null);
    assert.deepEqual(reasoningRequestFor("off"), { enabled: false });
    assert.deepEqual(reasoningRequestFor("low"), { effort: "low" });
    assert.deepEqual(reasoningRequestFor("medium"), { effort: "medium" });
    assert.deepEqual(reasoningRequestFor("high"), { effort: "high" });
  });

  it("only recognises OpenRouter hosts for automatic recovery", () => {
    assert.equal(supportsReasoningControl("https://openrouter.ai/api/v1"), true);
    assert.equal(supportsReasoningControl("https://api.openrouter.ai/v1"), true);
    assert.equal(supportsReasoningControl("http://OPENROUTER.AI/api/v1/"), true);
    assert.equal(supportsReasoningControl("https://api.openai.com/v1"), false);
    assert.equal(supportsReasoningControl("http://127.0.0.1:11434/v1"), false);
    assert.equal(supportsReasoningControl("https://openrouter.ai.example.com/v1"), false);
    assert.equal(supportsReasoningControl("not a url"), false);
  });

  it("retries with reasoning off only where the field is honoured", () => {
    assert.equal(canRetryRecipeReasoningOff(true, { effort: "high" }), true);
    assert.equal(canRetryRecipeReasoningOff(true, null), true);
    // Another endpoint would bill the same photo again for an ignored setting.
    assert.equal(canRetryRecipeReasoningOff(false, { effort: "high" }), false);
    assert.equal(canRetryRecipeReasoningOff(false, null), false);
    // Reasoning was already off, so there is nothing left to switch off.
    assert.equal(canRetryRecipeReasoningOff(true, { enabled: false }), false);
  });
});
