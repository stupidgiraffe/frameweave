export const LAYOUT_PAYLOAD_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["css", "javascript"],
  properties: {
    css: {
      type: "string",
      description: "CSS only. It must contain no imports, external URLs, or script-like content."
    },
    javascript: {
      type: "string",
      description: "A JSON-serialized, declarative AutomationProgram. It is not executable source code."
    }
  }
});

export const SYSTEM_INSTRUCTIONS = [
  "You are a layout-planning engine for a browser extension.",
  "Return exactly one raw JSON object and no markdown, prose, code fence, or extra field.",
  "The top-level object must have exactly these two string fields: css and javascript.",
  "css must be valid CSS for the supplied document structure. Do not use @import, url(), external assets, browser extensions, or hidden overlays.",
  "javascript is a JSON-serialized AutomationProgram, not arbitrary executable JavaScript source.",
  "The decoded AutomationProgram has exactly this outer shape: {\"version\":1,\"steps\":[...]}.",
  "Allowed step types are addClass, removeClass, toggleClass, setStyle, setAttribute, removeAttribute, setText, setValue, click, focus, scrollIntoView, remove, insert, dispatch, wait, on, and observe.",
  "Each action needs a CSS selector where applicable. Nested actions are allowed only inside on.actions and observe.actions.",
  "For insert, use tag, text, className, attributes, and placement; never provide HTML.",
  "Do not create network requests, navigation, form submission, storage access, clipboard access, authentication flows, data extraction, keylogging, or actions targeting passwords or payment fields.",
  "Only use selectors that can be derived from the structural map. The map intentionally contains no page text or media payload.",
  "If a selected structural target is supplied, prioritize that target. For an open shadow-DOM selector containing >>>, use declarative setStyle or other automation steps because document CSS cannot cross a shadow boundary.",
  "Favor CSS. Keep the automation program small, idempotent, and accessible. Use empty css or an empty steps array if no change is needed.",
  "Example outer response: {\"css\":\"main{max-width:72rem;}\",\"javascript\":\"{\\\"version\\\":1,\\\"steps\\\":[]}\"}."
].join("\n");

const MAX_PROMPT_LENGTH = 3000;
const MAX_DOM_MAP_CHARS = 120000;

export class AIClientError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AIClientError";
    this.code = code;
    this.details = details || {};
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, limit) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, limit);
}

function emitProgress(callback, event) {
  if (typeof callback !== "function") {
    return;
  }
  try {
    callback(event);
  } catch {
    // UI progress is best-effort and must never abort a provider request.
  }
}

function makeProgressReporter(callback) {
  let lastSentAt = 0;
  let lastLength = 0;

  return (phase, receivedLength) => {
    const now = Date.now();
    if (receivedLength === lastLength && now - lastSentAt < 600) {
      return;
    }
    if (now - lastSentAt < 260) {
      return;
    }
    lastSentAt = now;
    lastLength = receivedLength;
    emitProgress(callback, {
      phase,
      receivedLength
    });
  };
}

function sanitizeProviderError(message) {
  return boundedText(message, 1800).replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+)/gi, "[redacted]");
}

async function responseError(response, provider) {
  let detail = "";
  try {
    const body = await response.text();
    detail = sanitizeProviderError(body);
  } catch {
    detail = "";
  }

  const message = provider + " returned HTTP " + response.status + (detail ? ": " + detail : ".");
  return new AIClientError("provider_http_error", message, {
    provider,
    status: response.status
  });
}

async function checkedFetch(url, options, provider) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new AIClientError("request_cancelled", "The generation request was cancelled.");
    }
    throw new AIClientError(
      "network_error",
      "Could not reach " + provider + ". Check the network, key, model ID, and host permission."
    );
  }

  if (!response.ok) {
    throw await responseError(response, provider);
  }
  return response;
}

function isSseResponse(response) {
  return /text\/event-stream/i.test(response.headers.get("content-type") || "");
}

/**
 * Decodes server-sent events without relying on a third-party package.
 */
