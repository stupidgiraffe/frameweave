import { normalizeProviderBaseUrl, PROVIDER_PRESETS } from "./storage.js";

function tokens(value) {
  return (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean);
}

function normalizeModels(body, preset) {
  const entries = Array.isArray(body) ? body : body && body.data;
  if (!Array.isArray(entries)) throw new Error("The provider did not return a supported model list. Enter a model ID manually.");
  const [endpointLabel, endpointPath] = {
    chat: ["chat_completions", "/chat/completions"],
    responses: ["responses", "/responses"],
    anthropic: ["claude_api", "/messages"]
  }[preset.api];
  const models = new Map();
  for (const model of entries.slice(0, 10000)) {
    if (!model || typeof model !== "object" || model.active === false) continue;
    const id = typeof (model.id || model.model_id) === "string" ? (model.id || model.model_id).trim() : "";
    if (!id || id.length > 128 || !/^[A-Za-z0-9._:/@+-]+$/.test(id) || models.has(id)) continue;
    const output = tokens(model.architecture?.output_modalities || model.output_modalities);
    if (output.length && !output.includes("text")) continue;
    const types = tokens(model.types || model.type);
    if (types.length && types.some(type => /embedding|rerank|image|video|speech|audio|moderation|^tts$|^stt$/.test(type)) && !types.includes("llm") && !types.includes("chat")) continue;
    const endpoints = tokens(model.endpoints);
    // Catalogs can advertise protocol labels or versioned HTTP paths.
    if (endpoints.length && !endpoints.some(endpoint => endpoint === endpointLabel ||
        (endpoint.startsWith("/") && endpoint.endsWith(endpointPath)))) continue;
    if (/(^|[/_-])(embedding|embeddings|rerank|whisper|tts|dall-e|moderation|transcribe|transcription|realtime|audio|image|sora)([/_.:-]|$)/i.test(id)) continue;
    const name = model.name || model.display_name || model.model_name || id;
    models.set(id, { id, name: typeof name === "string" ? name.slice(0, 180) : id });
  }
  return [...models.values()];
}

/** Read-only model discovery; never saves credentials or chooses a model for the user. */
export async function fetchProviderModels({ provider, baseUrl, apiKey = "", signal }) {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) throw new Error("Unsupported provider.");
  const base = normalizeProviderBaseUrl(baseUrl, provider);
  if (!base) throw new Error("Enter a provider API base URL before fetching models.");
  if (!apiKey && !preset.keyOptional) throw new Error("Enter an API key to fetch models.");
  const headers = { Accept: "application/json" };
  if (preset.api === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (apiKey) {
    headers.Authorization = "Bearer " + apiKey;
  }
  const endpoint = base === preset.baseUrl && preset.modelsUrl ? preset.modelsUrl : base + "/models";
  const timeout = AbortSignal.timeout(15000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const models = new Map();
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const url = new URL(endpoint);
    if (cursor) url.searchParams.set("after_id", cursor);
    let response;
    try {
      response = await fetch(url.toString(), { headers, signal: requestSignal, redirect: "error", cache: "no-store" });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(timeout.aborted ? "Fetching models timed out. Try Refresh models." : "Could not fetch models. Check the URL, connection, and browser host access, or enter a model ID manually.");
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? "Check the API key and its permissions." : "Try Refresh models or enter a model ID manually.";
      throw new Error("Model list returned HTTP " + response.status + ". " + hint);
    }
    let body;
    try { body = await response.json(); }
    catch { throw new Error("The provider returned an invalid model list. Enter a model ID manually."); }
    for (const model of normalizeModels(body, preset)) if (!models.has(model.id)) models.set(model.id, model);
    if (!body.has_more) return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!body.last_id || body.last_id === cursor) throw new Error("The model catalog returned an invalid pagination cursor. Enter a model ID manually.");
    cursor = body.last_id;
  }
  throw new Error("The model catalog exceeded the page limit. Enter a model ID manually.");
}
