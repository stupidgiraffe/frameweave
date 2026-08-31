import {
  deleteUserScriptValueWithChange,
  getUserScript,
  getUserScriptValues,
  listUserScriptValueKeys,
  listUserScripts,
  setUserScriptValueWithChange
} from "./userscriptStore.js";
import { resolveUserScriptAssets } from "./userscriptAssets.js";

const REGISTRATION_PREFIX = "frameweave-script-";
const GM_MESSAGE_TYPE = "frameweave.userscript.gm.v1";
const GM_PORT_PREFIX = "frameweave.userscript.port.v1:";
const OFFSCREEN_CLIPBOARD_MESSAGE = "frameweave.offscreen.clipboard.v1";
const TAB_STATE_PREFIX = "frameweave.userscript.tab-state.v1.";
const MENU_ID_PREFIX = "frameweave-menu-";
let messageBridgeInstalled = false;
const activeXmlHttpRequests = new Map();
const activeUserScriptPorts = new Map();
const userScriptPortMetadata = new WeakMap();
const userScriptMenuCommands = new Map();
let offscreenDocumentPromise = null;

function asErrorMessage(error) {
  return String(error && error.message ? error.message : error || "Unknown error.").slice(0, 700);
}

function isUserScriptsApiPresent() {
  return Boolean(
    globalThis.chrome &&
    chrome.userScripts &&
    typeof chrome.userScripts.getScripts === "function" &&
    typeof chrome.userScripts.register === "function"
  );
}

export function registrationIdFor(scriptId) {
  return REGISTRATION_PREFIX + String(scriptId || "")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 120);
}

export async function getUserScriptsAvailability() {
  if (!isUserScriptsApiPresent()) {
    return {
      available: false,
      reason: "Chrome user scripts are unavailable. Use Chrome 135+ and enable Allow User Scripts in this extension’s Details page."
    };
  }
  try {
    await chrome.userScripts.getScripts();
    return {
      available: true,
      reason: ""
    };
  } catch (error) {
    return {
      available: false,
      reason: "Enable Allow User Scripts in this extension’s Details page, then reload the extension. " + asErrorMessage(error)
    };
  }
}

export function hostPatternsFor(script) {
  const matches = Array.isArray(script && script.matches) ? script.matches : [];
  return [...new Set(matches.filter((value) => typeof value === "string" && value.trim()))];
}

function connectPermissionPattern(connect) {
  const value = String(connect || "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  if (value === "*" || value === "<all_urls>") {
    return "<all_urls>";
  }
  if (/^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol + "//" + url.hostname + "/*";
    } catch {
      return "";
    }
  }
  if (/^\*\.[a-z0-9.-]+$/i.test(value) || /^[a-z0-9.-]+$/i.test(value)) {
    return "*://" + value + "/*";
  }
  return "";
}

export function permissionPatternsFor(script, includeConnects) {
  const patterns = hostPatternsFor(script);
  if (includeConnects && Array.isArray(script && script.connects)) {
    for (const connect of script.connects) {
      const pattern = connectPermissionPattern(connect);
      if (pattern) {
        patterns.push(pattern);
      }
    }
  }
  return [...new Set(patterns)];
}

export async function getScriptHostAccess(script, options) {
  const origins = permissionPatternsFor(script, Boolean(options && options.includeConnects));
  if (!origins.length) {
    return { granted: false, origins: [], missing: [] };
  }
  try {
    const granted = await chrome.permissions.contains({ origins });
    return {
      granted,
      origins,
      missing: granted ? [] : origins
    };
  } catch (error) {
    return {
      granted: false,
      origins,
      missing: origins,
      reason: asErrorMessage(error)
    };
  }
}

function worldIdFor(scriptId) {
  return "frameweave-world-" + String(scriptId || "")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 96);
}

function safeSourceName(value) {
  return String(value || "userscript")
    .replace(/[\r\n\\]/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 96) || "userscript";
}

function normalizeRuntimeAssets(rawAssets) {
  const raw = rawAssets && typeof rawAssets === "object" ? rawAssets : {};
  const requires = Array.isArray(raw.requires)
    ? raw.requires
      .filter((entry) => entry && typeof entry.code === "string")
      .map((entry) => ({
        code: entry.code,
        sourceUrl: typeof entry.sourceUrl === "string" ? entry.sourceUrl : ""
      }))
    : [];
  const resources = raw.resources && typeof raw.resources === "object" && !Array.isArray(raw.resources)
    ? Object.fromEntries(Object.entries(raw.resources)
      .filter(([name, entry]) => /^[A-Za-z0-9_.-]{1,160}$/.test(name) && entry && typeof entry === "object")
      .map(([name, entry]) => [name, {
        text: typeof entry.text === "string" ? entry.text : "",
        url: typeof entry.url === "string" ? entry.url : "",
        contentType: typeof entry.contentType === "string" ? entry.contentType : "",
        sourceUrl: typeof entry.sourceUrl === "string" ? entry.sourceUrl : ""
      }]))
    : {};
  return { requires, resources };
}

function requiredSourceCode(requires) {
  return requires.map((asset, index) => {
    const source = String(asset.sourceUrl || "require-" + (index + 1))
      .replace(/[\r\n]/g, "")
      .slice(0, 1_000);
    return "\n// @require " + source + "\n" + asset.code + "\n//# sourceURL=frameweave-require-" + (index + 1) + ".js\n";
  }).join("\n");
}

/**
 * The code string is intentionally passed only to chrome.userScripts, the MV3
 * API designed for user-provided code. It is never evaluated by extension code.
 */
