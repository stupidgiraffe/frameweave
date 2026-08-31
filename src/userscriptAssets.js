import { normalizeRemoteUrl } from "./userscriptMetadata.js";

const USER_SCRIPT_ASSETS_KEY = "frameweave.userscript-assets.v1";
const ASSET_SCHEMA_VERSION = 1;
const MAX_ASSET_BYTES = 4_000_000;
const MAX_TOTAL_ASSET_BYTES = 12_000_000;
const FETCH_TIMEOUT_MS = 60_000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asErrorMessage(error) {
  return String(error && error.message ? error.message : error || "Unknown asset error.").slice(0, 1_000);
}

function byteArrayToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToByteArray(base64) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function inferContentType(value, fallback) {
  const raw = String(value || "").split(";")[0].trim().toLowerCase();
  return raw && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw) ? raw : fallback;
}

function isTextualContentType(contentType) {
  return /^text\//.test(contentType) ||
    /(?:json|javascript|ecmascript|xml|svg|x-www-form-urlencoded)/.test(contentType);
}

function decodeText(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function encodeDataUrl(contentType, base64) {
  return "data:" + (contentType || "application/octet-stream") + ";base64," + base64;
}

function normalizeAssetRecord(raw) {
  if (!isPlainObject(raw) || typeof raw.url !== "string" || typeof raw.base64 !== "string") {
    return null;
  }
  const byteLength = Number(raw.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_ASSET_BYTES) {
    return null;
  }
  const contentType = inferContentType(raw.contentType, "application/octet-stream");
  return {
    url: raw.url,
    finalUrl: typeof raw.finalUrl === "string" ? raw.finalUrl : raw.url,
    contentType,
    base64: raw.base64,
    text: typeof raw.text === "string" ? raw.text : "",
    byteLength,
    checksum: typeof raw.checksum === "string" ? raw.checksum : "",
    fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0
  };
}

function normalizeScriptAssetBundle(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const requires = Array.isArray(raw.requires)
    ? raw.requires.map(normalizeAssetRecord).filter(Boolean)
    : [];
  const resources = Array.isArray(raw.resources)
    ? raw.resources.map((entry) => {
      if (!isPlainObject(entry) || typeof entry.name !== "string") return null;
      const asset = normalizeAssetRecord(entry.asset);
      return asset && /^[A-Za-z0-9_.-]{1,160}$/.test(entry.name)
        ? { name: entry.name, asset }
        : null;
    }).filter(Boolean)
    : [];
  return {
    signature: typeof raw.signature === "string" ? raw.signature : "",
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    requires,
    resources
  };
}

function normalizeAssetState(raw) {
  if (!isPlainObject(raw) || raw.version !== ASSET_SCHEMA_VERSION || !isPlainObject(raw.scripts)) {
    return { version: ASSET_SCHEMA_VERSION, scripts: {} };
  }
  const scripts = {};
  for (const [scriptId, bundle] of Object.entries(raw.scripts)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(scriptId)) continue;
    const normalized = normalizeScriptAssetBundle(bundle);
    if (normalized) scripts[scriptId] = normalized;
  }
  return { version: ASSET_SCHEMA_VERSION, scripts };
}

async function readAssetState() {
  const stored = await chrome.storage.local.get(USER_SCRIPT_ASSETS_KEY);
  return normalizeAssetState(stored[USER_SCRIPT_ASSETS_KEY]);
}

async function writeAssetState(state) {
  await chrome.storage.local.set({ [USER_SCRIPT_ASSETS_KEY]: state });
}

function scriptAssetSignature(script) {
  return JSON.stringify({
    requires: Array.isArray(script && script.requires) ? script.requires : [],
    resources: Array.isArray(script && script.resources) ? script.resources : []
  });
}

