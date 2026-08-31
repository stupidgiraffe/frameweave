import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { AIClientError, parseLayoutPayload, parseUserScriptPayload } from "../src/aiClient.js";
import {
  commitPreview,
  discardPreview,
  getDeploymentState,
  InjectionError,
  parseAutomationProgram,
  previewLayoutPayload,
  validateCss
} from "../src/injector.js";
import { normalizeBackendEndpoint } from "../src/storage.js";
import {
  createUserScriptSource,
  isValidConnectTarget,
  normalizeUserScriptGrant,
  normalizeUserScriptInput,
  parseUserScriptMetadata
} from "../src/userscriptMetadata.js";
import { buildUserScriptWrapper, registrationForUserScript } from "../src/userscriptRuntime.js";
import { resolveUserScriptAssets } from "../src/userscriptAssets.js";
import { checkUserScriptUpdate, compareUserScriptVersions } from "../src/userscriptUpdates.js";

const validProgram = {
  version: 1,
  steps: [
    {
      type: "addClass",
      selector: "main",
      className: "frameweave-calm"
    },
    {
      type: "setStyle",
      selector: "main",
      property: "max-width",
      value: "72rem"
    }
  ]
};

test("accepts the exact two-field layout payload contract", () => {
  const raw = JSON.stringify({
    css: "main { max-width: 72rem; }",
    javascript: JSON.stringify(validProgram)
  });

  const payload = parseLayoutPayload(raw, "test");
  assert.equal(payload.css, "main { max-width: 72rem; }");
  assert.deepEqual(parseAutomationProgram(payload.javascript), validProgram);
});

test("ships a current Manifest V3 user-script runtime contract", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve("manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Frameweave");
  assert.equal(manifest.minimum_chrome_version, "135");
  assert.ok(manifest.permissions.includes("userScripts"));
  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
});

test("rejects extra top-level model fields", () => {
  assert.throws(
    () => parseLayoutPayload({
      css: "",
      javascript: "{}",
      explanation: "not allowed"
    }, "test"),
    AIClientError
  );
});

test("rejects malformed declarative automation", () => {
  assert.throws(
    () => parseAutomationProgram("window.location = 'https://example.invalid'"),
    InjectionError
  );
});

test("accepts nested event automation and rejects unsafe attribute targets", () => {
  const program = {
    version: 1,
    steps: [
      {
        type: "on",
        selector: ".menu-toggle",
        event: "click",
        once: false,
        preventDefault: false,
        actions: [
          {
            type: "toggleClass",
            selector: ".drawer",
            className: "is-open"
          }
        ]
      }
    ]
  };

  assert.equal(parseAutomationProgram(JSON.stringify(program)).steps.length, 1);
  assert.throws(
    () => parseAutomationProgram(JSON.stringify({
      version: 1,
      steps: [
        {
          type: "setAttribute",
          selector: "a",
          name: "href",
          value: "https://example.invalid"
        }
      ]
    })),
    InjectionError
  );
});

test("accepts bounded open-shadow-root selector paths", () => {
  const program = parseAutomationProgram(JSON.stringify({
    version: 1,
    steps: [
      {
        type: "setStyle",
        selector: "app-shell > main >>> .toolbar > button",
        property: "border-radius",
        value: "999px"
      }
    ]
  }));

  assert.equal(program.steps[0].selector, "app-shell > main >>> .toolbar > button");
  assert.throws(
    () => parseAutomationProgram(JSON.stringify({
      version: 1,
      steps: [
        {
          type: "addClass",
          selector: "main >>> >>> .toolbar",
          className: "active"
        }
      ]
    })),
    InjectionError
  );
});

test("rejects CSS capable of loading remote resources", () => {
  assert.throws(() => validateCss("@import url('https://example.invalid/a.css');"), InjectionError);
  assert.equal(validateCss("body { color: rebeccapurple; }"), "body { color: rebeccapurple; }");
});

test("accepts only HTTPS backend endpoints", () => {
  assert.equal(normalizeBackendEndpoint("https://api.example.com/layout/"), "https://api.example.com/layout");
  assert.throws(() => normalizeBackendEndpoint("http://localhost:3000/layout"));
});

