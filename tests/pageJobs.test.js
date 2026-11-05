import assert from "node:assert/strict";
import test from "node:test";
import { createPageJobs, selectPageTab } from "../src/pageJobs.js";

function memory() {
  const values = {};
  return { async get(key) { return { [key]: structuredClone(values[key]) }; }, async set(patch) { Object.assign(values, structuredClone(patch)); }, async remove(key) { delete values[key]; } };
}

test("mobile extension tabs use their opener; ambiguous pages require a choice", () => {
  const tabs = [{ id: 1, active: true, url: "chrome-extension://fw/popup.html", openerTabId: 2 }, { id: 2, url: "https://example.org" }, { id: 3, url: "https://example.net" }];
  assert.equal(selectPageTab(tabs)?.id, 2);
  delete tabs[0].openerTabId;
  assert.equal(selectPageTab(tabs), null);
  assert.equal(selectPageTab(tabs, 3)?.id, 3);
  assert.equal(selectPageTab(tabs, 1), null);
});

test("jobs survive UI disconnect, prevent duplicates, and replay completion after worker restart", async () => {
  const storage = memory();
  const events = [];
  const jobs = createPageJobs({ storage, emit: (tabId, event) => events.push({ tabId, event }) });
  let finish;
  const work = jobs.run(2, async ({ report }) => {
    await report({ type: "state", message: "Generating" });
    await new Promise(resolve => { finish = resolve; });
    await report({ type: "apply.complete", deployment: { cssInjected: true } });
  });
  while (!finish) await new Promise(setImmediate);
  await assert.rejects(jobs.run(2, async () => {}), /already running/i);
  assert.equal((await jobs.get(2)).busy, true);
  // A newly opened UI gets its state from storage, without owning an abort controller.
  finish();
  await work;
  const reopened = createPageJobs({ storage });
  assert.equal((await reopened.get(2)).event.type, "apply.complete");
  assert.equal((await reopened.get(2)).busy, false);
  assert.equal(events.at(-1).event.type, "apply.complete");
});

test("a stopped worker reports interruption instead of replaying an eternal busy state", async () => {
  const storage = memory();
  await storage.set({ "frameweave.job.v1.7": { busy: true, event: { type: "state", message: "Generating" } } });
  const jobs = createPageJobs({ storage });
  const recovered = await jobs.get(7);
  assert.equal(recovered.busy, false);
  assert.match(recovered.event.error.message, /interrupted/i);
});

test("explicit cancellation aborts only that page's job and releases its lock", async () => {
  const jobs = createPageJobs({ storage: memory() });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const work = jobs.run(4, async ({ signal }) => {
    started();
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  await ready;
  jobs.cancel(4);
  await work;
  assert.equal((await jobs.get(4)).busy, false);
  assert.match((await jobs.get(4)).event.error.message, /cancel/i);
});