async function sha256(bytes) {
  if (!globalThis.crypto || !crypto.subtle) {
    return "";
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return byteArrayToBase64(new Uint8Array(digest));
}

function parseDataUrl(url) {
  const match = String(url || "").match(/^data:([^,]*),(.*)$/is);
  if (!match) {
    throw new Error("Invalid data URL.");
  }
  const metadata = match[1];
  const payload = match[2];
  const isBase64 = /(?:^|;)base64(?:;|$)/i.test(metadata);
  const contentType = inferContentType(metadata.replace(/(?:^|;)base64(?:;|$)/ig, ";"), "text/plain");
  if (isBase64) {
    return { bytes: base64ToByteArray(payload), contentType, finalUrl: url };
  }
  return {
    bytes: new TextEncoder().encode(decodeURIComponent(payload)),
    contentType,
    finalUrl: url
  };
}

async function downloadAsset(url, kind) {
  const normalized = normalizeRemoteUrl(url, kind === "require" ? "@require URL" : "@resource URL", { allowData: true });
  if (/^data:/i.test(normalized)) {
    return parseDataUrl(normalized);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(normalized, {
      method: "GET",
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " while fetching " + normalized + ".");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_BYTES) {
      throw new Error("Asset exceeds the 4 MB runtime asset limit.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new Error("Asset exceeds the 4 MB runtime asset limit.");
    }
    return {
      bytes,
      contentType: inferContentType(response.headers.get("content-type"), kind === "require" ? "text/javascript" : "application/octet-stream"),
      finalUrl: response.url || normalized
    };
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "timeout") {
      throw new Error("Asset download timed out after 60 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAsset(url, kind) {
  const response = await downloadAsset(url, kind);
  const byteLength = response.bytes.byteLength;
  const contentType = response.contentType;
  const text = kind === "require" || isTextualContentType(contentType)
    ? decodeText(response.bytes)
    : "";
  if (kind === "require" && !text.trim()) {
    throw new Error("@require downloaded an empty script.");
  }
  return {
    url,
    finalUrl: response.finalUrl,
    contentType,
    base64: byteArrayToBase64(response.bytes),
    text,
    byteLength,
    checksum: await sha256(response.bytes),
    fetchedAt: Date.now()
  };
}

function existingRequire(bundle, url) {
  return bundle && bundle.requires.find((asset) => asset.url === url) || null;
}

function existingResource(bundle, name, url) {
  return bundle && bundle.resources.find((entry) => entry.name === name && entry.asset.url === url) || null;
}

function runtimeBundle(bundle) {
  const resources = {};
  for (const entry of bundle.resources) {
    resources[entry.name] = {
      url: encodeDataUrl(entry.asset.contentType, entry.asset.base64),
      text: entry.asset.text,
      contentType: entry.asset.contentType,
      sourceUrl: entry.asset.finalUrl
    };
  }
  return {
    requires: bundle.requires.map((asset) => ({
      code: asset.text,
      sourceUrl: asset.finalUrl || asset.url,
      checksum: asset.checksum
    })),
    resources
  };
}

function emptyRuntimeBundle() {
  return { requires: [], resources: {} };
}

export async function getUserScriptAssets(scriptId) {
  const id = String(scriptId || "");
  const state = await readAssetState();
  const bundle = state.scripts[id];
  return bundle ? runtimeBundle(bundle) : emptyRuntimeBundle();
}

export async function getUserScriptAssetSummary(scriptId) {
  const id = String(scriptId || "");
  const state = await readAssetState();
  const bundle = state.scripts[id];
  if (!bundle) {
    return { ready: false, requires: 0, resources: 0, bytes: 0, updatedAt: null };
  }
  const allAssets = [...bundle.requires, ...bundle.resources.map((entry) => entry.asset)];
  return {
    ready: true,
    requires: bundle.requires.length,
    resources: bundle.resources.length,
    bytes: allAssets.reduce((total, asset) => total + asset.byteLength, 0),
    updatedAt: bundle.updatedAt || null
  };
}

export async function resolveUserScriptAssets(script, options) {
  if (!script || typeof script.id !== "string") {
    throw new Error("A saved userscript is required to resolve assets.");
  }
  const force = Boolean(options && options.force);
  const requires = Array.isArray(script.requires) ? script.requires : [];
  const resources = Array.isArray(script.resources) ? script.resources : [];
  if (!requires.length && !resources.length) {
    return { ok: true, fetched: 0, cached: 0, assets: emptyRuntimeBundle() };
  }

  const state = await readAssetState();
  const previous = state.scripts[script.id] || null;
  const next = {
    signature: scriptAssetSignature(script),
    updatedAt: Date.now(),
    requires: [],
    resources: []
  };
  let fetched = 0;
  let cached = 0;
  let totalBytes = 0;

  try {
    for (const url of requires) {
      let asset = !force ? existingRequire(previous, url) : null;
      if (asset) {
        cached += 1;
      } else {
        asset = await fetchAsset(url, "require");
        fetched += 1;
      }
      totalBytes += asset.byteLength;
      if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
        throw new Error("Combined @require and @resource assets exceed the 12 MB runtime limit.");
      }
      next.requires.push(asset);
    }
    for (const resource of resources) {
      let entry = !force ? existingResource(previous, resource.name, resource.url) : null;
      let asset;
      if (entry) {
        asset = entry.asset;
        cached += 1;
      } else {
        asset = await fetchAsset(resource.url, "resource");
        fetched += 1;
      }
      totalBytes += asset.byteLength;
      if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
        throw new Error("Combined @require and @resource assets exceed the 12 MB runtime limit.");
      }
      next.resources.push({ name: resource.name, asset });
    }
  } catch (error) {
    return {
      ok: false,
      fetched,
      cached,
      assets: previous ? runtimeBundle(previous) : emptyRuntimeBundle(),
      error: asErrorMessage(error)
    };
  }

  state.scripts[script.id] = next;
  await writeAssetState(state);
  return {
    ok: true,
    fetched,
    cached,
    assets: runtimeBundle(next)
  };
}

export async function refreshUserScriptAssets(script) {
  return resolveUserScriptAssets(script, { force: true });
}

export async function removeUserScriptAssets(scriptId) {
  const id = String(scriptId || "");
  if (!id) return;
  const state = await readAssetState();
  if (Object.prototype.hasOwnProperty.call(state.scripts, id)) {
    delete state.scripts[id];
    await writeAssetState(state);
  }
}

export async function clearAllUserScriptAssets() {
  await chrome.storage.local.set({
    [USER_SCRIPT_ASSETS_KEY]: {
      version: ASSET_SCHEMA_VERSION,
      scripts: {}
    }
  });
}
