const MAX_SOURCE_LENGTH = 2_000_000;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1_200;
const MAX_PATTERN_COUNT = 128;
const MAX_PATTERN_LENGTH = 512;
const MAX_URL_LENGTH = 4_096;
const MAX_REQUIRE_COUNT = 128;
const MAX_RESOURCE_COUNT = 128;

export const USER_SCRIPT_RUN_AT = Object.freeze([
  "document_start",
  "document_end",
  "document_idle"
]);

export const USER_SCRIPT_WORLDS = Object.freeze(["USER_SCRIPT", "MAIN"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function boundedLines(value, maximumCount, maximumLength) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/)
      : [];
  const unique = new Set();
  for (const entry of values) {
    const normalized = boundedString(entry, maximumLength);
    if (normalized) {
      unique.add(normalized);
    }
    if (unique.size >= maximumCount) {
      break;
    }
  }
  return [...unique];
}

function normalizeRunAt(value) {
  switch (boundedString(value, 64).toLowerCase()) {
    case "document-start":
    case "document_start":
      return "document_start";
    case "document-end":
    case "document_end":
    case "document-body":
      return "document_end";
    case "document-idle":
    case "document_idle":
    default:
      return "document_idle";
  }
}

function normalizeWorld(value, grants, injectInto) {
  const world = boundedString(value, 32).toUpperCase();
  if (USER_SCRIPT_WORLDS.includes(world)) {
    return world;
  }
  switch (boundedString(injectInto, 32).toLowerCase()) {
    case "page":
    case "main":
      return "MAIN";
    case "content":
    case "auto":
      return "USER_SCRIPT";
    default:
      return grants.includes("none") ? "MAIN" : "USER_SCRIPT";
  }
}

function normalizeScriptId(value) {
  const id = boundedString(value, 96);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? id : "";
}

function createScriptId() {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return "script_" + random.slice(0, 32);
}

function normalizeOrder(value, fallback) {
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 1_000_000) {
    return numeric;
  }
  const fallbackNumeric = Number(fallback);
  return Number.isSafeInteger(fallbackNumeric) && fallbackNumeric >= 0 && fallbackNumeric <= 1_000_000
    ? fallbackNumeric
    : 0;
}

export function stripUserScriptHeader(source) {
  return String(source || "").replace(
    /^\s*\/\/\s*==UserScript==[\t ]*\r?\n[\s\S]*?^\s*\/\/\s*==\/UserScript==[\t ]*\r?\n?/m,
    ""
  );
}

export function normalizeRemoteUrl(value, label, options) {
  const raw = boundedString(value, MAX_URL_LENGTH);
  const descriptor = label || "URL";
  const allowData = Boolean(options && options.allowData);
  if (!raw) {
    return "";
  }
  if (allowData && /^data:/i.test(raw)) {
    return raw;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(descriptor + " must be an absolute HTTP or HTTPS URL.");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(descriptor + " must use HTTP or HTTPS.");
  }
  return url.toString();
}

export function isValidRemoteUrl(value, options) {
  try {
    return Boolean(normalizeRemoteUrl(value, "URL", options));
  } catch {
    return false;
  }
}

function parseResourceDeclaration(value) {
  const raw = boundedString(value, MAX_URL_LENGTH + 256);
  const match = raw.match(/^([^\s]+)\s+(.+)$/);
  if (!match) {
    throw new Error("@resource entries must use the form: name URL.");
  }
  const name = boundedString(match[1], 160);
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("@resource names may use letters, numbers, periods, underscores, and hyphens only.");
  }
  return {
    name,
    url: normalizeRemoteUrl(match[2], "@resource URL", { allowData: true })
  };
}

function normalizeRequires(value) {
  const requires = boundedLines(value, MAX_REQUIRE_COUNT, MAX_URL_LENGTH);
  return requires.map((url) => normalizeRemoteUrl(url, "@require URL", { allowData: true }));
}

