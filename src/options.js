import { generateUserScriptDraft } from "./aiClient.js";
import { extractDomMap } from "./domExtractor.js";
import { getRuntimeSettings } from "./storage.js";
import {
  createUserScriptSource,
  normalizeUserScriptInput
} from "./userscriptMetadata.js";
import {
  deleteUserScript,
  exportUserScripts,
  importUserScripts,
  listUserScripts,
  moveUserScript,
  saveUserScript
} from "./userscriptStore.js";
import { refreshUserScriptAssets } from "./userscriptAssets.js";
import { applyUserScriptUpdate, checkUserScriptUpdate } from "./userscriptUpdates.js";
import {
  getUserScriptsAvailability,
  runUserScriptNow,
  syncUserScripts
} from "./userscriptRuntime.js";

const elements = {
  runtimeCard: document.querySelector("#runtime-card"),
  runtimeTitle: document.querySelector("#runtime-title"),
  runtimeDetail: document.querySelector("#runtime-detail"),
  sync: document.querySelector("#sync-scripts"),
  openPopup: document.querySelector("#open-popup"),
  scriptCount: document.querySelector("#script-count"),
  filter: document.querySelector("#script-filter"),
  list: document.querySelector("#script-list"),
  newScript: document.querySelector("#new-script"),
  importScript: document.querySelector("#import-script"),
  exportScripts: document.querySelector("#export-scripts"),
  updateAll: document.querySelector("#update-all-scripts"),
  installUrl: document.querySelector("#install-url"),
  installUrlButton: document.querySelector("#install-url-button"),
  importFile: document.querySelector("#import-file"),
  form: document.querySelector("#script-form"),
  editorTitle: document.querySelector("#editor-title"),
  editorSubtitle: document.querySelector("#editor-subtitle"),
  enabled: document.querySelector("#script-enabled"),
  name: document.querySelector("#script-name"),
  version: document.querySelector("#script-version"),
  description: document.querySelector("#script-description"),
  runAt: document.querySelector("#script-run-at"),
  world: document.querySelector("#script-world"),
  matches: document.querySelector("#script-matches"),
  excludeMatches: document.querySelector("#script-exclude-matches"),
  includeGlobs: document.querySelector("#script-include-globs"),
  excludeGlobs: document.querySelector("#script-exclude-globs"),
  grants: document.querySelector("#script-grants"),
  connects: document.querySelector("#script-connects"),
  requires: document.querySelector("#script-requires"),
  resources: document.querySelector("#script-resources"),
  updateUrl: document.querySelector("#script-update-url"),
  downloadUrl: document.querySelector("#script-download-url"),
  sourceUrl: document.querySelector("#script-source-url"),
  autoUpdate: document.querySelector("#script-auto-update"),
  allFrames: document.querySelector("#script-all-frames"),
  code: document.querySelector("#script-code"),
  runNow: document.querySelector("#run-now"),
  exportScript: document.querySelector("#export-script"),
  refreshAssets: document.querySelector("#refresh-assets"),
  checkUpdate: document.querySelector("#check-update"),
  moveUp: document.querySelector("#move-script-up"),
  moveDown: document.querySelector("#move-script-down"),
  delete: document.querySelector("#delete-script"),
  aiPageUrl: document.querySelector("#ai-page-url"),
  aiPrompt: document.querySelector("#ai-prompt"),
  generate: document.querySelector("#generate-script"),
  status: document.querySelector("#status")
};

let scripts = [];
let selectedId = null;
let draftBase = null;
let busy = false;

function emptyDraft() {
  return {
    id: "",
    name: "",
    version: "1.0.0",
    description: "",
    matches: ["*://*/*"],
    excludeMatches: [],
    includeGlobs: [],
    excludeGlobs: [],
    grants: [],
    connects: [],
    requires: [],
    resources: [],
    updateUrl: "",
    downloadUrl: "",
    sourceUrl: "",
    checkForUpdates: true,
    runAt: "document_idle",
    world: "USER_SCRIPT",
    allFrames: false,
    enabled: true,
    provenance: "manual",
    code: ""
  };
}

