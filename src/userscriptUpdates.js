import { normalizeRemoteUrl, normalizeUserScriptInput } from "./userscriptMetadata.js";

const MAX_UPDATE_SOURCE_BYTES = 2_000_000;
const UPDATE_FETCH_TIMEOUT_MS = 60_000;

function asErrorMessage(error) {
  return String(error && error.message ? error.message : error || "Unknown update error.").slice(0, 1_000);
}

function versionParts(version) {
  const raw = String(version || "").trim().replace(/^v/i, "");
  const [core, prerelease = ""] = raw.split("+", 1)[0].split("-", 2);
  const numeric = core.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part.toLowerCase());
  const prereleaseParts = prerelease
    ? prerelease.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part.toLowerCase())
    : [];
  return { numeric, prerelease: prereleaseParts };
}

function comparePart(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  return String(left).localeCompare(String(right));
}

export function compareUserScriptVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.numeric.length, b.numeric.length);
  for (let index = 0; index < length; index += 1) {
    const result = comparePart(a.numeric[index] === undefined ? 0 : a.numeric[index], b.numeric[index] === undefined ? 0 : b.numeric[index]);
    if (result) return result > 0 ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const result = comparePart(a.prerelease[index], b.prerelease[index]);
    if (result) return result > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchUpdateSource(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), UPDATE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " while checking " + url + ".");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPDATE_SOURCE_BYTES) {
      throw new Error("Updated source exceeds the 2 MB runtime source limit.");
    }
    const source = await response.text();
    if (!source.trim()) {
      throw new Error("Update endpoint returned an empty source file.");
    }
    if (source.length > MAX_UPDATE_SOURCE_BYTES) {
      throw new Error("Updated source exceeds the 2 MB runtime source limit.");
    }
    return { source, sourceUrl: response.url || url };
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "timeout") {
      throw new Error("Update check timed out after 60 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function withUpdateStatus(script, patch) {
  return {
    ...script,
    ...patch,
    lastUpdateCheckAt: Date.now()
  };
}

export async function checkUserScriptUpdate(script) {
  if (!script || typeof script.id !== "string") {
    throw new Error("A saved userscript is required to check for updates.");
  }
  const endpoint = normalizeRemoteUrl(script.updateUrl || script.downloadUrl, "Update URL");
  if (!endpoint) {
    return {
      status: "unconfigured",
      message: "This userscript has no @updateURL or @downloadURL.",
      script: withUpdateStatus(script, { lastUpdateError: "" }),
      candidate: null
    };
  }

  try {
    const downloaded = await fetchUpdateSource(endpoint);
    const candidate = normalizeUserScriptInput({
      id: script.id,
      source: downloaded.source,
      sourceUrl: downloaded.sourceUrl,
      enabled: script.enabled,
      order: script.order,
      checkForUpdates: script.checkForUpdates,
      provenance: "update",
      lastUpdateCheckAt: Date.now(),
      lastUpdateError: ""
    }, script);
    const comparison = compareUserScriptVersions(candidate.version, script.version);
    const state = withUpdateStatus(script, { lastUpdateError: "" });
    if (comparison <= 0) {
      return {
        status: "current",
        message: comparison < 0
          ? "The remote source is older than the installed version."
          : "The installed version is current.",
        script: state,
        candidate: null
      };
    }
    return {
      status: "available",
      message: "Version " + candidate.version + " is available (installed: " + script.version + ").",
      script: state,
      candidate
    };
  } catch (error) {
    const message = asErrorMessage(error);
    return {
      status: "error",
      message,
      script: withUpdateStatus(script, { lastUpdateError: message }),
      candidate: null
    };
  }
}

export function applyUserScriptUpdate(script, candidate) {
  if (!script || !candidate || script.id !== candidate.id) {
    throw new Error("The proposed update does not belong to this userscript.");
  }
  return {
    ...candidate,
    id: script.id,
    order: script.order,
    enabled: script.enabled,
    checkForUpdates: script.checkForUpdates,
    createdAt: script.createdAt,
    provenance: "update",
    sourceUrl: candidate.sourceUrl || script.sourceUrl,
    lastUpdateCheckAt: Date.now(),
    lastRemoteUpdateAt: Date.now(),
    lastUpdateError: ""
  };
}