export async function consumeSse(response, onEvent) {
  if (!response.body) {
    throw new AIClientError("stream_unavailable", "The provider did not return a readable response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatchBlock = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!data) {
      return;
    }
    if (data === "[DONE]") {
      onEvent({ type: "stream.done" });
      return;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      onEvent({
        type: "stream.malformed_event",
        raw: data.slice(0, 500)
      });
      return;
    }
    onEvent(event);
  };

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      dispatchBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode().replace(/\r\n/g, "\n");
  if (buffer.trim()) {
    dispatchBlock(buffer);
  }
}

function ensureExactPayload(value, source) {
  if (!isPlainObject(value)) {
    throw new AIClientError("invalid_payload", source + " did not return a JSON object.");
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "css" || keys[1] !== "javascript") {
    throw new AIClientError(
      "invalid_payload",
      source + " returned an object that does not have exactly css and javascript fields."
    );
  }

  if (typeof value.css !== "string" || typeof value.javascript !== "string") {
    throw new AIClientError("invalid_payload", source + " returned non-string css or javascript fields.");
  }

  if (value.css.length > 100000 || value.javascript.length > 60000) {
    throw new AIClientError("payload_too_large", source + " returned a payload above the extension safety limit.");
  }

  return {
    css: value.css,
    javascript: value.javascript
  };
}

export function parseLayoutPayload(raw, source) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      throw new AIClientError("invalid_payload", source + " returned a code fence instead of raw JSON.");
    }

    try {
      return ensureExactPayload(JSON.parse(trimmed), source);
    } catch (error) {
      if (error instanceof AIClientError) {
        throw error;
      }
      throw new AIClientError("invalid_json", source + " returned invalid JSON: " + boundedText(error.message, 300));
    }
  }

  return ensureExactPayload(raw, source);
}

function validateGenerationInput(input) {
  if (!isPlainObject(input)) {
    throw new AIClientError("invalid_request", "Generation input must be an object.");
  }

  const prompt = boundedText(input.prompt, MAX_PROMPT_LENGTH);
  if (!prompt) {
    throw new AIClientError("missing_prompt", "Describe the layout change before generating.");
  }
  if (!isPlainObject(input.domMap)) {
    throw new AIClientError("missing_dom_map", "A structural page map is required.");
  }

  let serializedMap;
  try {
    serializedMap = JSON.stringify(input.domMap);
  } catch {
    throw new AIClientError("invalid_dom_map", "The page map could not be serialized.");
  }
  if (serializedMap.length > MAX_DOM_MAP_CHARS) {
    throw new AIClientError("dom_map_too_large", "The structural page map exceeded the request safety limit.");
  }

  const rawSelectedElement = isPlainObject(input.selectedElement) ? input.selectedElement : null;
  const selectedElement = rawSelectedElement && typeof rawSelectedElement.selector === "string"
    ? {
      tag: boundedText(rawSelectedElement.tag, 32),
      selector: boundedText(rawSelectedElement.selector, 1200),
      segments: Array.isArray(rawSelectedElement.segments)
        ? rawSelectedElement.segments
          .filter((segment) => typeof segment === "string" && segment.length <= 240)
          .slice(0, 10)
        : [],
      inShadowDom: Boolean(rawSelectedElement.inShadowDom),
      shadowRootMode: rawSelectedElement.shadowRootMode === "open" || rawSelectedElement.shadowRootMode === "closed"
        ? rawSelectedElement.shadowRootMode
        : null,
      stableAttributes: isPlainObject(rawSelectedElement.stableAttributes)
        ? {
          id: boundedText(rawSelectedElement.stableAttributes.id, 64),
          classes: Array.isArray(rawSelectedElement.stableAttributes.classes)
            ? rawSelectedElement.stableAttributes.classes
              .filter((className) => typeof className === "string" && className.length <= 48)
              .slice(0, 3)
            : []
        }
        : { id: "", classes: [] },
      interactionHints: Array.isArray(rawSelectedElement.interactionHints)
        ? rawSelectedElement.interactionHints
          .filter((hint) => typeof hint === "string" && hint.length <= 32)
          .slice(0, 8)
        : []
    }
    : null;

  return {
    prompt,
    domMap: input.domMap,
    domMapJson: serializedMap,
    selectedElement: selectedElement && selectedElement.selector ? selectedElement : null,
    maxOutputTokens: Number.isInteger(input.maxOutputTokens)
      ? Math.max(512, Math.min(8192, input.maxOutputTokens))
      : 3500,
    signal: input.signal,
    onProgress: input.onProgress
  };
}