function lines(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function listFromText(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function setStatus(message, kind) {
  elements.status.textContent = message;
  elements.status.className = "status status-" + (kind || "idle");
}

function setBusy(nextBusy) {
  busy = nextBusy;
  for (const element of [
    elements.sync,
    elements.openPopup,
    elements.newScript,
    elements.importScript,
    elements.exportScripts,
    elements.updateAll,
    elements.installUrl,
    elements.installUrlButton,
    elements.enabled,
    elements.name,
    elements.version,
    elements.description,
    elements.runAt,
    elements.world,
    elements.matches,
    elements.excludeMatches,
    elements.includeGlobs,
    elements.excludeGlobs,
    elements.grants,
    elements.connects,
    elements.requires,
    elements.resources,
    elements.updateUrl,
    elements.downloadUrl,
    elements.sourceUrl,
    elements.autoUpdate,
    elements.allFrames,
    elements.code,
    elements.runNow,
    elements.exportScript,
    elements.refreshAssets,
    elements.checkUpdate,
    elements.moveUp,
    elements.moveDown,
    elements.delete,
    elements.aiPageUrl,
    elements.aiPrompt,
    elements.generate
  ]) {
    element.disabled = nextBusy;
  }
  if (!nextBusy) {
    elements.delete.disabled = !selectedId;
    elements.runNow.disabled = !selectedId;
    elements.exportScript.disabled = !selectedId;
    elements.refreshAssets.disabled = !selectedId;
    elements.checkUpdate.disabled = !selectedId;
    elements.moveUp.disabled = !selectedId;
    elements.moveDown.disabled = !selectedId;
  }
}

function renderRuntime(availability, syncResult) {
  elements.runtimeCard.classList.toggle("is-ready", Boolean(availability && availability.available));
  elements.runtimeCard.classList.toggle("is-blocked", Boolean(availability && !availability.available));
  if (!availability || !availability.available) {
    elements.runtimeTitle.textContent = "User Scripts needs one browser setting";
    elements.runtimeDetail.textContent = availability && availability.reason || "Frameweave could not access Chrome User Scripts.";
    return;
  }

  const result = syncResult || {};
  const issues = (result.skipped || []).length + (result.failed || []).length;
  elements.runtimeTitle.textContent = issues
    ? "User Scripts available; " + issues + " script(s) need attention"
    : "User Scripts available";
  elements.runtimeDetail.textContent = syncResult
    ? (result.registered || 0) + " enabled script(s) registered." + (issues ? " Review permissions or errors below." : "")
    : "Enabled scripts register locally and run on their matching sites.";
}

function currentScript() {
  return selectedId ? scripts.find((script) => script.id === selectedId) || null : null;
}

function readDraft() {
  const base = draftBase || currentScript() || emptyDraft();
  return {
    ...base,
    id: base.id || "",
    name: elements.name.value,
    version: elements.version.value,
    description: elements.description.value,
    matches: listFromText(elements.matches.value),
    excludeMatches: listFromText(elements.excludeMatches.value),
    includeGlobs: listFromText(elements.includeGlobs.value),
    excludeGlobs: listFromText(elements.excludeGlobs.value),
    grants: listFromText(elements.grants.value),
    connects: listFromText(elements.connects.value),
    requires: listFromText(elements.requires.value),
    resources: listFromText(elements.resources.value),
    updateUrl: elements.updateUrl.value,
    downloadUrl: elements.downloadUrl.value,
    sourceUrl: elements.sourceUrl.value,
    checkForUpdates: elements.autoUpdate.checked,
    runAt: elements.runAt.value,
    world: elements.world.value,
    allFrames: elements.allFrames.checked,
    enabled: elements.enabled.checked,
    code: elements.code.value,
    source: elements.code.value
  };
}

function loadDraft(script, saved) {
  const draft = script || emptyDraft();
  selectedId = saved ? draft.id : null;
  draftBase = { ...draft };
  elements.editorTitle.textContent = saved ? draft.name : draft.provenance === "ai" ? "AI draft — not saved" : "New userscript";
  elements.editorSubtitle.textContent = saved
    ? "Edit the local source, then save and sync the native registration."
    : "Review all code and match patterns before saving.";
  elements.enabled.checked = draft.enabled !== false;
  elements.name.value = draft.name || "";
  elements.version.value = draft.version || "1.0.0";
  elements.description.value = draft.description || "";
  elements.runAt.value = draft.runAt || "document_idle";
  elements.world.value = draft.world || "USER_SCRIPT";
  elements.matches.value = lines(draft.matches && draft.matches.length ? draft.matches : ["*://*/*"]);
  elements.excludeMatches.value = lines(draft.excludeMatches);
  elements.includeGlobs.value = lines(draft.includeGlobs);
  elements.excludeGlobs.value = lines(draft.excludeGlobs);
  elements.grants.value = lines(draft.grants);
  elements.connects.value = lines(draft.connects);
  elements.requires.value = lines(draft.requires);
  elements.resources.value = Array.isArray(draft.resources)
    ? draft.resources.map((resource) => resource.name + " " + resource.url).join("\n")
    : "";
  elements.updateUrl.value = draft.updateUrl || "";
  elements.downloadUrl.value = draft.downloadUrl || "";
  elements.sourceUrl.value = draft.sourceUrl || "";
  elements.autoUpdate.checked = draft.checkForUpdates !== false;
  elements.allFrames.checked = Boolean(draft.allFrames);
  elements.code.value = draft.code || "";
  renderScriptList();
  setBusy(false);
}

function renderScriptList() {
  const query = elements.filter.value.trim().toLowerCase();
  const filtered = scripts.filter((script) => {
    if (!query) {
      return true;
    }
    return [script.name, script.description, ...(script.matches || [])]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  elements.scriptCount.textContent = scripts.length + " saved · " + scripts.filter((script) => script.enabled !== false).length + " enabled";
  elements.list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = scripts.length ? "No scripts match this filter." : "No local userscripts yet.";
    elements.list.append(empty);
    return;
  }

  for (const script of filtered) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "script-item" + (script.id === selectedId ? " is-active" : "") + (script.enabled === false ? " is-disabled" : "");
    const title = document.createElement("strong");
    title.textContent = script.name;
    const metadata = document.createElement("span");
    const capabilities = [
      script.enabled === false ? "Disabled" : "#" + (Number(script.order) + 1),
      ...(script.matches || []).slice(0, 1),
      script.requires && script.requires.length ? script.requires.length + " require" : "",
      script.updateUrl || script.downloadUrl ? "updates" : ""
    ].filter(Boolean);
    metadata.textContent = capabilities.join(" · ");
    item.append(title, metadata);
    item.addEventListener("click", () => loadDraft(script, true));
    elements.list.append(item);
  }
}

async function refreshLibrary(syncResult) {
  scripts = await listUserScripts();
  renderScriptList();
  renderRuntime(await getUserScriptsAvailability(), syncResult);
}

function syncSummary(result) {
  const failures = (result.failed || []).map((entry) => entry.name + ": " + entry.reason);
  const skipped = (result.skipped || []).map((entry) => entry.name + ": " + entry.reason);
  const details = [...skipped, ...failures];
  return {
    message: (result.registered || 0) + " script(s) registered." + (details.length ? " " + details.slice(0, 2).join(" ") : ""),
    kind: failures.length ? "error" : skipped.length ? "working" : "success"
  };
}

async function saveCurrentScript() {
  const draft = readDraft();
  const candidate = normalizeUserScriptInput(draft, currentScript() || draftBase || undefined);
  const canonicalSource = createUserScriptSource(candidate);
  const saved = await saveUserScript({
    ...candidate,
    source: canonicalSource,
    code: candidate.code
  });
  const syncResult = await syncUserScripts();
  await refreshLibrary(syncResult);
  loadDraft(saved, true);
  const summary = syncSummary(syncResult);
  setStatus("Saved. " + summary.message, summary.kind);
}

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs[0] || !Number.isInteger(tabs[0].id)) {
    throw new Error("Open a normal web page in the active tab first.");
  }
  return tabs[0].id;
}