export function buildUserScriptWrapper(script, initialValues, rawAssets) {
  const id = JSON.stringify(String(script.id));
  const name = JSON.stringify(String(script.name || "Frameweave userscript"));
  const version = JSON.stringify(String(script.version || "1.0.0"));
  const values = JSON.stringify(initialValues && typeof initialValues === "object" ? initialValues : {});
  const assets = normalizeRuntimeAssets(rawAssets);
  const resources = JSON.stringify(assets.resources);
  const dependencies = requiredSourceCode(assets.requires);
  const info = JSON.stringify({
    name: String(script.name || "Frameweave userscript"),
    namespace: String(script.namespace || ""),
    version: String(script.version || "1.0.0"),
    description: String(script.description || ""),
    matches: Array.isArray(script.matches) ? script.matches : [],
    excludeMatches: Array.isArray(script.excludeMatches) ? script.excludeMatches : [],
    runAt: String(script.runAt || "document_idle"),
    downloadURL: String(script.downloadUrl || ""),
    updateURL: String(script.updateUrl || "")
  });
  const portPrefix = JSON.stringify(GM_PORT_PREFIX);
  const sourceName = safeSourceName(script.name) + "-" + safeSourceName(script.id);
  return `;(async () => {
  "use strict";
  const __otScriptId = ${id};
  const __otScriptName = ${name};
  const __otValues = ${values};
  const __otResources = ${resources};
  const __otClone = (value) => {
    if (value === undefined) return undefined;
    try { return structuredClone(value); } catch {}
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  };
  const __otRequest = (operation, payload) => {
    if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      return Promise.reject(new Error("Frameweave GM bridge is unavailable in this execution world."));
    }
    return chrome.runtime.sendMessage({
      type: ${JSON.stringify(GM_MESSAGE_TYPE)},
      scriptId: __otScriptId,
      operation,
      payload: payload || {}
    });
  };
  const __otInstanceId = __otScriptId + ":" + Date.now().toString(36) + ":" + Math.random().toString(36).slice(2, 10);
  const __otPortName = ${portPrefix} + __otScriptId;
  const __otValueListeners = new Map();
  const __otMenuCallbacks = new Map();
  let __otValueListenerId = 0;
  let __otMenuCommandId = 0;
  let __otPort = null;
  const __otHas = (key) => Object.prototype.hasOwnProperty.call(__otValues, String(key));
  const __otNotifyValueListeners = (key, oldValue, newValue, remote) => {
    for (const listener of __otValueListeners.values()) {
      if (listener.key !== key) continue;
      try {
        listener.callback(key, __otClone(oldValue), __otClone(newValue), Boolean(remote));
      } catch (error) {
        console.error("[Frameweave userscript] value listener failed", __otScriptName, error);
      }
    }
  };
  const __otConnect = () => {
    if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.connect !== "function") return;
    try {
      __otPort = chrome.runtime.connect({ name: __otPortName });
      __otPort.onMessage.addListener((message) => {
        if (!message || message.scriptId !== __otScriptId) return;
        if (message.type === "menuCommand") {
          const callback = __otMenuCallbacks.get(Number(message.commandId));
          if (typeof callback === "function") {
            try { callback(message.info && typeof message.info === "object" ? message.info : {}); }
            catch (error) { console.error("[Frameweave userscript] menu command failed", __otScriptName, error); }
          }
          return;
        }
        if (message.type !== "valueChanged" || message.instanceId === __otInstanceId) return;
        const key = typeof message.key === "string" ? message.key : "";
        if (!key) return;
        const oldValue = __otHas(key) ? __otClone(__otValues[key]) : undefined;
        if (message.deleted) delete __otValues[key];
        else __otValues[key] = __otClone(message.value);
        __otNotifyValueListeners(key, oldValue, message.deleted ? undefined : __otValues[key], true);
      });
      __otPort.onDisconnect.addListener(() => { __otPort = null; });
    } catch {
      __otPort = null;
    }
  };
  __otConnect();
  const __otStyle = (css) => {
    const style = document.createElement("style");
    style.textContent = String(css || "");
    (document.head || document.documentElement).append(style);
    return style;
  };
  const __otAddElement = (parentOrTag, tagOrAttributes, maybeAttributes) => {
    let parent;
    let tag;
    let attributes;
    if (typeof parentOrTag === "string") {
      parent = document.head || document.documentElement || document.body;
      tag = parentOrTag;
      attributes = tagOrAttributes;
    } else {
      parent = parentOrTag;
      tag = tagOrAttributes;
      attributes = maybeAttributes;
    }
    if (!parent || typeof parent.append !== "function" || typeof tag !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(tag)) {
      throw new Error("GM_addElement received an invalid parent or tag.");
    }
    const node = document.createElement(tag);
    if (attributes && typeof attributes === "object") {
      for (const [key, value] of Object.entries(attributes)) {
        if (/^on/i.test(key)) continue;
        if (key === "textContent") node.textContent = String(value);
        else if (key === "className") node.className = String(value);
        else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
      }
    }
    parent.append(node);
    return node;
  };
  const GM_info = Object.freeze({
    script: Object.freeze({ ...${info}, uuid: __otScriptId, version: ${version} }),
    scriptHandler: "Frameweave",
    version: "1"
  });
  const GM_getValue = (key, fallback) => {
    return __otHas(key) ? __otClone(__otValues[String(key)]) : fallback;
  };
  const GM_setValue = (key, value) => {
    const normalized = String(key);
    const hadValue = __otHas(normalized);
    const oldValue = hadValue ? __otClone(__otValues[normalized]) : undefined;
    const nextValue = __otClone(value);
    __otValues[normalized] = nextValue;
    return __otRequest("setValue", {
      key: normalized,
      value: nextValue,
      instanceId: __otInstanceId
    }).then((result) => {
      if (!result || !result.ok) throw new Error(result && result.error || "GM_setValue failed");
      const saved = Object.prototype.hasOwnProperty.call(result, "value") ? __otClone(result.value) : nextValue;
      __otValues[normalized] = saved;
      __otNotifyValueListeners(normalized, oldValue, saved, false);
      return saved;
    }).catch((error) => {
      if (hadValue) __otValues[normalized] = oldValue;
      else delete __otValues[normalized];
      throw error;
    });
  };
  const GM_deleteValue = (key) => {
    const normalized = String(key);
    if (!__otHas(normalized)) return Promise.resolve(false);
    const oldValue = __otClone(__otValues[normalized]);
    delete __otValues[normalized];
    return __otRequest("deleteValue", {
      key: normalized,
      instanceId: __otInstanceId
    }).then((result) => {
      if (!result || !result.ok) throw new Error(result && result.error || "GM_deleteValue failed");
      if (result.deleted) __otNotifyValueListeners(normalized, oldValue, undefined, false);
      return Boolean(result.deleted);
    }).catch((error) => {
      __otValues[normalized] = oldValue;
      throw error;
    });
  };
  const GM_listValues = () => {
    return Object.keys(__otValues).sort();
  };
  const GM_addValueChangeListener = (key, callback) => {
    const normalized = String(key);
    if (!normalized || typeof callback !== "function") throw new Error("GM_addValueChangeListener requires a key and callback.");
    const listenerId = ++__otValueListenerId;
    __otValueListeners.set(listenerId, { key: normalized, callback });
    return listenerId;
  };
  const GM_removeValueChangeListener = (listenerId) => {
    return __otValueListeners.delete(Number(listenerId));
  };
  const GM_addStyle = (css) => {
    return __otStyle(css);
  };
  const GM_addElement = (...args) => {
    return __otAddElement(...args);
  };
  const GM_log = (...args) => {
    console.log("[" + __otScriptName + "]", ...args);
  };
  const GM_getResourceText = (resourceName) => {
    const resource = __otResources[String(resourceName || "")];
    if (!resource) throw new Error("GM_getResourceText could not find resource: " + resourceName);
    return resource.text;
  };
  const GM_getResourceURL = (resourceName) => {
    const resource = __otResources[String(resourceName || "")];
    if (!resource) throw new Error("GM_getResourceURL could not find resource: " + resourceName);
    return resource.url;
  };
  const GM_registerMenuCommand = (caption, callback, accessKey) => {
    if (typeof caption !== "string" || !caption.trim() || typeof callback !== "function") {
      throw new Error("GM_registerMenuCommand requires a caption and callback.");
    }
    const commandId = ++__otMenuCommandId;
    __otMenuCallbacks.set(commandId, callback);
    void __otRequest("registerMenuCommand", {
      commandId,
      caption: caption.trim(),
      accessKey: typeof accessKey === "string" ? accessKey.slice(0, 1) : ""
    }).then((result) => {
      if (!result || !result.ok) throw new Error(result && result.error || "GM_registerMenuCommand failed");
    }).catch((error) => {
      __otMenuCallbacks.delete(commandId);
      console.error("[Frameweave userscript] menu registration failed", __otScriptName, error);
    });
    return commandId;
  };
  const GM_unregisterMenuCommand = (commandId) => {
    const normalized = Number(commandId);
    const removed = __otMenuCallbacks.delete(normalized);
    void __otRequest("unregisterMenuCommand", { commandId: normalized }).catch(() => {});
    return removed;
  };
  const GM_getTab = (callback) => {
    const request = __otRequest("getTab", {}).then((result) => {
      if (!result || !result.ok) throw new Error(result && result.error || "GM_getTab failed");
      return result.tab || {};
    });
    if (typeof callback === "function") {
      void request.then(callback);
      return undefined;
    }
    return request;
  };
  const GM_saveTab = (data) => __otRequest("saveTab", { data }).then((result) => {
    if (!result || !result.ok) throw new Error(result && result.error || "GM_saveTab failed");
  });
  const GM_getTabs = (callback) => {
    const request = __otRequest("getTabs", {}).then((result) => {
      if (!result || !result.ok) throw new Error(result && result.error || "GM_getTabs failed");
      return result.tabs || {};
    });
    if (typeof callback === "function") {
      void request.then(callback);
      return undefined;
    }
    return request;
  };
  const GM_closeTab = (tab) => __otRequest("closeTab", {
    tabId: tab && typeof tab === "object" ? tab.id : undefined
  }).then((result) => {
    if (!result || !result.ok) throw new Error(result && result.error || "GM_closeTab failed");
    return Boolean(result.closed);
  });
  const GM_openInTab = (url, options) => {
    return __otRequest("openInTab", {
    url: String(url || ""),
    options: options && typeof options === "object" ? options : { active: true }
    }).then((result) => {
    if (!result || !result.ok) throw new Error(result && result.error || "GM_openInTab failed");
    const tab = result.tab || {};
    return Object.freeze({
      ...tab,
      close: () => GM_closeTab(tab)
    });
    });
  };
  const GM_setClipboard = (text, type) => {
    return __otRequest("setClipboard", {
    text: String(text === undefined || text === null ? "" : text),
    type: String(type || "text/plain")
    }).then((result) => {
    if (!result || !result.ok) throw new Error(result && result.error || "GM_setClipboard failed");
    });
  };
  const GM_notification = (details, ondone) => {
    return __otRequest("notification", {
    details: typeof details === "string" ? details : details && typeof details === "object"
      ? { text: details.text, title: details.title, image: details.image }
      : ""
    }).then((result) => {
    if (!result || !result.ok) throw new Error(result && result.error || "GM_notification failed");
    const callback = typeof ondone === "function" ? ondone : details && typeof details.ondone === "function" ? details.ondone : null;
    if (callback) callback();
    return result.id;
    });
  };
  const GM_download = (details, onload) => {
    const requestDetails = details && typeof details === "object" ? details : { url: details };
    return __otRequest("download", {
      details: {
        url: requestDetails.url,
        name: requestDetails.name,
        saveAs: Boolean(requestDetails.saveAs)
      }
    }).then((result) => {
      if (!result || !result.ok) throw new Error(result && result.error || "GM_download failed");
      const callback = typeof onload === "function" ? onload : typeof requestDetails.onload === "function" ? requestDetails.onload : null;
      if (callback) callback({ id: result.id });
      return result.id;
    });
  };
  const GM_xmlhttpRequest = (details) => {
    const requestId = __otScriptId + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    let settled = false;
    const requestDetails = details && typeof details === "object" ? details : {};
    const payload = {
      method: requestDetails.method,
      url: requestDetails.url,
      headers: requestDetails.headers,
      data: requestDetails.data,
      timeout: requestDetails.timeout,
      responseType: requestDetails.responseType
    };
    const request = __otRequest("xmlHttpRequest", { requestId, details: payload });
    request.then((result) => {
      if (settled) return;
      settled = true;
      if (result && result.ok) {
        if (typeof requestDetails.onload === "function") requestDetails.onload(result.response);
      } else if (typeof requestDetails.onerror === "function") {
        requestDetails.onerror({ error: result && result.error || "GM_xmlhttpRequest failed" });
      }
    }).catch((error) => {
      if (settled) return;
      settled = true;
      if (typeof requestDetails.onerror === "function") requestDetails.onerror({ error: String(error && error.message || error) });
    });
    return {
      abort() {
        if (settled) return;
        settled = true;
        void __otRequest("abortXmlHttpRequest", { requestId }).catch(() => {});
        if (typeof requestDetails.onabort === "function") requestDetails.onabort({});
      }
    };
  };
  const GM = Object.freeze({
    info: GM_info,
    getValue: (key, fallback) => Promise.resolve(GM_getValue(key, fallback)),
    setValue: GM_setValue,
    deleteValue: GM_deleteValue,
    listValues: () => Promise.resolve(GM_listValues()),
    addValueChangeListener: GM_addValueChangeListener,
    removeValueChangeListener: GM_removeValueChangeListener,
    addStyle: GM_addStyle,
    addElement: GM_addElement,
    getResourceText: (name) => Promise.resolve(GM_getResourceText(name)),
    getResourceUrl: (name) => Promise.resolve(GM_getResourceURL(name)),
    getResourceURL: (name) => Promise.resolve(GM_getResourceURL(name)),
    registerMenuCommand: (caption, callback, accessKey) => Promise.resolve(GM_registerMenuCommand(caption, callback, accessKey)),
    unregisterMenuCommand: (commandId) => Promise.resolve(GM_unregisterMenuCommand(commandId)),
    openInTab: GM_openInTab,
    closeTab: GM_closeTab,
    getTab: () => GM_getTab(),
    saveTab: GM_saveTab,
    getTabs: () => GM_getTabs(),
    setClipboard: GM_setClipboard,
    notification: GM_notification,
    download: GM_download,
    xmlHttpRequest: (details) => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...details,
        onload: resolve,
        onerror: (error) => reject(new Error(error && error.error || "GM.xmlHttpRequest failed"))
      });
    }),
    log: GM_log
  });
  const unsafeWindow = window;
  try {
${dependencies}
${String(script.code || "")}
  } catch (error) {
    console.error("[Frameweave userscript]", __otScriptName, error);
    void __otRequest("scriptError", {
      message: String(error && error.message || error || "Unknown userscript error").slice(0, 500)
    }).catch(() => {});
  }
})();
//# sourceURL=frameweave-user-script-${sourceName}.js`;
}

