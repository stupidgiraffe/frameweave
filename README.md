# Frameweave

Frameweave is a local-first, bring-your-own-key browser workspace for two jobs that normally require separate tools:

- turn a natural-language layout request into verified CSS plus declarative page automation; and
- install, author, update, and run full-power userscripts through Chrome's native Manifest V3 User Scripts runtime.

No hosted service is required for the open-source base. Provider keys, scripts, values, assets, backups, and layout telemetry remain in the browser's local extension storage unless the user explicitly selects the optional backend adapter.

> Status: v1.0.0 MV3 release candidate. The repository has static checks and contract tests; run the browser acceptance checklist before publishing a Chrome Web Store listing.

## Design boundary

Frameweave is a **Manifest V3** extension core, not a "v3 product" label. Its userscript runtime requires Chrome 135+ because manual execution uses `chrome.userScripts.execute()`. Chrome 138+ exposes an **Allow User Scripts** toggle in each extension's Details page; older Chrome versions require Developer mode for the User Scripts API. See the [Chrome User Scripts API](https://developer.chrome.com/docs/extensions/reference/api/userScripts).

The extension never evaluates a fetched string with `eval` or `new Function`. User-provided script bodies, `@require` dependencies, and fetched script updates are passed only to `chrome.userScripts`, the documented MV3 API intended for arbitrary user-provided code. Extension-owned logic remains packaged and reviewable, which is the important MV3/Web Store boundary. See [Chrome's MV3 policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) and [remote hosted code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

## Capabilities

### AI layout workspace

- Direct BYOK adapters for OpenAI Responses, Anthropic Messages, and DeepSeek Chat.
- A central adapter route: `byok` sends directly to the selected provider; `backend` posts to a configurable HTTPS endpoint for a future hosted tier.
- Token-efficient DOM extraction: tags, stable IDs, structural classes, hierarchy, layout signals, and selected-element hints only. It excludes page text, image data, scripts, form values, and article payloads.
- Strict response contract. Every layout adapter must return exactly:

```json
{
  "css": "main { max-width: 72rem; }",
  "javascript": "{\"version\":1,\"steps\":[]}"
}
```

`javascript` is a JSON-serialized declarative `AutomationProgram`, not arbitrary model-generated source. Frameweave validates it, injects CSS with `chrome.scripting.insertCSS()`, and runs the validated program through a static interpreter with `chrome.scripting.executeScript()`.

- Element picking with open-shadow-root selector paths.
- Preview → keep/discard lifecycle. Preview injects CSS only; automation executes only on **Keep preview**.
- **Save current CSS as userscript** converts the generated CSS into a persistent, site-scoped local userscript.

### Native userscript manager

- Local script library with authoring, filtering, enable/disable, deterministic execution order, import, URL loading, JSON backup/export, and run-now.
- Native dynamic registration through `chrome.userScripts`; no extension-side code evaluator.
- Common metadata: `@name`, `@namespace`, `@description`, `@version`, `@match`, `@exclude-match`, `@include`, `@exclude`, `@run-at`, `@noframes`, `@inject-into`, `@grant`, `@connect`, `@require`, `@resource`, `@updateURL`, and `@downloadURL`.
- Dependency and resource cache: `@require` runs before the script body; `@resource` is available through `GM_getResourceText` and `GM_getResourceURL`.
- Manual **Check update**, **Update all**, and a 24-hour automatic update alarm for scripts with an update source and auto-update enabled.
- AI userscript drafting. It consumes the active page's slim structural map when available, fills the editor only, and never auto-runs generated code.

### GM compatibility core

`@grant` and `@connect` remain portable metadata; Frameweave does not use them as per-script capability gates. Browser-level permissions and user-enabled site access remain platform requirements.

| Surface | Supported APIs |
| --- | --- |
| Values | `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues`, `GM_addValueChangeListener`, `GM_removeValueChangeListener` and `GM.*` aliases |
| Page mutation | `GM_addStyle`, `GM_addElement`, `GM_log`, `GM_info` |
| Resources | `GM_getResourceText`, `GM_getResourceURL` |
| Networking | `GM_xmlhttpRequest`, `GM.xmlHttpRequest` for HTTP(S) text/JSON responses |
| Browser actions | `GM_openInTab`, `GM_closeTab`, `GM_getTab`, `GM_saveTab`, `GM_getTabs` |
| Native integrations | `GM_setClipboard`, `GM_notification`, `GM_download` |
| Context menu | `GM_registerMenuCommand`, `GM_unregisterMenuCommand` |

`MAIN` world gives scripts page-global access. `USER_SCRIPT` world is the default and exposes the native Frameweave GM message bridge. Scripts using `@grant none` default to `MAIN` for conventional userscript behavior.

## Install locally

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** and choose **Load unpacked**.
4. Select the project directory.
5. In the extension's Details page, enable **Allow User Scripts**. If the browser does not show that toggle, leave Developer mode enabled and reload the extension.
6. Pin Frameweave. Configure a direct provider key in the popup, or open **Manage** to use the script library.

Use dedicated, revocable API keys with spend limits. `chrome.storage.local` is browser storage, not a hardware-backed secret vault.

## Permission model

Frameweave intentionally requests broad browser access because a general-purpose userscript manager cannot predeclare every site, dependency host, update endpoint, or `GM_xmlhttpRequest` destination.

| Permission | Purpose |
| --- | --- |
| `<all_urls>` | Page injection, userscripts, provider-independent remote script assets/updates, and GM HTTP(S) requests |
| `userScripts` | Native execution of user-provided scripts |
| `scripting`, `activeTab` | Layout extraction, picker, CSS injection, and declarative automation |
| `storage`, `unlimitedStorage` | Local keys, scripts, values, cached assets, and backups |
| `tabs`, `contextMenus`, `alarms` | Tab APIs, GM menu commands, deterministic auto-update checks |
| `downloads`, `notifications`, `clipboardWrite`, `offscreen` | Matching GM integrations |

Chrome-controlled pages, extension pages, browser internal pages, and file URLs without the browser's file-access toggle remain unavailable by platform design.

## Project layout

```text
frameweave/
├── manifest.json
├── popup.html
├── options.html
├── offscreen.html
├── README.md
├── LICENSE
├── PRIVACY.md
├── SECURITY.md
├── CONTRIBUTING.md
├── CHANGELOG.md
├── docs/
│   ├── architecture.md
│   └── compatibility.md
├── .github/workflows/ci.yml
├── icons/
└── src/
    ├── aiClient.js
    ├── background.js
    ├── domExtractor.js
    ├── elementPicker.js
    ├── injector.js
    ├── offscreen.js
    ├── popup.js
    ├── options.js
    ├── storage.js
    ├── userscriptMetadata.js
    ├── userscriptAssets.js
    ├── userscriptUpdates.js
    ├── userscriptStore.js
    └── userscriptRuntime.js
```

## Development

No runtime package dependency is required.

```bash
npm run check
```

Before release, run the [browser acceptance checklist](docs/compatibility.md#browser-acceptance-checklist) in a clean Chrome profile, with at least one API key from each advertised provider and representative userscripts using `@require`, `@resource`, updates, GM values, menus, tabs, download, notification, and XHR.

## Future hosted tier

The `routeMode` switch and adapters deliberately isolate optional hosted functionality from the local core. A premium service can add account-bound history, shared presets, team policy, artifact syncing, multi-agent page workflows, or hosted model routing without changing the popup protocol, DOM extractor, validation contracts, script store, or injection pipeline.

## Name and release diligence

`Frameweave` is a working project name selected after an initial public collision search. It is not legal trademark clearance. Before publication, perform jurisdiction-appropriate trademark/domain review, add an owner/support contact, publish a marketplace privacy disclosure, and review every permission warning against the released build.

## License

Apache-2.0. See [LICENSE](LICENSE).
