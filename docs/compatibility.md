# Compatibility and acceptance

## Runtime baseline

- Chromium-based browsers with Chrome 135 or later.
- Manifest V3.
- `chrome.userScripts` enabled for the extension.
- Chrome 138+ users enable **Allow User Scripts** on the extension Details page. Earlier versions require Developer mode for the API.

Frameweave currently targets Chromium's User Scripts API. Firefox and Safari need dedicated runtime adapters before they can be advertised as supported.

## Userscript metadata

| Directive | Status | Notes |
| --- | --- | --- |
| `@name`, `@namespace`, `@description`, `@version`, `@author`, homepage/support/icon/license fields | Supported | Parsed, stored, and regenerated on export |
| `@match`, `@exclude-match`, `@include`, `@exclude` | Supported | Chrome match patterns plus native include/exclude globs |
| `@run-at`, `@noframes` | Supported | Native registration maps to Chrome run-at/all-frames fields |
| `@inject-into` | Compatible mapping | `page`/`main` map to `MAIN`; `content`/`auto` map to `USER_SCRIPT` |
| `@grant`, `@connect` | Metadata compatibility | Not used as Frameweave capability gates |
| `@require`, `@resource` | Supported | Cached locally and executed through `chrome.userScripts` only |
| `@updateURL`, `@downloadURL` | Supported | Manual and daily automatic update checks |
| `@run-in`, `@unwrap`, `@antifeature`, `@compatible`, `@contributionURL` | Not implemented | Preserved only if manually retained in source; not represented by the editor |

## GM API compatibility

| API | Status | Notes |
| --- | --- | --- |
| Value APIs and change listeners | Supported | JSON-compatible values, local per-script namespace |
| `GM_addStyle`, `GM_addElement`, `GM_log`, `GM_info` | Supported | Legacy and `GM.*` aliases where applicable |
| `GM_getResourceText`, `GM_getResourceURL` | Supported | Uses cached `@resource` entries |
| `GM_xmlhttpRequest`, `GM.xmlHttpRequest` | Supported core | HTTP(S), text/JSON response types, timeout and abort |
| `GM_openInTab`, `GM_closeTab` | Supported | Standard tab creation/closure options supported by Chrome |
| `GM_getTab`, `GM_saveTab`, `GM_getTabs` | Supported | Session-scoped per-tab data |
| `GM_registerMenuCommand`, `GM_unregisterMenuCommand` | Supported | Native context-menu integration; callback runs in the top frame of the clicked tab |
| Clipboard, notification, download APIs | Supported | Backed by extension capabilities |
| `GM_cookie`, `GM_webRequest`, `GM_webRequestRules`, `GM_webext` | Not implemented | Do not claim broad manager parity for these APIs |

## Browser acceptance checklist

Run in a fresh Chrome profile after loading the unpacked extension.

1. Confirm the manifest loads without errors and **Allow User Scripts** is enabled.
2. Open a normal HTTPS page. Save an OpenAI, Anthropic, and DeepSeek test key independently; generate one layout preview for each provider.
3. Confirm Preview, Keep, Discard, and Remove correctly affect CSS and that **Save current CSS as userscript** produces a registered script.
4. Create a `USER_SCRIPT` script using GM values, a `MAIN` script using page globals, and a `@grant none` script. Verify each runs at its selected run-at value.
5. Import a `.user.js` with `@match`, `@include`, exclusions, `@require`, and `@resource`; save and reload the target page.
6. Verify `GM_getResourceText`, `GM_getResourceURL`, `GM_xmlhttpRequest`, notification, clipboard, download, tab state, and context-menu command behavior.
7. Load a userscript by URL, configure `@updateURL`, change the remote version, run **Check update**, and verify both manual and scheduled update application.
8. Export a backup, clear a disposable profile, import the backup, and verify execution order and enabled states survive.
9. Test a page with an open shadow root, a same-origin child frame, and a denied special URL. Confirm normal-page behavior and clear platform error messages.
10. Review the final permission warning and marketplace privacy disclosures against the released manifest.

## Known platform limits

- Browser internal pages, browser-store pages, other extension pages, and protected browser surfaces cannot receive scripts.
- File pages require the browser's separate **Allow access to file URLs** setting.
- A `MAIN` world script does not receive the native GM message bridge; use `USER_SCRIPT` for GM APIs.
- Dynamic registrations may be cleared by browser/extension lifecycle events; Frameweave reconciles them on install and startup.
- Remote script sources are powerful by design. Users should treat imported scripts, dependencies, and update URLs as code they are choosing to execute.