export function registrationForUserScript(script, values, assets) {
  const registration = {
    id: registrationIdFor(script.id),
    matches: hostPatternsFor(script),
    js: [{ code: buildUserScriptWrapper(script, values, assets) }],
    runAt: script.runAt || "document_idle",
    allFrames: Boolean(script.allFrames),
    world: script.world === "MAIN" ? "MAIN" : "USER_SCRIPT"
  };
  if (registration.world === "USER_SCRIPT") {
    registration.worldId = worldIdFor(script.id);
  }
  if (Array.isArray(script.excludeMatches) && script.excludeMatches.length) {
    registration.excludeMatches = script.excludeMatches;
  }
  if (Array.isArray(script.includeGlobs) && script.includeGlobs.length) {
    registration.includeGlobs = script.includeGlobs;
  }
  if (Array.isArray(script.excludeGlobs) && script.excludeGlobs.length) {
    registration.excludeGlobs = script.excludeGlobs;
  }
  return registration;
}

async function configureUserScriptWorld(script) {
  if (script && script.world === "MAIN") {
    return;
  }
  if (typeof chrome.userScripts.configureWorld !== "function") {
    throw new Error("Chrome User Scripts world configuration is unavailable.");
  }
  await chrome.userScripts.configureWorld({
    messaging: true,
    worldId: worldIdFor(script && script.id)
  });
}

