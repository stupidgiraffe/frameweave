import {
  clearBackendToken,
  clearProviderApiKey,
  getPublicSettings,
  requestBackendHostPermission,
  saveSettingsPatch,
  setBackendToken,
  setProviderApiKey
} from "./storage.js";
import { listUserScriptSummaries } from "./userscriptStore.js";
import { getUserScriptsAvailability } from "./userscriptRuntime.js";

const elements = {
  settingsForm: document.querySelector("#settings-form"),
  routeMode: document.querySelectorAll('input[name="routeMode"]'),
  byokSettings: document.querySelector("#byok-settings"),
  backendSettings: document.querySelector("#backend-settings"),
  provider: document.querySelector("#provider"),
  model: document.querySelector("#model"),
  apiKey: document.querySelector("#api-key"),
  providerKeyState: document.querySelector("#provider-key-state"),
  clearProviderKey: document.querySelector("#clear-provider-key"),
  backendEndpoint: document.querySelector("#backend-endpoint"),
  backendToken: document.querySelector("#backend-token"),
  backendTokenState: document.querySelector("#backend-token-state"),
  clearBackendToken: document.querySelector("#clear-backend-token"),
  maxNodes: document.querySelector("#max-nodes"),
  maxDepth: document.querySelector("#max-depth"),
  allFrames: document.querySelector("#all-frames"),
  prompt: document.querySelector("#layout-prompt"),
  manageScripts: document.querySelector("#manage-scripts"),
  userScriptState: document.querySelector("#userscript-state"),
  pickElement: document.querySelector("#pick-element"),
  clearPickedElement: document.querySelector("#clear-picked-element"),
  selectedTarget: document.querySelector("#selected-target"),
  inspect: document.querySelector("#inspect-page"),
  preview: document.querySelector("#preview-layout"),
  apply: document.querySelector("#apply-layout"),
  previewActions: document.querySelector("#preview-actions"),
  commitPreview: document.querySelector("#commit-preview"),
  discardPreview: document.querySelector("#discard-preview"),
  saveLayout: document.querySelector("#save-layout-as-script"),
  removeCss: document.querySelector("#remove-css"),
  save: document.querySelector("#save-settings"),
  impactSummary: document.querySelector("#impact-summary"),
  status: document.querySelector("#status")
};

const port = chrome.runtime.connect({ name: "frameweave-popup" });
let publicSettings = null;
let selectedElement = null;
let previewActive = false;
let persistableCss = false;
let busy = false;

function selectedRoute() {
  const selected = Array.from(elements.routeMode).find((input) => input.checked);
  return selected ? selected.value : "byok";
}

function setStatus(message, kind) {
  elements.status.textContent = message;
  elements.status.className = "status status-" + (kind || "idle");
}

function refreshActionAvailability() {
  const alwaysBusyDisabled = [
    elements.inspect,
    elements.preview,
    elements.apply,
    elements.saveLayout,
    elements.removeCss,
    elements.save,
    elements.clearProviderKey,
    elements.clearBackendToken,
    elements.pickElement,
    elements.manageScripts
  ];
  for (const button of alwaysBusyDisabled) {
    button.disabled = busy;
  }
  elements.clearPickedElement.disabled = busy || !selectedElement;
  elements.commitPreview.disabled = busy || !previewActive;
  elements.discardPreview.disabled = busy || !previewActive;
  elements.saveLayout.disabled = busy || !persistableCss;
}

function setBusy(nextBusy) {
  busy = nextBusy;
  refreshActionAvailability();
}

function refreshVisibility() {
  const backend = selectedRoute() === "backend";
  elements.byokSettings.classList.toggle("is-hidden", backend);
  elements.backendSettings.classList.toggle("is-hidden", !backend);
}

function refreshSecretState() {
  const provider = elements.provider.value;
  const keySaved = Boolean(publicSettings && publicSettings.providerKeyPresent[provider]);
  const backendTokenSaved = Boolean(publicSettings && publicSettings.backendTokenPresent);

  elements.providerKeyState.textContent = keySaved
    ? "A key is saved for this provider. Leave the field blank to keep it."
    : "No key is saved for this provider.";
  elements.backendTokenState.textContent = backendTokenSaved
    ? "A backend token is saved. Leave the field blank to keep it."
    : "No backend token is saved.";
}

