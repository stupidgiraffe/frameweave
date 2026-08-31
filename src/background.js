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
  if (error instanceof AIClientError || error instanceof InjectionError) {
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

async function activeTabId() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  const tab = tabs[0];
  if (!tab || !Number.isInteger(tab.id)) {
    throw new Error("Open a web page in the active tab, then try again.");
  }
  return tab.id;
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

async function inspectActivePage(port, message) {
  const [settings, tabId] = await Promise.all([getPublicSettings(), activeTabId()]);
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

async function generateAndDeploy(port, message, abortController, mode) {
  const [settings, tabId] = await Promise.all([getRuntimeSettings(), activeTabId()]);
  const extractionOptions = optionsFrom(settings, message);

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
    signal: abortController.signal,
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

  send(port, {
    type: "state",
    phase: "injecting",
    message: mode === "preview"
      ? "Injecting the CSS preview; automation will wait for confirmation..."
      : "Applying CSS and validated interface automation..."
  });
  const deployment = mode === "preview"
    ? await previewLayoutPayload(tabId, payload, extractionOptions)
    : await deployLayoutPayload(tabId, payload, extractionOptions);
  const impact = await recordImpact({
    preview: mode === "preview",
    cssInjected: deployment.cssInjected,
    automationApplied: deployment.automation.applied
  });

  send(port, {
    type: mode === "preview" ? "preview.complete" : "apply.complete",
    summary,
    deployment,
    impact,
    selectedElement
  });
}

async function commitCurrentPreview(port) {
  const tabId = await activeTabId();
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

async function discardCurrentPreview(port) {
  const tabId = await activeTabId();
  const result = await discardPreview(tabId);
  send(port, {
    type: "preview.discard.complete",
    result
  });
}

async function removeCss(port) {
  const tabId = await activeTabId();
  const result = await removeLastInjectedCss(tabId);
  send(port, {
    type: "remove.complete",
    result
  });
}

async function saveCurrentLayoutAsUserScript(port) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") {
    throw new Error("Open a normal web page before saving a layout as a userscript.");
  }
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

async function startElementPicker(port) {
  const tabId = await activeTabId();
  const result = await startPickerInTab(tabId);
  send(port, {
    type: "picker.started",
    result
  });
}

async function clearElementTarget(port) {
  const tabId = await activeTabId();
  await Promise.all([
    clearPickedElement(tabId),
    stopPickerInTab(tabId).catch(() => ({ stopped: false }))
  ]);
  send(port, { type: "picker.cleared" });
}

async function sendActiveState(port) {
  const tabId = await activeTabId();
  const [selectedElement, impact, deployment] = await Promise.all([
    getPickedElement(tabId),
    getImpactSummary(),
    getDeploymentState(tabId)
  ]);
  send(port, {
    type: "active-state",
    selectedElement,
    impact,
    deployment
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
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }

  if (message.type === PICKER_CANCEL) {
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void Promise.all([
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
  if (port.name !== POPUP_PORT) {
    return;
  }

  let busy = false;
  let abortController = null;

  port.onDisconnect.addListener(() => {
    if (abortController) {
      abortController.abort();
    }
  });

  port.onMessage.addListener((message) => {
    void (async () => {
      if (!message || typeof message.type !== "string") {
        return;
      }

      if (message.type === "ping") {
        send(port, { type: "pong" });
        return;
      }
      if (message.type === "get-active-state") {
        try {
          await sendActiveState(port);
        } catch (error) {
          send(port, { type: "error", error: safeError(error) });
        }
        return;
      }
      if (busy) {
        send(port, {
          type: "error",
          error: {
            code: "request_in_progress",
            message: "Wait for the current operation to finish."
          }
        });
        return;
      }

      try {
        switch (message.type) {
          case "inspect":
            busy = true;
            await inspectActivePage(port, message);
            break;
          case "preview":
            busy = true;
            abortController = new AbortController();
            await generateAndDeploy(port, message, abortController, "preview");
            break;
          case "apply":
            busy = true;
            abortController = new AbortController();
            await generateAndDeploy(port, message, abortController, "apply");
            break;
          case "commit-preview":
            busy = true;
            await commitCurrentPreview(port);
            break;
          case "discard-preview":
            busy = true;
            await discardCurrentPreview(port);
            break;
          case "remove-css":
            busy = true;
            await removeCss(port);
            break;
          case "save-layout-as-script":
            busy = true;
            await saveCurrentLayoutAsUserScript(port);
            break;
          case "pick-element":
            busy = true;
            await startElementPicker(port);
            break;
          case "clear-picked-element":
            busy = true;
            await clearElementTarget(port);
            break;
          default:
            send(port, {
              type: "error",
              error: {
                code: "unknown_message",
                message: "The extension received an unsupported request."
              }
            });
            return;
        }
      } catch (error) {
        send(port, {
          type: "error",
          error: safeError(error)
        });
      } finally {
        busy = false;
        abortController = null;
      }
    })();
  });
});