async function clearFrameweaveRegistrations() {
  const existing = await chrome.userScripts.getScripts();
  const ids = existing
    .map((entry) => entry && entry.id)
    .filter((id) => typeof id === "string" && id.startsWith(REGISTRATION_PREFIX));
  if (ids.length) {
    await chrome.userScripts.unregister({ ids });
  }
  return ids.length;
}

async function clearFrameweaveWorldConfigurations() {
  if (
    typeof chrome.userScripts.getWorldConfigurations !== "function" ||
    typeof chrome.userScripts.resetWorldConfiguration !== "function"
  ) {
    return 0;
  }
  const configurations = await chrome.userScripts.getWorldConfigurations();
  const ids = configurations
    .map((entry) => entry && entry.worldId)
    .filter((worldId) => typeof worldId === "string" && worldId.startsWith("frameweave-world-"));
  await Promise.all(ids.map((worldId) => chrome.userScripts.resetWorldConfiguration(worldId)));
  return ids.length;
}

export async function syncUserScripts() {
  const availability = await getUserScriptsAvailability();
  const scripts = await listUserScripts();
  if (!availability.available) {
    return {
      ...availability,
      registered: 0,
      removed: 0,
      skipped: scripts.filter((script) => script.enabled !== false).map((script) => ({
        id: script.id,
        name: script.name,
        reason: availability.reason
      })),
      failed: []
    };
  }

  try {
    const removed = await clearFrameweaveRegistrations();
    await clearFrameweaveWorldConfigurations();
    await clearUserScriptMenus();
    const skipped = [];
    const failed = [];
    let registered = 0;

    for (const script of scripts) {
      if (script.enabled === false) {
        continue;
      }
      const access = await getScriptHostAccess(script);
      if (!access.granted) {
        skipped.push({
          id: script.id,
          name: script.name,
          reason: "Host access has not been granted for " + access.missing.join(", ") + "."
        });
        continue;
      }
      try {
        const assetResult = await resolveUserScriptAssets(script);
        if (!assetResult.ok) {
          failed.push({
            id: script.id,
            name: script.name,
            reason: "Could not resolve @require/@resource assets: " + assetResult.error
          });
          continue;
        }
        const values = await getUserScriptValues(script.id);
        await configureUserScriptWorld(script);
        await chrome.userScripts.register([registrationForUserScript(script, values, assetResult.assets)]);
        registered += 1;
      } catch (error) {
        failed.push({
          id: script.id,
          name: script.name,
          reason: asErrorMessage(error)
        });
      }
    }

    return {
      available: true,
      reason: "",
      registered,
      removed,
      skipped,
      failed
    };
  } catch (error) {
    return {
      available: false,
      reason: asErrorMessage(error),
      registered: 0,
      removed: 0,
      skipped: [],
      failed: []
    };
  }
}

