import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getRuntimeSettings, initializeStorage } from "../src/storage.js";

let instance = 0;
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(check(), "Popup did not reach the expected state");
}

async function popup(t, values = {}) {
  const previous = { chrome: globalThis.chrome, document: globalThis.document, window: globalThis.window };
  class Element extends EventTarget {
    value = ""; textContent = ""; checked = false; disabled = false; children = [];
    classList = { toggle() {} };
    replaceChildren(...children) { this.children = children; }
    focus() {}
  }
  const html = fs.readFileSync(new URL("../popup.html", import.meta.url), "utf8");
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const routes = ["byok", "backend"].map(value => Object.assign(new Element(), { value }));
  const listener = { addListener() {} };
  globalThis.chrome = { storage: { local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])])); },
    async set(patch) { Object.assign(values, structuredClone(patch)); }
  } }, runtime: { connect: () => ({ postMessage() {}, onMessage: listener, onDisconnect: listener }) } };
  globalThis.document = { querySelector: selector => elements[selector.slice(1)], querySelectorAll: () => routes, createElement: () => new Element() };
  globalThis.window = Object.assign(new EventTarget(), { confirm: () => true });
  t.after(() => {
    globalThis.window.dispatchEvent(new Event("pagehide"));
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  });
  await initializeStorage();
  await import("../src/popup.js?picker-test=" + instance++);
  await waitFor(() => elements.status.textContent.startsWith("Ready."));
  return { elements, values, routes };
}

test("fresh BYOK requires a model and OpenRouter fills its URL before credentials are saved", async (t) => {
  const { elements, values } = await popup(t);
  assert.equal(elements.model.value, "");
  assert.equal(elements["save-settings"].disabled, true);
  elements.provider.value = "openrouter";
  elements.provider.dispatchEvent(new Event("change"));
  assert.equal(elements["provider-base-url"].value, "https://openrouter.ai/api/v1");
  elements["settings-form"].dispatchEvent(new Event("submit", { cancelable: true }));
  await waitFor(() => /select.*model/i.test(elements.status.textContent));
  assert.equal(values["frameweave.settings.v1"].provider, "openai");
});

test("pasting a key automatically fetches selectable models without auto-selecting or saving credentials", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, key: options.headers.Authorization });
    return new Response(JSON.stringify({ data: [{ id: "vendor/current-model:free", name: "Current Model" }] }));
  });
  const { elements, values } = await popup(t);
  elements.provider.value = "openrouter";
  elements.provider.dispatchEvent(new Event("change"));
  elements["api-key"].value = "pasted-secret";
  elements["api-key"].dispatchEvent(new Event("input"));
  assert.ok(elements["model-status"], "Model loading status is missing");
  await waitFor(() => /1.*model.*loaded/i.test(elements["model-status"].textContent));
  assert.deepEqual(requests, [{ url: "https://openrouter.ai/api/v1/models", key: "Bearer pasted-secret" }]);
  assert.equal(elements["provider-models"].children[0].value, "vendor/current-model:free");
  assert.equal(elements.model.value, "");
  assert.equal(elements["save-settings"].disabled, true);
  assert.equal(values["frameweave.secrets.v1"].providerKeys.openrouter, "");
  elements.model.value = "vendor/current-model:free";
  elements.model.dispatchEvent(new Event("input"));
  assert.equal(elements["save-settings"].disabled, false);
  elements["settings-form"].dispatchEvent(new Event("submit", { cancelable: true }));
  await waitFor(() => elements.status.textContent === "Settings saved locally.");
  const runtime = await getRuntimeSettings();
  assert.equal(runtime.model, "vendor/current-model:free");
  assert.equal(runtime.apiKey, "pasted-secret");
});

test("opening settings fetches using the saved key without displaying it", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://aihubmix.com/api/v1/models");
    assert.equal(options.headers.Authorization, "Bearer saved-secret");
    return new Response(JSON.stringify({ data: [{ model_id: "existing-model", types: "llm" }] }));
  });
  const { elements } = await popup(t, {
    "frameweave.settings.v1": { provider: "aihubmix", models: { aihubmix: "existing-model" } },
    "frameweave.secrets.v1": { providerKeys: { aihubmix: "saved-secret" } }
  });
  assert.ok(elements["model-status"], "Model loading status is missing");
  await waitFor(() => /loaded/i.test(elements["model-status"].textContent));
  assert.equal(elements["api-key"].value, "");
  assert.equal(elements.model.value, "existing-model");
});

test("stale model responses cannot overwrite another provider's picker", async (t) => {
  let finishOld;
  t.mock.method(globalThis, "fetch", async url => {
    if (url.includes("openrouter")) return new Promise(resolve => { finishOld = resolve; });
    return new Response(JSON.stringify({ data: [{ id: "new-provider-model" }] }));
  });
  const { elements } = await popup(t);
  elements.provider.value = "openrouter";
  elements.provider.dispatchEvent(new Event("change"));
  elements["api-key"].value = "old-key";
  elements["api-key"].dispatchEvent(new Event("change"));
  await waitFor(() => Boolean(finishOld));
  elements.provider.value = "groq";
  elements.provider.dispatchEvent(new Event("change"));
  elements["api-key"].value = "new-key";
  elements["api-key"].dispatchEvent(new Event("change"));
  await waitFor(() => /loaded/i.test(elements["model-status"].textContent));
  finishOld(new Response(JSON.stringify({ data: [{ id: "stale-model" }] })));
  await new Promise(setImmediate);
  assert.deepEqual(elements["provider-models"].children.map(option => option.value), ["new-provider-model"]);
});

test("editing an unsaved URL cannot automatically send a saved key to a new origin", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, key: options.headers.Authorization });
    return new Response(JSON.stringify({ data: [{ id: "selected-model" }] }));
  });
  const { elements } = await popup(t, {
    "frameweave.settings.v1": { provider: "openrouter", models: { openrouter: "selected-model" } },
    "frameweave.secrets.v1": { providerKeys: { openrouter: "saved-secret" } }
  });
  await waitFor(() => /loaded/i.test(elements["model-status"].textContent));
  elements["provider-base-url"].value = "https://new-provider.example/v2";
  elements["provider-base-url"].dispatchEvent(new Event("input"));
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(requests.length, 1, "URL typing must not send credentials");
  elements["provider-base-url"].dispatchEvent(new Event("change"));
  elements["refresh-models"].dispatchEvent(new Event("click"));
  await waitFor(() => /paste.*key/i.test(elements["model-status"].textContent));
  assert.equal(requests.length, 1, "Refresh must not reuse the old origin's saved key");
  elements["api-key"].value = "new-provider-key";
  elements["api-key"].dispatchEvent(new Event("change"));
  await waitFor(() => /loaded/i.test(elements["model-status"].textContent));
  assert.deepEqual(requests[1], { url: "https://new-provider.example/v2/models", key: "Bearer new-provider-key" });
});
