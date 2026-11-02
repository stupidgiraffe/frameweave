import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { generateLayoutPayload, generateUserScriptDraft, consumeSse } from "../src/aiClient.js";
import * as storage from "../src/storage.js";

const layout = { css: "main{max-width:72rem}", javascript: '{"version":1,"steps":[]}' };
const draft = {
  name: "Reader", description: "Reading width", matches: ["https://example.com/*"],
  excludeMatches: [], grants: ["GM_addStyle"], connects: [], requires: [], resources: [],
  updateUrl: "", downloadUrl: "", checkForUpdates: false, runAt: "document_idle",
  world: "USER_SCRIPT", code: "GM_addStyle('main{max-width:72rem}');"
};
const input = { prompt: "Make the reading column narrower", domMap: { version: 1, nodes: [] } };

function installStorage(t) {
  const previous = globalThis.chrome;
  const values = {};
  globalThis.chrome = { storage: { local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]])); },
    async set(patch) { Object.assign(values, structuredClone(patch)); }
  } } };
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  return values;
}

test("custom URL/model/key survive storage and switching providers without exposing secrets", async (t) => {
  installStorage(t);
  await storage.initializeStorage();
  await storage.setProviderApiKey("openai", "preset-secret");
  await storage.saveSettingsPatch({ provider: "custom", baseUrl: "https://gateway.example/v1/chat/completions/", model: "vendor/model:free" });
  await storage.setProviderApiKey("custom", "custom-secret");
  let runtime = await storage.getRuntimeSettings();
  assert.equal(runtime.baseUrl, "https://gateway.example/v1");
  assert.equal(runtime.model, "vendor/model:free");
  assert.equal(runtime.apiKey, "custom-secret");
  const publicSettings = await storage.getPublicSettings();
  assert.equal(publicSettings.baseUrls.custom, runtime.baseUrl);
  assert.equal(publicSettings.providerKeyPresent.custom, true);
  assert.equal(JSON.stringify(publicSettings).includes("custom-secret"), false);
  await storage.saveSettingsPatch({ provider: "openai" });
  runtime = await storage.getRuntimeSettings();
  assert.equal(runtime.apiKey, "preset-secret");
  assert.equal(runtime.baseUrl, "https://api.openai.com/v1");
  await storage.saveSettingsPatch({ provider: "custom" });
  assert.equal((await storage.getRuntimeSettings()).model, "vendor/model:free");
});

test("existing settings migrate with preset endpoints and keys intact", async (t) => {
  const values = installStorage(t);
  values["frameweave.settings.v1"] = { provider: "deepseek", models: { deepseek: "deepseek-chat" } };
  values["frameweave.secrets.v1"] = { providerKeys: { deepseek: "existing-secret" } };
  await storage.initializeStorage();
  const runtime = await storage.getRuntimeSettings();
  assert.equal(runtime.baseUrl, "https://api.deepseek.com");
  assert.equal(runtime.apiKey, "existing-secret");
  assert.equal(runtime.model, "deepseek-chat");
});

test("provider URLs preserve gateway paths and accept local servers", () => {
  assert.equal(storage.normalizeProviderBaseUrl("https://gateway.example/api/v1/", "custom"), "https://gateway.example/api/v1");
  assert.equal(storage.normalizeProviderBaseUrl("http://localhost:11434/v1", "custom"), "http://localhost:11434/v1");
  assert.equal(storage.normalizeProviderBaseUrl("http://127.0.0.1:1234/v1/chat/completions", "custom"), "http://127.0.0.1:1234/v1");
  assert.equal(storage.normalizeProviderBaseUrl("http://[::1]:1234/v1", "custom"), "http://[::1]:1234/v1");
});

test("provider URLs reject credentials, queries, fragments and insecure remote addresses", () => {
  for (const url of ["not a url", "javascript:alert(1)", "http://remote.example/v1", "https://user:secret@gateway.example/v1", "https://gateway.example/v1?key=secret", "https://gateway.example/v1#anchor"]) {
    assert.throws(() => storage.normalizeProviderBaseUrl(url, "custom"), error => !(error instanceof TypeError));
  }
});

test("custom provider sends both generation types to the selected Chat Completions URL", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    const payload = requests.length === 1 ? layout : draft;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { headers: { "content-type": "application/json" } });
  });
  const settings = { routeMode: "byok", provider: "custom", baseUrl: "https://gateway.example/api/v1", model: "vendor/model:free", apiKey: "custom-secret" };
  assert.deepEqual(await generateLayoutPayload(settings, input), layout);
  assert.deepEqual(await generateUserScriptDraft(settings, input), draft);
  for (const request of requests) {
    assert.equal(request.url, "https://gateway.example/api/v1/chat/completions");
    assert.equal(request.headers.Authorization, "Bearer custom-secret");
    assert.equal(request.body.model, "vendor/model:free");
    assert.equal(request.body.messages[0].role, "system");
    assert.equal(request.body.response_format.type, "json_object");
    assert.equal(request.body.stream_options, undefined);
    assert.equal(request.redirect, "error");
  }
});

test("local custom provider works without a saved API key", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://localhost:11434/v1/chat/completions");
    assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(layout) } }] }));
  });
  assert.deepEqual(await generateLayoutPayload({ routeMode: "byok", provider: "custom", baseUrl: "http://localhost:11434/v1", model: "llama3.2", apiKey: "" }, input), layout);
});