export async function unregisterAllFrameweaveUserScripts() {
  const availability = await getUserScriptsAvailability();
  if (!availability.available) {
    return 0;
  }
  await clearUserScriptMenus();
  return clearFrameweaveRegistrations();
}

export async function clearUserScriptTabStateForTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  const stored = await chrome.storage.session.get(null);
  const suffix = "." + String(tabId);
  const keys = Object.keys(stored).filter((key) => key.startsWith(TAB_STATE_PREFIX) && key.endsWith(suffix));
  if (keys.length) await chrome.storage.session.remove(keys);
}

export async function runUserScriptNow(scriptId, tabId) {
  const availability = await getUserScriptsAvailability();
  if (!availability.available) {
    throw new Error(availability.reason);
  }
  if (typeof chrome.userScripts.execute !== "function") {
    throw new Error("Run now requires Chrome 135 or newer.");
  }
  if (!Number.isInteger(tabId)) {
    throw new Error("An active web tab is required.");
  }
  const script = await getUserScript(scriptId);
  if (!script || script.enabled === false) {
    throw new Error("Enable the userscript before running it.");
  }
  const access = await getScriptHostAccess(script);
  if (!access.granted) {
    throw new Error("Chrome has not enabled this target for user-script execution.");
  }
  const values = await getUserScriptValues(script.id);
  const assetResult = await resolveUserScriptAssets(script);
  if (!assetResult.ok) {
    throw new Error("Could not resolve @require/@resource assets: " + assetResult.error);
  }
  await configureUserScriptWorld(script);
  const injection = {
    target: {
      tabId,
      allFrames: Boolean(script.allFrames)
    },
    js: [{ code: buildUserScriptWrapper(script, values, assetResult.assets) }],
    world: script.world === "MAIN" ? "MAIN" : "USER_SCRIPT",
    injectImmediately: true
  };
  if (injection.world === "USER_SCRIPT") {
    injection.worldId = worldIdFor(script.id);
  }
  return chrome.userScripts.execute(injection);
}

function normalizeXmlHttpRequestDetails(raw) {
  const details = raw && typeof raw === "object" ? raw : {};
  const method = String(details.method || "GET").trim().toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
    throw new Error("GM_xmlhttpRequest method is not supported.");
  }
  const url = new URL(String(details.url || ""));
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("GM_xmlhttpRequest supports only HTTP and HTTPS URLs.");
  }
  const data = details.data === undefined || details.data === null ? "" : String(details.data);
  if (data.length > 1000000) {
    throw new Error("GM_xmlhttpRequest data exceeds the 1 MB safety limit.");
  }
  const rawHeaders = details.headers && typeof details.headers === "object" ? details.headers : {};
  const headers = {};
  const entries = Object.entries(rawHeaders);
  if (entries.length > 30) {
    throw new Error("GM_xmlhttpRequest supports at most 30 request headers.");
  }
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || typeof value !== "string" || value.length > 8000) {
      throw new Error("GM_xmlhttpRequest contains an invalid request header.");
    }
    headers[name] = value;
  }
  const timeout = Number.isInteger(details.timeout) ? Math.max(0, Math.min(120000, details.timeout)) : 30000;
  return {
    method,
    url,
    data,
    headers,
    timeout,
    responseType: details.responseType === "json" ? "json" : "text"
  };
}

function responseHeadersToString(headers) {
  return [...headers.entries()].map(([name, value]) => name + ": " + value).join("\r\n");
}

