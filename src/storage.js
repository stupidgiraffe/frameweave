const SETTINGS_KEY = "frameweave.settings.v1";
const SECRETS_KEY = "frameweave.secrets.v1";
const IMPACT_KEY = "frameweave.impact.v1";
const PICKED_ELEMENT_PREFIX = "frameweave.picked-element.v1.";

export const PROVIDERS = Object.freeze(["openai", "anthropic", "deepseek"]);
export const ROUTE_MODES = Object.freeze(["byok", "backend"]);

const DEFAULT_MODELS = Object.freeze({
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-5",
  deepseek: "deepseek-chat"
});

export const DEFAULT_SETTINGS = Object.freeze({
  routeMode: "byok",
  provider: "openai",
  models: DEFAULT_MODELS,
  backendEndpoint: "",
  maxNodes: 260,
  maxDepth: 8,
  maxOutputTokens: 3500
});

const DEFAULT_IMPACT = Object.freeze({
  totalPagesModified: 0,
  totalPreviews: 0,
  totalCssInjections: 0,
  totalAutomationActions: 0,
  lastModifiedAt: null
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asTrimmedString(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function isProvider(value) {
  return PROVIDERS.includes(value);
}

function isRouteMode(value) {
  return ROUTE_MODES.includes(value);
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeModelId(value, fallback) {
  const model = asTrimmedString(value, 128);
  if (!model) {
    return fallback;
  }

  if (!/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new Error("Model IDs may use letters, numbers, periods, underscores, colons, slashes, and hyphens only.");
  }

  return model;
}

function normalizeStoredModelId(value, fallback) {
  try {
    return normalizeModelId(value, fallback);
  } catch {
    return fallback;
  }
}

export function normalizeBackendEndpoint(value) {
  const raw = asTrimmedString(value, 1024);
  if (!raw) {
    return "";
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid HTTPS backend URL.");
  }

  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error("Backend routing requires a valid HTTPS URL.");
  }

  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeStoredBackendEndpoint(value) {
  try {
    return normalizeBackendEndpoint(value);
  } catch {
    return "";
  }
}

function normalizeSettings(rawSettings) {
  const raw = isPlainObject(rawSettings) ? rawSettings : {};
  const rawModels = isPlainObject(raw.models) ? raw.models : {};
  const provider = isProvider(raw.provider) ? raw.provider : DEFAULT_SETTINGS.provider;

  return {
    routeMode: isRouteMode(raw.routeMode) ? raw.routeMode : DEFAULT_SETTINGS.routeMode,
    provider,
    models: {
      openai: normalizeStoredModelId(rawModels.openai, DEFAULT_MODELS.openai),
      anthropic: normalizeStoredModelId(rawModels.anthropic, DEFAULT_MODELS.anthropic),
      deepseek: normalizeStoredModelId(rawModels.deepseek, DEFAULT_MODELS.deepseek)
    },
    backendEndpoint: normalizeStoredBackendEndpoint(raw.backendEndpoint),
    maxNodes: clampInteger(raw.maxNodes, 40, 500, DEFAULT_SETTINGS.maxNodes),
    maxDepth: clampInteger(raw.maxDepth, 3, 16, DEFAULT_SETTINGS.maxDepth),
    maxOutputTokens: clampInteger(raw.maxOutputTokens, 512, 8192, DEFAULT_SETTINGS.maxOutputTokens)
  };
}

function normalizeSecrets(rawSecrets) {
  const raw = isPlainObject(rawSecrets) ? rawSecrets : {};
  const rawKeys = isPlainObject(raw.providerKeys) ? raw.providerKeys : {};
  const providerKeys = {};

  for (const provider of PROVIDERS) {
    providerKeys[provider] = asTrimmedString(rawKeys[provider], 4096);
  }

  return {
    providerKeys,
    backendToken: asTrimmedString(raw.backendToken, 4096)
  };
}

function normalizeImpact(rawImpact) {
  const raw = isPlainObject(rawImpact) ? rawImpact : {};
  const count = (value) => clampInteger(value, 0, Number.MAX_SAFE_INTEGER, 0);
  return {
    totalPagesModified: count(raw.totalPagesModified),
    totalPreviews: count(raw.totalPreviews),
    totalCssInjections: count(raw.totalCssInjections),
    totalAutomationActions: count(raw.totalAutomationActions),
    lastModifiedAt: typeof raw.lastModifiedAt === "number" && Number.isFinite(raw.lastModifiedAt)
      ? raw.lastModifiedAt
      : null
  };
}

function normalizePickedElement(rawSelection) {
  if (!isPlainObject(rawSelection)) {
    return null;
  }

  const tag = asTrimmedString(rawSelection.tag, 32).toLowerCase();
  const selector = asTrimmedString(rawSelection.selector, 1200);
  if (!tag || !/^[a-z][a-z0-9-]*$/.test(tag) || !selector) {
    return null;
  }

  const segments = Array.isArray(rawSelection.segments)
    ? rawSelection.segments
      .filter((segment) => typeof segment === "string" && segment.trim() && segment.length <= 240)
      .slice(0, 10)
      .map((segment) => segment.trim())
    : [];
  const stableAttributes = isPlainObject(rawSelection.stableAttributes) ? rawSelection.stableAttributes : {};
  const classes = Array.isArray(stableAttributes.classes)
    ? stableAttributes.classes
      .filter((name) => typeof name === "string" && /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name) && name.length <= 48)
      .slice(0, 3)
    : [];
  const hints = Array.isArray(rawSelection.interactionHints)
    ? rawSelection.interactionHints
      .filter((hint) => typeof hint === "string" && /^[a-z-]+$/.test(hint) && hint.length <= 32)
      .slice(0, 8)
    : [];
  const rawRect = isPlainObject(rawSelection.rect) ? rawSelection.rect : {};
  const coordinate = (value) => Number.isFinite(value) ? Math.round(value) : 0;

  return {
    version: 1,
    tag,
    selector,
    segments,
    inShadowDom: Boolean(rawSelection.inShadowDom),
    shadowRootMode: rawSelection.shadowRootMode === "open" || rawSelection.shadowRootMode === "closed"
      ? rawSelection.shadowRootMode
      : null,
    stableAttributes: {
      id: asTrimmedString(stableAttributes.id, 64),
      classes
    },
    interactionHints: hints,
    rect: {
      top: coordinate(rawRect.top),
      left: coordinate(rawRect.left),
      width: Math.max(0, coordinate(rawRect.width)),
      height: Math.max(0, coordinate(rawRect.height))
    }
  };
}

function pickedElementKey(tabId) {
  return PICKED_ELEMENT_PREFIX + String(tabId);
}

async function readStoredState() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, SECRETS_KEY]);
  return {
    settings: normalizeSettings(stored[SETTINGS_KEY]),
    secrets: normalizeSecrets(stored[SECRETS_KEY])
  };
}

