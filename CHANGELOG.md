# Changelog

## 1.0.5

- Accept versioned endpoint paths in model catalogs. OpenRouter chat models appear in the picker and batch-only entries stay excluded.

## 1.0.4

- Separate keyword search from the selected model ID; keep filtering active across delayed responses and refreshes.
- Replace clipped native options with touch-friendly buttons showing wrapped names and IDs, live result counts, and an empty state.
- Add a Chromium mobile-width interaction and overflow check to CI.

## 1.0.3

- Replaced the native datalist with a visible, searchable model list that works with mobile browsers.
- Removed popup-closing confirmation dialogs from key and token clearing, preserving current provider and form state.
- Retain text models when optional JSON capability metadata is incomplete.

## 1.0.2

- Added live model discovery after pasting a key and when reopening saved provider settings, with searchable suggestions, Refresh models, and manual model IDs.
- Added OpenRouter, AIHubMix, Groq, Together AI, NVIDIA NIM, Ollama, and LM Studio presets with API URLs filled automatically.
- Added AIHubMix catalog parsing, Together array catalogs, and Anthropic model pagination; filtered known non-text and explicitly incompatible model capabilities.
- Require a non-empty model in both the BYOK UI and settings storage; new installations no longer silently choose a model. The backend route remains independent.
- Cancel stale discovery results on provider/credential/URL changes; URL editing never sends keys automatically, and saved keys are not reused for discovery on a different origin without explicit re-entry.
- Added regression coverage for automatic discovery, saved keys, provider switching, errors, catalog formats, URL editing, preset generation, and missing-model validation.

## 1.0.1

- Added custom OpenAI-compatible BYOK with an editable API base URL, model ID, and optional key for local servers.
- Added editable API base URLs for existing providers; preserved saved keys and models during migration and provider switching.
- Connected custom endpoints to both layout generation and AI userscript drafting, including streamed layout responses.
- Fixed SSE event parsing when CRLF separators span network chunks and added Anthropic's direct-browser request header.
- Reject provider URLs containing embedded credentials and prevent credential-bearing AI requests from following redirects.
- Added regression coverage for provider storage, routing, streaming, URL validation, popup saving, and backend-route isolation.

## 1.0.0

- Established Frameweave as a Manifest V3 local-first BYOK workspace.
- Added native User Scripts API registration, local script library, import/export, URL loading, deterministic order, dependency/resource caching, and update checks.
- Added a broad GM compatibility core for values, resources, networking, menus, tab state, clipboard, notifications, downloads, and tabs.
- Added direct provider adapters, strict two-field layout payload validation, token-efficient DOM extraction, element targeting, preview/commit/discard, and persistent CSS-to-userscript conversion.
- Added GitHub-oriented documentation, privacy/security guidance, CI, and contract tests.
- Added packaged GitHub Releases, including a load-unpacked ZIP and SHA-256 checksum, plus project support links.
