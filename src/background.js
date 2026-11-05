import { createPageJobs, selectPageTab } from "./pageJobs.js";
import { AIClientError, generateLayoutPayload } from "./aiClient.js";
import { extractDomMap } from "./domExtractor.js";
import { startPickerInTab, stopPickerInTab } from "./elementPicker.js";
import {
  clearDeploymentState,
  commitPreview,
  deployLayoutPayload,
  discardPreview,
  getDeploymentState,
  getPersistableLayoutCss,
  InjectionError,
  previewLayoutPayload,
  removeLastInjectedCss
} from "./injector.js";
import {
  clearPickedElement,
  getImpactSummary,
  getPickedElement,
  getPublicSettings,
  getRuntimeSettings,
  initializeStorage,
  recordImpact,
  savePickedElement
} from "./storage.js";
import { listUserScripts, saveUserScript } from "./userscriptStore.js";
import { createUserScriptSource, normalizeUserScriptInput } from "./userscriptMetadata.js";
import { applyUserScriptUpdate, checkUserScriptUpdate } from "./userscriptUpdates.js";
import {
  clearUserScriptTabStateForTab,
  installUserScriptMessageBridge,
  syncUserScripts
} from "./userscriptRuntime.js";

const POPUP_PORT = "frameweave-popup";
const PICKER_SELECTION = "frameweave.picker.selection";
const PICKER_CANCEL = "frameweave.picker.cancel";
const USERSCRIPT_UPDATE_ALARM = "frameweave-userscript-update-check";

installUserScriptMessageBridge();

function scheduleUserScriptUpdateChecks() {
  if (!chrome.alarms || typeof chrome.alarms.create !== "function") return;
  chrome.alarms.create(USERSCRIPT_UPDATE_ALARM, {
    delayInMinutes: 10,
    periodInMinutes: 24 * 60
  });
}

async function runAutoUserScriptUpdateCheck() {
  const scripts = await listUserScripts();
  let checked = 0;
  let updated = 0;
  for (const script of scripts) {
    if (script.checkForUpdates === false || !(script.updateUrl || script.downloadUrl)) continue;
    const result = await checkUserScriptUpdate(script);
    checked += 1;
    if (result.status === "available" && result.candidate) {
      await saveUserScript(applyUserScriptUpdate(script, result.candidate));
      updated += 1;
    } else if (result.script) {
      await saveUserScript(result.script);
    }
  }
  if (updated) await syncUserScripts();
  return { checked, updated };
}

function send(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The popup may have closed while a stream was in flight.
  }
}

function safeError(error) {
  if (error instanceof AIClientError || error instanceof InjectionError || error?.code === "request_in_progress") {
    return {
      code: error.code,
      message: error.message
    };
  }
  return {
    code: "unexpected_error",
    message: String(error && error.message ? error.message : error || "An unexpected error occurred.").slice(0, 700)
  };
}

const connections = new Set();
const jobs = createPageJobs({
  storage: chrome.storage.session,
  heartbeat: () => chrome.runtime.getPlatformInfo(),
  emit(tabId, message) {
    for (const connection of connections) {
      if (connection.tabId === tabId) send(connection.port, { ...message, tabId });
    }
  }
});

async function pageTabs() {
  return chrome.tabs.query({ lastFocusedWindow: true });
}

async function requirePage(tabId) {
  const tab = selectPageTab(await pageTabs(), tabId);
  if (!tab) throw new Error("Choose a target web page above the layout prompt. Browser settings and extension pages cannot be styled.");
  return tab;
}

async function documentIdentity(tabId, allFrames = false) {
  const documents = await chrome.scripting.executeScript({
    target: { tabId, allFrames }, func: () => ({ url: location.href, timeOrigin: performance.timeOrigin }), world: "ISOLATED"
  });
  const main = documents.find(document => document.frameId === 0);
  if (!main?.result || documents.some(document => !document.documentId)) {
    throw new Error("The target page is not readable. Reload it and check Frameweave’s site access permission and browser scripting support.");
  }
  return { ...main.result, documentIds: documents.map(document => document.documentId).sort() };
}

function sameDocument(left, right) {
  return left.url === right.url && JSON.stringify(left.documentIds) === JSON.stringify(right.documentIds);
}