test("preview defers automation until explicit commit and can be discarded", { concurrency: false }, async () => {
  const originalChrome = globalThis.chrome;
  const session = new Map();
  const calls = [];
  globalThis.chrome = {
    storage: {
      session: {
        async get(key) {
          return { [key]: session.get(key) };
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) {
            session.set(key, value);
          }
        },
        async remove(key) {
          session.delete(key);
        }
      }
    },
    scripting: {
      async insertCSS(details) {
        calls.push({ kind: "insertCSS", details });
      },
      async removeCSS(details) {
        calls.push({ kind: "removeCSS", details });
      },
      async executeScript(details) {
        calls.push({ kind: "executeScript", functionName: details.func.name });
        if (details.func.name === "cleanupAutomationRuntime") {
          return [{ result: { cleaned: 0 } }];
        }
        return [{ result: { applied: 1, skipped: 0, errors: [] } }];
      }
    }
  };

  try {
    const payload = {
      css: "main { max-width: 72rem; }",
      javascript: JSON.stringify(validProgram)
    };
    const preview = await previewLayoutPayload(41, payload, { allFrames: false });
    assert.equal(preview.cssInjected, true);
    assert.equal(
      calls.filter((call) => call.functionName === "executeAutomationProgram").length,
      0
    );
    assert.deepEqual(await getDeploymentState(41), {
      mode: "preview",
      hasCss: true,
      allFrames: false,
      injectedAt: (await getDeploymentState(41)).injectedAt
    });

    const committed = await commitPreview(41);
    assert.equal(committed.committed, true);
    assert.equal(committed.automation.applied, 1);
    assert.equal(
      calls.filter((call) => call.functionName === "executeAutomationProgram").length,
      1
    );
    assert.equal((await getDeploymentState(41)).mode, "applied");

    await previewLayoutPayload(41, payload, { allFrames: false });
    const discarded = await discardPreview(41);
    assert.equal(discarded.discarded, true);
    assert.equal(discarded.removedCss, true);
    assert.equal(await getDeploymentState(41), null);
    assert.equal(calls.filter((call) => call.kind === "removeCSS").length, 2);
  } finally {
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
});

test("parses portable userscript metadata and preserves the Frameweave execution world", () => {
  const source = `// ==UserScript==
// @name         Example script
// @description  Makes an example page calmer
// @version      1.2.3
// @match        https://example.com/*
// @exclude-match https://example.com/admin/*
// @connect      api.example.com
// @require      https://cdn.example.com/helper.js
// @resource     icon https://cdn.example.com/icon.svg
// @updateURL    https://example.com/update.user.js
// @downloadURL  https://example.com/download.user.js
// @run-at       document-end
// @frameweave-world USER_SCRIPT
// @grant        GM_getValue
// ==/UserScript==
GM_addStyle("body { line-height: 1.6; }");`;
  const parsed = parseUserScriptMetadata(source);
  assert.equal(parsed.headerPresent, true);
  assert.equal(parsed.metadata.name, "Example script");
  assert.equal(parsed.metadata.world, "USER_SCRIPT");
  assert.equal(parsed.metadata.requires[0], "https://cdn.example.com/helper.js");
  assert.equal(parsed.code, 'GM_addStyle("body { line-height: 1.6; }");');

  const script = normalizeUserScriptInput({ source, provenance: "import" });
  assert.equal(script.world, "USER_SCRIPT");
  assert.deepEqual(script.connects, ["api.example.com"]);
  assert.deepEqual(script.requires, ["https://cdn.example.com/helper.js"]);
  assert.deepEqual(script.resources, [{ name: "icon", url: "https://cdn.example.com/icon.svg" }]);
  assert.equal(script.updateUrl, "https://example.com/update.user.js");
  assert.equal(script.runAt, "document_end");
  assert.match(createUserScriptSource(script), /@frameweave-world USER_SCRIPT/);
});

test("rejects invalid userscript match patterns and builds a native registration", () => {
  assert.throws(
    () => normalizeUserScriptInput({
      name: "Invalid match",
      matches: ["https://example.com/no whitespace"],
      code: "console.log('x');"
    }),
    /invalid Chrome match pattern/
  );
  const broadScript = normalizeUserScriptInput({
    name: "No scope",
    matches: [],
    code: "console.log('x');"
  });
  assert.deepEqual(broadScript.matches, ["*://*/*"]);

  const script = normalizeUserScriptInput({
    name: "Stored values",
    matches: ["https://example.com/*"],
    connects: ["api.example.com"],
    grants: ["GM.setValue", "GM_addValueChangeListener"],
    world: "USER_SCRIPT",
    code: "void GM.setValue('enabled', true);"
  });
  const registration = registrationForUserScript(script, { enabled: false });
  assert.equal(registration.matches[0], "https://example.com/*");
  assert.equal(registration.world, "USER_SCRIPT");
  assert.match(registration.worldId, /^frameweave-world-/);
  assert.match(registration.js[0].code, /GM_xmlhttpRequest/);
  assert.match(registration.js[0].code, /async \(\) =>/);
  const wrapper = buildUserScriptWrapper(script, { enabled: true }, {
    requires: [{ code: "const helper = true;", sourceUrl: "https://cdn.example.com/helper.js" }],
    resources: {
      icon: { text: "<svg/>", url: "data:image/svg+xml;base64,PHN2Zy8+", contentType: "image/svg+xml" }
    }
  });
  assert.match(wrapper, /"enabled":true/);
  assert.match(wrapper, /GM_getResourceText/);
  assert.match(wrapper, /GM_registerMenuCommand/);
  assert.match(wrapper, /const helper = true/);
  assert.equal(normalizeUserScriptGrant("GM.xmlHttpRequest"), "GM_xmlhttpRequest");
  assert.equal(isValidConnectTarget("self"), true);
  assert.equal(isValidConnectTarget("https://api.example.com"), true);
  assert.equal(isValidConnectTarget("https://api.example.com/path"), false);
  assert.doesNotThrow(() => new Function(buildUserScriptWrapper(script, { enabled: true })));
});