async function executeXmlHttpRequest(script, requestId, rawDetails) {
  const details = normalizeXmlHttpRequestDetails(rawDetails);
  const origin = details.url.protocol + "//" + details.url.hostname + "/*";
  const hasHostAccess = await chrome.permissions.contains({ origins: [origin] });
  if (!hasHostAccess) {
    throw new Error("Chrome has not enabled network access for " + origin + ".");
  }

  const key = script.id + ":" + String(requestId || "");
  if (!requestId || activeXmlHttpRequests.has(key)) {
    throw new Error("GM_xmlhttpRequest request ID is invalid or already active.");
  }
  const controller = new AbortController();
  activeXmlHttpRequests.set(key, controller);
  let timer = null;
  try {
    if (details.timeout > 0) {
      timer = setTimeout(() => controller.abort("timeout"), details.timeout);
    }
    const response = await fetch(details.url.toString(), {
      method: details.method,
      headers: details.headers,
      body: details.method === "GET" || details.method === "HEAD" ? undefined : details.data,
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal
    });
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 5000000) {
      throw new Error("GM_xmlhttpRequest response exceeds the 5 MB safety limit.");
    }
    const responseText = await response.text();
    if (responseText.length > 5000000) {
      throw new Error("GM_xmlhttpRequest response exceeds the 5 MB safety limit.");
    }
    let responseValue = responseText;
    if (details.responseType === "json") {
      try {
        responseValue = responseText ? JSON.parse(responseText) : null;
      } catch {
        throw new Error("GM_xmlhttpRequest could not parse the JSON response.");
      }
    }
    return {
      finalUrl: response.url,
      readyState: 4,
      status: response.status,
      statusText: response.statusText,
      responseHeaders: responseHeadersToString(response.headers),
      responseText,
      response: responseValue
    };
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "timeout") {
      throw new Error("GM_xmlhttpRequest timed out.");
    }
    if (controller.signal.aborted) {
      throw new Error("GM_xmlhttpRequest was aborted.");
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    activeXmlHttpRequests.delete(key);
  }
}

function abortXmlHttpRequest(scriptId, requestId) {
  const controller = activeXmlHttpRequests.get(String(scriptId) + ":" + String(requestId || ""));
  if (!controller) {
    return false;
  }
  controller.abort("aborted");
  return true;
}

function boundedBridgeText(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function optionalPermissionError(permission) {
  const labels = {
    notifications: "Notifications",
    downloads: "Downloads",
    clipboardWrite: "Clipboard write"
  };
  return (labels[permission] || permission) + " permission has not been granted for this userscript.";
}

async function requireOptionalPermission(permission) {
  const granted = await chrome.permissions.contains({ permissions: [permission] });
  if (!granted) {
    throw new Error(optionalPermissionError(permission));
  }
}

function normalizeHttpUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(label + " must be an absolute HTTP or HTTPS URL.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error(label + " must be an absolute HTTP or HTTPS URL without credentials.");
  }
  return url;
}

async function openUserScriptTab(rawUrl, rawOptions, sender) {
  const url = normalizeHttpUrl(rawUrl, "GM_openInTab URL");
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const sourceTab = sender && sender.tab && typeof sender.tab === "object" ? sender.tab : null;
  const active = options.active !== false && options.openInBackground !== true;
  const createProperties = {
    url: url.toString(),
    active
  };
  if (options.insert !== false && sourceTab && Number.isInteger(sourceTab.index)) {
    createProperties.index = sourceTab.index + 1;
  }
  if (options.setParent === true && sourceTab && Number.isInteger(sourceTab.id)) {
    createProperties.openerTabId = sourceTab.id;
  }
  const tab = await chrome.tabs.create({
    ...createProperties
  });
  return {
    id: Number.isInteger(tab && tab.id) ? tab.id : null
  };
}

async function createUserScriptNotification(script, rawDetails) {
  await requireOptionalPermission("notifications");
  const details = typeof rawDetails === "string"
    ? { text: rawDetails }
    : rawDetails && typeof rawDetails === "object"
      ? rawDetails
      : {};
  const message = boundedBridgeText(details.text, 4000);
  if (!message) {
    throw new Error("GM_notification requires non-empty text.");
  }
  const title = boundedBridgeText(details.title, 256) || script.name || "Frameweave userscript";
  const notificationId = registrationIdFor(script.id) + "-" + Date.now().toString(36);
  const id = await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title,
    message
  });
  return id;
}

function normalizeDownloadRequest(rawDetails) {
  const details = rawDetails && typeof rawDetails === "object" ? rawDetails : {};
  const source = boundedBridgeText(details.url, 1000000);
  if (!source) {
    throw new Error("GM_download requires a URL.");
  }
  if (source.startsWith("data:")) {
    if (!/^data:(?:text\/plain|text\/csv|application\/json|application\/octet-stream)?(?:;charset=[a-z0-9_-]+)?(?:;base64)?,/i.test(source)) {
      throw new Error("GM_download accepts only text, JSON, or binary data URLs.");
    }
  } else {
    normalizeHttpUrl(source, "GM_download URL");
  }
  const requestedName = boundedBridgeText(details.name, 240);
  if (requestedName && (requestedName.split(/[\\/]+/).some((part) => part === "." || part === "..") || /[\u0000-\u001F]/.test(requestedName))) {
    throw new Error("GM_download filename contains an unsafe path segment.");
  }
  return {
    url: source,
    filename: requestedName || undefined,
    saveAs: Boolean(details.saveAs)
  };
}

async function startUserScriptDownload(rawDetails) {
  await requireOptionalPermission("downloads");
  return chrome.downloads.download({
    ...normalizeDownloadRequest(rawDetails),
    conflictAction: "uniquify"
  });
}