function normalizeResources(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/)
      : [];
  const resources = [];
  const names = new Set();
  for (const entry of raw) {
    if (resources.length >= MAX_RESOURCE_COUNT) {
      break;
    }
    const parsed = isPlainObject(entry)
      ? {
        name: boundedString(entry.name, 160),
        url: normalizeRemoteUrl(entry.url, "@resource URL", { allowData: true })
      }
      : parseResourceDeclaration(entry);
    if (!parsed.name) {
      throw new Error("@resource entries require a name.");
    }
    if (!parsed.url) {
      throw new Error("@resource entries require a URL.");
    }
    if (names.has(parsed.name)) {
      throw new Error("@resource names must be unique: " + parsed.name);
    }
    names.add(parsed.name);
    resources.push(parsed);
  }
  return resources;
}

export function parseUserScriptMetadata(source) {
  if (typeof source !== "string") {
    throw new Error("Userscript source must be a string.");
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error("Userscript source exceeds the 2 MB local runtime limit.");
  }

  const header = source.match(
    /^\s*\/\/\s*==UserScript==[\t ]*\r?\n([\s\S]*?)^\s*\/\/\s*==\/UserScript==[\t ]*(?:\r?\n|$)/m
  );
  const values = {};
  if (header) {
    for (const line of header[1].split(/\r?\n/)) {
      const directive = line.match(/^\s*\/\/\s*@([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/);
      if (!directive) {
        continue;
      }
      const key = directive[1].toLowerCase();
      const value = directive[2].trim();
      if (!values[key]) {
        values[key] = [];
      }
      values[key].push(value);
    }
  }

  const first = (key) => values[key] && values[key][0] || "";
  return {
    headerPresent: Boolean(header),
    metadata: {
      name: first("name"),
      namespace: first("namespace"),
      description: first("description"),
      version: first("version"),
      author: first("author"),
      homepage: first("homepage") || first("homepageurl"),
      supportUrl: first("supporturl"),
      icon: first("icon") || first("iconurl"),
      license: first("license"),
      updateUrl: first("updateurl"),
      downloadUrl: first("downloadurl"),
      matches: values.match || [],
      excludeMatches: values["exclude-match"] || [],
      includeGlobs: values.include || [],
      excludeGlobs: values.exclude || [],
      grants: values.grant || [],
      connects: values.connect || [],
      requires: values.require || [],
      resources: values.resource || [],
      runAt: first("run-at"),
      world: first("frameweave-world"),
      injectInto: first("inject-into"),
      noframes: Object.prototype.hasOwnProperty.call(values, "noframes")
    },
    code: stripUserScriptHeader(source)
  };
}

export function isValidMatchPattern(value) {
  const pattern = boundedString(value, MAX_PATTERN_LENGTH);
  if (pattern === "<all_urls>") {
    return true;
  }
  if (/[?#\s]/.test(pattern)) {
    return false;
  }
  const match = pattern.match(/^(\*|http|https|file|ftp):\/\/([^/]*)(\/.*)$/i);
  if (!match) {
    return false;
  }
  const [, scheme, host, path] = match;
  if (!path || !path.startsWith("/")) {
    return false;
  }
  if (scheme.toLowerCase() === "file") {
    return host === "" || host === "*";
  }
  if (!host) {
    return false;
  }
  if (host === "*") {
    return true;
  }
  if (host.startsWith("*.")) {
    return /^[A-Za-z0-9.-]+$/.test(host.slice(2));
  }
  return /^[A-Za-z0-9.-]+(?::(?:\d+|\*))?$/.test(host);
}

function validatePatterns(patterns, label) {
  for (const pattern of patterns) {
    if (!isValidMatchPattern(pattern)) {
      throw new Error(label + " contains an invalid Chrome match pattern: " + pattern);
    }
  }
  return patterns;
}

function normalizeGlobs(value) {
  return boundedLines(value, MAX_PATTERN_COUNT, MAX_PATTERN_LENGTH)
    .filter((pattern) => !/[\r\n]/.test(pattern));
}

const CANONICAL_GRANT_NAMES = Object.freeze({
  gm_getvalue: "GM_getValue",
  gm_setvalue: "GM_setValue",
  gm_deletevalue: "GM_deleteValue",
  gm_listvalues: "GM_listValues",
  gm_addvaluechangelistener: "GM_addValueChangeListener",
  gm_removevaluechangelistener: "GM_removeValueChangeListener",
  gm_xmlhttprequest: "GM_xmlhttpRequest",
  gm_addstyle: "GM_addStyle",
  gm_addelement: "GM_addElement",
  gm_log: "GM_log",
  gm_openintab: "GM_openInTab",
  gm_closetab: "GM_closeTab",
  gm_gettab: "GM_getTab",
  gm_savetab: "GM_saveTab",
  gm_gettabs: "GM_getTabs",
  gm_setclipboard: "GM_setClipboard",
  gm_notification: "GM_notification",
  gm_download: "GM_download",
  gm_registermenucommand: "GM_registerMenuCommand",
  gm_unregistermenucommand: "GM_unregisterMenuCommand",
  gm_getresourcetext: "GM_getResourceText",
  gm_getresourceurl: "GM_getResourceURL",
  gm_info: "GM_info"
});

export function normalizeUserScriptGrant(value) {
  const grant = boundedString(value, 96);
  const dotted = grant.replace(/^GM\./i, "GM_");
  return CANONICAL_GRANT_NAMES[dotted.toLowerCase()] || dotted;
}

function normalizeGrants(value) {
  return boundedLines(value, 64, 96)
    .map(normalizeUserScriptGrant)
    .filter((grant) => /^[A-Za-z0-9_.-]+$/.test(grant));
}

export function isValidConnectTarget(value) {
  const target = boundedString(value, 256).toLowerCase();
  if (!target || target === "*" || target === "<all_urls>" || target === "self") {
    return Boolean(target);
  }
  if (/^https?:\/\//.test(target)) {
    try {
      const url = new URL(target);
      return /^https?:$/.test(url.protocol) &&
        Boolean(url.hostname) &&
        (url.pathname === "/" || url.pathname === "") &&
        !url.search &&
        !url.hash;
    } catch {
      return false;
    }
  }
  return /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(target);
}

function normalizeConnectTargets(value) {
  const targets = boundedLines(value, 128, 256);
  for (const target of targets) {
    if (!isValidConnectTarget(target)) {
      throw new Error("Connect hosts contains an invalid @connect target: " + target);
    }
  }
  return targets.map((target) => target.toLowerCase());
}

function normalizeSource(input, parsed) {
  const explicit = typeof input.source === "string"
    ? input.source
    : typeof input.code === "string"
      ? input.code
      : "";
  if (explicit.length > MAX_SOURCE_LENGTH) {
    throw new Error("Userscript source exceeds the 2 MB local runtime limit.");
  }
  return parsed ? parsed.code : stripUserScriptHeader(explicit);
}

export function normalizeUserScriptInput(input, existing) {
  const raw = isPlainObject(input) ? input : {};
  const current = isPlainObject(existing) ? existing : {};
  const suppliedSource = typeof raw.source === "string" || typeof raw.code === "string";
  const sourceWithHeader = suppliedSource
    ? (typeof raw.source === "string" ? raw.source : raw.code)
    : (typeof current.source === "string" ? current.source : current.code || "");
  const parsed = parseUserScriptMetadata(sourceWithHeader);
  const meta = parsed.metadata;
  const source = normalizeSource(raw, parsed);
  const explicit = (name, fallback) => Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : fallback;
  const grants = normalizeGrants(explicit("grants", meta.grants.length ? meta.grants : current.grants));
  const rawMatches = boundedLines(explicit("matches", meta.matches.length ? meta.matches : current.matches), MAX_PATTERN_COUNT, MAX_PATTERN_LENGTH);
  const rawIncludes = normalizeGlobs(explicit("includeGlobs", meta.includeGlobs.length ? meta.includeGlobs : current.includeGlobs));
  const matches = rawMatches.length ? rawMatches : (rawIncludes.length ? ["<all_urls>"] : ["*://*/*"]);
  const excludeMatches = boundedLines(
    explicit("excludeMatches", meta.excludeMatches.length ? meta.excludeMatches : current.excludeMatches),
    MAX_PATTERN_COUNT,
    MAX_PATTERN_LENGTH
  );

  validatePatterns(matches, "Matches");
  validatePatterns(excludeMatches, "Exclude matches");
  if (!source.trim()) {
    throw new Error("Userscript code cannot be empty.");
  }

  const now = Date.now();
  const id = normalizeScriptId(raw.id || current.id) || createScriptId();
  const updateUrl = normalizeRemoteUrl(explicit("updateUrl", meta.updateUrl || current.updateUrl), "@updateURL");
  const downloadUrl = normalizeRemoteUrl(explicit("downloadUrl", meta.downloadUrl || current.downloadUrl), "@downloadURL");
  const requires = normalizeRequires(explicit("requires", meta.requires.length ? meta.requires : current.requires));
  const resources = normalizeResources(explicit("resources", meta.resources.length ? meta.resources : current.resources));
  const injectInto = boundedString(explicit("injectInto", meta.injectInto || current.injectInto), 32).toLowerCase();
  const allFrames = Object.prototype.hasOwnProperty.call(raw, "allFrames")
    ? Boolean(raw.allFrames)
    : Object.prototype.hasOwnProperty.call(current, "allFrames") && !suppliedSource
      ? Boolean(current.allFrames)
      : !meta.noframes;

  return {
    schemaVersion: 2,
    id,
    name: boundedString(explicit("name", meta.name || current.name), MAX_NAME_LENGTH) || "Untitled userscript",
    namespace: boundedString(explicit("namespace", meta.namespace || current.namespace), 256),
    version: boundedString(explicit("version", meta.version || current.version), 96) || "1.0.0",
    description: boundedString(explicit("description", meta.description || current.description), MAX_DESCRIPTION_LENGTH),
    author: boundedString(explicit("author", meta.author || current.author), 256),
    homepage: boundedString(explicit("homepage", meta.homepage || current.homepage), MAX_URL_LENGTH),
    supportUrl: boundedString(explicit("supportUrl", meta.supportUrl || current.supportUrl), MAX_URL_LENGTH),
    icon: boundedString(explicit("icon", meta.icon || current.icon), MAX_URL_LENGTH),
    license: boundedString(explicit("license", meta.license || current.license), 160),
    source: sourceWithHeader,
    code: source,
    matches,
    excludeMatches,
    includeGlobs: rawIncludes,
    excludeGlobs: normalizeGlobs(explicit("excludeGlobs", meta.excludeGlobs.length ? meta.excludeGlobs : current.excludeGlobs)),
    grants,
    connects: normalizeConnectTargets(explicit("connects", meta.connects.length ? meta.connects : current.connects)),
    requires,
    resources,
    updateUrl,
    downloadUrl,
    checkForUpdates: Object.prototype.hasOwnProperty.call(raw, "checkForUpdates")
      ? Boolean(raw.checkForUpdates)
      : current.checkForUpdates !== false,
    runAt: normalizeRunAt(explicit("runAt", meta.runAt || current.runAt)),
    injectInto,
    world: normalizeWorld(explicit("world", meta.world || current.world), grants, injectInto),
    allFrames,
    enabled: Object.prototype.hasOwnProperty.call(raw, "enabled") ? Boolean(raw.enabled) : current.enabled !== false,
    order: normalizeOrder(explicit("order", current.order), current.order),
    provenance: boundedString(explicit("provenance", current.provenance), 48) || "manual",
    sourceUrl: normalizeRemoteUrl(explicit("sourceUrl", current.sourceUrl), "Source URL"),
    createdAt: Number.isFinite(current.createdAt) ? current.createdAt : now,
    updatedAt: now,
    lastUpdateCheckAt: Number.isFinite(raw.lastUpdateCheckAt)
      ? raw.lastUpdateCheckAt
      : Number.isFinite(current.lastUpdateCheckAt) ? current.lastUpdateCheckAt : null,
    lastRemoteUpdateAt: Number.isFinite(raw.lastRemoteUpdateAt)
      ? raw.lastRemoteUpdateAt
      : Number.isFinite(current.lastRemoteUpdateAt) ? current.lastRemoteUpdateAt : null,
    lastUpdateError: boundedString(
      Object.prototype.hasOwnProperty.call(raw, "lastUpdateError") ? raw.lastUpdateError : current.lastUpdateError,
      1_000
    )
  };
}

export function createUserScriptSource(script) {
  const normalized = normalizeUserScriptInput(script, script);
  const lines = [
    "// ==UserScript==",
    "// @name         " + normalized.name
  ];
  if (normalized.namespace) lines.push("// @namespace    " + normalized.namespace);
  lines.push("// @version      " + normalized.version);
  if (normalized.description) lines.push("// @description  " + normalized.description);
  if (normalized.author) lines.push("// @author       " + normalized.author);
  if (normalized.homepage) lines.push("// @homepageURL  " + normalized.homepage);
  if (normalized.supportUrl) lines.push("// @supportURL   " + normalized.supportUrl);
  if (normalized.icon) lines.push("// @icon          " + normalized.icon);
  if (normalized.license) lines.push("// @license       " + normalized.license);
  if (normalized.updateUrl) lines.push("// @updateURL    " + normalized.updateUrl);
  if (normalized.downloadUrl) lines.push("// @downloadURL  " + normalized.downloadUrl);
  for (const pattern of normalized.matches) lines.push("// @match        " + pattern);
  for (const pattern of normalized.excludeMatches) lines.push("// @exclude-match " + pattern);
  for (const pattern of normalized.includeGlobs) lines.push("// @include      " + pattern);
  for (const pattern of normalized.excludeGlobs) lines.push("// @exclude      " + pattern);
  for (const url of normalized.requires) lines.push("// @require      " + url);
  for (const resource of normalized.resources) lines.push("// @resource     " + resource.name + " " + resource.url);
  lines.push("// @run-at       " + normalized.runAt.replace(/_/g, "-"));
  if (normalized.injectInto) lines.push("// @inject-into  " + normalized.injectInto);
  lines.push("// @frameweave-world " + normalized.world);
  if (!normalized.allFrames) lines.push("// @noframes");
  for (const grant of normalized.grants.length ? normalized.grants : ["none"]) lines.push("// @grant        " + grant);
  for (const connect of normalized.connects) lines.push("// @connect      " + connect);
  lines.push("// ==/UserScript==", "");
  return lines.join("\n") + stripUserScriptHeader(normalized.code);
}

export function userScriptSummary(script) {
  const value = isPlainObject(script) ? script : {};
  return {
    id: boundedString(value.id, 96),
    name: boundedString(value.name, MAX_NAME_LENGTH),
    description: boundedString(value.description, MAX_DESCRIPTION_LENGTH),
    version: boundedString(value.version, 96),
    enabled: value.enabled !== false,
    matches: Array.isArray(value.matches) ? value.matches.slice(0, MAX_PATTERN_COUNT) : [],
    runAt: USER_SCRIPT_RUN_AT.includes(value.runAt) ? value.runAt : "document_idle",
    world: USER_SCRIPT_WORLDS.includes(value.world) ? value.world : "USER_SCRIPT",
    order: normalizeOrder(value.order, 0),
    requires: Array.isArray(value.requires) ? value.requires.length : 0,
    resources: Array.isArray(value.resources) ? value.resources.length : 0,
    updateUrl: boundedString(value.updateUrl, MAX_URL_LENGTH),
    downloadUrl: boundedString(value.downloadUrl, MAX_URL_LENGTH),
    checkForUpdates: value.checkForUpdates !== false,
    updatedAt: Number(value.updatedAt) || null,
    provenance: boundedString(value.provenance, 48) || "manual"
  };
}
