import { normalizeUserScriptInput, userScriptSummary } from "./userscriptMetadata.js";
import { clearAllUserScriptAssets, removeUserScriptAssets } from "./userscriptAssets.js";

const USER_SCRIPTS_KEY = "frameweave.userscripts.v1";
const USER_SCRIPT_VALUES_KEY = "frameweave.userscript-values.v1";
const MAX_VALUE_KEYS_PER_SCRIPT = 256;
const MAX_VALUE_KEY_LENGTH = 180;
const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_NODES = 4000;
let writeQueue = Promise.resolve();

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readRawCollection(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const scripts = [];
  for (const item of raw.slice(0, 500)) {
    try {
      scripts.push(normalizeUserScriptInput(item, item));
    } catch {
      // Invalid local entries are skipped rather than blocking every script.
    }
  }
  return scripts;
}

function normalizeStorageValue(value, depth, state) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Userscript values must be JSON-compatible.");
    }
    if (typeof value === "string" && value.length > 100000) {
      throw new Error("A userscript value exceeds the 100 KB safety limit.");
    }
    state.nodes += 1;
    return value;
  }
  if (depth >= MAX_VALUE_DEPTH || state.nodes >= MAX_VALUE_NODES) {
    throw new Error("Userscript value is too deeply nested or large.");
  }
  if (Array.isArray(value)) {
    state.nodes += 1;
    if (value.length > 1000) {
      throw new Error("Userscript arrays may contain at most 1,000 entries.");
    }
    return value.map((item) => normalizeStorageValue(item, depth + 1, state));
  }
  if (isPlainObject(value)) {
    state.nodes += 1;
    const entries = Object.entries(value);
    if (entries.length > 1000) {
      throw new Error("Userscript objects may contain at most 1,000 fields.");
    }
    const result = {};
    for (const [key, item] of entries) {
      if (key.length > MAX_VALUE_KEY_LENGTH) {
        throw new Error("Userscript object keys may contain at most 180 characters.");
      }
      result[key] = normalizeStorageValue(item, depth + 1, state);
    }
    return result;
  }
  throw new Error("Userscript values must be JSON-compatible.");
}

function normalizeValuesMap(raw) {
  if (!isPlainObject(raw)) {
    return {};
  }
  const result = {};
  for (const [scriptId, values] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(scriptId) || !isPlainObject(values)) {
      continue;
    }
    try {
      result[scriptId] = normalizeStorageValue(values, 0, { nodes: 0 });
    } catch {
      // One corrupt script value namespace must not discard valid others.
    }
  }
  return result;
}

async function readState() {
  const stored = await chrome.storage.local.get([USER_SCRIPTS_KEY, USER_SCRIPT_VALUES_KEY]);
  return {
    scripts: readRawCollection(stored[USER_SCRIPTS_KEY]),
    values: normalizeValuesMap(stored[USER_SCRIPT_VALUES_KEY])
  };
}

async function writeScripts(scripts) {
  await chrome.storage.local.set({ [USER_SCRIPTS_KEY]: scripts });
}

async function writeValues(values) {
  await chrome.storage.local.set({ [USER_SCRIPT_VALUES_KEY]: values });
}

function enqueueWrite(operation) {
  const result = writeQueue.then(operation);
  writeQueue = result.catch(() => {
    // Keep later mutations usable after one failed storage write.
  });
  return result;
}

