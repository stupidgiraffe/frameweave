# Privacy

## Local-first base behavior

Frameweave stores the following in `chrome.storage.local` in the current browser profile:

- provider API keys and optional backend token;
- provider/model and extraction settings;
- userscript source, metadata, local values, execution order, update state, and cached `@require` / `@resource` assets;
- aggregate local activity counters.

The popup's element target and layout preview state use `chrome.storage.session` and are cleared with the browser session or tab lifecycle.

## Network behavior

Frameweave contacts only destinations selected or encoded by the user:

- the selected direct model provider when Direct BYOK is used;
- the configured HTTPS backend endpoint when backend mode is selected;
- script URLs, `@require` URLs, `@resource` URLs, `@updateURL`/`@downloadURL` URLs, and destinations requested by a userscript through `GM_xmlhttpRequest`.

The default build does not include a Frameweave-hosted account service, analytics collector, remote configuration feed, or cloud sync.

## Page data sent to model providers

For layout generation and active-page userscript drafting, Frameweave sends a compact structural map. It intentionally excludes text nodes, article text, media payloads, scripts, form values, password fields, payment fields, and user-entered data. The user's free-form prompt is sent to the selected route.

## User control

Users can remove saved keys from the popup, delete scripts and values from the library, remove layout CSS from the current tab, and export local script backups. Uninstalling the extension removes its local storage subject to browser behavior.

## Marketplace publication

Before publishing a store build, replace this project privacy notice with the operator's legally reviewed privacy policy, support contact, jurisdictional disclosures, and any hosted-tier data processing terms.
