import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMockAiServer, type MockAiRequest } from "./mock-ai-server.js";

export interface ApiTestResponse {
  status: number;
  data: any;
  cookie: string | null;
}

export interface RecipeScanFixture {
  base: string;
  aiBase: string;
  houseId: string;
  cookie: string;
  aiRequests: MockAiRequest[];
  request: (
    pathname: string,
    options?: { method?: string; body?: unknown; auth?: string; headers?: Record<string, string> },
  ) => Promise<ApiTestResponse>;
  close: () => Promise<void>;
}

/**
 * Isolated app instance for the recipe-scan API tests: a temporary data
 * directory, the real Express app on an ephemeral port, the mock provider and
 * one registered owner whose house already points at that provider.
 *
 * Environment variables are set before the server modules are imported, so the
 * config picks up the temporary directory exactly as it does in api.test.ts.
 */
export async function createRecipeScanFixture(): Promise<RecipeScanFixture> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "svault-recipe-scan-"));
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  process.env.OPENAI_API_KEY = "";
  process.env.SV_REGISTRATION = "open";
  process.env.SVAI_API_KEY = "";

  const { app } = await import("../../index.js");
  const { closeDb } = await import("../../db.js");

  const aiRequests: MockAiRequest[] = [];
  const ai = await startMockAiServer(aiRequests);

  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${address.port}`;

  let cookie = "";

  async function request(
    pathname: string,
    options: { method?: string; body?: unknown; auth?: string; headers?: Record<string, string> } = {},
  ): Promise<ApiTestResponse> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const useCookie = options.auth === undefined ? cookie : options.auth;
    if (useCookie) headers.cookie = useCookie;
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        body = options.body;
      } else {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.body);
      }
    }
    const res = await fetch(base + pathname, { method: options.method ?? (body ? "POST" : "GET"), headers, body });
    const setCookie = res.headers.get("set-cookie");
    const nextCookie = setCookie ? setCookie.split(";")[0] : null;
    const text = await res.text();
    return {
      status: res.status,
      data: text ? JSON.parse(text) : null,
      cookie: nextCookie,
    };
  }

  const registration = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Scan Owner", email: "scan@example.com", password: "test password" },
  });
  assert.equal(registration.status, 201);
  cookie = registration.cookie!;
  const houseId = registration.data.houses[0].id;

  const settings = await request(`/api/houses/${houseId}`, {
    method: "PATCH",
    body: {
      settings: {
        ai: {
          enabled: true,
          baseUrl: ai.baseUrl,
          apiKey: "test-key",
          model: "mock-model",
          visionModel: null,
          recipeVisionModels: [],
          recipeReasoning: "auto",
        },
      },
    },
  });
  assert.equal(settings.status, 200);

  // The recipe-scan tests read the AI log page, which is developer mode only.
  const developer = await request("/api/auth/me", { method: "PATCH", body: { developerMode: true } });
  assert.equal(developer.status, 200);

  return {
    base,
    aiBase: ai.baseUrl,
    houseId,
    cookie,
    aiRequests,
    request,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => ai.server.close(() => resolve()));
      await closeDb();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