async function hasOffscreenClipboardDocument(url) {
  if (typeof chrome.runtime.getContexts !== "function") {
    return false;
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  return contexts.length > 0;
}

async function ensureOffscreenClipboardDocument() {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== "function") {
    throw new Error("This browser does not support the extension clipboard runtime.");
  }
  const url = chrome.runtime.getURL("offscreen.html");
  if (await hasOffscreenClipboardDocument(url)) {
    return;
  }
  if (!offscreenDocumentPromise) {
    offscreenDocumentPromise = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Write text explicitly requested by a locally installed userscript."
    }).catch(async (error) => {
      if (await hasOffscreenClipboardDocument(url)) {
        return;
      }
      throw error;
    }).finally(() => {
      offscreenDocumentPromise = null;
    });
  }
  await offscreenDocumentPromise;
}

async function writeUserScriptClipboard(rawText, rawType) {
  await requireOptionalPermission("clipboardWrite");
  const text = typeof rawText === "string" ? rawText : "";
  if (text.length > 1000000) {
    throw new Error("GM_setClipboard text exceeds the 1 MB safety limit.");
  }
  if (rawType && rawType !== "text/plain") {
    throw new Error("GM_setClipboard supports only text/plain.");
  }
  await ensureOffscreenClipboardDocument();
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: OFFSCREEN_CLIPBOARD_MESSAGE,
        text
      });
      if (response && response.ok) {
        return;
      }
      lastError = new Error(response && response.error || "The clipboard runtime did not acknowledge the request.");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error("The clipboard runtime is unavailable.");
}

function scriptIdFromPort(port) {
  const name = String(port && port.name || "");
  if (!name.startsWith(GM_PORT_PREFIX)) {
    return "";
  }
  const scriptId = name.slice(GM_PORT_PREFIX.length);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(scriptId) ? scriptId : "";
}

function senderTabId(sender) {
  return sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
}

function postToUserScriptPorts(scriptId, message, tabId, frameId) {
  const ports = activeUserScriptPorts.get(scriptId);
  if (!ports || !ports.size) return 0;
  let delivered = 0;
  for (const port of [...ports]) {
    const metadata = userScriptPortMetadata.get(port);
    if (Number.isInteger(tabId) && (!metadata || metadata.tabId !== tabId)) continue;
    if (Number.isInteger(frameId) && (!metadata || metadata.frameId !== frameId)) continue;
    try {
      port.postMessage(message);
      delivered += 1;
    } catch {
      ports.delete(port);
    }
  }
  if (!ports.size) activeUserScriptPorts.delete(scriptId);
  return delivered;
}

function attachUserScriptPort(port) {
  const scriptId = scriptIdFromPort(port);
  if (!scriptId) {
    try {
      port.disconnect();
    } catch {
      // Invalid ports have no observable effect.
    }
    return;
  }
  const ports = activeUserScriptPorts.get(scriptId) || new Set();
  ports.add(port);
  activeUserScriptPorts.set(scriptId, ports);
  userScriptPortMetadata.set(port, {
    tabId: senderTabId(port.sender),
    frameId: Number.isInteger(port.sender && port.sender.frameId) ? port.sender.frameId : 0
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (!ports.size) {
      activeUserScriptPorts.delete(scriptId);
    }
  });
  void getUserScript(scriptId)
    .then((script) => {
      if (!script || script.enabled === false) {
        port.disconnect();
      }
    })
    .catch(() => port.disconnect());
}

function broadcastValueChange(scriptId, change, instanceId) {
  const message = {
    type: "valueChanged",
    scriptId,
    instanceId: boundedBridgeText(instanceId, 160),
    key: change.key,
    value: change.value,
    deleted: Boolean(change.deleted)
  };
  postToUserScriptPorts(scriptId, message);
}

function tabStateKey(scriptId, tabId) {
  return TAB_STATE_PREFIX + scriptId + "." + String(tabId);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

async function getUserScriptTabState(script, sender) {
  const tabId = senderTabId(sender);
  if (!Number.isInteger(tabId)) throw new Error("GM_getTab is available only from a browser tab.");
  const key = tabStateKey(script.id, tabId);
  const stored = await chrome.storage.session.get(key);
  const value = stored[key];
  return value && typeof value === "object" ? cloneJson(value) : {};
}

async function saveUserScriptTabState(script, sender, value) {
  const tabId = senderTabId(sender);
  if (!Number.isInteger(tabId)) throw new Error("GM_saveTab is available only from a browser tab.");
  let data;
  try {
    data = value === undefined ? {} : cloneJson(value);
  } catch {
    throw new Error("GM_saveTab accepts JSON-compatible data only.");
  }
  await chrome.storage.session.set({ [tabStateKey(script.id, tabId)]: data });
}

async function getUserScriptTabs(script) {
  const stored = await chrome.storage.session.get(null);
  const prefix = TAB_STATE_PREFIX + script.id + ".";
  const result = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(prefix) || !value || typeof value !== "object") continue;
    const tabId = key.slice(prefix.length);
    result[tabId] = cloneJson(value);
  }
  return result;
}

async function closeUserScriptTab(sender, requestedTabId) {
  const tabId = Number.isInteger(requestedTabId) ? requestedTabId : senderTabId(sender);
  if (!Number.isInteger(tabId)) throw new Error("GM_closeTab is available only from a browser tab.");
  await chrome.tabs.remove(tabId);
  return true;
}

function menuKey(scriptId, commandId) {
  return scriptId + ":" + String(commandId);
}

function chromeMenuId(scriptId, commandId) {
  return MENU_ID_PREFIX + registrationIdFor(scriptId).slice(REGISTRATION_PREFIX.length) + "-" + String(commandId).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
}

