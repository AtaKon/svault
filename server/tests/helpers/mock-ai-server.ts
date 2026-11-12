import http from "node:http";
import type { Server } from "node:http";

/** One provider call captured by the mock, in the shape the tests assert on. */
export interface MockAiRequest {
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface MockAiServer {
  server: Server;
  baseUrl: string;
}

/**
 * OpenAI-compatible provider used by the API tests so AI code paths run
 * without a key. Every request is appended to `requests`; model names opt
 * into the failure shapes the recipe fallback tests need.
 */
export async function startMockAiServer(requests: MockAiRequest[]): Promise<MockAiServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = {};
      }
      requests.push({ headers: req.headers, body });
      const system = String(body?.messages?.[0]?.content ?? "");
      const userContent = body?.messages?.[1]?.content;
      // Reasoning models can spend the whole output budget thinking and
      // return no content at all. The first attempt asks for reasoning; the
      // recipe route must retry with it disabled.
      if (body?.model === "reasoning-only-model" && body?.reasoning?.enabled !== false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: null, reasoning: "Let me think about the handwriting…" }, finish_reason: "length" }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 8192,
              total_tokens: 9192,
              completion_tokens_details: { reasoning_tokens: 8192 },
              cost: 0.0018,
            },
          }),
        );
        return;
      }
      // A reasoning model that returns no answer and omits `usage` entirely:
      // the first attempt's spend cannot be priced, so the retry must still
      // name it rather than silently reporting only the retry's cost.
      if (body?.model === "reasoning-unpriced-model" && body?.reasoning?.enabled !== false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: null, reasoning: "Thinking about the handwriting…" }, finish_reason: "length" }],
          }),
        );
        return;
      }
      // An answer cut off at the token limit with no usable text.
      if (body?.model === "truncated-model") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 8192,
              total_tokens: 9192,
              completion_tokens_details: { reasoning_tokens: 8100 },
              cost: 0.0018,
            },
          }),
        );
        return;
      }
      // A plain OpenAI-compatible endpoint that does not know OpenRouter's
      // `reasoning` field.
      if (body?.model === "reject-reasoning-model" && body?.reasoning) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unsupported parameter: reasoning" } }));
        return;
      }
      // A provider that rejects `response_format` with a generic 400 body
      // that does not name the field. JSON mode must be retried without it.
      if (body?.model === "json-reject-model" && body?.response_format) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid request" } }));
        return;
      }
      // A provider that rejects an unknown field but has no idea about the
      // photo: the recipe route must not mistake "unsupported parameter" for
      // an image-input failure and re-bill a text-only retry.
      if (body?.model === "reasoning-unsupported-model") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unsupported parameter: reasoning" } }));
        return;
      }
      // A rate limit that mentions images: still not an image-input failure.
      if (body?.model === "image-rate-limited-model") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Rate limit reached for image requests" } }));
        return;
      }
      // An auth failure must not be retried without the reasoning/json field.
      if (body?.model === "unauthorised-model") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
        return;
      }
      // A parseable answer with only a title: not a recipe, so it must never
      // be returned as a successful read.
      if (body?.model === "truncated-title-model") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { content: JSON.stringify({ recipes: [{ title: "Just a title", notes: null }] }) },
                finish_reason: "length",
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, cost: 0.00125 },
          }),
        );
        return;
      }
      // A text model that answers with a title and notes but no ingredient
      // or step list (a link-import page can legitimately look like this).
      if (body?.model === "title-only-model") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { content: JSON.stringify({ title: "Notes only", notes: "Just a note about the dish." }) },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0002 },
          }),
        );
        return;
      }
      // A text-only model rejects image parts the way OpenAI-compatible
      // providers do, so the recipe route's retry can be exercised.
      if (body?.model === "text-only-model" && Array.isArray(userContent)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "This model does not support image input" } }));
        return;
      }
      // A later model in a chain rejects the photo after an earlier model
      // failed for an unrelated reason. The text-only retry must target only
      // this model, not re-bill the earlier failure.
      if (body?.model === "image-reject-model" && Array.isArray(userContent)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "This model does not accept image input" } }));
        return;
      }
      // A 400 about the request's content type says nothing about the photo:
      // retrying without the image would bill a second, pointless call.
      if (body?.model === "content-type-model") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unsupported content type: text/plain" } }));
        return;
      }
      // Rejects the photo, then fails the photo-less retry. The response must
      // still report every model the photo chain tried.
      if (body?.model === "image-reject-then-fail-model") {
        if (Array.isArray(userContent)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "This model does not accept image input" } }));
        } else {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Mock text-only retry exploded" } }));
        }
        return;
      }
      // Rejects the reasoning field, then fails without it: the retry note
      // must still reach the caller that shows the failure warning.
      if (body?.model === "reasoning-reject-then-fail-model") {
        if (body?.reasoning) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Unsupported parameter: reasoning" } }));
        } else {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Mock retry exploded" } }));
        }
        return;
      }
      // Models used by the recipe fallback-chain tests: a provider failure,
      // an empty answer, and a rate limit must each move to the next model.
      if (body?.model === "chain-500-model") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Mock upstream exploded" } }));
        return;
      }
      if (body?.model === "chain-429-model") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Mock rate limit" } }));
        return;
      }
      if (body?.model === "chain-empty-model") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900, cost: 0.0009 },
          }),
        );
        return;
      }
      // An empty answer whose usage omits the price: the failed attempt's
      // tokens are known but its spend is not, and the next model still bills.
      if (body?.model === "unpriced-empty-model") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 },
          }),
        );
        return;
      }
      // A usable answer that still hit the output limit: JSON parses, but the
      // provider says it was cut off. This is an objective truncation, so the
      // chain may try another model and keep this one as a last resort.
      if (body?.model === "truncated-json-model") {
        const partial = {
          recipes: [
            {
              title: "AI pancakes",
              description: "Cut off at the token limit",
              ingredients: [{ name: "Flour", quantity: 200, unit: "g", optional: false }],
              steps: [{ text: "Mix everything." }],
              notes: null,
            },
          ],
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(partial) }, finish_reason: "length" }],
            usage: { prompt_tokens: 1000, completion_tokens: 8192, total_tokens: 9192, cost: 0.00125 },
          }),
        );
        return;
      }
      let payload: any;
      if (system.includes("receipt")) {
        payload = {
          vendorName: "Mock Mart",
          purchasedAt: "2026-10-12",
          currency: "EUR",
          total: 5.5,
          lines: [
            { description: "Milk", quantity: 2, unit: "l", unitPrice: 1.2, lineTotal: 2.4 },
            { description: "Bread", quantity: 1, unit: null, unitPrice: 3.1, lineTotal: 3.1 },
          ],
          notes: "Mock receipt",
        };
      } else if (system.includes("archivist")) {
        const single = {
          title: body?.model === "chain-ok-model" ? "Fallback pancakes" : "AI pancakes",
          description: "Cleaned by the mock model",
          servings: 3,
          prepMinutes: 5,
          cookMinutes: 10,
          tags: ["breakfast"],
          ingredients: [{ name: "Flour", quantity: 200, unit: "g", optional: false }],
          steps: [{ text: "Mix everything." }, { text: "Fry until golden.", timerSeconds: 120 }],
          notes: "Mock cleanup",
        };
        payload =
          body?.model === "multi-model"
            ? {
                recipes: [
                  single,
                  {
                    ...single,
                    title: "AI biscuits",
                    ingredients: [{ name: "Coconut", quantity: 100, unit: "g", optional: false }],
                    steps: [{ text: "Shape and bake." }],
                    notes: "Second recipe on the same page",
                  },
                ],
              }
            : single;
      } else if (system.includes("home cook")) {
        payload = {
          summary: "Mock ideas from stock",
          ideas: [
            {
              title: "Mock soup",
              rationale: "You have everything",
              timeMinutes: 20,
              servings: 2,
              uses: [{ name: "Milk", quantity: 1, unit: "l" }],
              missing: [],
              steps: ["Warm it up."],
            },
          ],
        };
      } else {
        payload = {
          title: "Pancakes improved",
          description: "Completed",
          servings: 4,
          prepMinutes: 10,
          cookMinutes: 15,
          tags: ["breakfast"],
          ingredients: [{ name: "Flour", quantity: 250, unit: "g", optional: false }],
          steps: [{ text: "Whisk the batter." }, { text: "Cook for 3 minutes." }],
          notes: "completed by mock",
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
            ...(body?.model === "priced-model" ? {} : { cost: 0.00125 }),
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no ai address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}
