import {
  clearBackendToken,
  clearProviderApiKey,
  getPublicSettings,
  getProviderConnection,
  normalizeProviderBaseUrl,
  PROVIDER_PRESETS,
  requestBackendHostPermission,
  saveSettingsPatch,
  setBackendToken,
  setProviderApiKey
} from "./storage.js";
import { listUserScriptSummaries } from "./userscriptStore.js";
import { getUserScriptsAvailability } from "./userscriptRuntime.js";
import { fetchProviderModels } from "./providerModels.js";

const elements = {
  settingsForm: document.querySelector("#settings-form"),
  routeMode: document.querySelectorAll('input[name="routeMode"]'),
  byokSettings: document.querySelector("#byok-settings"),
  backendSettings: document.querySelector("#backend-settings"),
  provider: document.querySelector("#provider"),
  providerBaseUrl: document.querySelector("#provider-base-url"),
  model: document.querySelector("#model"),
  modelChooser: document.querySelector("#model-chooser"),
  selectedModelLabel: document.querySelector("#selected-model-label"),
  changeModel: document.querySelector("#change-model"),
  manualModel: document.querySelector("#manual-model"),
  useModelId: document.querySelector("#use-model-id"),
  pageTab: document.querySelector("#page-tab"),
  refreshPages: document.querySelector("#refresh-pages"),
  cancelGeneration: document.querySelector("#cancel-generation"),
  applySavedResult: document.querySelector("#apply-saved-result"),
  modelSearch: document.querySelector("#model-search"),
  modelResultsStatus: document.querySelector("#model-results-status"),
  providerModels: document.querySelector("#provider-models"),
  refreshModels: document.querySelector("#refresh-models"),
  modelStatus: document.querySelector("#model-status"),
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
let modelRequest = 0;
let modelTimer = null;
let modelController = null;
let modelsLoading = false;
let availableModels = [];
let chooserOpen = false;
let targetTabId = null;
let remoteBusy = false;
let canCancel = false;

function renderModelSummary() {
  const id = elements.model.value.trim();
  const name = availableModels.find(model => model.id === id)?.name;
  elements.selectedModelLabel.textContent = name && name !== id ? name + " · " + id : id || "No model selected";
  elements.changeModel.textContent = chooserOpen ? "Done" : id ? "Change model" : "Choose model";
}

function setChooserOpen(open) {
  chooserOpen = open;
  elements.modelChooser.classList.toggle("is-hidden", !open);
  elements.changeModel.setAttribute("aria-expanded", String(open));
  renderModelSummary();
}

function openModelChooser() {
  setChooserOpen(true);
  if (!availableModels.length && !modelsLoading) scheduleModelFetch(0);
  elements.modelSearch.focus();
}

function renderModels() {
  const words = elements.modelSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = availableModels.filter(model => words.every(word => (model.id + " " + model.name).toLowerCase().includes(word)));
  elements.providerModels.replaceChildren(...matching.map(model => {
    const row = document.createElement("button");
    row.type = "button";
    row.value = model.id;
    row.className = "model-choice";
    row.setAttribute("aria-pressed", String(elements.model.value === model.id));
    const name = document.createElement("span");
    name.className = "model-choice-name";
    name.textContent = model.name;
    const id = document.createElement("span");
    id.className = "model-choice-id";
    id.textContent = model.id;
    row.replaceChildren(name, id);
    row.addEventListener("click", () => {
      elements.model.value = model.id;
      renderModels();
      setChooserOpen(false);
      refreshActionAvailability();
    });
    return row;
  }));
  renderModelSummary();
  elements.modelResultsStatus.textContent = matching.length
    ? matching.length + " of " + availableModels.length + " models shown"
    : words.length ? "No models match your search." : "No models loaded yet.";
}

elements.provider.replaceChildren(...Object.entries(PROVIDER_PRESETS).map(([id, preset]) => {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = preset.label;
  return option;
}));

function cancelModelFetch() {
  modelRequest += 1;
  clearTimeout(modelTimer);
  modelController?.abort();
  modelController = null;
  modelsLoading = false;
}

function scheduleModelFetch(delay = 400) {
  cancelModelFetch();
  availableModels = [];
  renderModels();
  refreshActionAvailability();
  if (!publicSettings || selectedRoute() !== "byok") return;
  const provider = elements.provider.value;
  if (!elements.providerBaseUrl.value.trim() && !PROVIDER_PRESETS[provider]?.baseUrl) {
    elements.modelStatus.textContent = "Enter your provider URL to load models, or enter a model ID manually.";
    return;
  }
  if (!elements.apiKey.value.trim() && !publicSettings.providerKeyPresent[provider] && !PROVIDER_PRESETS[provider]?.keyOptional) {
    elements.modelStatus.textContent = "Paste your API key to load current models. A model is required to save.";
    return;
  }
  const request = modelRequest;
  elements.modelStatus.textContent = "Preparing to fetch models…";
  modelTimer = setTimeout(() => { void loadModels(request); }, delay);
}

async function loadModels(request) {
  const provider = elements.provider.value;
  const baseUrl = elements.providerBaseUrl.value;
  const typedKey = elements.apiKey.value.trim();
  const controller = new AbortController();
  modelController = controller;
  modelsLoading = true;
  refreshActionAvailability();
  elements.modelStatus.textContent = "Fetching current models…";
  try {
    const saved = await getProviderConnection(provider);
    if (request !== modelRequest) return;
    const destination = normalizeProviderBaseUrl(baseUrl, provider);
    if (!typedKey && saved.apiKey && (!saved.baseUrl || new URL(destination).origin !== new URL(saved.baseUrl).origin)) {
      throw new Error("Paste an API key for the new provider URL before fetching models. Saved keys are not sent to a different origin.");
    }
    const models = await fetchProviderModels({ provider, baseUrl, apiKey: typedKey || saved.apiKey, signal: controller.signal });
    if (request !== modelRequest) return;
    availableModels = models;
    renderModels();
    elements.modelStatus.textContent = models.length
      ? models.length + " text model(s) loaded. Select one below or type an ID."
      : "No compatible text models were listed. Check the key permissions or enter a model ID manually.";
  } catch (error) {
    if (request === modelRequest) elements.modelStatus.textContent = error.message || "Could not fetch models. Enter a model ID manually.";
  } finally {
    if (request === modelRequest) {
      modelsLoading = false;
      modelController = null;
      refreshActionAvailability();
    }
  }
}

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
  const missingModel = selectedRoute() === "byok" && !elements.model.value.trim();
  elements.save.disabled = busy || missingModel;
  elements.preview.disabled = busy || missingModel;
  elements.apply.disabled = busy || missingModel;
  elements.refreshModels.disabled = busy || modelsLoading;
  elements.pageTab.disabled = busy;
  elements.cancelGeneration.classList.toggle("is-hidden", !(remoteBusy && canCancel));
  elements.changeModel.disabled = busy;
  elements.useModelId.disabled = busy;
  const noPage = !Number.isInteger(targetTabId);
  for (const button of [elements.inspect, elements.preview, elements.apply, elements.pickElement, elements.removeCss]) button.disabled ||= noPage;
  elements.applySavedResult.disabled = busy || noPage;
}