test("accepts the exact structured AI userscript draft schema", () => {
  const payload = parseUserScriptPayload(JSON.stringify({
    name: "Reader mode helper",
    description: "Adjusts reading width.",
    matches: ["https://example.com/*"],
    excludeMatches: [],
    grants: ["GM_addStyle"],
    connects: [],
    requires: [],
    resources: [],
    updateUrl: "",
    downloadUrl: "",
    checkForUpdates: false,
    runAt: "document_idle",
    world: "USER_SCRIPT",
    code: "GM_addStyle('main{max-width:72rem}');"
  }), "test");
  assert.equal(payload.name, "Reader mode helper");
  assert.equal(payload.code, "GM_addStyle('main{max-width:72rem}');");
  assert.throws(
    () => parseUserScriptPayload({ ...payload, explanation: "not allowed" }, "test"),
    AIClientError
  );
});

test("compares remote userscript versions deterministically", () => {
  assert.equal(compareUserScriptVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareUserScriptVersions("1.2.0-beta.2", "1.2.0-beta.10"), -1);
  assert.equal(compareUserScriptVersions("1.2.0", "1.2.0-beta.10"), 1);
  assert.equal(compareUserScriptVersions("v2.0.0", "2.0.0"), 0);
});

test("caches require and resource assets before user-script registration", { concurrency: false }, async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const storage = new Map();
  let fetches = 0;
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: storage.get(key) };
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }
      }
    }
  };
  globalThis.fetch = async (url) => {
    fetches += 1;
    const source = String(url).includes("helper.js") ? "globalThis.helperLoaded = true;" : "<svg/>";
    return {
      ok: true,
      url: String(url),
      headers: new Headers({ "content-type": String(url).includes("helper.js") ? "text/javascript" : "image/svg+xml" }),
      async arrayBuffer() {
        return new TextEncoder().encode(source).buffer;
      }
    };
  };
  try {
    const script = normalizeUserScriptInput({
      id: "asset_script",
      name: "Assets",
      matches: ["https://example.com/*"],
      requires: ["https://cdn.example.com/helper.js"],
      resources: [{ name: "icon", url: "https://cdn.example.com/icon.svg" }],
      code: "void 0;"
    });
    const first = await resolveUserScriptAssets(script);
    assert.equal(first.ok, true);
    assert.equal(first.fetched, 2);
    assert.match(first.assets.requires[0].code, /helperLoaded/);
    assert.match(first.assets.resources.icon.url, /^data:image\/svg\+xml;base64,/);
    const second = await resolveUserScriptAssets(script);
    assert.equal(second.ok, true);
    assert.equal(second.cached, 2);
    assert.equal(fetches, 2);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("remote script metadata replaces an installed script during update checks", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    url: "https://example.com/updated.user.js",
    headers: new Headers({ "content-length": "300" }),
    async text() {
      return `// ==UserScript==
// @name         Updated script
// @version      2.0.0
// @match        https://updated.example/*
// ==/UserScript==
GM_addStyle("body{color:rebeccapurple}");`;
    }
  });
  try {
    const installed = normalizeUserScriptInput({
      id: "update_script",
      name: "Old script",
      version: "1.0.0",
      matches: ["https://example.com/*"],
      updateUrl: "https://example.com/updated.user.js",
      code: "void 0;"
    });
    const result = await checkUserScriptUpdate(installed);
    assert.equal(result.status, "available");
    assert.equal(result.candidate.name, "Updated script");
    assert.deepEqual(result.candidate.matches, ["https://updated.example/*"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