function optionsFrom(settings, message) {
  return {
    maxNodes: settings.maxNodes,
    maxDepth: settings.maxDepth,
    allFrames: Boolean(message && message.allFrames)
  };
}

function summarizeDomMap(map) {
  if (map && Array.isArray(map.frames)) {
    return map.frames.reduce(
      (summary, frame) => {
        const current = frame.map && frame.map.summary ? frame.map.summary : {};
        summary.frames += 1;
        summary.nodes += Number(current.emitted) || 0;
        summary.scanned += Number(current.scanned) || 0;
        summary.truncated = summary.truncated || Boolean(current.truncated);
        return summary;
      },
      { frames: 0, nodes: 0, scanned: 0, truncated: false }
    );
  }

  const summary = map && map.summary ? map.summary : {};
  return {
    frames: 1,
    nodes: Number(summary.emitted) || 0,
    scanned: Number(summary.scanned) || 0,
    truncated: Boolean(summary.truncated)
  };
}

/**
 * Central route middleware. A hosted route can be added here without changing
 * popup messages, DOM extraction, payload validation, or page injection.
 */
async function routeGeneration(settings, input) {
  switch (settings.routeMode) {
    case "byok":
      return generateLayoutPayload({ ...settings, routeMode: "byok" }, input);
    case "backend":
      return generateLayoutPayload({ ...settings, routeMode: "backend" }, input);
    default:
      throw new AIClientError("unsupported_route", "The selected execution route is not supported.");
  }
}

async function inspectActivePage(port, message, tabId) {
  const settings = await getPublicSettings();
  send(port, {
    type: "state",
    phase: "extracting",
    message: "Building a slim structural map of the active page..."
  });

  const [domMap, selectedElement] = await Promise.all([
    extractDomMap(tabId, optionsFrom(settings, message)),
    getPickedElement(tabId)
  ]);
  send(port, {
    type: "inspect.complete",
    summary: summarizeDomMap(domMap),
    selectedElement
  });
}

async function generateAndDeploy(port, message, signal, mode, tabId, report) {
  const settings = await getRuntimeSettings();
  const extractionOptions = optionsFrom(settings, message);
  const identity = await documentIdentity(tabId, extractionOptions.allFrames);
  extractionOptions.documentIds = identity.documentIds;

  send(port, {
    type: "state",
    phase: "extracting",
    message: "Building a slim structural map of the active page..."
  });
  const [domMap, selectedElement] = await Promise.all([
    extractDomMap(tabId, extractionOptions),
    getPickedElement(tabId)
  ]);
  const summary = summarizeDomMap(domMap);

  send(port, {
    type: "state",
    phase: "generating",
    message: "Requesting a structured layout plan..."
  });
  const payload = await routeGeneration(settings, {
    prompt: message.prompt,
    domMap,
    selectedElement,
    maxOutputTokens: settings.maxOutputTokens,
    signal,
    onProgress(progress) {
      if (progress.phase === "generating") {
        send(port, {
          type: "state",
          phase: "generating",
          message: "Receiving the structured layout plan..."
        });
      }
    }
  });

  signal.throwIfAborted();
  const pending = { payload, extractionOptions, summary, selectedElement, identity, mode };
  let current = null;
  try { current = await documentIdentity(tabId, extractionOptions.allFrames); } catch { /* Retain the result if the page is temporarily unavailable. */ }
  if (!current || !sameDocument(identity, current)) {
    await report({ type: "generation.ready", message: "Generation finished. The target page navigated, so the result was saved. Return to the original page and choose Apply saved result when ready." }, pending);
    return;
  }
  try {
    await deployGenerated(port, tabId, pending, signal);
  } catch (error) {
    signal.throwIfAborted();
    let after = null;
    try { after = await documentIdentity(tabId, extractionOptions.allFrames); } catch { /* Preserve the plan. */ }
    if (!after || !sameDocument(identity, after)) {
      await report({ type: "generation.ready", message: "The page changed during deployment. Your generated result is saved; return to the original page and apply it when ready." }, pending);
    } else throw error;
  }
}