function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function userscriptFilename(name) {
  const stem = String(name || "frameweave-script")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "frameweave-script";
  return stem + ".user.js";
}

async function loadUserscriptFromUrl() {
  const requestedUrl = elements.installUrl.value.trim();
  if (!requestedUrl) throw new Error("Enter a userscript URL first.");
  const response = await fetch(requestedUrl, {
    method: "GET",
    credentials: "omit",
    redirect: "follow",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok) throw new Error("Script URL returned HTTP " + response.status + ".");
  const source = await response.text();
  const draft = normalizeUserScriptInput({
    source,
    code: source,
    sourceUrl: response.url || requestedUrl,
    downloadUrl: response.url || requestedUrl,
    provenance: "url-import"
  });
  loadDraft(draft, false);
  return draft;
}

async function refreshCurrentAssets() {
  const script = currentScript();
  if (!script) throw new Error("Save the userscript before refreshing its dependencies.");
  const result = await refreshUserScriptAssets(script);
  if (!result.ok) throw new Error(result.error || "Could not refresh userscript assets.");
  const syncResult = await syncUserScripts();
  await refreshLibrary(syncResult);
  loadDraft(scripts.find((entry) => entry.id === script.id) || script, true);
  return { ...result, syncResult };
}

async function checkCurrentUpdate() {
  const script = currentScript();
  if (!script) throw new Error("Save the userscript before checking for updates.");
  const result = await checkUserScriptUpdate(script);
  if (result.script) await saveUserScript(result.script);
  if (result.status !== "available" || !result.candidate) {
    await refreshLibrary();
    return { ...result, updated: false };
  }
  const install = window.confirm(result.message + "\n\nInstall this update now?");
  if (!install) {
    await refreshLibrary();
    return { ...result, updated: false };
  }
  const saved = await saveUserScript(applyUserScriptUpdate(script, result.candidate));
  const syncResult = await syncUserScripts();
  await refreshLibrary(syncResult);
  loadDraft(scripts.find((entry) => entry.id === saved.id) || saved, true);
  return { ...result, updated: true, syncResult };
}

async function updateAllScripts() {
  const snapshot = [...scripts].filter((script) => script.checkForUpdates !== false && (script.updateUrl || script.downloadUrl));
  if (!snapshot.length) {
    return { checked: 0, updated: 0, failed: 0 };
  }
  let checked = 0;
  let updated = 0;
  let failed = 0;
  for (const script of snapshot) {
    const result = await checkUserScriptUpdate(script);
    checked += 1;
    if (result.status === "available" && result.candidate) {
      await saveUserScript(applyUserScriptUpdate(script, result.candidate));
      updated += 1;
    } else if (result.script) {
      await saveUserScript(result.script);
      if (result.status === "error") failed += 1;
    }
  }
  const syncResult = await syncUserScripts();
  await refreshLibrary(syncResult);
  return { checked, updated, failed, syncResult };
}

async function moveCurrentScript(direction) {
  const script = currentScript();
  if (!script) throw new Error("Save the userscript before changing its execution order.");
  const moved = await moveUserScript(script.id, direction);
  const syncResult = await syncUserScripts();
  await refreshLibrary(syncResult);
  loadDraft(scripts.find((entry) => entry.id === moved.id) || moved, true);
  return syncResult;
}

async function collectAiContext(settings) {
  const requestedUrl = elements.aiPageUrl.value.trim();
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  const activeUrl = tab && typeof tab.url === "string" ? tab.url : "";
  const canExtract = Number.isInteger(tab && tab.id) && /^https?:/i.test(activeUrl) && (!requestedUrl || requestedUrl === activeUrl);
  if (!canExtract) return { pageUrl: requestedUrl, domMap: null };
  const domMap = await extractDomMap(tab.id, {
    maxNodes: settings.maxNodes,
    maxDepth: settings.maxDepth,
    allFrames: false
  });
  return { pageUrl: requestedUrl || activeUrl, domMap };
}

elements.filter.addEventListener("input", renderScriptList);

elements.newScript.addEventListener("click", () => loadDraft(emptyDraft(), false));

elements.sync.addEventListener("click", () => {
  if (busy) {
    return;
  }
  setBusy(true);
  setStatus("Synchronizing native userscript registrations…", "working");
  void syncUserScripts()
    .then(async (result) => {
      await refreshLibrary(result);
      const summary = syncSummary(result);
      setStatus(summary.message, summary.kind);
    })
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.openPopup.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) {
    return;
  }
  setBusy(true);
  setStatus("Validating source and synchronizing native registration…", "working");
  void saveCurrentScript()
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.delete.addEventListener("click", () => {
  const script = currentScript();
  if (busy || !script || !window.confirm("Delete “" + script.name + "” and its local GM values?")) {
    return;
  }
  setBusy(true);
  void deleteUserScript(script.id)
    .then(() => syncUserScripts())
    .then(async (result) => {
      await refreshLibrary(result);
      loadDraft(emptyDraft(), false);
      setStatus("Deleted. " + syncSummary(result).message, "success");
    })
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.runNow.addEventListener("click", () => {
  const script = currentScript();
  if (busy || !script) {
    return;
  }
  setBusy(true);
  setStatus("Running the saved userscript in the active tab…", "working");
  void activeTabId()
    .then((tabId) => runUserScriptNow(script.id, tabId))
    .then((results) => {
      const count = Array.isArray(results) ? results.length : 0;
      setStatus("Userscript ran in " + count + " frame(s).", "success");
    })
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.exportScript.addEventListener("click", () => {
  if (busy || !selectedId) return;
  try {
    const candidate = normalizeUserScriptInput(readDraft(), currentScript() || draftBase || undefined);
    const source = createUserScriptSource(candidate);
    downloadText(userscriptFilename(candidate.name), source, "application/javascript");
    setStatus("Userscript source downloaded.", "success");
  } catch (error) {
    setStatus(String(error.message || error), "error");
  }
});

elements.importScript.addEventListener("click", () => elements.importFile.click());

elements.installUrlButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  setStatus("Loading userscript source from the URL…", "working");
  void loadUserscriptFromUrl()
    .then((draft) => setStatus("Loaded “" + draft.name + "” into the editor. Review it, then Save and sync.", "success"))
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.importFile.addEventListener("change", () => {
  const file = elements.importFile.files && elements.importFile.files[0];
  elements.importFile.value = "";
  if (!file || busy) {
    return;
  }
  setBusy(true);
  setStatus("Reading import…", "working");
  void file.text()
    .then(async (text) => {
      const json = file.name.toLowerCase().endsWith(".json") || /^\s*[\[{]/.test(text);
      if (json) {
        const imported = await importUserScripts(text, "merge");
        const result = await syncUserScripts();
        await refreshLibrary(result);
        if (imported[0]) {
          loadDraft(imported[0], true);
        }
        setStatus("Imported " + imported.length + " script(s). " + syncSummary(result).message, "success");
        return;
      }
      const draft = normalizeUserScriptInput({
        source: text,
        code: text,
        provenance: "import"
      });
      loadDraft(draft, false);
      setStatus("Imported into the editor. Review it, then Save and sync.", "success");
    })
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.exportScripts.addEventListener("click", () => {
  if (busy) {
    return;
  }
  setBusy(true);
  void exportUserScripts()
    .then((backup) => {
      const date = new Date().toISOString().slice(0, 10);
      downloadText("frameweave-userscripts-" + date + ".json", JSON.stringify(backup, null, 2), "application/json");
      setStatus("Local script backup downloaded.", "success");
    })
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.updateAll.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  setStatus("Checking configured userscript update URLs…", "working");
  void updateAllScripts()
    .then((result) => {
      setStatus(
        result.checked
          ? "Checked " + result.checked + " script(s); installed " + result.updated + " update(s)" + (result.failed ? "; " + result.failed + " check(s) failed." : ".")
          : "No enabled auto-update sources are configured.",
        result.failed ? "working" : "success"
      );
    })
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.refreshAssets.addEventListener("click", () => {
  if (busy || !currentScript()) return;
  setBusy(true);
  setStatus("Refreshing @require and @resource assets…", "working");
  void refreshCurrentAssets()
    .then((result) => setStatus("Dependencies ready: " + result.fetched + " fetched, " + result.cached + " reused. " + syncSummary(result.syncResult).message, "success"))
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.checkUpdate.addEventListener("click", () => {
  if (busy || !currentScript()) return;
  setBusy(true);
  setStatus("Checking the selected userscript for an update…", "working");
  void checkCurrentUpdate()
    .then((result) => {
      const message = result.updated ? "Update installed. " + syncSummary(result.syncResult).message : result.message;
      setStatus(message, result.status === "error" ? "error" : "success");
    })
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.moveUp.addEventListener("click", () => {
  if (busy || !currentScript()) return;
  setBusy(true);
  void moveCurrentScript("up")
    .then((result) => setStatus("Execution order updated. " + syncSummary(result).message, "success"))
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.moveDown.addEventListener("click", () => {
  if (busy || !currentScript()) return;
  setBusy(true);
  void moveCurrentScript("down")
    .then((result) => setStatus("Execution order updated. " + syncSummary(result).message, "success"))
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

elements.generate.addEventListener("click", () => {
  const prompt = elements.aiPrompt.value.trim();
  if (busy) {
    return;
  }
  if (!prompt) {
    setStatus("Describe the userscript before generating.", "error");
    elements.aiPrompt.focus();
    return;
  }
  setBusy(true);
  setStatus("Preparing a structured BYOK userscript draft…", "working");
  void getRuntimeSettings()
    .then(async (settings) => {
      setStatus("Building a slim structural map for the AI draft…", "working");
      const context = await collectAiContext(settings);
      setStatus("Requesting a structured BYOK userscript draft…", "working");
      return generateUserScriptDraft(settings, {
        prompt,
        pageUrl: context.pageUrl,
        domMap: context.domMap,
        maxOutputTokens: settings.maxOutputTokens
      });
    })
    .then((draft) => {
      const normalized = normalizeUserScriptInput({
        ...draft,
        source: draft.code,
        code: draft.code,
        allFrames: false,
        enabled: true,
        provenance: "ai"
      });
      loadDraft(normalized, false);
      setStatus("AI draft loaded into the editor. Review it before saving or running.", "success");
    })
    .catch((error) => setStatus(String(error.message || error), "error"))
    .finally(() => setBusy(false));
});

void refreshLibrary()
  .then(() => {
    loadDraft(emptyDraft(), false);
    setStatus("Ready. Scripts remain local until you explicitly save and sync.", "idle");
  })
  .catch((error) => setStatus("Could not load the local script library: " + String(error.message || error), "error"));