function setBusy(nextBusy) {
  busy = nextBusy;
  refreshActionAvailability();
}

function refreshVisibility() {
  const backend = selectedRoute() === "backend";
  elements.byokSettings.classList.toggle("is-hidden", backend);
  elements.backendSettings.classList.toggle("is-hidden", !backend);
  refreshActionAvailability();
}

function refreshSecretState() {
  const provider = elements.provider.value;
  const keySaved = Boolean(publicSettings && publicSettings.providerKeyPresent[provider]);
  const backendTokenSaved = Boolean(publicSettings && publicSettings.backendTokenPresent);

  elements.providerKeyState.textContent = keySaved
    ? "A key is saved for this provider. Leave the field blank to keep it."
    : PROVIDER_PRESETS[provider]?.keyOptional ? "No key saved. A key is optional for servers that do not require authentication." : "No key is saved for this provider.";
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
  elements.providerBaseUrl.value = settings.baseUrls[settings.provider];
  elements.backendEndpoint.value = settings.backendEndpoint;
  elements.maxNodes.value = String(settings.maxNodes);
  elements.maxDepth.value = String(settings.maxDepth);
  elements.apiKey.value = "";
  elements.backendToken.value = "";
  refreshVisibility();
  refreshSecretState();
  cancelModelFetch();
  availableModels = [];
  setChooserOpen(false);
  renderModels();
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

  if (routeMode === "byok" && !elements.model.value.trim()) {
    throw new Error("Select a model or enter a model ID before saving BYOK settings.");
  }

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
    ...(routeMode === "byok" ? { model: elements.model.value, modelProvider: provider, baseUrl: elements.providerBaseUrl.value } : {}),
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
  elements.providerBaseUrl.value = publicSettings.baseUrls[provider];
  refreshSecretState();
  return publicSettings;
}

