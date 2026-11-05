import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";

const layout = { css: "main { max-width: 321px !important; }", javascript: '{"version":1,"steps":[]}' };
let waiting = [];
let hold = false;
let requests = 0;
const server = createServer(async (request, response) => {
  if (request.url === "/v1/chat/completions") {
    requests++;
    for await (const chunk of request) { /* Consume the request without logging credentials or page structure. */ }
    if (hold) await new Promise(resolve => waiting.push(resolve));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(layout) } }] }));
  } else if (request.url === "/v1/models") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "fixture-model", name: "Fixture Model" }] }));
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Frameweave test page</title><main id="article" style="padding:20px; min-height:300px"><h1>Layout fixture</h1><p>Mobile and desktop page actions</p></main>');
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extensionPath = resolve(process.cwd());
const context = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true,
  viewport: { width: 360, height: 800 }, hasTouch: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});
const release = () => { hold = false; waiting.splice(0).forEach(resolve => resolve()); };
async function until(check, message) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(message);
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  console.log("Loaded extension worker:", worker.url());
  await until(() => worker.evaluate(() => Boolean(globalThis.chrome?.storage?.local)), "Extension storage API did not initialize");
  await worker.evaluate(async baseUrl => {
    await chrome.storage.local.set({
      "frameweave.settings.v1": { provider: "custom", baseUrls: { custom: baseUrl }, models: { custom: "fixture-model" } },
      "frameweave.secrets.v1": { providerKeys: { custom: "fixture-key" } }
    });
  }, origin + "/v1");
  const target = await context.newPage();
  await target.goto(origin + "/fixture");
  const targetId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, origin + "/fixture");
  async function popup() {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.waitForFunction(() => document.querySelector("#page-tab").value !== "");
    assert.equal(await page.locator("#page-tab").inputValue(), String(targetId));
    return page;
  }
  let ui = await popup();
  assert.equal(await ui.locator("#model-chooser").isVisible(), false);
  assert.equal(await ui.locator("#selected-model-label").textContent(), "fixture-model");
  await ui.locator("#inspect-page").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Mapped "));
  assert.equal(await ui.locator("#inspect-page").isEnabled(), true);

  await ui.locator("#pick-element").click();
  await target.locator("#frameweave-picker-overlay button").waitFor();
  await target.locator("h1").hover();
  assert.equal(await target.locator("#frameweave-picker-highlight").isVisible(), true);
  assert.equal(await target.locator("#frameweave-picker-tooltip").isVisible(), true);
  await target.locator("h1").tap();
  await ui.bringToFront();
  await ui.locator("#refresh-pages").click();
  await ui.waitForFunction(() => document.querySelector("#selected-target").textContent.startsWith("Target: h1"));
  await ui.close();
  ui = await popup();
  assert.equal(ui.isClosed(), false, "Restoring picker state must not close a new popup");
  assert.match(await ui.locator("#selected-target").textContent(), /Target: h1/);
  await ui.locator("#clear-picked-element").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent === "Specific target cleared.");
  await ui.locator("#pick-element").click();
  await target.locator("#frameweave-picker-overlay button").click();
  assert.equal(await target.locator("#frameweave-picker-overlay").count(), 0);
  await ui.bringToFront();
  await ui.locator("#layout-prompt").fill("Make the main column narrower");

  // Actual background fetch and injection after the extension UI is destroyed.
  hold = true;
  await ui.locator("#apply-layout").click();
  await until(() => waiting.length === 1, "AI request did not reach the local provider");
  await ui.close();
  ui = await popup();
  await ui.waitForFunction(() => document.querySelector("#apply-layout").disabled);
  assert.match(await ui.locator("#status").textContent(), /layout plan|Preparing/);
  await ui.close();
  release();
  await target.waitForFunction(() => getComputedStyle(document.querySelector("main")).maxWidth === "321px");
  ui = await popup();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("CSS applied"));
  assert.equal(await ui.locator("#save-layout-as-script").isEnabled(), true);
  await ui.locator("#remove-css").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("The last injected CSS was removed"));
  assert.equal(await target.locator("main").evaluate(element => getComputedStyle(element).maxWidth), "none");

  await ui.locator("#layout-prompt").fill("Make the main column narrower");
  await ui.locator("#preview-layout").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("CSS preview applied"));
  await ui.locator("#discard-preview").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Preview discarded"));
  assert.equal(await target.locator("main").evaluate(element => getComputedStyle(element).maxWidth), "none");
  await ui.locator("#preview-layout").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("CSS preview applied"));
  await ui.locator("#commit-preview").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Preview kept"));
  await ui.locator("#save-layout-as-script").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved “Frameweave layout"));
  await worker.evaluate(async () => { await chrome.storage.local.remove("frameweave.userscripts.v1"); });

  // Navigate the SAME tab before the result arrives. New document must remain untouched.
  hold = true;
  await ui.locator("#apply-layout").click();
  await until(() => waiting.length === 1, "Second AI request did not start");
  await ui.close();
  await target.goto(origin + "/next");
  release();
  await until(async () => {
    const value = await worker.evaluate(async tabId => (await chrome.storage.session.get("frameweave.job.v1." + tabId))["frameweave.job.v1." + tabId], targetId);
    return value?.event?.type === "generation.ready";
  }, "Navigated generation was not retained");
  assert.equal(await target.locator("main").evaluate(element => getComputedStyle(element).maxWidth), "none");
  ui = await popup();
  assert.equal(await ui.locator("#apply-saved-result").isVisible(), true);
  assert.equal(await ui.locator("#save-layout-as-script").isEnabled(), false);
  await ui.locator("#inspect-page").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Mapped "));
  assert.equal(await ui.locator("#apply-saved-result").isVisible(), true, "Inspect must preserve a saved generation");
  await ui.locator("#apply-saved-result").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.includes("original page"));
  await target.goto(origin + "/fixture");
  await ui.locator("#apply-saved-result").click();
  await ui.waitForFunction(() => document.querySelector("#status").textContent.startsWith("CSS applied"));
  assert.equal(await target.locator("main").evaluate(element => getComputedStyle(element).maxWidth), "321px");
  await target.reload();
  await ui.close();
  ui = await popup();
  assert.equal(await ui.locator("#save-layout-as-script").isEnabled(), false, "Replayed completion must not restore CSS that navigation removed");
  assert.equal(await ui.locator("#preview-actions").isVisible(), false);
  assert.ok(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await ui.locator(".prompt-section").screenshot({ path: "page-actions-phone-width.png" });
  assert.ok(requests >= 4);
  console.log("Loaded MV3 extension: mobile inspect, touch picker/cancel, preview/commit/discard, CSS removal/save, detached generation, reconnect, navigation retention and explicit application passed.");
} finally {
  release();
  await context.close();
  await new Promise(resolve => server.close(resolve));
}