function buildUserMessage(input) {
  const message = [
    "User layout goal:",
    input.prompt,
    "",
    "Structural DOM map (content, image payloads, and text are intentionally absent):",
    input.domMapJson,
  ];
  if (input.selectedElement) {
    message.push(
      "",
      "User-selected structural target (no page content is included):",
      JSON.stringify(input.selectedElement)
    );
  }
  message.push("", "Return the required raw JSON object now.");
  return message.join("\n");
}

function extractOpenAIText(response) {
  if (response && typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  if (!response || !Array.isArray(response.output)) {
    return "";
  }

  const pieces = [];
  for (const item of response.output) {
    if (!item || !Array.isArray(item.content)) {
      continue;
    }
    for (const block of item.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (typeof block.text === "string" && (block.type === "output_text" || block.type === "text")) {
        pieces.push(block.text);
      }
    }
  }
  return pieces.join("");
}

function extractDeepSeekText(response) {
  const choice = response && Array.isArray(response.choices) ? response.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : "";
  return typeof content === "string" ? content : "";
}

function extractAnthropicToolInput(response) {
  const blocks = response && Array.isArray(response.content) ? response.content : [];
  const toolUse = blocks.find((block) => block && block.type === "tool_use" && block.name === "return_layout_payload");
  return toolUse ? toolUse.input : null;
}

function throwOnStreamError(event, provider) {
  if (event && event.type === "error") {
    const message = event.error && event.error.message ? event.error.message : "Unknown streaming error.";
    throw new AIClientError("provider_stream_error", provider + " stream failed: " + sanitizeProviderError(message));
  }
}

async function generateOpenAI(input, config) {
  const userMessage = buildUserMessage(input);
  emitProgress(input.onProgress, { phase: "requesting", provider: "openai" });
  const response = await checkedFetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey
      },
      body: JSON.stringify({
        model: config.model,
        instructions: SYSTEM_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: userMessage
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "layout_payload",
            strict: true,
            schema: LAYOUT_PAYLOAD_SCHEMA
          }
        },
        store: false,
        max_output_tokens: input.maxOutputTokens,
        stream: true
      })
    },
    "OpenAI"
  );

  if (!isSseResponse(response)) {
    return parseLayoutPayload(extractOpenAIText(await response.json()), "OpenAI");
  }

  let streamedText = "";
  let completedResponse = null;
  const report = makeProgressReporter(input.onProgress);
  await consumeSse(response, (event) => {
    throwOnStreamError(event, "OpenAI");
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      streamedText += event.delta;
      report("generating", streamedText.length);
    }
    if (event.type === "response.completed" && event.response) {
      completedResponse = event.response;
    }
  });

  const finalText = extractOpenAIText(completedResponse) || streamedText;
  return parseLayoutPayload(finalText, "OpenAI");
}