function renderSelectedTarget(selection) {
  selectedElement = selection && typeof selection.selector === "string" ? selection : null;
  if (!selectedElement) {
    elements.selectedTarget.textContent = "No specific target selected. The model will use the page structure.";
    refreshActionAvailability();
    return;
  }

  const tag = String(selectedElement.tag || "element").toLowerCase();
  const stableId = selectedElement.stableAttributes && selectedElement.stableAttributes.id;
  const identifier = stableId ? tag + "#" + stableId : tag;
  const selector = selectedElement.selector.length > 105
    ? selectedElement.selector.slice(0, 105) + "…"
    : selectedElement.selector;
  const shadowNote = selectedElement.inShadowDom ? " Open shadow-root path included." : "";
  elements.selectedTarget.textContent = "Target: " + identifier + " · " + selector + "." + shadowNote;
  refreshActionAvailability();
}

function renderPreviewState(deployment) {
  previewActive = Boolean(deployment && deployment.mode === "preview");
  persistableCss = Boolean(deployment && (deployment.hasCss || deployment.cssInjected));
  elements.previewActions.classList.toggle("is-hidden", !previewActive);
  refreshActionAvailability();
}

function renderImpact(impact) {
  const value = impact && typeof impact === "object" ? impact : {};
  const pages = Number(value.totalPagesModified) || 0;
  const previews = Number(value.totalPreviews) || 0;
  const css = Number(value.totalCssInjections) || 0;
  const automation = Number(value.totalAutomationActions) || 0;
  elements.impactSummary.textContent =
    pages + " applied page(s) · " + previews + " preview(s) · " + css + " CSS injection(s) · " + automation + " automation action(s)";
}

async function refreshUserScriptState() {
  const [availability, scripts] = await Promise.all([
    getUserScriptsAvailability(),
    listUserScriptSummaries()
  ]);
  const enabled = scripts.filter((script) => script.enabled).length;
  elements.userScriptState.textContent = availability.available
    ? enabled + " of " + scripts.length + " local script(s) enabled."
    : "User Scripts needs its Allow User Scripts browser toggle.";
}

function applySettingsToForm(settings) {
  publicSettings = settings;
  for (const input of elements.routeMode) {
    input.checked = input.value === settings.routeMode;
  }
  elements.provider.value = settings.provider;
  elements.model.value = settings.models[settings.provider];
  elements.backendEndpoint.value = settings.backendEndpoint;
  elements.maxNodes.value = String(settings.maxNodes);
  elements.maxDepth.value = String(settings.maxDepth);
  elements.apiKey.value = "";
  elements.backendToken.value = "";
  refreshVisibility();
  refreshSecretState();
}

async function reloadSettings() {
  applySettingsToForm(await getPublicSettings());
}

async function persistSettings(requestPermission) {
  const routeMode = selectedRoute();
  const provider = elements.provider.value;
  const endpoint = elements.backendEndpoint.value;
  const apiKey = elements.apiKey.value.trim();
  const backendToken = elements.backendToken.value.trim();

  if (routeMode === "backend") {
    if (!endpoint.trim()) {
      throw new Error("Enter an HTTPS backend endpoint before selecting the backend route.");
    }
    if (requestPermission) {
      const granted = await requestBackendHostPermission(endpoint);
      if (!granted) {
        throw new Error("The backend origin permission was not granted.");
      }
    }
  }

  const saved = await saveSettingsPatch({
    routeMode,
    provider,
    model: elements.model.value,
    modelProvider: provider,
    backendEndpoint: endpoint,
    maxNodes: elements.maxNodes.value,
    maxDepth: elements.maxDepth.value
  });

  if (apiKey) {
    await setProviderApiKey(provider, apiKey);
  }
  if (backendToken) {
    await setBackendToken(backendToken);
  }

  elements.apiKey.value = "";
  elements.backendToken.value = "";
  publicSettings = await getPublicSettings();
  elements.model.value = publicSettings.models[provider] || saved.models[provider];
  refreshSecretState();
  return publicSettings;
}