function toPublicSettings(settings, secrets) {
  return {
    routeMode: settings.routeMode,
    provider: settings.provider,
    models: { ...settings.models },
    backendEndpoint: settings.backendEndpoint,
    maxNodes: settings.maxNodes,
    maxDepth: settings.maxDepth,
    maxOutputTokens: settings.maxOutputTokens,
    providerKeyPresent: Object.fromEntries(
      PROVIDERS.map((provider) => [provider, Boolean(secrets.providerKeys[provider])])
    ),
    backendTokenPresent: Boolean(secrets.backendToken)
  };
}

export async function initializeStorage() {
  const { settings, secrets } = await readStoredState();
  const impact = await getImpactSummary();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: settings,
    [SECRETS_KEY]: secrets,
    [IMPACT_KEY]: impact
  });
}

export async function getPublicSettings() {
  const { settings, secrets } = await readStoredState();
  return toPublicSettings(settings, secrets);
}

export async function getRuntimeSettings() {
  const { settings, secrets } = await readStoredState();
  return {
    ...settings,
    model: settings.models[settings.provider],
    apiKey: secrets.providerKeys[settings.provider],
    backendToken: secrets.backendToken
  };
}

export async function getImpactSummary() {
  const stored = await chrome.storage.local.get(IMPACT_KEY);
  return normalizeImpact(stored[IMPACT_KEY]);
}

export async function recordImpact(event) {
  const current = await getImpactSummary();
  const raw = isPlainObject(event) ? event : {};
  const cssInjected = Boolean(raw.cssInjected);
  const automationApplied = clampInteger(raw.automationApplied, 0, 100000, 0);
  const preview = Boolean(raw.preview);
  const committed = Boolean(raw.committed);
  const modified = cssInjected || automationApplied > 0 || committed;
  const next = {
    totalPagesModified: current.totalPagesModified + (modified && !preview ? 1 : 0),
    totalPreviews: current.totalPreviews + (preview ? 1 : 0),
    totalCssInjections: current.totalCssInjections + (cssInjected ? 1 : 0),
    totalAutomationActions: current.totalAutomationActions + automationApplied,
    lastModifiedAt: modified ? Date.now() : current.lastModifiedAt
  };

  await chrome.storage.local.set({ [IMPACT_KEY]: next });
  return next;
}

