import assert from "node:assert/strict";
import test from "node:test";
import { generateLayoutPayload, generateUserScriptDraft } from "../src/aiClient.js";
import * as storage from "../src/storage.js";

test("presets fill verified API URLs and route both operations through their own credentials", async (t) => {
  const providers = {
    openrouter: "https://openrouter.ai/api/v1",
    aihubmix: "https://aihubmix.com/v1",
    groq: "https://api.groq.com/openai/v1",
    together: "https://api.together.ai/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
    ollama: "http://localhost:11434/v1",
    lmstudio: "http://localhost:1234/v1"
  };
  const layout = { css: "main{color:red}", javascript: '{"version":1,"steps":[]}' };
  const draft = { name: "Test", description: "Test", matches: ["https://example.com/*"], excludeMatches: [], grants: [], connects: [], requires: [], resources: [], updateUrl: "", downloadUrl: "", checkForUpdates: false, runAt: "document_idle", world: "USER_SCRIPT", code: "void 0;" };
  let expectedUrl;
  let payload;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, expectedUrl);
    assert.equal(options.headers.Authorization, "Bearer selected-provider-key");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
  for (const [provider, base] of Object.entries(providers)) {
    assert.equal(storage.DEFAULT_BASE_URLS[provider], base);
    expectedUrl = base + "/chat/completions";
    const settings = { routeMode: "byok", provider, model: "selected-model", apiKey: "selected-provider-key" };
    payload = layout;
    assert.deepEqual(await generateLayoutPayload(settings, { prompt: "Make it red", domMap: {} }), layout);
    payload = draft;
    assert.deepEqual(await generateUserScriptDraft(settings, { prompt: "Create a script" }), draft);
  }
});

test("OpenRouter models are fetched with the typed key and normalized for a text model picker", async (t) => {
  const { fetchProviderModels } = await import("../src/providerModels.js");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/models");
    assert.equal(options.headers.Authorization, "Bearer typed-key");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ data: [
      { id: "vendor/z-model:free", name: "Z Model", architecture: { output_modalities: ["text"] } },
      { id: "vendor/a-model", name: "A Model", architecture: { output_modalities: ["text"] } },
      { id: "vendor/image", architecture: { output_modalities: ["image"] } },
      { id: "vendor/z-model:free", name: "Duplicate" },
      { id: "" }
    ] }));
  });
  assert.deepEqual(await fetchProviderModels({ provider: "openrouter", apiKey: "typed-key" }), [
    { id: "vendor/a-model", name: "A Model" }, { id: "vendor/z-model:free", name: "Z Model" }
  ]);
});

test("model lists without capabilities exclude known audio, image, embedding and realtime families", async (t) => {
  const { fetchProviderModels } = await import("../src/providerModels.js");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [
    { id: "gpt-audio-1.5" }, { id: "chatgpt-image-latest" }, { id: "text-embedding-3-small" },
    { id: "gpt-realtime" }, { id: "dall-e-3" }, { id: "sora-2" }, { id: "gpt-4.1-mini" }
  ] })));
  assert.deepEqual(await fetchProviderModels({ provider: "openai", apiKey: "key" }), [{ id: "gpt-4.1-mini", name: "gpt-4.1-mini" }]);
});

test("AIHubMix uses its annotated catalog while overridden URLs use their own models endpoint", async (t) => {
  const { fetchProviderModels } = await import("../src/providerModels.js");
  const urls = [];
  t.mock.method(globalThis, "fetch", async url => {
    urls.push(url);
    return new Response(JSON.stringify({ data: [
      { model_id: "chat-model", model_name: "Chat Model", types: "llm", endpoints: "chat_completions,responses", output_modalities: "text" },
      { model_id: "image-model", types: "image_generation", output_modalities: "image" },
      { model_id: "native-only", types: "llm", endpoints: "gemini_api" },
      { model_id: "unannotated", types: "llm", endpoints: "", output_modalities: "" }
    ] }));
  });
  assert.deepEqual(await fetchProviderModels({ provider: "aihubmix", apiKey: "key" }), [{ id: "chat-model", name: "Chat Model" }, { id: "unannotated", name: "unannotated" }]);
  await fetchProviderModels({ provider: "aihubmix", baseUrl: "https://proxy.example/custom/v2", apiKey: "key" });
  assert.deepEqual(urls, ["https://aihubmix.com/api/v1/models", "https://proxy.example/custom/v2/models"]);
});

test("Together array catalogs and keyless local models are supported", async (t) => {
  const { fetchProviderModels } = await import("../src/providerModels.js");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([
    { id: "vendor/chat", type: "chat" }, { id: "vendor/embed", type: "embedding" }
  ])));
  assert.deepEqual(await fetchProviderModels({ provider: "together", apiKey: "key" }), [{ id: "vendor/chat", name: "vendor/chat" }]);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://localhost:11434/v1/models");
    assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify({ data: [{ id: "qwen:latest" }] }));
  });
  assert.deepEqual(await fetchProviderModels({ provider: "ollama" }), [{ id: "qwen:latest", name: "qwen:latest" }]);
});

test("Anthropic model discovery uses native headers and follows same-origin cursors", async (t) => {
  const { fetchProviderModels } = await import("../src/providerModels.js");
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    urls.push(url);
    assert.equal(options.headers["x-api-key"], "anthropic-key");
    assert.equal(options.headers["anthropic-dangerous-direct-browser-access"], "true");
    const page = urls.length;
    return new Response(JSON.stringify({ data: [{ id: "claude-" + page, display_name: "Claude " + page }], has_more: page === 1, last_id: "claude-1" }));
  });
  const models = await fetchProviderModels({ provider: "anthropic", apiKey: "anthropic-key" });
  assert.equal(models.length, 2);
  assert.equal(new URL(urls[1]).searchParams.get("after_id"), "claude-1");
  assert.equal(new URL(urls[1]).origin, "https://api.anthropic.com");
});

test("model discovery reports HTTP and malformed catalogs without echoing provider secrets", async (t) => {
  const { fetchProviderModels } = await import("../src/providerModels.js");
  t.mock.method(globalThis, "fetch", async () => new Response("secret-key-do-not-echo", { status: 401 }));
  await assert.rejects(fetchProviderModels({ provider: "openrouter", apiKey: "secret-key-do-not-echo" }), error => /401/.test(error.message) && !error.message.includes("secret-key-do-not-echo"));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ unexpected: [] })));
  await assert.rejects(fetchProviderModels({ provider: "groq", apiKey: "key" }), /model list|catalog/i);
});