async function deployGenerated(port, tabId, pending, signal) {
  signal.throwIfAborted();
  const { payload, summary, selectedElement, mode } = pending;
  const extractionOptions = { ...pending.extractionOptions, signal };
  send(port, {
    type: "state", phase: "injecting",
    message: mode === "preview" ? "Applying the CSS preview…" : "Applying CSS and validated interface automation…"
  });
  const deployment = mode === "preview"
    ? await previewLayoutPayload(tabId, payload, extractionOptions)
    : await deployLayoutPayload(tabId, payload, extractionOptions);
  const impact = await recordImpact({ preview: mode === "preview", cssInjected: deployment.cssInjected, automationApplied: deployment.automation.applied });
  send(port, { type: mode === "preview" ? "preview.complete" : "apply.complete", summary, deployment, impact, selectedElement });
}

async function commitCurrentPreview(port, tabId) {
  send(port, {
    type: "state",
    phase: "injecting",
    message: "Keeping the preview and applying validated automation..."
  });
  const deployment = await commitPreview(tabId);
  const impact = await recordImpact({
    committed: true,
    automationApplied: deployment.automation.applied
  });
  send(port, {
    type: "preview.commit.complete",
    deployment,
    impact
  });
}

async function discardCurrentPreview(port, tabId) {
  const result = await discardPreview(tabId);
  send(port, {
    type: "preview.discard.complete",
    result
  });
}

async function removeCss(port, tabId) {
  const result = await removeLastInjectedCss(tabId);
  send(port, {
    type: "remove.complete",
    result
  });
}

async function saveCurrentLayoutAsUserScript(port, tabId) {
  const tab = await requirePage(tabId);
  const url = new URL(tab.url);
  if (!/^https?:$/.test(url.protocol) || !url.hostname) {
    throw new Error("Layouts can be saved only from an HTTP or HTTPS page.");
  }
  const layout = await getPersistableLayoutCss(tab.id);
  const match = url.protocol + "//" + url.host + "/*";
  const draft = normalizeUserScriptInput({
    name: "Frameweave layout — " + url.hostname,
    description: "Persistent CSS layout saved from " + url.hostname + ".",
    version: "1.0.0",
    matches: [match],
    grants: ["GM_addStyle"],
    runAt: "document_idle",
    world: "USER_SCRIPT",
    allFrames: layout.allFrames,
    enabled: true,
    provenance: "layout-save",
    code: "GM_addStyle(" + JSON.stringify(layout.css) + ");"
  });
  const saved = await saveUserScript({
    ...draft,
    source: createUserScriptSource(draft)
  });
  const syncResult = await syncUserScripts();
  send(port, {
    type: "layout.saved-as-script",
    script: { id: saved.id, name: saved.name, matches: saved.matches },
    syncResult
  });
}

async function startElementPicker(port, tabId) {
  const result = await startPickerInTab(tabId);
  await chrome.tabs.update(tabId, { active: true });
  send(port, {
    type: "picker.started",
    result
  });
}

async function clearElementTarget(port, tabId) {
  await Promise.all([
    clearPickedElement(tabId),
    stopPickerInTab(tabId).catch(() => ({ stopped: false }))
  ]);
  send(port, { type: "picker.cleared" });
}