function sortScripts(scripts) {
  return [...scripts].sort((left, right) => {
    const order = Number(left.order || 0) - Number(right.order || 0);
    if (order) return order;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

export async function listUserScripts() {
  const { scripts } = await readState();
  return sortScripts(scripts);
}

export async function listUserScriptSummaries() {
  return (await listUserScripts()).map(userScriptSummary);
}

export async function getUserScript(scriptId) {
  const id = String(scriptId || "");
  return (await listUserScripts()).find((script) => script.id === id) || null;
}

export async function saveUserScript(input) {
  return enqueueWrite(async () => {
    const state = await readState();
    const requestedId = input && input.id ? String(input.id) : "";
    const existing = state.scripts.find((script) => script.id === requestedId) || null;
    const next = normalizeUserScriptInput(input, existing || undefined);
    const index = state.scripts.findIndex((script) => script.id === next.id);
    const assetDeclarationsChanged = Boolean(existing) && (
      JSON.stringify(existing.requires || []) !== JSON.stringify(next.requires || []) ||
      JSON.stringify(existing.resources || []) !== JSON.stringify(next.resources || [])
    );
    const remoteUpdateChangedSource = Boolean(existing) && next.provenance === "update" && existing.code !== next.code;
    if (index >= 0) {
      state.scripts[index] = next;
    } else {
      if (!Object.prototype.hasOwnProperty.call(input || {}, "order")) {
        const highestOrder = state.scripts.reduce((highest, script) => Math.max(highest, Number(script.order) || 0), -1);
        next.order = highestOrder + 1;
      }
      state.scripts.push(next);
    }
    await writeScripts(state.scripts);
    if (assetDeclarationsChanged || remoteUpdateChangedSource) {
      await removeUserScriptAssets(next.id);
    }
    return next;
  });
}

export async function setUserScriptEnabled(scriptId, enabled) {
  return enqueueWrite(async () => {
    const state = await readState();
    const index = state.scripts.findIndex((script) => script.id === String(scriptId || ""));
    if (index < 0) {
      throw new Error("Userscript not found.");
    }
    const next = normalizeUserScriptInput(
      { ...state.scripts[index], enabled: Boolean(enabled) },
      state.scripts[index]
    );
    state.scripts[index] = next;
    await writeScripts(state.scripts);
    return next;
  });
}

export async function deleteUserScript(scriptId) {
  return enqueueWrite(async () => {
    const id = String(scriptId || "");
    const state = await readState();
    const nextScripts = state.scripts.filter((script) => script.id !== id);
    if (nextScripts.length === state.scripts.length) {
      throw new Error("Userscript not found.");
    }
    delete state.values[id];
    await Promise.all([writeScripts(nextScripts), writeValues(state.values)]);
    await removeUserScriptAssets(id);
  });
}

export async function moveUserScript(scriptId, direction) {
  const offset = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  if (!offset) {
    throw new Error("Userscript move direction must be up or down.");
  }
  return enqueueWrite(async () => {
    const state = await readState();
    const ordered = sortScripts(state.scripts);
    const index = ordered.findIndex((script) => script.id === String(scriptId || ""));
    const targetIndex = index + offset;
    if (index < 0) throw new Error("Userscript not found.");
    if (targetIndex < 0 || targetIndex >= ordered.length) return ordered[index];
    const moved = ordered[index];
    ordered[index] = ordered[targetIndex];
    ordered[targetIndex] = moved;
    const nextById = new Map(ordered.map((script, order) => [script.id, {
      ...script,
      order,
      updatedAt: script.id === moved.id || script.id === ordered[index].id ? Date.now() : script.updatedAt
    }]));
    state.scripts = state.scripts.map((script) => nextById.get(script.id) || script);
    await writeScripts(state.scripts);
    return nextById.get(moved.id);
  });
}

export async function getUserScriptValues(scriptId) {
  const id = String(scriptId || "");
  const { values } = await readState();
  return cloneJson(values[id] || {});
}

export async function getUserScriptValue(scriptId, key, fallback) {
  const name = String(key || "").trim();
  if (!name || name.length > MAX_VALUE_KEY_LENGTH) {
    throw new Error("Userscript value keys must contain 1–180 characters.");
  }
  const values = await getUserScriptValues(scriptId);
  return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
}

export async function setUserScriptValue(scriptId, key, value) {
  const id = String(scriptId || "");
  const name = String(key || "").trim();
  if (!id || !name || name.length > MAX_VALUE_KEY_LENGTH) {
    throw new Error("Userscript value keys must contain 1–180 characters.");
  }
  return enqueueWrite(async () => {
    const state = await readState();
    const bucket = isPlainObject(state.values[id]) ? state.values[id] : {};
    if (!Object.prototype.hasOwnProperty.call(bucket, name) && Object.keys(bucket).length >= MAX_VALUE_KEYS_PER_SCRIPT) {
      throw new Error("Each userscript may store at most 256 values.");
    }
    bucket[name] = normalizeStorageValue(value, 0, { nodes: 0 });
    state.values[id] = bucket;
    await writeValues(state.values);
    return cloneJson(bucket[name]);
  });
}

export async function setUserScriptValueWithChange(scriptId, key, value) {
  const id = String(scriptId || "");
  const name = String(key || "").trim();
  if (!id || !name || name.length > MAX_VALUE_KEY_LENGTH) {
    throw new Error("Userscript value keys must contain 1–180 characters.");
  }
  return enqueueWrite(async () => {
    const state = await readState();
    const bucket = isPlainObject(state.values[id]) ? state.values[id] : {};
    if (!Object.prototype.hasOwnProperty.call(bucket, name) && Object.keys(bucket).length >= MAX_VALUE_KEYS_PER_SCRIPT) {
      throw new Error("Each userscript may store at most 256 values.");
    }
    const hadValue = Object.prototype.hasOwnProperty.call(bucket, name);
    const oldValue = hadValue ? cloneJson(bucket[name]) : undefined;
    bucket[name] = normalizeStorageValue(value, 0, { nodes: 0 });
    state.values[id] = bucket;
    await writeValues(state.values);
    return {
      key: name,
      hadValue,
      oldValue,
      value: cloneJson(bucket[name])
    };
  });
}

export async function deleteUserScriptValue(scriptId, key) {
  const id = String(scriptId || "");
  const name = String(key || "").trim();
  if (!id || !name || name.length > MAX_VALUE_KEY_LENGTH) {
    throw new Error("Userscript value keys must contain 1–180 characters.");
  }
  return enqueueWrite(async () => {
    const state = await readState();
    const bucket = isPlainObject(state.values[id]) ? state.values[id] : null;
    if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, name)) {
      return false;
    }
    delete bucket[name];
    if (Object.keys(bucket).length) {
      state.values[id] = bucket;
    } else {
      delete state.values[id];
    }
    await writeValues(state.values);
    return true;
  });
}

export async function deleteUserScriptValueWithChange(scriptId, key) {
  const id = String(scriptId || "");
  const name = String(key || "").trim();
  if (!id || !name || name.length > MAX_VALUE_KEY_LENGTH) {
    throw new Error("Userscript value keys must contain 1–180 characters.");
  }
  return enqueueWrite(async () => {
    const state = await readState();
    const bucket = isPlainObject(state.values[id]) ? state.values[id] : null;
    if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, name)) {
      return {
        key: name,
        deleted: false,
        hadValue: false,
        oldValue: undefined
      };
    }
    const oldValue = cloneJson(bucket[name]);
    delete bucket[name];
    if (Object.keys(bucket).length) {
      state.values[id] = bucket;
    } else {
      delete state.values[id];
    }
    await writeValues(state.values);
    return {
      key: name,
      deleted: true,
      hadValue: true,
      oldValue
    };
  });
}