async function generateAnthropic(input, config) {
  const userMessage = buildUserMessage(input);
  emitProgress(input.onProgress, { phase: "requesting", provider: "anthropic" });
  const response = await checkedFetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: input.maxOutputTokens,
        system: SYSTEM_INSTRUCTIONS,
        messages: [
          {
            role: "user",
            content: userMessage
          }
        ],
        tools: [
          {
            name: "return_layout_payload",
            description: "Return the required layout payload. The input must have exactly css and javascript string fields.",
            input_schema: LAYOUT_PAYLOAD_SCHEMA,
            strict: true
          }
        ],
        tool_choice: {
          type: "tool",
          name: "return_layout_payload"
        },
        stream: true
      })
    },
    "Anthropic"
  );

  if (!isSseResponse(response)) {
    return parseLayoutPayload(extractAnthropicToolInput(await response.json()), "Anthropic");
  }

  let toolInput = null;
  let partialInput = "";
  const report = makeProgressReporter(input.onProgress);
  await consumeSse(response, (event) => {
    throwOnStreamError(event, "Anthropic");
    if (event.type === "content_block_start" && event.content_block && event.content_block.type === "tool_use") {
      if (event.content_block.name === "return_layout_payload") {
        toolInput = event.content_block.input || null;
      }
    }
    if (event.type === "content_block_delta" && event.delta && event.delta.type === "input_json_delta") {
      partialInput += event.delta.partial_json || "";
      report("generating", partialInput.length);
    }
  });

  if (partialInput) {
    try {
      return parseLayoutPayload(JSON.parse(partialInput), "Anthropic");
    } catch (error) {
      if (error instanceof AIClientError) {
        throw error;
      }
      throw new AIClientError("invalid_json", "Anthropic returned an incomplete structured payload.");
    }
  }

  return parseLayoutPayload(toolInput, "Anthropic");
}

async function generateDeepSeek(input, config) {
  const userMessage = buildUserMessage(input);
  emitProgress(input.onProgress, { phase: "requesting", provider: "deepseek" });
  const response = await checkedFetch(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: SYSTEM_INSTRUCTIONS
          },
          {
            role: "user",
            content: userMessage
          }
        ],
        response_format: {
          type: "json_object"
        },
        temperature: 0.2,
        max_tokens: input.maxOutputTokens,
        stream: true,
        stream_options: {
          include_usage: true
        }
      })
    },
    "DeepSeek"
  );

  if (!isSseResponse(response)) {
    return parseLayoutPayload(extractDeepSeekText(await response.json()), "DeepSeek");
  }

  let streamedText = "";
  const report = makeProgressReporter(input.onProgress);
  await consumeSse(response, (event) => {
    throwOnStreamError(event, "DeepSeek");
    const choice = event && Array.isArray(event.choices) ? event.choices[0] : null;
    const delta = choice && choice.delta ? choice.delta.content : "";
    if (typeof delta === "string") {
      streamedText += delta;
      report("generating", streamedText.length);
    }
  });

  return parseLayoutPayload(streamedText, "DeepSeek");
}

class ByokAdapter {
  constructor(config) {
    this.config = config;
  }

  async generate(input) {
    const provider = this.config.provider;
    const apiKey = boundedText(this.config.apiKey, 4096);
    const model = boundedText(this.config.model, 128);

    if (!apiKey) {
      throw new AIClientError("missing_api_key", "Save an API key for the selected provider first.");
    }
    if (!model) {
      throw new AIClientError("missing_model", "Enter a model ID for the selected provider.");
    }

    const request = {
      ...input,
      apiKey,
      model
    };
    switch (provider) {
      case "openai":
        return generateOpenAI(request, request);
      case "anthropic":
        return generateAnthropic(request, request);
      case "deepseek":
        return generateDeepSeek(request, request);
      default:
        throw new AIClientError("unsupported_provider", "The selected direct provider is not supported.");
    }
  }
}

async function ensureBackendPermission(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AIClientError("invalid_backend_endpoint", "Save a valid HTTPS backend endpoint first.");
  }
  if (url.protocol !== "https:" || !url.hostname) {
    throw new AIClientError("invalid_backend_endpoint", "Backend routing requires a valid HTTPS endpoint.");
  }

  const originPattern = url.protocol + "//" + url.hostname + "/*";
  const granted = await chrome.permissions.contains({ origins: [originPattern] });
  if (!granted) {
    throw new AIClientError(
      "backend_permission_required",
      "Save the backend endpoint and approve its origin permission before generating."
    );
  }
}

