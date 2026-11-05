const JOB_PREFIX = "frameweave.job.v1.";

export function selectPageTab(tabs, requestedId) {
  const pages = tabs.filter(tab => Number.isInteger(tab.id) && /^https?:\/\//.test(tab.url || ""));
  if (Number.isInteger(requestedId)) return pages.find(tab => tab.id === requestedId) || null;
  const active = tabs.find(tab => tab.active);
  return pages.find(tab => tab.id === active?.id)
    || pages.find(tab => tab.id === active?.openerTabId)
    || (pages.length === 1 ? pages[0] : null);
}

/** A page owns its work. Popup ports only observe it. No credentials or prompt are persisted. */
export function createPageJobs({ storage, emit = () => {}, heartbeat = () => {} }) {
  const running = new Map();
  let generation = 0;

  async function get(tabId) {
    if (running.has(tabId)) return running.get(tabId).snapshot;
    const readGeneration = generation;
    const key = JOB_PREFIX + tabId;
    const saved = (await storage.get(key))[key] || null;
    if (readGeneration !== generation) return get(tabId);
    if (running.has(tabId)) return running.get(tabId).snapshot;
    if (saved?.busy) {
      saved.busy = false;
      saved.event = { type: "error", error: { code: "job_interrupted", message: "Generation was interrupted because the browser stopped its background worker. You can retry the request." } };
      await storage.set({ [key]: saved });
    }
    return saved;
  }

  async function run(tabId, execute) {
    if (running.has(tabId)) throw Object.assign(new Error("An operation is already running for this page."), { code: "request_in_progress" });
    const controller = new AbortController();
    const entry = { controller, snapshot: { busy: true, event: { type: "state", message: "Preparing the page…" } } };
    generation += 1;
    running.set(tabId, entry);
    let writes = Promise.resolve();
    const report = (event, pending = entry.snapshot.pending || null) => {
      entry.snapshot = { busy: event.type === "state", event, pending, updatedAt: Date.now() };
      const snapshot = structuredClone(entry.snapshot);
      writes = writes.then(() => storage.set({ [JOB_PREFIX + tabId]: snapshot }));
      if (event.type === "state") emit(tabId, event);
      return writes;
    };
    // Chrome's documented long-operation keepalive, stopped as soon as this job settles.
    const interval = setInterval(() => { void Promise.resolve(heartbeat()).catch(() => {}); }, 25000);
    const timeout = setTimeout(() => controller.abort(new Error("The operation timed out after 10 minutes. Try again.")), 600000);
    try {
      const saved = (await storage.get(JOB_PREFIX + tabId))[JOB_PREFIX + tabId];
      entry.snapshot.pending = saved?.pending || null;
      await report(entry.snapshot.event);
      controller.signal.throwIfAborted();
      await execute({ report, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) error = controller.signal.reason;
      await report({ type: "error", error: { code: error.code || "operation_failed", message: String(error.message || error).slice(0, 700) } });
    } finally {
      clearInterval(interval);
      clearTimeout(timeout);
      try { await writes; } finally { running.delete(tabId); }
      emit(tabId, entry.snapshot.event);
    }
  }

  return {
    get, run,
    isRunning: tabId => running.has(tabId),
    cancel(tabId) { running.get(tabId)?.controller.abort(new Error("Generation cancelled.")); },
    async remove(tabId) { this.cancel(tabId); await storage.remove(JOB_PREFIX + tabId); }
  };
}
