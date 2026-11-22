import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* The server's own prices come from the environment, so pin them before the
   config module is imported. */
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "server-secret";
process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
process.env.OPENAI_INPUT_PRICE = "1";
process.env.OPENAI_OUTPUT_PRICE = "2";

const { resolveAi } = await import("../ai.js");

describe("house AI prices and the instance budget", () => {
  it("ignores house prices when the call uses the server's own key", async () => {
    // A house that zeroes its prices would otherwise record every call as
    // free against the instance-wide AI budget.
    const cfg = resolveAi({ ai: { inputPrice: 0, outputPrice: 0 } });
    assert.equal(cfg.apiKey, "server-secret");
    assert.equal(cfg.inputPrice, 1);
    assert.equal(cfg.outputPrice, 2);
  });

  it("honours house prices when the house brings its own key", async () => {
    const cfg = resolveAi({ ai: { apiKey: "house-secret", inputPrice: 0, outputPrice: 0 } });
    assert.equal(cfg.apiKey, "house-secret");
    assert.equal(cfg.inputPrice, 0);
    assert.equal(cfg.outputPrice, 0);
  });

  it("honours house prices for a house-configured endpoint", async () => {
    const cfg = resolveAi({ ai: { enabled: true, baseUrl: "http://ollama.lan:11434/v1", inputPrice: 0.5, outputPrice: 0.25 } });
    assert.equal(cfg.customEndpoint, true);
    assert.equal(cfg.inputPrice, 0.5);
    assert.equal(cfg.outputPrice, 0.25);
  });
});