function post(message) {
  try {
    port.postMessage({ ...message, ...(Number.isInteger(targetTabId) ? { tabId: targetTabId } : {}) });
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
  elements.providerBaseUrl.value = publicSettings.baseUrls[elements.provider.value] || "";
  elements.apiKey.value = "";
  refreshSecretState();
  setChooserOpen(false);
  elements.modelSearch.value = "";
  scheduleModelFetch(0);
});

for (const input of elements.routeMode) {
  input.addEventListener("change", () => {
    refreshVisibility();
    scheduleModelFetch(0);
  });
}

elements.apiKey.addEventListener("input", () => { if (elements.apiKey.value.trim()) setChooserOpen(true); scheduleModelFetch(); });
elements.apiKey.addEventListener("change", () => { if (elements.apiKey.value.trim()) setChooserOpen(true); scheduleModelFetch(0); });
function providerUrlEdited() {
  cancelModelFetch();
  availableModels = [];
  renderModels();
  elements.modelStatus.textContent = "Provider URL changed. Choose Refresh models when the URL is complete.";
  refreshActionAvailability();
}
elements.providerBaseUrl.addEventListener("input", providerUrlEdited);
elements.providerBaseUrl.addEventListener("change", providerUrlEdited);
elements.modelSearch.addEventListener("input", renderModels);
elements.model.addEventListener("input", () => { renderModels(); refreshActionAvailability(); });
elements.model.addEventListener("change", refreshActionAvailability);
elements.refreshModels.addEventListener("click", () => scheduleModelFetch(0));
elements.changeModel.addEventListener("click", () => chooserOpen ? setChooserOpen(false) : openModelChooser());
elements.useModelId.addEventListener("click", () => {
  if (!elements.model.value.trim()) { elements.model.focus(); return; }
  setChooserOpen(false);
  refreshActionAvailability();
});
elements.pageTab.addEventListener("change", () => {
  targetTabId = elements.pageTab.value ? Number(elements.pageTab.value) : null;
  post({ type: "get-active-state" });
});
elements.refreshPages.addEventListener("click", () => post({ type: "get-active-state" }));
elements.cancelGeneration.addEventListener("click", () => post({ type: "cancel-generation" }));
elements.applySavedResult.addEventListener("click", () => {
  setBusy(true);
  post({ type: "apply-saved-result" });
});
window.addEventListener("pagehide", cancelModelFetch);
window.addEventListener("focus", () => { if (!busy || remoteBusy) post({ type: "get-active-state" }); });