test("custom layout accepts streamed Chat Completions", async (t) => {
  const json = JSON.stringify(layout);
  const events = [json.slice(0, 20), json.slice(20)].map(content => "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n").join("") + "data: [DONE]\n\n";
  t.mock.method(globalThis, "fetch", async () => new Response(events, { headers: { "content-type": "text/event-stream" } }));
  assert.deepEqual(await generateLayoutPayload({ routeMode: "byok", provider: "custom", baseUrl: "https://gateway.example/v1", model: "test", apiKey: "key" }, input), layout);
});

test("missing custom URL fails before sending any request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  await assert.rejects(generateLayoutPayload({ routeMode: "byok", provider: "custom", model: "test", apiKey: "key" }, input), error => error.code === "invalid_provider_endpoint");
  assert.equal(fetch.mock.callCount(), 0);
});

test("preset endpoints can be overridden for layout and userscript generation", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  const settings = { routeMode: "byok", provider: "openai", baseUrl: "https://proxy.example/openai", model: "test", apiKey: "preset-secret" };
  // Use separate responses so the test asserts the real request paths for both operations.
  fetch.mock.mockImplementation(async url => { assert.equal(url, "https://proxy.example/openai/responses"); return new Response(JSON.stringify({ output_text: JSON.stringify(layout) })); });
  assert.deepEqual(await generateLayoutPayload(settings, input), layout);
  fetch.mock.mockImplementation(async url => { assert.equal(url, "https://proxy.example/openai/responses"); return new Response(JSON.stringify({ output_text: JSON.stringify(draft) })); });
  assert.deepEqual(await generateUserScriptDraft(settings, input), draft);
});

test("SSE preserves event boundaries when CRLF is split across network chunks", async () => {
  const chunks = ['data: {"part":1}\r', '\n\r', '\ndata: {"part":2}\r', '\n\r\n'];
  const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
  const events = [];
  await consumeSse(new Response(stream), event => events.push(event));
  assert.deepEqual(events, [{ part: 1 }, { part: 2 }]);
});

test("Anthropic opts into direct browser access for both generation operations", async (t) => {
  let payload = layout;
  let operation = "return_layout_payload";
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, headers: options.headers });
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: operation, input: payload }] }));
  });
  const settings = { routeMode: "byok", provider: "anthropic", model: "test", apiKey: "test-key" };
  assert.deepEqual(await generateLayoutPayload(settings, input), layout);
  payload = draft;
  operation = "return_userscript_draft";
  assert.deepEqual(await generateUserScriptDraft(settings, input), draft);
  for (const request of requests) {
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.headers["anthropic-dangerous-direct-browser-access"], "true");
  }
});

test("popup lets users save a custom provider and restores its URL when switching back", async (t) => {
  installStorage(t);
  await storage.initializeStorage();
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const html = fs.readFileSync(new URL("../popup.html", import.meta.url), "utf8");
  class Element extends EventTarget {
    value = "";
    textContent = "";
    checked = false;
    disabled = false;
    classList = { toggle() {} };
  }
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => ["#" + id, new Element()]));
  const routes = ["byok", "backend"].map(value => Object.assign(new Element(), { value }));
  globalThis.document = {
    querySelector(selector) { assert.ok(elements[selector], "Popup selector missing from HTML: " + selector); return elements[selector]; },
    querySelectorAll() { return routes; }
  };
  globalThis.window = { confirm: () => true };
  const listener = { addListener() {} };
  globalThis.chrome.runtime = { connect: () => ({ postMessage() {}, onMessage: listener, onDisconnect: listener }) };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  });
  await import("../src/popup.js");
  for (let i = 0; i < 20 && !elements["#status"].textContent.startsWith("Ready."); i++) await new Promise(setImmediate);
  assert.match(elements["#status"].textContent, /^Ready\./);
  elements["#provider"].value = "custom";
  elements["#provider"].dispatchEvent(new Event("change"));
  elements["#provider-base-url"].value = "https://gateway.example/v1/chat/completions";
  elements["#model"].value = "vendor/model:free";
  elements["#api-key"].value = "custom-test-key";
  elements["#settings-form"].dispatchEvent(new Event("submit", { cancelable: true }));
  for (let i = 0; i < 20 && elements["#status"].textContent !== "Settings saved locally."; i++) await new Promise(setImmediate);
  assert.equal(elements["#status"].textContent, "Settings saved locally.");
  const settings = await storage.getRuntimeSettings();
  assert.equal(settings.provider, "custom");
  assert.equal(settings.baseUrl, "https://gateway.example/v1");
  assert.equal(settings.apiKey, "custom-test-key");
  assert.equal(elements["#api-key"].value, "");
  elements["#provider"].value = "openai";
  elements["#provider"].dispatchEvent(new Event("change"));
  assert.equal(elements["#provider-base-url"].value, "https://api.openai.com/v1");
  elements["#provider"].value = "custom";
  elements["#provider"].dispatchEvent(new Event("change"));
  assert.equal(elements["#provider-base-url"].value, "https://gateway.example/v1");
  assert.equal(elements["#model"].value, "vendor/model:free");
  // Hidden BYOK fields must not prevent saving the independent backend route.
  globalThis.chrome.permissions = { contains: async () => true };
  routes[0].checked = false;
  routes[1].checked = true;
  elements["#provider-base-url"].value = "";
  elements["#backend-endpoint"].value = "https://backend.example/layout";
  elements["#status"].textContent = "";
  elements["#settings-form"].dispatchEvent(new Event("submit", { cancelable: true }));
  for (let i = 0; i < 20 && !["Settings saved locally.", "Enter your provider API base URL first."].includes(elements["#status"].textContent); i++) await new Promise(setImmediate);
  assert.equal(elements["#status"].textContent, "Settings saved locally.");
  assert.equal((await storage.getRuntimeSettings()).routeMode, "backend");
});