function extractBackendPayload(response) {
  if (isPlainObject(response) && isPlainObject(response.payload)) {
    return response.payload;
  }
  if (isPlainObject(response) && typeof response.output_text === "string") {
    return response.output_text;
  }
  return response;
}

class BackendAdapter {
  constructor(config) {
    this.config = config;
  }

  async generate(input) {
    const endpoint = boundedText(this.config.backendEndpoint, 1024);
    if (!endpoint) {
      throw new AIClientError("missing_backend_endpoint", "Save an HTTPS backend endpoint before selecting the backend route.");
    }

    await ensureBackendPermission(endpoint);
    emitProgress(input.onProgress, { phase: "requesting", provider: "backend" });
    const headers = {
      "Content-Type": "application/json"
    };
    const token = boundedText(this.config.backendToken, 4096);
    if (token) {
      headers.Authorization = "Bearer " + token;
    }

    const response = await checkedFetch(
      endpoint,
      {
        method: "POST",
        signal: input.signal,
        headers,
        body: JSON.stringify({
          version: 1,
          operation: "generate_layout_payload",
          input: {
            prompt: input.prompt,
            dom: input.domMap,
            responseSchema: LAYOUT_PAYLOAD_SCHEMA
          }
        })
      },
      "Configured backend"
    );

    if (!isSseResponse(response)) {
      return parseLayoutPayload(extractBackendPayload(await response.json()), "Configured backend");
    }

    let finalPayload = null;
    let outputText = "";
    const report = makeProgressReporter(input.onProgress);
    await consumeSse(response, (event) => {
      throwOnStreamError(event, "Configured backend");
      if (event.type === "payload" && event.payload) {
        finalPayload = event.payload;
      }
      if (event.type === "response.completed" && event.payload) {
        finalPayload = event.payload;
      }
      if (typeof event.delta === "string") {
        outputText += event.delta;
        report("generating", outputText.length);
      }
    });

    return parseLayoutPayload(finalPayload || outputText, "Configured backend");
  }
}

export function createAdapter(settings) {
  if (!settings || typeof settings !== "object") {
    throw new AIClientError("invalid_settings", "No runtime settings were available.");
  }

  switch (settings.routeMode) {
    case "byok":
      return new ByokAdapter(settings);
    case "backend":
      return new BackendAdapter(settings);
    default:
      throw new AIClientError("unsupported_route", "The selected execution route is not supported.");
  }
}

export async function generateLayoutPayload(settings, rawInput) {
  const input = validateGenerationInput(rawInput);
  const adapter = createAdapter(settings);
  return adapter.generate(input);
}

export const USERSCRIPT_PAYLOAD_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "matches", "excludeMatches", "grants", "connects", "requires", "resources", "updateUrl", "downloadUrl", "checkForUpdates", "runAt", "world", "code"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    matches: {
      type: "array",
      items: { type: "string" }
    },
    excludeMatches: {
      type: "array",
      items: { type: "string" }
    },
    grants: {
      type: "array",
      items: { type: "string" }
    },
    connects: {
      type: "array",
      items: { type: "string" }
    },
    requires: {
      type: "array",
      items: { type: "string" }
    },
    resources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "url"],
        properties: {
          name: { type: "string" },
          url: { type: "string" }
        }
      }
    },
    updateUrl: { type: "string" },
    downloadUrl: { type: "string" },
    checkForUpdates: { type: "boolean" },
    runAt: {
      type: "string",
      enum: ["document_start", "document_end", "document_idle"]
    },
    world: {
      type: "string",
      enum: ["USER_SCRIPT", "MAIN"]
    },
    code: { type: "string" }
  }
});