function contextMenuCreate(details) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(details, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function contextMenuRemove(id) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.remove(id, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function registerUserScriptMenuCommand(script, payload) {
  if (!chrome.contextMenus || typeof chrome.contextMenus.create !== "function") {
    throw new Error("This browser does not expose the context menu API.");
  }
  const commandId = Number(payload.commandId);
  const caption = boundedBridgeText(payload.caption, 256);
  if (!Number.isInteger(commandId) || commandId < 1 || commandId > 1_000_000 || !caption) {
    throw new Error("GM_registerMenuCommand received invalid command metadata.");
  }
  const key = menuKey(script.id, commandId);
  const previous = userScriptMenuCommands.get(key);
  if (previous) {
    try {
      await contextMenuRemove(previous.chromeId);
    } catch {
      // A stale menu entry is harmless and must not block a replacement command.
    }
  }
  const chromeId = chromeMenuId(script.id, commandId);
  await contextMenuCreate({
    id: chromeId,
    title: caption,
    contexts: ["all"]
  });
  userScriptMenuCommands.set(key, { scriptId: script.id, commandId, chromeId });
  return commandId;
}

async function unregisterUserScriptMenuCommand(script, payload) {
  const commandId = Number(payload.commandId);
  const key = menuKey(script.id, commandId);
  const entry = userScriptMenuCommands.get(key);
  if (!entry) return false;
  userScriptMenuCommands.delete(key);
  try {
    await contextMenuRemove(entry.chromeId);
  } catch {
    // The menu may have been removed by an extension reload.
  }
  return true;
}

async function clearUserScriptMenus() {
  const entries = [...userScriptMenuCommands.values()];
  userScriptMenuCommands.clear();
  await Promise.all(entries.map((entry) => contextMenuRemove(entry.chromeId).catch(() => {})));
}

function installContextMenuBridge() {
  if (!chrome.contextMenus || !chrome.contextMenus.onClicked || installContextMenuBridge.installed) return;
  installContextMenuBridge.installed = true;
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const entry = [...userScriptMenuCommands.values()].find((candidate) => candidate.chromeId === info.menuItemId);
    if (!entry || !tab || !Number.isInteger(tab.id)) return;
    postToUserScriptPorts(entry.scriptId, {
      type: "menuCommand",
      scriptId: entry.scriptId,
      commandId: entry.commandId,
      info: {
        menuItemId: info.menuItemId,
        pageUrl: info.pageUrl || "",
        frameUrl: info.frameUrl || "",
        linkUrl: info.linkUrl || "",
        srcUrl: info.srcUrl || "",
        selectionText: typeof info.selectionText === "string" ? info.selectionText : "",
        editable: Boolean(info.editable)
      }
    }, tab.id, 0);
  });
}

async function handleUserScriptMessage(message, sender) {
  if (!message || message.type !== GM_MESSAGE_TYPE || typeof message.scriptId !== "string") {
    return { ok: false, error: "Unsupported userscript message." };
  }
  const script = await getUserScript(message.scriptId);
  if (!script || script.enabled === false) {
    return { ok: false, error: "Userscript is not enabled." };
  }
  const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
  switch (message.operation) {
    case "setValue": {
      const change = await setUserScriptValueWithChange(script.id, payload.key, payload.value);
      broadcastValueChange(script.id, change, payload.instanceId);
      return {
        ok: true,
        value: change.value
      };
    }
    case "deleteValue": {
      const change = await deleteUserScriptValueWithChange(script.id, payload.key);
      if (change.deleted) {
        broadcastValueChange(script.id, change, payload.instanceId);
      }
      return {
        ok: true,
        deleted: change.deleted
      };
    }
    case "listValues":
      return {
        ok: true,
        keys: await listUserScriptValueKeys(script.id)
      };
    case "xmlHttpRequest":
      return {
        ok: true,
        response: await executeXmlHttpRequest(script, payload.requestId, payload.details)
      };
    case "abortXmlHttpRequest":
      return {
        ok: true,
        aborted: abortXmlHttpRequest(script.id, payload.requestId)
      };
    case "openInTab":
      return {
        ok: true,
        tab: await openUserScriptTab(payload.url, payload.options, sender)
      };
    case "setClipboard":
      await writeUserScriptClipboard(payload.text, payload.type);
      return { ok: true };
    case "notification":
      return {
        ok: true,
        id: await createUserScriptNotification(script, payload.details)
      };
    case "download":
      return {
        ok: true,
        id: await startUserScriptDownload(payload.details)
      };
    case "registerMenuCommand":
      return {
        ok: true,
        id: await registerUserScriptMenuCommand(script, payload)
      };
    case "unregisterMenuCommand":
      return {
        ok: true,
        removed: await unregisterUserScriptMenuCommand(script, payload)
      };
    case "getTab":
      return {
        ok: true,
        tab: await getUserScriptTabState(script, sender)
      };
    case "saveTab":
      await saveUserScriptTabState(script, sender, payload.data);
      return { ok: true };
    case "getTabs":
      return {
        ok: true,
        tabs: await getUserScriptTabs(script)
      };
    case "closeTab":
      return {
        ok: true,
        closed: await closeUserScriptTab(sender, payload.tabId)
      };
    case "scriptError":
      return { ok: true };
    default:
      return { ok: false, error: "Unsupported GM operation." };
  }
}

export function installUserScriptMessageBridge() {
  if (messageBridgeInstalled || !globalThis.chrome || !chrome.runtime || !chrome.runtime.onUserScriptMessage) {
    return;
  }
  messageBridgeInstalled = true;
  installContextMenuBridge();
  if (chrome.contextMenus && typeof chrome.contextMenus.removeAll === "function") {
    void new Promise((resolve) => chrome.contextMenus.removeAll(() => resolve())).catch(() => {});
  }
  chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
    void handleUserScriptMessage(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: asErrorMessage(error) }));
    return true;
  });
  if (chrome.runtime.onUserScriptConnect) {
    chrome.runtime.onUserScriptConnect.addListener(attachUserScriptPort);
  }
}