function post(message) {
  try {
    port.postMessage(message);
  } catch {
    setBusy(false);
    setStatus("The extension background worker is unavailable. Reopen the popup and try again.", "error");
  }
}

function startGeneration(mode) {
  if (busy) {
    return;
  }
  const prompt = elements.prompt.value.trim();
  if (!prompt) {
    setStatus("Describe the layout change first.", "error");
    elements.prompt.focus();
    return;
  }

  setBusy(true);
  setStatus("Saving settings and preparing the request...", "working");
  void persistSettings(true)
    .then(() => {
      post({
        type: mode,
        prompt,
        allFrames: elements.allFrames.checked
      });
    })
    .catch((error) => {
      setBusy(false);
      setStatus(String(error.message || error), "error");
    });
}

elements.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) {
    return;
  }

  setBusy(true);
  void persistSettings(true)
    .then(() => {
      setStatus("Settings saved locally.", "success");
    })
    .catch((error) => {
      setStatus(String(error.message || error), "error");
    })
    .finally(() => {
      setBusy(false);
    });
});

elements.provider.addEventListener("change", () => {
  if (!publicSettings) {
    return;
  }
  elements.model.value = publicSettings.models[elements.provider.value] || "";
  elements.apiKey.value = "";
  refreshSecretState();
});

for (const input of elements.routeMode) {
  input.addEventListener("change", refreshVisibility);
}

