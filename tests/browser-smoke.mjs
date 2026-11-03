import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const server = createServer(async (request, response) => {
  const path = resolve(root, "." + new URL(request.url, "http://localhost").pathname);
  if (!path.startsWith(root + "/")) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    response.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[extname(path)] || "text/plain");
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const values = {
      "frameweave.settings.v1": { provider: "openrouter", models: { openrouter: "saved-model" } },
      "frameweave.secrets.v1": { providerKeys: { openrouter: "test-fixture-key" } }
    };
    const listeners = { addListener() {} };
    globalThis.chrome = {
      storage: { local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]])); },
        async set(patch) { Object.assign(values, patch); }
      } },
      runtime: { connect: () => ({ postMessage() {}, onMessage: listeners, onDisconnect: listeners }) }
    };
  });
  let pending;
  await page.route("https://openrouter.ai/api/v1/models", async route => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,accept", "access-control-allow-methods": "GET" } });
    } else pending = route;
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Ready."));
  for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(pending, "Model request did not start");
  await page.locator("#model-search").fill("FrEe");
  const longId = "vendor/" + "long-model-".repeat(8) + ":free";
  await pending.fulfill({ headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ data: [
    { id: "vendor/paid", name: "Paid model" },
    { id: "vendor/short:free", name: "Free model" },
    { id: longId, name: "A very long descriptive model name with many words that must wrap across multiple lines on a small phone" }
  ] }) });
  await page.waitForFunction(() => document.querySelectorAll(".model-choice").length === 2);
  assert.equal(await page.locator("#model").inputValue(), "saved-model");
  await page.locator(".model-choice").filter({ hasText: longId }).click();
  assert.equal(await page.locator("#model").inputValue(), longId);
  assert.equal(await page.locator("#model-search").inputValue(), "FrEe");
  await page.locator("#model-search").fill("no-matching-model");
  assert.equal(await page.locator(".model-choice").count(), 0);
  assert.match(await page.locator("#model-results-status").textContent(), /no models match/i);
  await page.locator("#model-search").fill("");
  assert.equal(await page.locator(".model-choice").count(), 3);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Page overflows phone width");
  assert.ok(await page.locator(".model-choice").evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth)), "Model text is clipped horizontally");
  await page.locator("#provider-models").screenshot({ path: "model-picker-phone-width.png" });
  await page.locator("#clear-provider-key").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Saved provider key removed.");
  assert.equal(page.isClosed(), false);
  assert.deepEqual(errors, []);
  console.log("Chromium mobile viewport: live search, late response, selection, reset, wrapping, and key clearing passed.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