async function sendActiveState(connection, requestedId) {
  const tabs = await pageTabs();
  const active = tabs.find(tab => tab.active);
  const targetKey = "frameweave.target.v1." + (active?.windowId ?? "default");
  const savedTarget = (await chrome.storage.session.get(targetKey))[targetKey];
  const tab = selectPageTab(tabs, requestedId ?? connection.tabId)
    || (requestedId == null && connection.tabId == null ? selectPageTab(tabs, savedTarget) : null);
  if (tab) await chrome.storage.session.set({ [targetKey]: tab.id });
  connection.tabId = tab?.id ?? null;
  let selectedElement, impact, deployment, job, before;
  do {
    before = tab ? await jobs.get(tab.id) : null;
    [selectedElement, impact, deployment] = await Promise.all([
      tab ? getPickedElement(tab.id) : null, getImpactSummary(), tab ? getDeploymentState(tab.id) : null
    ]);
    job = tab ? await jobs.get(tab.id) : null;
    // Retry if completion changed deployment while the snapshot was being read.
  } while (before?.busy !== job?.busy || before?.event?.type !== job?.event?.type || (!job?.busy && before?.updatedAt !== job?.updatedAt));
  send(connection.port, {
    type: "active-state", selectedElement, impact, deployment,
    tabId: connection.tabId,
    pages: tabs.filter(tab => /^https?:\/\//.test(tab.url || "")).map(tab => ({ id: tab.id, title: tab.title || tab.url, url: tab.url })),
    job: job ? { busy: job.busy, event: job.event, hasPending: Boolean(job.pending) } : null
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage()
    .then(async () => {
      scheduleUserScriptUpdateChecks();
      await syncUserScripts();
    })
    .catch(() => {
      // Local settings survive even when a browser blocks the userScripts API.
    });
});

chrome.runtime.onStartup.addListener(() => {
  void initializeStorage()
    .then(async () => {
      scheduleUserScriptUpdateChecks();
      await syncUserScripts();
    })
    .catch(() => {
      // Session state is optional and local storage will self-heal on popup open.
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (!message || !Number.isInteger(tabId)) {
    return undefined;
  }

  if (message.type === PICKER_SELECTION) {
    void savePickedElement(tabId, message.selection)
      .then((selectedElement) => {
        for (const connection of connections) if (connection.tabId === tabId) send(connection.port, { type: "picker.selected", selectedElement });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }

  if (message.type === PICKER_CANCEL) {
    for (const connection of connections) if (connection.tabId === tabId) send(connection.port, { type: "picker.cancelled" });
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void Promise.all([
    jobs.remove(tabId),
    clearPickedElement(tabId),
    clearUserScriptTabStateForTab(tabId)
  ]);
});

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === USERSCRIPT_UPDATE_ALARM) {
      void runAutoUserScriptUpdateCheck().catch(() => {
        // Update failures are recorded per script and do not disrupt page execution.
      });
    }
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void Promise.all([
      clearPickedElement(tabId),
      clearDeploymentState(tabId)
    ]);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT) return;
  const connection = { port, tabId: null };
  connections.add(connection);
  port.onDisconnect.addListener(() => connections.delete(connection));

  port.onMessage.addListener((message) => {
    void (async () => {
      if (!message || typeof message.type !== "string") return;
      try {
        if (message.type === "ping") { send(port, { type: "pong" }); return; }
        if (message.type === "get-active-state") {
          await sendActiveState(connection, message.tabId);
          return;
        }
        if (message.type === "cancel-generation") {
          const tabId = message.tabId ?? connection.tabId;
          if (Number.isInteger(tabId)) jobs.cancel(tabId);
          return;
        }
        const tab = await requirePage(message.tabId ?? connection.tabId);
        connection.tabId = tab.id;
        const previous = message.type === "apply-saved-result" ? await jobs.get(tab.id) : null;
        await jobs.run(tab.id, async ({ report, signal }) => {
          const sink = { postMessage: event => { void report(event, ["apply.complete", "preview.complete"].includes(event.type) ? null : undefined).catch(() => {}); } };
          switch (message.type) {
            case "inspect": await inspectActivePage(sink, message, tab.id); break;
            case "preview":
            case "apply": await generateAndDeploy(sink, message, signal, message.type, tab.id, report); break;
            case "apply-saved-result": {
              if (!previous?.pending) throw new Error("There is no saved result for this page.");
              const current = await documentIdentity(tab.id, previous.pending.extractionOptions.allFrames);
              if (current.url !== previous.pending.identity.url) {
                await report({ type: "generation.ready", message: "Return this target tab to the original page before applying its saved result." }, previous.pending);
                break;
              }
              await deployGenerated(sink, tab.id, { ...previous.pending, extractionOptions: { ...previous.pending.extractionOptions, documentIds: current.documentIds } }, signal);
              break;
            }
            case "commit-preview": await commitCurrentPreview(sink, tab.id); break;
            case "discard-preview": await discardCurrentPreview(sink, tab.id); break;
            case "remove-css": await removeCss(sink, tab.id); break;
            case "save-layout-as-script": await saveCurrentLayoutAsUserScript(sink, tab.id); break;
            case "pick-element": await startElementPicker(sink, tab.id); break;
            case "clear-picked-element": await clearElementTarget(sink, tab.id); break;
            default: throw new Error("The extension received an unsupported request.");
          }
        });
      } catch (error) {
        send(port, { type: "error", error: safeError(error) });
      }
    })();
  });
});