const USERSCRIPT_SYSTEM_INSTRUCTIONS = [
  "You generate a browser userscript draft for a local-first extension.",
  "Return exactly one raw JSON object with no markdown, prose, or code fence.",
  "The object must have exactly these fields: name, description, matches, excludeMatches, grants, connects, requires, resources, updateUrl, downloadUrl, checkForUpdates, runAt, world, code.",
  "matches and excludeMatches are arrays of valid Chrome match patterns. Scope them to the request when practical; use *://*/* when the requested behavior is intentionally global.",
  "runAt must be document_start, document_end, or document_idle. world must be USER_SCRIPT or MAIN.",
  "code is JavaScript body code only: do not include a Userscript metadata header.",
  "Favor idempotent DOM changes. Do not download or execute remote code, use eval/new Function, exfiltrate page content, capture credentials, submit forms, or bypass access controls.",
  "grants is portable userscript metadata. Supported names include GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_addValueChangeListener, GM_removeValueChangeListener, GM_addStyle, GM_addElement, GM_log, GM_openInTab, GM_xmlhttpRequest, GM_setClipboard, GM_notification, and GM_download.",
  "Frameweave exposes matching GM and legacy APIs in USER_SCRIPT world regardless of grants metadata.",
  "Use GM_xmlhttpRequest only when the user explicitly requests it. @connect metadata is optional compatibility information.",
  "requires is an array of direct @require URLs and resources is an array of {name,url} @resource declarations. Keep both empty unless the user explicitly asks for a specific, existing dependency or asset. updateUrl and downloadUrl are empty strings unless the user supplies a real update source. checkForUpdates is true only when an update URL is present.",
  "The draft will be shown in an editor for explicit review before it can be saved or run."
].join("\n");

function ensureStringList(value, source, field, maximumItems, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumItems || value.some((item) => typeof item !== "string" || item.length > maximumLength)) {
    throw new AIClientError("invalid_userscript_payload", source + " returned an invalid " + field + " array.");
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function ensureExactUserScriptPayload(value, source) {
  if (!isPlainObject(value)) {
    throw new AIClientError("invalid_userscript_payload", source + " did not return a JSON object.");
  }
  const expected = ["checkForUpdates", "code", "connects", "description", "downloadUrl", "excludeMatches", "grants", "matches", "name", "requires", "resources", "runAt", "updateUrl", "world"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new AIClientError("invalid_userscript_payload", source + " did not return the exact userscript draft schema.");
  }
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 160) {
    throw new AIClientError("invalid_userscript_payload", source + " returned an invalid userscript name.");
  }
  if (typeof value.description !== "string" || value.description.length > 1200) {
    throw new AIClientError("invalid_userscript_payload", source + " returned an invalid userscript description.");
  }
  if (typeof value.code !== "string" || !value.code.trim() || value.code.length > 750000) {
    throw new AIClientError("invalid_userscript_payload", source + " returned invalid userscript code.");
  }
  if (!["document_start", "document_end", "document_idle"].includes(value.runAt)) {
    throw new AIClientError("invalid_userscript_payload", source + " returned an unsupported runAt value.");
  }
  if (!["USER_SCRIPT", "MAIN"].includes(value.world)) {
    throw new AIClientError("invalid_userscript_payload", source + " returned an unsupported execution world.");
  }
  if (typeof value.updateUrl !== "string" || value.updateUrl.length > 4096 || typeof value.downloadUrl !== "string" || value.downloadUrl.length > 4096) {
    throw new AIClientError("invalid_userscript_payload", source + " returned invalid update URLs.");
  }
  if (!Array.isArray(value.resources) || value.resources.length > 128 || value.resources.some((entry) => !isPlainObject(entry) || typeof entry.name !== "string" || typeof entry.url !== "string" || entry.name.length > 160 || entry.url.length > 4096)) {
    throw new AIClientError("invalid_userscript_payload", source + " returned invalid resource declarations.");
  }
  if (typeof value.checkForUpdates !== "boolean") {
    throw new AIClientError("invalid_userscript_payload", source + " returned an invalid checkForUpdates value.");
  }
  return {
    name: value.name.trim(),
    description: value.description.trim(),
    matches: ensureStringList(value.matches, source, "matches", 64, 512),
    excludeMatches: ensureStringList(value.excludeMatches, source, "excludeMatches", 64, 512),
    grants: ensureStringList(value.grants, source, "grants", 48, 96),
    connects: ensureStringList(value.connects, source, "connects", 64, 256),
    requires: ensureStringList(value.requires, source, "requires", 128, 4096),
    resources: value.resources.map((entry) => ({ name: entry.name.trim(), url: entry.url.trim() })),
    updateUrl: value.updateUrl.trim(),
    downloadUrl: value.downloadUrl.trim(),
    checkForUpdates: value.checkForUpdates,
    runAt: value.runAt,
    world: value.world,
    code: value.code
  };
}