export async function savePickedElement(tabId, selection) {
  if (!Number.isInteger(tabId)) {
    throw new Error("An active tab is required to save an element selection.");
  }
  const normalized = normalizePickedElement(selection);
  if (!normalized) {
    throw new Error("The selected element metadata is invalid.");
  }

  await chrome.storage.session.set({
    [pickedElementKey(tabId)]: {
      ...normalized,
      selectedAt: Date.now()
    }
  });
  return normalized;
}

export async function getPickedElement(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }
  const key = pickedElementKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return normalizePickedElement(stored[key]);
}

export async function clearPickedElement(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  await chrome.storage.session.remove(pickedElementKey(tabId));
}

export async function saveSettingsPatch(patch) {
  if (!isPlainObject(patch)) {
    throw new Error("Settings must be an object.");
  }

  const { settings, secrets } = await readStoredState();
  const next = {
    ...settings,
    models: { ...settings.models }
  };

  if (Object.prototype.hasOwnProperty.call(patch, "routeMode")) {
    if (!isRouteMode(patch.routeMode)) {
      throw new Error("Unsupported execution route.");
    }
    next.routeMode = patch.routeMode;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "provider")) {
    if (!isProvider(patch.provider)) {
      throw new Error("Unsupported provider.");
    }
    next.provider = patch.provider;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "model")) {
    const modelProvider = isProvider(patch.modelProvider) ? patch.modelProvider : next.provider;
    next.models[modelProvider] = normalizeModelId(patch.model, DEFAULT_MODELS[modelProvider]);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "backendEndpoint")) {
    next.backendEndpoint = normalizeBackendEndpoint(patch.backendEndpoint);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "maxNodes")) {
    next.maxNodes = clampInteger(patch.maxNodes, 40, 500, next.maxNodes);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "maxDepth")) {
    next.maxDepth = clampInteger(patch.maxDepth, 3, 16, next.maxDepth);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "maxOutputTokens")) {
    next.maxOutputTokens = clampInteger(patch.maxOutputTokens, 512, 8192, next.maxOutputTokens);
  }

  await chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(next) });
  return toPublicSettings(normalizeSettings(next), secrets);
}

export async function setProviderApiKey(provider, apiKey) {
  if (!isProvider(provider)) {
    throw new Error("Unsupported provider.");
  }

  const nextKey = asTrimmedString(apiKey, 4096);
  if (nextKey.length < 8) {
    throw new Error("The provider API key is too short.");
  }

  const { secrets } = await readStoredState();
  const nextSecrets = {
    ...secrets,
    providerKeys: {
      ...secrets.providerKeys,
      [provider]: nextKey
    }
  };

  await chrome.storage.local.set({ [SECRETS_KEY]: nextSecrets });
}

export async function clearProviderApiKey(provider) {
  if (!isProvider(provider)) {
    throw new Error("Unsupported provider.");
  }

  const { secrets } = await readStoredState();
  const nextSecrets = {
    ...secrets,
    providerKeys: {
      ...secrets.providerKeys,
      [provider]: ""
    }
  };

  await chrome.storage.local.set({ [SECRETS_KEY]: nextSecrets });
}

export async function setBackendToken(token) {
  const nextToken = asTrimmedString(token, 4096);
  if (nextToken.length < 8) {
    throw new Error("The backend token is too short.");
  }

  const { secrets } = await readStoredState();
  await chrome.storage.local.set({
    [SECRETS_KEY]: {
      ...secrets,
      backendToken: nextToken
    }
  });
}

export async function clearBackendToken() {
  const { secrets } = await readStoredState();
  await chrome.storage.local.set({
    [SECRETS_KEY]: {
      ...secrets,
      backendToken: ""
    }
  });
}

export function backendOriginPattern(endpoint) {
  const normalized = normalizeBackendEndpoint(endpoint);
  if (!normalized) {
    return "";
  }

  const url = new URL(normalized);
  return url.protocol + "//" + url.hostname + "/*";
}

export async function hasBackendHostPermission(endpoint) {
  const origin = backendOriginPattern(endpoint);
  if (!origin) {
    return false;
  }

  return chrome.permissions.contains({ origins: [origin] });
}

export async function requestBackendHostPermission(endpoint) {
  const origin = backendOriginPattern(endpoint);
  if (!origin) {
    throw new Error("Save a valid HTTPS backend endpoint first.");
  }

  const alreadyGranted = await chrome.permissions.contains({ origins: [origin] });
  if (alreadyGranted) {
    return true;
  }

  return chrome.permissions.request({ origins: [origin] });
}