elements.clearProviderKey.addEventListener("click", () => {
  if (busy) {
    return;
  }

  setBusy(true);
  cancelModelFetch();
  elements.apiKey.value = "";
  void clearProviderApiKey(elements.provider.value)
    .then(getPublicSettings)
    .then((settings) => { publicSettings = settings; refreshSecretState(); scheduleModelFetch(0); setStatus("Saved provider key removed.", "success"); })
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.clearBackendToken.addEventListener("click", () => {
  if (busy) {
    return;
  }

  setBusy(true);
  elements.backendToken.value = "";
  void clearBackendToken()
    .then(getPublicSettings)
    .then((settings) => { publicSettings = settings; refreshSecretState(); setStatus("Saved backend token removed.", "success"); })
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

function handleMessage(message, restoring = false) {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "state") {
    remoteBusy = true;
    canCancel = message.phase === "generating" || message.phase === "extracting";
    setBusy(true);
    setStatus(message.message || "Working...", "working");
    return;
  }

  if (message.type === "active-state") {
    targetTabId = message.tabId ?? null;
    elements.pageTab.replaceChildren(...[{ id: "", title: "Choose a web page" }, ...(message.pages || [])].map(page => {
      const option = document.createElement("option");
      option.value = String(page.id);
      option.textContent = page.title + (page.url ? " · " + new URL(page.url).hostname : "");
      return option;
    }));
    elements.pageTab.value = targetTabId === null ? "" : String(targetTabId);
    renderSelectedTarget(message.selectedElement);
    renderImpact(message.impact);
    renderPreviewState(message.deployment);
    remoteBusy = Boolean(message.job?.busy);
    elements.applySavedResult.classList.toggle("is-hidden", !message.job?.hasPending);
    setBusy(remoteBusy);
    if (message.job?.event) handleMessage(message.job.event, true);
    else setStatus(targetTabId === null ? "Choose a target web page to enable the page actions." : "Ready. Describe the change for the selected page.", "idle");
    return;
  }

  if (message.type === "generation.ready") {
    remoteBusy = false;
    elements.applySavedResult.classList.remove("is-hidden");
    setStatus(message.message, "success");
    setBusy(false);
    return;
  }

  remoteBusy = false;
  if (["apply.complete", "preview.complete"].includes(message.type)) elements.applySavedResult.classList.add("is-hidden");

  if (message.type === "picker.selected") {
    renderSelectedTarget(message.selectedElement);
    setBusy(false);
    setStatus("Target selected. Describe the change you want.", "success");
    return;
  }
  if (message.type === "picker.cancelled") {
    setBusy(false);
    setStatus("Element selection cancelled.", "idle");
    return;
  }
  if (message.type === "picker.started") {
    if (restoring) { setStatus(selectedElement ? "Target selected. Describe the change you want." : "Ready. Describe a change or pick an element on the target page.", "idle"); return; }
    setBusy(false);
    setStatus("Tap an element on the target page, then reopen Frameweave. Use Cancel selection on the page to stop.", "success");
    if (!restoring) void chrome.tabs?.getCurrent().then(tab => { if (!tab) window.close(); });
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
    if (!restoring && Object.prototype.hasOwnProperty.call(message, "selectedElement")) {
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
    if (!restoring) renderPreviewState({ mode: "preview", cssInjected: deployment.cssInjected });
    renderImpact(message.impact);
    if (!restoring && Object.prototype.hasOwnProperty.call(message, "selectedElement")) {
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
    if (!restoring) renderPreviewState({ mode: "applied", cssInjected: deployment.cssInjected });
    renderImpact(message.impact);
    if (!restoring && Object.prototype.hasOwnProperty.call(message, "selectedElement")) {
      renderSelectedTarget(message.selectedElement);
    }
    setStatus(cssMessage + "; " + automationMessage + "." + warning, "success");
    setBusy(false);
    return;
  }

  if (message.type === "preview.commit.complete") {
    const automation = message.deployment && message.deployment.automation || {};
    if (!restoring) renderPreviewState({ mode: "applied", cssInjected: message.deployment && message.deployment.cssInjected });
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
    if (error.code === "request_in_progress") { post({ type: "get-active-state" }); return; }
    setStatus(error.message || "The request failed.", "error");
    setBusy(false);
  }
}

port.onMessage.addListener(message => handleMessage(message));

port.onDisconnect.addListener(() => {
  if (busy) {
    setBusy(false);
    setStatus("The connection closed. Reopen Frameweave to reconnect to the background operation.", "error");
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