export function parseUserScriptPayload(raw, source) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      throw new AIClientError("invalid_userscript_payload", source + " returned a code fence instead of raw JSON.");
    }
    try {
      return ensureExactUserScriptPayload(JSON.parse(trimmed), source);
    } catch (error) {
      if (error instanceof AIClientError) {
        throw error;
      }
      throw new AIClientError("invalid_userscript_json", source + " returned invalid JSON: " + boundedText(error.message, 300));
    }
  }
  return ensureExactUserScriptPayload(raw, source);
}

function validateUserScriptGenerationInput(rawInput) {
  if (!isPlainObject(rawInput)) {
    throw new AIClientError("invalid_request", "Userscript generation input must be an object.");
  }
  const prompt = boundedText(rawInput.prompt, MAX_PROMPT_LENGTH);
  if (!prompt) {
    throw new AIClientError("missing_prompt", "Describe the userscript before generating.");
  }
  const pageUrl = boundedText(rawInput.pageUrl, 2048);
  if (pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw new AIClientError("invalid_page_url", "Provide a valid HTTP or HTTPS page URL, or leave it blank.");
    }
  }
  let domMap = null;
  let domMapJson = "";
  if (rawInput.domMap !== undefined && rawInput.domMap !== null) {
    if (!isPlainObject(rawInput.domMap)) {
      throw new AIClientError("invalid_dom_map", "The userscript page map must be an object.");
    }
    try {
      domMapJson = JSON.stringify(rawInput.domMap);
    } catch {
      throw new AIClientError("invalid_dom_map", "The userscript page map could not be serialized.");
    }
    if (domMapJson.length > MAX_DOM_MAP_CHARS) {
      throw new AIClientError("dom_map_too_large", "The userscript page map exceeded the request safety limit.");
    }
    domMap = rawInput.domMap;
  }
  return {
    prompt,
    pageUrl,
    domMap,
    domMapJson,
    maxOutputTokens: Number.isInteger(rawInput.maxOutputTokens)
      ? Math.max(512, Math.min(8192, rawInput.maxOutputTokens))
      : 3500,
    signal: rawInput.signal,
    onProgress: rawInput.onProgress
  };
}

function buildUserScriptGenerationMessage(input) {
  const lines = [
    "User request:",
    input.prompt,
    "",
    "Target page URL:",
    input.pageUrl || "Not supplied; choose a narrow, conservative match pattern."
  ];
  if (input.domMapJson) {
    lines.push(
      "",
      "Structural DOM map (page text, image payloads, and form values are intentionally absent):",
      input.domMapJson
    );
  }
  lines.push("", "Return the exact raw JSON userscript draft now.");
  return lines.join("\n");
}

async function generateOpenAIUserScript(input, config) {
  emitProgress(input.onProgress, { phase: "requesting", provider: "openai" });
  const response = await checkedFetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey
      },
      body: JSON.stringify({
        model: config.model,
        instructions: USERSCRIPT_SYSTEM_INSTRUCTIONS,
        input: [{
          role: "user",
          content: [{ type: "input_text", text: buildUserScriptGenerationMessage(input) }]
        }],
        text: {
          format: {
            type: "json_schema",
            name: "userscript_draft",
            strict: true,
            schema: USERSCRIPT_PAYLOAD_SCHEMA
          }
        },
        store: false,
        max_output_tokens: input.maxOutputTokens
      })
    },
    "OpenAI"
  );
  emitProgress(input.onProgress, { phase: "generating", provider: "openai" });
  return parseUserScriptPayload(extractOpenAIText(await response.json()), "OpenAI");
}

