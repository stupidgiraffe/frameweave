/**
 * A self-contained, isolated-world picker. It returns only structural target
 * metadata: never page text, input values, images, or other content payloads.
 */
export function installElementPicker() {
  const runtimeKey = "__frameweave_element_picker_v1__";
  const existing = globalThis[runtimeKey];
  if (existing && typeof existing.stop === "function") {
    return {
      active: true,
      alreadyActive: true
    };
  }

  if (!document.body) {
    throw new Error("The page body is not ready for element selection.");
  }

  const overlayId = "frameweave-picker-overlay";
  const highlightId = "frameweave-picker-highlight";
  const tooltipId = "frameweave-picker-tooltip";
  const styleId = "frameweave-picker-styles";
  const maxSelectorDepth = 6;
  const shadowSeparator = " >>> ";
  let currentElement = null;
  let overlay = null;
  let highlight = null;
  let tooltip = null;
  let stopped = false;

  const send = (message) => {
    try {
      chrome.runtime.sendMessage(message);
    } catch {
      // The extension may have been reloaded while the picker was open.
    }
  };

  const escapeCss = (value) => {
    try {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(String(value));
      }
    } catch {
      // Fall through to a conservative escape.
    }
    return String(value).replace(/([^a-zA-Z0-9_\u00A0-\uFFFF-])/g, "\\\\$1");
  };

  const isPickerNode = (element) => {
    if (!element || typeof element.closest !== "function") {
      return false;
    }
    return Boolean(
      element.id === overlayId ||
      element.id === highlightId ||
      element.id === tooltipId ||
      element.closest("#" + overlayId) ||
      element.closest("#" + highlightId) ||
      element.closest("#" + tooltipId)
    );
  };

  const isSensitive = (element) => {
    if (!element || typeof element.matches !== "function") {
      return false;
    }
    return element.matches(
      'input[type="password"], input[autocomplete*="cc-"], input[autocomplete*="one-time-code"], [contenteditable="true"]'
    );
  };

  const safeClasses = (element) => {
    const className = typeof element.className === "string"
      ? element.className
      : element.getAttribute && element.getAttribute("class") || "";
    const classes = [];
    for (const token of String(className).split(/\s+/)) {
      if (
        token &&
        token.length <= 48 &&
        /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(token) &&
        !token.startsWith("frameweave-") &&
        !/^(css|sc|jsx|emotion|styled)-/i.test(token) &&
        !/[a-f0-9]{8,}/i.test(token)
      ) {
        classes.push(token);
      }
      if (classes.length === 3) {
        break;
      }
    }
    return classes;
  };

  const isUnique = (root, selector, element) => {
    try {
      const matches = root.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch {
      return false;
    }
  };

  const segmentFor = (element) => {
    const tag = element.tagName.toLowerCase();
    const classes = safeClasses(element);
    let segment = tag;
    if (classes.length) {
      segment += "." + classes.map(escapeCss).join(".");
    }

    const parent = element.parentElement || element.parentNode;
    if (parent && parent.children) {
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
      if (sameTag.length > 1) {
        segment += ":nth-of-type(" + (sameTag.indexOf(element) + 1) + ")";
      }
    }
    return segment;
  };

  const selectorInRoot = (element, root) => {
    const id = typeof element.id === "string" ? element.id.trim() : "";
    if (id) {
      const idSelector = "#" + escapeCss(id);
      if (isUnique(root, idSelector, element)) {
        return idSelector;
      }
    }

    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < maxSelectorDepth) {
      const currentId = typeof current.id === "string" ? current.id.trim() : "";
      if (current !== element && currentId) {
        const idSelector = "#" + escapeCss(currentId);
        if (isUnique(root, idSelector, current)) {
          parts.unshift(idSelector);
          const candidate = parts.join(" > ");
          if (isUnique(root, candidate, element)) {
            return candidate;
          }
          break;
        }
      }

      parts.unshift(segmentFor(current));
      const candidate = parts.join(" > ");
      if (isUnique(root, candidate, element)) {
        return candidate;
      }
      current = current.parentElement;
    }

    return parts.join(" > ");
  };

  const selectorDescriptor = (element) => {
    const segments = [];
    const modes = [];
    let current = element;
    for (let depth = 0; current && depth < 10; depth += 1) {
      const root = current.getRootNode ? current.getRootNode() : document;
      segments.unshift(selectorInRoot(current, root));
      if (root && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && root.host) {
        modes.unshift(root.mode || "closed");
        current = root.host;
      } else {
        break;
      }
    }

    return {
      selector: segments.join(shadowSeparator),
      segments,
      inShadowDom: segments.length > 1,
      shadowRootMode: modes.includes("closed") ? "closed" : modes.length ? "open" : null
    };
  };

  const interactionHints = (element, descriptor) => {
    const hints = [];
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      hints.push("form-control");
    }
    if (tag === "button" || element.matches('[role="button"], a[href], [data-action]')) {
      hints.push("clickable");
    }
    if (element.closest("form")) {
      hints.push("form-related");
    }
    if (descriptor.inShadowDom) {
      hints.push("shadow-dom");
    }
    return hints;
  };

  const describe = (element) => {
    const descriptor = selectorDescriptor(element);
    const rect = element.getBoundingClientRect();
    const id = typeof element.id === "string" && element.id.length <= 64 ? element.id : "";
    return {
      version: 1,
      tag: element.tagName.toLowerCase(),
      selector: descriptor.selector,
      segments: descriptor.segments,
      inShadowDom: descriptor.inShadowDom,
      shadowRootMode: descriptor.shadowRootMode,
      stableAttributes: {
        id,
        classes: safeClasses(element)
      },
      interactionHints: interactionHints(element, descriptor),
      rect: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  };

  const ensureUi = () => {
    document.getElementById(styleId)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = [
      "#" + overlayId + "{position:fixed!important;inset:0!important;z-index:2147483645!important;pointer-events:none!important;}",
      "#" + highlightId + "{position:fixed!important;z-index:2147483646!important;pointer-events:none!important;display:none!important;outline:2px solid #6d7cff!important;outline-offset:2px!important;background:rgba(109,124,255,.15)!important;border-radius:3px!important;}",
      "#" + tooltipId + "{position:fixed!important;z-index:2147483647!important;pointer-events:none!important;display:none!important;max-width:340px!important;padding:9px 11px!important;border:1px solid rgba(175,190,255,.66)!important;border-radius:9px!important;background:#101a35!important;color:#eff4ff!important;box-shadow:0 12px 35px rgba(0,0,0,.34)!important;font:12px/1.4 ui-sans-serif,system-ui,sans-serif!important;}",
      "#" + tooltipId + " .frameweave-picker-selector{color:#91a2ff!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important;overflow-wrap:anywhere!important;}",
      "#" + tooltipId + " .frameweave-picker-hint{margin-top:4px!important;color:#b9c5e6!important;font-size:11px!important;}",
      "body.frameweave-picker-active,body.frameweave-picker-active *{cursor:crosshair!important;}"
    ].join("");
    document.head.append(style);

    overlay = document.createElement("div");
    overlay.id = overlayId;
    highlight = document.createElement("div");
    highlight.id = highlightId;
    tooltip = document.createElement("div");
    tooltip.id = tooltipId;
    document.body.append(overlay, highlight, tooltip);
    document.body.classList.add("frameweave-picker-active");
  };

  const hide = () => {
    if (highlight) {
      highlight.style.display = "none";
    }
    if (tooltip) {
      tooltip.style.display = "none";
    }
  };

  const render = (element, x, y) => {
    if (!highlight || !tooltip || !element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      hide();
      return;
    }
    highlight.style.top = rect.top + "px";
    highlight.style.left = rect.left + "px";
    highlight.style.width = rect.width + "px";
    highlight.style.height = rect.height + "px";
    highlight.style.display = "block";

    const descriptor = selectorDescriptor(element);
    tooltip.replaceChildren();
    const selector = document.createElement("div");
    selector.className = "frameweave-picker-selector";
    selector.textContent = descriptor.selector.length > 180
      ? descriptor.selector.slice(0, 180) + "…"
      : descriptor.selector;
    const hint = document.createElement("div");
    hint.className = "frameweave-picker-hint";
    hint.textContent = isSensitive(element)
      ? "Sensitive target — selection is blocked"
      : descriptor.shadowRootMode === "closed"
        ? "Closed shadow root — styling may be limited"
        : "Click to target this element · Esc to cancel";
    tooltip.append(selector, hint);
    tooltip.style.display = "block";

    const tooltipRect = tooltip.getBoundingClientRect();
    const left = x + tooltipRect.width + 16 > window.innerWidth ? x - tooltipRect.width - 14 : x + 14;
    const top = y + tooltipRect.height + 16 > window.innerHeight ? y - tooltipRect.height - 14 : y + 14;
    tooltip.style.left = Math.max(8, left) + "px";
    tooltip.style.top = Math.max(8, top) + "px";
  };

  const eventTarget = (event) => {
    let target = null;
    try {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      target = path.find((node) => node && node.nodeType === Node.ELEMENT_NODE) || null;
    } catch {
      target = null;
    }
    return target || (event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : null);
  };

  const onPointerMove = (event) => {
    const target = eventTarget(event);
    if (!target || isPickerNode(target)) {
      return;
    }
    currentElement = target;
    render(target, event.clientX, event.clientY);
  };

  const onClick = (event) => {
    const target = eventTarget(event);
    if (!target || isPickerNode(target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (isSensitive(target)) {
      return;
    }
    const selection = describe(target);
    stop();
    send({
      type: "frameweave.picker.selection",
      selection
    });
  };

  const onKeyDown = (event) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    stop();
    send({ type: "frameweave.picker.cancel" });
  };

  const onScroll = () => {
    if (currentElement) {
      const rect = currentElement.getBoundingClientRect();
      render(currentElement, rect.left, rect.top);
    }
  };

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", onScroll, true);
    document.body.classList.remove("frameweave-picker-active");
    for (const id of [overlayId, highlightId, tooltipId, styleId]) {
      document.getElementById(id)?.remove();
    }
    delete globalThis[runtimeKey];
  };

  globalThis[runtimeKey] = { stop };
  ensureUi();
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("scroll", onScroll, true);
  return { active: true, alreadyActive: false };
}

/**
 * Self-contained stop helper for chrome.scripting.executeScript serialization.
 */
export function stopElementPicker() {
  const runtime = globalThis.__frameweave_element_picker_v1__;
  if (runtime && typeof runtime.stop === "function") {
    runtime.stop();
    return { stopped: true };
  }
  return { stopped: false };
}

export async function startPickerInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: installElementPicker,
    world: "ISOLATED",
    injectImmediately: true
  });
  return results[0] && results[0].result ? results[0].result : { active: true };
}

export async function stopPickerInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: stopElementPicker,
    world: "ISOLATED",
    injectImmediately: true
  });
  return results[0] && results[0].result ? results[0].result : { stopped: false };
}