elements.clearProviderKey.addEventListener("click", () => {
  if (busy || !window.confirm("Remove the saved API key for this provider from this browser?")) {
    return;
  }

  setBusy(true);
  void clearProviderApiKey(elements.provider.value)
    .then(reloadSettings)
    .then(() => setStatus("Saved provider key removed.", "success"))
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.clearBackendToken.addEventListener("click", () => {
  if (busy || !window.confirm("Remove the saved backend token from this browser?")) {
    return;
  }

  setBusy(true);
  void clearBackendToken()
    .then(reloadSettings)
    .then(() => setStatus("Saved backend token removed.", "success"))
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.inspect.addEventListener("click", () => {
  if (busy) {
    return;
  }
  setBusy(true);
  setStatus("Inspecting the active page...", "working");
  post({
    type: "inspect",
    allFrames: elements.allFrames.checked
  });
});

elements.manageScripts.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

elements.pickElement.addEventListener("click", () => {
  if (busy) {
    return;
  }
  setBusy(true);
  setStatus("Starting target selection on the active page...", "working");
  post({ type: "pick-element" });
});

elements.clearPickedElement.addEventListener("click", () => {
  if (busy || !selectedElement) {
    return;
  }
  setBusy(true);
  post({ type: "clear-picked-element" });
});

elements.preview.addEventListener("click", () => startGeneration("preview"));
elements.apply.addEventListener("click", () => startGeneration("apply"));

elements.commitPreview.addEventListener("click", () => {
  if (busy || !previewActive) {
    return;
  }
  setBusy(true);
  setStatus("Keeping the preview...", "working");
  post({ type: "commit-preview" });
});

elements.discardPreview.addEventListener("click", () => {
  if (busy || !previewActive) {
    return;
  }
  setBusy(true);
  setStatus("Discarding the preview...", "working");
  post({ type: "discard-preview" });
});

elements.removeCss.addEventListener("click", () => {
  if (busy) {
    return;
  }
  setBusy(true);
  setStatus("Removing the last injected CSS...", "working");
  post({ type: "remove-css" });
});

elements.saveLayout.addEventListener("click", () => {
  if (busy || !persistableCss) return;
  setBusy(true);
  setStatus("Saving the current generated CSS as a userscript…", "working");
  post({ type: "save-layout-as-script" });
});

port.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "state") {
    setStatus(message.message || "Working...", "working");
    return;
  }

  if (message.type === "active-state") {
    renderSelectedTarget(message.selectedElement);
    renderImpact(message.impact);
    renderPreviewState(message.deployment);
    return;
  }

  if (message.type === "picker.started") {
    setBusy(false);
    setStatus("Click a non-sensitive page element to target it. Press Esc to cancel.", "success");
    return;
  }

  if (message.type === "picker.cleared") {
    renderSelectedTarget(null);
    setBusy(false);
    setStatus("Specific target cleared.", "success");
    return;
  }

  if (message.type === "inspect.complete") {
    const summary = message.summary || {};
    const truncation = summary.truncated ? " The map reached its configured limit." : "";
    if (Object.prototype.hasOwnProperty.call(message, "selectedElement")) {
      renderSelectedTarget(message.selectedElement);
    }
    setStatus(
      "Mapped " + (summary.nodes || 0) + " layout nodes across " + (summary.frames || 1) + " frame(s)." + truncation,
      "success"
    );
    setBusy(false);
    return;
  }

  if (message.type === "preview.complete") {
    const deployment = message.deployment || {};
    renderPreviewState({ mode: "preview", cssInjected: deployment.cssInjected });
    renderImpact(message.impact);
    if (Object.prototype.hasOwnProperty.call(message, "selectedElement")) {
      renderSelectedTarget(message.selectedElement);
    }
    const previewMessage = deployment.cssInjected
      ? "CSS preview applied. Automation has not run; keep or discard the preview."
      : "No CSS was needed. Automation is waiting for confirmation.";
    setStatus(previewMessage, "success");
    setBusy(false);
    return;
  }

  if (message.type === "apply.complete") {
    const deployment = message.deployment || {};
    const automation = deployment.automation || {};
    const cssMessage = deployment.cssInjected ? "CSS applied" : "No CSS needed";
    const automationMessage = (automation.applied || 0) + " automation action(s) applied";
    const warning = Array.isArray(automation.errors) && automation.errors.length > 0
      ? " Some actions were skipped; reload the page if a change needs a full reset."
      : "";
    renderPreviewState({ mode: "applied", cssInjected: deployment.cssInjected });
    renderImpact(message.impact);
    if (Object.prototype.hasOwnProperty.call(message, "selectedElement")) {
      renderSelectedTarget(message.selectedElement);
    }
    setStatus(cssMessage + "; " + automationMessage + "." + warning, "success");
    setBusy(false);
    return;
  }

  if (message.type === "preview.commit.complete") {
    const automation = message.deployment && message.deployment.automation || {};
    renderPreviewState({ mode: "applied", cssInjected: message.deployment && message.deployment.cssInjected });
    renderImpact(message.impact);
    setStatus("Preview kept; " + (automation.applied || 0) + " automation action(s) applied.", "success");
    setBusy(false);
    return;
  }

  if (message.type === "preview.discard.complete") {
    const result = message.result || {};
    renderPreviewState(null);
    setStatus(result.removedCss ? "Preview discarded and CSS removed." : "Preview discarded.", "success");
    setBusy(false);
    return;
  }

  if (message.type === "remove.complete") {
    const result = message.result || {};
    const text = result.removedCss
      ? "The last injected CSS was removed."
      : "No saved Frameweave CSS was found for this tab.";
    renderPreviewState(null);
    setStatus(text + " Reload the page to undo irreversible page-content changes.", "success");
    setBusy(false);
    return;
  }

  if (message.type === "layout.saved-as-script") {
    const script = message.script || {};
    void refreshUserScriptState();
    setStatus("Saved “" + (script.name || "Frameweave layout") + "” to the local userscript library.", "success");
    setBusy(false);
    return;
  }

  if (message.type === "error") {
    const error = message.error || {};
    setStatus(error.message || "The request failed.", "error");
    setBusy(false);
  }
});

port.onDisconnect.addListener(() => {
  if (busy) {
    setBusy(false);
    setStatus("The popup connection closed before the operation completed.", "error");
  }
});

void reloadSettings()
  .then(() => {
    renderSelectedTarget(null);
    renderPreviewState(null);
    renderImpact(null);
    setStatus("Ready. Open a normal web page, then describe the change you want.", "idle");
    post({ type: "get-active-state" });
    return refreshUserScriptState();
  })
  .catch((error) => {
    setStatus("Could not load local settings: " + String(error.message || error), "error");
  });