async function generateAnthropicUserScript(input, config) {
  emitProgress(input.onProgress, { phase: "requesting", provider: "anthropic" });
  const response = await checkedFetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: input.maxOutputTokens,
        system: USERSCRIPT_SYSTEM_INSTRUCTIONS,
        messages: [{
          role: "user",
          content: buildUserScriptGenerationMessage(input)
        }],
        tools: [{
          name: "return_userscript_draft",
          description: "Return the exact userscript draft schema.",
          input_schema: USERSCRIPT_PAYLOAD_SCHEMA,
          strict: true
        }],
        tool_choice: {
          type: "tool",
          name: "return_userscript_draft"
        }
      })
    },
    "Anthropic"
  );
  emitProgress(input.onProgress, { phase: "generating", provider: "anthropic" });
  const body = await response.json();
  const blocks = Array.isArray(body && body.content) ? body.content : [];
  const toolUse = blocks.find((block) => block && block.type === "tool_use" && block.name === "return_userscript_draft");
  return parseUserScriptPayload(toolUse && toolUse.input, "Anthropic");
}

async function generateDeepSeekUserScript(input, config) {
  emitProgress(input.onProgress, { phase: "requesting", provider: "deepseek" });
  const response = await checkedFetch(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: USERSCRIPT_SYSTEM_INSTRUCTIONS },
          { role: "user", content: buildUserScriptGenerationMessage(input) }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: input.maxOutputTokens
      })
    },
    "DeepSeek"
  );
  emitProgress(input.onProgress, { phase: "generating", provider: "deepseek" });
  return parseUserScriptPayload(extractDeepSeekText(await response.json()), "DeepSeek");
}

async function generateBackendUserScript(input, config) {
  const endpoint = boundedText(config.backendEndpoint, 1024);
  if (!endpoint) {
    throw new AIClientError("missing_backend_endpoint", "Save an HTTPS backend endpoint before selecting the backend route.");
  }
  await ensureBackendPermission(endpoint);
  emitProgress(input.onProgress, { phase: "requesting", provider: "backend" });
  const headers = { "Content-Type": "application/json" };
  const token = boundedText(config.backendToken, 4096);
  if (token) {
    headers.Authorization = "Bearer " + token;
  }
  const response = await checkedFetch(
    endpoint,
    {
      method: "POST",
      signal: input.signal,
      headers,
      body: JSON.stringify({
        version: 1,
        operation: "generate_userscript",
        input: {
          prompt: input.prompt,
          pageUrl: input.pageUrl,
          dom: input.domMap,
          responseSchema: USERSCRIPT_PAYLOAD_SCHEMA
        }
      })
    },
    "Configured backend"
  );
  emitProgress(input.onProgress, { phase: "generating", provider: "backend" });
  return parseUserScriptPayload(extractBackendPayload(await response.json()), "Configured backend");
}

export async function generateUserScriptDraft(settings, rawInput) {
  if (!settings || typeof settings !== "object") {
    throw new AIClientError("invalid_settings", "No runtime settings were available.");
  }
  const input = validateUserScriptGenerationInput(rawInput);
  const apiKey = boundedText(settings.apiKey, 4096);
  const model = boundedText(settings.model, 128);
  if (settings.routeMode === "backend") {
    return generateBackendUserScript(input, settings);
  }
  if (!apiKey) {
    throw new AIClientError("missing_api_key", "Save an API key for the selected provider first.");
  }
  if (!model) {
    throw new AIClientError("missing_model", "Enter a model ID for the selected provider.");
  }
  const config = { ...settings, apiKey, model };
  switch (settings.provider) {
    case "openai":
      return generateOpenAIUserScript(input, config);
    case "anthropic":
      return generateAnthropicUserScript(input, config);
    case "deepseek":
      return generateDeepSeekUserScript(input, config);
    default:
      throw new AIClientError("unsupported_provider", "The selected direct provider is not supported.");
  }
}