export async function listUserScriptValueKeys(scriptId) {
  return Object.keys(await getUserScriptValues(scriptId)).sort((left, right) => left.localeCompare(right));
}

export async function exportUserScripts() {
  const { scripts: rawScripts, values } = await readState();
  const scripts = sortScripts(rawScripts);
  return {
    format: "frameweave-userscripts",
    version: 2,
    exportedAt: new Date().toISOString(),
    scripts: scripts.map((script) => ({
      ...script,
      source: script.source || script.code
    })),
    values: cloneJson(values)
  };
}

export async function importUserScripts(payload, mode) {
  const raw = typeof payload === "string" ? JSON.parse(payload) : payload;
  const candidates = Array.isArray(raw) ? raw : raw && raw.scripts;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 500) {
    throw new Error("Import must contain between 1 and 500 userscripts.");
  }
  const normalized = candidates.map((candidate) => normalizeUserScriptInput(candidate, candidate));
  const importedValues = normalizeValuesMap(raw && raw.values);
  return enqueueWrite(async () => {
    const state = await readState();
    const next = mode === "replace" ? [] : [...state.scripts];
    const nextValues = mode === "replace" ? {} : { ...state.values };
    for (const script of normalized) {
      const index = next.findIndex((entry) => entry.id === script.id);
      if (index >= 0) {
        next[index] = script;
      } else {
        next.push(script);
      }
      if (Object.prototype.hasOwnProperty.call(importedValues, script.id)) {
        nextValues[script.id] = importedValues[script.id];
      }
    }
    await Promise.all([writeScripts(next), writeValues(nextValues)]);
    if (mode === "replace") {
      await clearAllUserScriptAssets();
    }
    return sortScripts(normalized);
  });
}

export async function clearAllUserScripts() {
  return enqueueWrite(async () => {
    await chrome.storage.local.set({
      [USER_SCRIPTS_KEY]: [],
      [USER_SCRIPT_VALUES_KEY]: {}
    });
    await clearAllUserScriptAssets();
  });
}
