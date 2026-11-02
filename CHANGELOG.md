# Changelog

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
