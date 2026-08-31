const DEFAULT_EXTRACTION_OPTIONS = Object.freeze({
  maxNodes: 260,
  maxDepth: 8,
  allFrames: false
});

function normalizeExtractionOptions(options) {
  const raw = options && typeof options === "object" ? options : {};
  const number = (value, minimum, maximum, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(minimum, Math.min(maximum, parsed));
  };

  return {
    maxNodes: number(raw.maxNodes, 40, 500, DEFAULT_EXTRACTION_OPTIONS.maxNodes),
    maxDepth: number(raw.maxDepth, 3, 16, DEFAULT_EXTRACTION_OPTIONS.maxDepth),
    allFrames: Boolean(raw.allFrames)
  };
}

/**
 * This function is deliberately self-contained because Chrome serializes it
 * before running it in an isolated world inside the active tab.
 */
export function extractSlimDomMap(rawOptions) {
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const asBoundedInteger = (value, minimum, maximum, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(minimum, Math.min(maximum, parsed));
  };

  const maxNodes = asBoundedInteger(options.maxNodes, 40, 500, 260);
  const maxDepth = asBoundedInteger(options.maxDepth, 3, 16, 8);
  const maxScannedNodes = Math.max(maxNodes * 18, 1800);
  const omittedTags = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "path",
    "canvas",
    "video",
    "audio",
    "source",
    "picture",
    "img",
    "iframe",
    "object",
    "embed",
    "meta",
    "link"
  ]);
  const semanticTags = new Set([
    "html",
    "body",
    "header",
    "footer",
    "main",
    "nav",
    "aside",
    "section",
    "article",
    "form",
    "dialog",
    "menu",
    "table",
    "thead",
    "tbody",
    "tr",
    "ul",
    "ol",
    "li",
    "button",
    "input",
    "select",
    "textarea"
  ]);
  const interactiveTags = new Set(["a", "button", "input", "select", "textarea", "summary"]);
  const outputNodes = [];
  const emittedByElement = new WeakMap();
  const startedAt = performance.now();
  let scanned = 0;
  let hidden = 0;
  let omittedMedia = 0;
  let rejectedDepth = 0;
  let truncated = false;

  const html = document.documentElement;
  if (!html) {
    return {
      version: 1,
      viewport: { w: 0, h: 0 },
      document: { lang: "", dir: "" },
      nodes: [],
      summary: { scanned: 0, emitted: 0, truncated: false, elapsedMs: 0 }
    };
  }

  const clampString = (value, limit) => {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim().slice(0, limit);
  };

  const isLikelyGeneratedToken = (token) => {
    if (
      token.length > 48 ||
      /^[a-f0-9]{7,}$/i.test(token) ||
      /^(css|sc|jsx|emotion|styled)-/i.test(token) ||
      /__[A-Za-z0-9_-]{5,}$/.test(token) ||
      /[a-f0-9]{8,}/i.test(token)
    ) {
      return true;
    }
    return false;
  };

  const structuralClasses = (element) => {
    if (typeof element.className !== "string") {
      return [];
    }

    const unique = new Set();
    for (const token of element.className.split(/\s+/)) {
      const normalized = clampString(token, 48);
      if (
        normalized &&
        /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(normalized) &&
        !isLikelyGeneratedToken(normalized)
      ) {
        unique.add(normalized);
      }
      if (unique.size >= 6) {
        break;
      }
    }
    return Array.from(unique);
  };

  const stableId = (element) => {
    const id = clampString(element.id, 64);
    if (
      !id ||
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) ||
      /(?:email|password|token|secret|session|account|customer|user-?\d)/i.test(id)
    ) {
      return "";
    }
    return id;
  };

  const elementDepth = (element) => {
    let depth = 0;
    let current = element;
    while (current && current !== html && depth <= maxDepth + 1) {
      current = current.parentElement;
      depth += 1;
    }
    return depth;
  };

  const nearestEmittedParent = (element) => {
    let current = element.parentElement;
    while (current) {
      const index = emittedByElement.get(current);
      if (Number.isInteger(index)) {
        return index;
      }
      current = current.parentElement;
    }
    return null;
  };

  const selectorHint = (tag, id, classes) => {
    if (id) {
      return "#" + CSS.escape(id);
    }
    if (classes.length > 0) {
      return tag + "." + classes.slice(0, 3).map((item) => CSS.escape(item)).join(".");
    }
    return "";
  };

  const classifier = (element, style, tag) => {
    const display = style.display;
    const position = style.position;
    const visibility = style.visibility;
    const rect = element.getBoundingClientRect();
    const isVisible =
      display !== "none" &&
      visibility !== "hidden" &&
      visibility !== "collapse" &&
      rect.width > 0 &&
      rect.height > 0 &&
      element.getAttribute("aria-hidden") !== "true";

    if (!isVisible) {
      return { include: false, hidden: true };
    }

    const id = stableId(element);
    const classes = structuralClasses(element);
    const childCount = element.children.length;
    const interactive = interactiveTags.has(tag) || element.hasAttribute("contenteditable") || element.hasAttribute("role");
    const landmark = semanticTags.has(tag);
    const layout =
      display === "grid" ||
      display === "inline-grid" ||
      display === "flex" ||
      display === "inline-flex" ||
      position === "fixed" ||
      position === "sticky";

    return {
      include: landmark || Boolean(id) || classes.length > 0 || childCount >= 2 || interactive || layout,
      id,
      classes,
      childCount,
      interactive,
      layout: display === "grid" || display === "inline-grid"
        ? "grid"
        : display === "flex" || display === "inline-flex"
          ? "flex"
          : position === "fixed" || position === "sticky"
            ? position
            : ""
    };
  };

  const walker = document.createTreeWalker(
    html,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(element) {
        const tag = element.tagName.toLowerCase();
        if (omittedTags.has(tag)) {
          if (tag === "img" || tag === "picture" || tag === "video" || tag === "canvas" || tag === "iframe") {
            omittedMedia += 1;
          }
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let current = walker.currentNode;
  while (current) {
    scanned += 1;
    if (scanned > maxScannedNodes || outputNodes.length >= maxNodes) {
      truncated = true;
      break;
    }

    const depth = elementDepth(current);
    if (depth > maxDepth) {
      rejectedDepth += 1;
      current = walker.nextNode();
      continue;
    }

    const tag = current.tagName.toLowerCase();
    const style = window.getComputedStyle(current);
    const details = classifier(current, style, tag);
    if (details.hidden) {
      hidden += 1;
    }

    if (details.include || current === html || current === document.body) {
      const index = outputNodes.length;
      const node = {
        n: index,
        t: tag
      };
      const parent = nearestEmittedParent(current);
      if (parent !== null) {
        node.p = parent;
      }
      if (details.id) {
        node.i = details.id;
      }
      if (details.classes && details.classes.length > 0) {
        node.c = details.classes.join(" ");
      }
      if (details.layout) {
        node.l = details.layout;
      }
      if (details.interactive) {
        node.a = tag;
      }
      const hint = selectorHint(tag, details.id || "", details.classes || []);
      if (hint) {
        node.q = hint;
      }
      outputNodes.push(node);
      emittedByElement.set(current, index);
    }

    current = walker.nextNode();
  }

  return {
    version: 1,
    viewport: {
      w: Math.max(0, Math.round(window.innerWidth)),
      h: Math.max(0, Math.round(window.innerHeight))
    },
    document: {
      lang: clampString(document.documentElement.lang, 20),
      dir: document.dir === "rtl" ? "rtl" : "ltr"
    },
    nodes: outputNodes,
    summary: {
      scanned,
      emitted: outputNodes.length,
      hidden,
      omittedMedia,
      rejectedDepth,
      truncated,
      elapsedMs: Math.round(performance.now() - startedAt)
    }
  };
}

export async function extractDomMap(tabId, rawOptions) {
  const options = normalizeExtractionOptions(rawOptions);
  const results = await chrome.scripting.executeScript({
    target: {
      tabId,
      allFrames: options.allFrames
    },
    func: extractSlimDomMap,
    args: [options],
    injectImmediately: true,
    world: "ISOLATED"
  });

  const maps = results
    .filter((entry) => entry && entry.result && typeof entry.result === "object")
    .map((entry) => ({
      frameId: entry.frameId,
      map: entry.result
    }));

  if (maps.length === 0) {
    throw new Error("No readable document was found in the active tab.");
  }

  if (options.allFrames) {
    return {
      version: 1,
      frames: maps
    };
  }

  return maps[0].map;
}
