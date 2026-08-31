const SESSION_PREFIX = "frameweave.injection.v1.";
const MAX_CSS_LENGTH = 100000;
const MAX_AUTOMATION_LENGTH = 60000;
const MAX_STEPS = 80;
const MAX_NESTED_DEPTH = 2;

const ACTION_TYPES = new Set([
  "addClass",
  "removeClass",
  "toggleClass",
  "setStyle",
  "setAttribute",
  "removeAttribute",
  "setText",
  "setValue",
  "click",
  "focus",
  "scrollIntoView",
  "remove",
  "insert",
  "dispatch",
  "wait",
  "on",
  "observe"
]);

export class InjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InjectionError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowedKeys, requiredKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new InjectionError("invalid_program", label + " contains an unsupported field: " + key + ".");
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new InjectionError("invalid_program", label + " is missing required field: " + key + ".");
    }
  }
}

function requireString(value, field, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new InjectionError("invalid_program", field + " must be a non-empty string of at most " + limit + " characters.");
  }
  return value.trim();
}

function optionalString(value, field, limit) {
  if (value === undefined) {
    return "";
  }
  return requireString(value, field, limit);
}

function requireSelector(step, label) {
  const selector = requireString(step.selector, label + ".selector", 240);
  if (selector.includes(":has(")) {
    throw new InjectionError("invalid_program", label + ".selector may not use :has().");
  }
  const shadowSegments = selector.split(/\s*>>>\s*/);
  if (shadowSegments.length > 10 || shadowSegments.some((segment) => !segment.trim())) {
    throw new InjectionError(
      "invalid_program",
      label + ".selector contains an invalid open-shadow-root selector path."
    );
  }
  return selector;
}

function validateClassName(value, label) {
  const className = requireString(value, label, 180);
  if (!/^[A-Za-z_-][A-Za-z0-9_ -]*$/.test(className)) {
    throw new InjectionError("invalid_program", label + " must contain valid CSS class tokens.");
  }
  return className;
}

function validateAttributeName(value, label) {
  const name = requireString(value, label, 64).toLowerCase();
  if (!/^(aria-[a-z0-9_-]+|data-[a-z0-9_-]+|role|title|tabindex|hidden)$/.test(name)) {
    throw new InjectionError("invalid_program", label + " is not an allowed safe attribute.");
  }
  return name;
}

function validateEventName(value, label) {
  const event = requireString(value, label, 32);
  const allowedEvents = new Set([
    "click",
    "change",
    "input",
    "keydown",
    "keyup",
    "mouseenter",
    "mouseleave",
    "focus",
    "blur"
  ]);
  if (!allowedEvents.has(event)) {
    throw new InjectionError("invalid_program", label + " is not an allowed event.");
  }
  return event;
}

function validateAttributes(value, label) {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new InjectionError("invalid_program", label + " must be an object.");
  }

  const result = {};
  const entries = Object.entries(value);
  if (entries.length > 12) {
    throw new InjectionError("invalid_program", label + " may contain at most 12 attributes.");
  }
  for (const [name, attributeValue] of entries) {
    const safeName = validateAttributeName(name, label + "." + name);
    if (typeof attributeValue !== "string" || attributeValue.length > 300) {
      throw new InjectionError("invalid_program", label + "." + name + " must be a string of at most 300 characters.");
    }
    result[safeName] = attributeValue;
  }
  return result;
}

function validateSteps(rawSteps, depth, state) {
  if (!Array.isArray(rawSteps)) {
    throw new InjectionError("invalid_program", "AutomationProgram.steps must be an array.");
  }
  if (rawSteps.length > MAX_STEPS) {
    throw new InjectionError("invalid_program", "AutomationProgram has too many steps.");
  }
  const validationState = state || { count: 0 };

  return rawSteps.map((rawStep, index) => {
    const label = "steps[" + index + "]";
    if (!isPlainObject(rawStep)) {
      throw new InjectionError("invalid_program", label + " must be an object.");
    }
    validationState.count += 1;
    if (validationState.count > MAX_STEPS) {
      throw new InjectionError("invalid_program", "AutomationProgram has too many total steps.");
    }

    const type = requireString(rawStep.type, label + ".type", 32);
    if (!ACTION_TYPES.has(type)) {
      throw new InjectionError("invalid_program", label + ".type is not supported.");
    }

    const step = { type };
    switch (type) {
      case "addClass":
      case "removeClass":
      case "toggleClass":
        assertExactKeys(rawStep, ["type", "selector", "className"], ["type", "selector", "className"], label);
        step.selector = requireSelector(rawStep, label);
        step.className = validateClassName(rawStep.className, label + ".className");
        if (type === "toggleClass" && step.className.split(/\s+/).length !== 1) {
          throw new InjectionError("invalid_program", label + ".className must be one class for toggleClass.");
        }
        break;
      case "setStyle":
        assertExactKeys(rawStep, ["type", "selector", "property", "value"], ["type", "selector", "property", "value"], label);
        step.selector = requireSelector(rawStep, label);
        step.property = requireString(rawStep.property, label + ".property", 64);
        step.value = requireString(rawStep.value, label + ".value", 500);
        if (!/^(--[A-Za-z0-9_-]+|[a-z-]+)$/.test(step.property) || /url\s*\(|expression\s*\(/i.test(step.value)) {
          throw new InjectionError("invalid_program", label + " contains an unsafe style declaration.");
        }
        break;
      case "setAttribute":
        assertExactKeys(rawStep, ["type", "selector", "name", "value"], ["type", "selector", "name", "value"], label);
        step.selector = requireSelector(rawStep, label);
        step.name = validateAttributeName(rawStep.name, label + ".name");
        step.value = requireString(rawStep.value, label + ".value", 500);
        break;
      case "removeAttribute":
        assertExactKeys(rawStep, ["type", "selector", "name"], ["type", "selector", "name"], label);
        step.selector = requireSelector(rawStep, label);
        step.name = validateAttributeName(rawStep.name, label + ".name");
        break;
      case "setText":
        assertExactKeys(rawStep, ["type", "selector", "text"], ["type", "selector", "text"], label);
        step.selector = requireSelector(rawStep, label);
        if (typeof rawStep.text !== "string" || rawStep.text.length > 2000) {
          throw new InjectionError("invalid_program", label + ".text must be a string of at most 2000 characters.");
        }
        step.text = rawStep.text;
        break;
      case "setValue":
        assertExactKeys(rawStep, ["type", "selector", "value"], ["type", "selector", "value"], label);
        step.selector = requireSelector(rawStep, label);
        if (typeof rawStep.value !== "string" || rawStep.value.length > 2000) {
          throw new InjectionError("invalid_program", label + ".value must be a string of at most 2000 characters.");
        }
        step.value = rawStep.value;
        break;
      case "click":
      case "focus":
      case "scrollIntoView":
      case "remove":
        assertExactKeys(rawStep, ["type", "selector"], ["type", "selector"], label);
        step.selector = requireSelector(rawStep, label);
        break;
      case "dispatch":
        assertExactKeys(rawStep, ["type", "selector", "event"], ["type", "selector", "event"], label);
        step.selector = requireSelector(rawStep, label);
        step.event = validateEventName(rawStep.event, label + ".event");
        break;
      case "wait":
        assertExactKeys(rawStep, ["type", "milliseconds"], ["type", "milliseconds"], label);
        if (!Number.isInteger(rawStep.milliseconds) || rawStep.milliseconds < 0 || rawStep.milliseconds > 5000) {
          throw new InjectionError("invalid_program", label + ".milliseconds must be an integer from 0 through 5000.");
        }
        step.milliseconds = rawStep.milliseconds;
        break;
      case "insert": {
        assertExactKeys(
          rawStep,
          ["type", "selector", "placement", "tag", "text", "className", "attributes"],
          ["type", "selector", "placement", "tag"],
          label
        );
        step.selector = requireSelector(rawStep, label);
        step.placement = requireString(rawStep.placement, label + ".placement", 16);
        if (!["append", "prepend", "before", "after"].includes(step.placement)) {
          throw new InjectionError("invalid_program", label + ".placement is not supported.");
        }
        step.tag = requireString(rawStep.tag, label + ".tag", 32).toLowerCase();
        if (!["div", "span", "section", "aside", "p", "button", "small", "strong", "em", "ul", "li"].includes(step.tag)) {
          throw new InjectionError("invalid_program", label + ".tag is not allowed.");
        }
        if (rawStep.text !== undefined && (typeof rawStep.text !== "string" || rawStep.text.length > 2000)) {
          throw new InjectionError("invalid_program", label + ".text must be a string of at most 2000 characters.");
        }
        step.text = rawStep.text || "";
        step.className = rawStep.className === undefined ? "" : validateClassName(rawStep.className, label + ".className");
        step.attributes = validateAttributes(rawStep.attributes, label + ".attributes");
        break;
      }
      case "on":
      case "observe":
        if (depth >= MAX_NESTED_DEPTH) {
          throw new InjectionError("invalid_program", label + " exceeds the maximum automation nesting depth.");
        }
        assertExactKeys(
          rawStep,
          type === "on"
            ? ["type", "selector", "event", "actions", "once", "preventDefault"]
            : ["type", "selector", "actions", "once"],
          type === "on"
            ? ["type", "selector", "event", "actions"]
            : ["type", "selector", "actions"],
          label
        );
        step.selector = requireSelector(rawStep, label);
        if (type === "on") {
          step.event = validateEventName(rawStep.event, label + ".event");
          step.preventDefault = Boolean(rawStep.preventDefault);
        }
        if (rawStep.once !== undefined && typeof rawStep.once !== "boolean") {
          throw new InjectionError("invalid_program", label + ".once must be a boolean.");
        }
        step.once = Boolean(rawStep.once);
        step.actions = validateSteps(rawStep.actions, depth + 1, validationState);
        break;
      default:
        throw new InjectionError("invalid_program", label + ".type is not supported.");
    }
    return step;
  });
}

export function parseAutomationProgram(raw) {
  if (typeof raw !== "string") {
    throw new InjectionError("invalid_program", "javascript must be a JSON-serialized AutomationProgram.");
  }
  if (raw.length > MAX_AUTOMATION_LENGTH) {
    throw new InjectionError("program_too_large", "The automation program exceeds the safety limit.");
  }
  if (!raw.trim()) {
    return {
      version: 1,
      steps: []
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InjectionError("invalid_program_json", "javascript is not valid JSON: " + String(error.message).slice(0, 300));
  }

  if (!isPlainObject(parsed)) {
    throw new InjectionError("invalid_program", "AutomationProgram must be a JSON object.");
  }
  assertExactKeys(parsed, ["version", "steps"], ["version", "steps"], "AutomationProgram");
  if (parsed.version !== 1) {
    throw new InjectionError("unsupported_program", "Only AutomationProgram version 1 is supported.");
  }

  return {
    version: 1,
    steps: validateSteps(parsed.steps, 0, { count: 0 })
  };
}

export function validateCss(rawCss) {
  if (typeof rawCss !== "string") {
    throw new InjectionError("invalid_css", "css must be a string.");
  }
  if (rawCss.length > MAX_CSS_LENGTH) {
    throw new InjectionError("css_too_large", "The CSS payload exceeds the safety limit.");
  }

  const css = rawCss.trim();
  if (/@import\b|@font-face\b|url\s*\(|expression\s*\(|-moz-binding\b|behavior\s*:/i.test(css)) {
    throw new InjectionError("unsafe_css", "CSS may not import or load external resources.");
  }
  return css;
}

function sessionKey(tabId) {
  return SESSION_PREFIX + String(tabId);
}

async function getStoredInjection(tabId) {
  const key = sessionKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return isPlainObject(stored[key]) ? stored[key] : null;
}

async function removeStoredCss(tabId, existingRecord) {
  const key = sessionKey(tabId);
  const record = existingRecord || await getStoredInjection(tabId);
  if (!record) {
    return false;
  }

  if (typeof record.css === "string" && record.css) {
    try {
      await chrome.scripting.removeCSS({
        target: {
          tabId,
          allFrames: Boolean(record.allFrames)
        },
        css: record.css,
        origin: "USER"
      });
    } catch {
      // A tab may have navigated or closed since the last injection.
    }
  }
  await chrome.storage.session.remove(key);
  return Boolean(record.css);
}

/**
 * Self-contained for chrome.scripting.executeScript serialization.
 */
export function cleanupAutomationRuntime() {
  const runtimeKey = "__frameweave_automation_runtime_v1__";
  const runtime = globalThis[runtimeKey];
  if (!runtime || typeof runtime !== "object") {
    return { cleaned: 0 };
  }

  let cleaned = 0;
  for (const controller of runtime.controllers || []) {
    try {
      controller.abort();
      cleaned += 1;
    } catch {
      // Ignore already-released listeners.
    }
  }
  for (const observer of runtime.observers || []) {
    try {
      observer.disconnect();
      cleaned += 1;
    } catch {
      // Ignore already-disconnected observers.
    }
  }
  for (const node of runtime.createdNodes || []) {
    try {
      node.remove();
      cleaned += 1;
    } catch {
      // The page may already have removed it.
    }
  }
  delete globalThis[runtimeKey];
  return { cleaned };
}

/**
 * Self-contained for chrome.scripting.executeScript serialization. It only
 * interprets the validated declarative program passed as data; it never evals
 * model-generated source text.
 */
export async function executeAutomationProgram(program) {
  const runtimeKey = "__frameweave_automation_runtime_v1__";
  const previous = globalThis[runtimeKey];
  if (previous && typeof previous === "object") {
    for (const controller of previous.controllers || []) {
      try {
        controller.abort();
      } catch {
        // Best-effort cleanup.
      }
    }
    for (const observer of previous.observers || []) {
      try {
        observer.disconnect();
      } catch {
        // Best-effort cleanup.
      }
    }
    for (const node of previous.createdNodes || []) {
      try {
        node.remove();
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  const runtime = {
    controllers: [],
    observers: [],
    createdNodes: []
  };
  globalThis[runtimeKey] = runtime;

  const summary = {
    applied: 0,
    skipped: 0,
    errors: []
  };
  const addError = (message) => {
    if (summary.errors.length < 12) {
      summary.errors.push(String(message).slice(0, 180));
    }
  };
  const isProtected = (element) => {
    if (!element || !element.matches) {
      return false;
    }
    return element.matches(
      'input[type="password"], input[autocomplete*="cc-"], input[autocomplete*="one-time-code"], [contenteditable="true"]'
    );
  };
  const safeElements = (selector) => {
    const segments = String(selector)
      .split(/\s*>>>\s*/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (!segments.length || segments.length > 10) {
      addError("Invalid selector skipped.");
      return [];
    }

    let roots = [document];
    for (let index = 0; index < segments.length; index += 1) {
      const matches = [];
      for (const root of roots) {
        try {
          matches.push(...Array.from(root.querySelectorAll(segments[index])));
        } catch {
          addError("Invalid selector skipped.");
          return [];
        }
        if (matches.length >= 50) {
          break;
        }
      }

      if (index === segments.length - 1) {
        return matches.slice(0, 50);
      }

      roots = matches
        .map((element) => element.shadowRoot)
        .filter((root) => root && typeof root.querySelectorAll === "function");
      if (!roots.length) {
        return [];
      }
    }
    return [];
  };
  const markApplied = (count) => {
    summary.applied += count;
  };
  const markSkipped = (count) => {
    summary.skipped += count;
  };
  const classTokens = (value) => String(value).split(/\s+/).filter(Boolean);
  const safeMutationTargets = (selector) => {
    const elements = safeElements(selector);
    const safe = elements.filter((element) => !isProtected(element));
    markSkipped(elements.length - safe.length);
    return safe;
  };
  const selectorHasProtectedTarget = (selector) => safeElements(selector).some((element) => isProtected(element));
  const runSteps = async (steps) => {
    for (const step of steps) {
      if (step.type === "wait") {
        await new Promise((resolve) => setTimeout(resolve, step.milliseconds));
        markApplied(1);
        continue;
      }

      if (step.type === "on") {
        const elements = safeMutationTargets(step.selector);
        for (const element of elements) {
          const controller = new AbortController();
          runtime.controllers.push(controller);
          element.addEventListener(
            step.event,
            (event) => {
              if (step.preventDefault) {
                event.preventDefault();
              }
              void runSteps(step.actions).catch((error) => {
                addError(error && error.message ? error.message : "Event automation failed.");
              });
            },
            {
              once: step.once,
              signal: controller.signal
            }
          );
          markApplied(1);
        }
        continue;
      }

      if (step.type === "observe") {
        const elements = safeMutationTargets(step.selector);
        for (const element of elements) {
          let running = false;
          const observer = new MutationObserver(() => {
            if (running) {
              return;
            }
            running = true;
            void runSteps(step.actions)
              .catch((error) => {
                addError(error && error.message ? error.message : "Observer automation failed.");
              })
              .finally(() => {
                running = false;
                if (step.once) {
                  observer.disconnect();
                }
              });
          });
          observer.observe(element, {
            childList: true,
            subtree: true
          });
          runtime.observers.push(observer);
          markApplied(1);
        }
        continue;
      }

      const elements = safeMutationTargets(step.selector);
      if (elements.length === 0) {
        continue;
      }

      if (step.type === "addClass") {
        for (const element of elements) {
          element.classList.add(...classTokens(step.className));
        }
        markApplied(elements.length);
      } else if (step.type === "removeClass") {
        for (const element of elements) {
          element.classList.remove(...classTokens(step.className));
        }
        markApplied(elements.length);
      } else if (step.type === "toggleClass") {
        for (const element of elements) {
          element.classList.toggle(classTokens(step.className)[0]);
        }
        markApplied(elements.length);
      } else if (step.type === "setStyle") {
        for (const element of elements) {
          element.style.setProperty(step.property, step.value);
        }
        markApplied(elements.length);
      } else if (step.type === "setAttribute") {
        for (const element of elements) {
          element.setAttribute(step.name, step.value);
        }
        markApplied(elements.length);
      } else if (step.type === "removeAttribute") {
        for (const element of elements) {
          element.removeAttribute(step.name);
        }
        markApplied(elements.length);
      } else if (step.type === "setText") {
        for (const element of elements) {
          element.textContent = step.text;
        }
        markApplied(elements.length);
      } else if (step.type === "setValue") {
        for (const element of elements) {
          const tag = element.tagName.toLowerCase();
          if (tag === "input" || tag === "textarea" || tag === "select") {
            element.value = step.value;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            markApplied(1);
          } else {
            markSkipped(1);
          }
        }
      } else if (step.type === "click") {
        for (const element of elements) {
          const tag = element.tagName.toLowerCase();
          const type = String(element.getAttribute("type") || "").toLowerCase();
          if (tag === "a" || type === "submit" || type === "image" || (tag === "button" && (!type || type === "submit"))) {
            markSkipped(1);
            continue;
          }
          element.click();
          markApplied(1);
        }
      } else if (step.type === "focus") {
        for (const element of elements) {
          element.focus({ preventScroll: true });
        }
        markApplied(elements.length);
      } else if (step.type === "scrollIntoView") {
        for (const element of elements) {
          element.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        }
        markApplied(elements.length);
      } else if (step.type === "remove") {
        for (const element of elements) {
          const tag = element.tagName.toLowerCase();
          if (tag === "html" || tag === "body" || tag === "head") {
            markSkipped(1);
            continue;
          }
          element.remove();
          markApplied(1);
        }
      } else if (step.type === "insert") {
        for (const element of elements) {
          const node = document.createElement(step.tag);
          node.textContent = step.text;
          if (step.className) {
            node.classList.add(...classTokens(step.className));
          }
          for (const [name, value] of Object.entries(step.attributes)) {
            node.setAttribute(name, value);
          }
          if (step.placement === "append") {
            element.append(node);
          } else if (step.placement === "prepend") {
            element.prepend(node);
          } else if (step.placement === "before") {
            element.before(node);
          } else {
            element.after(node);
          }
          runtime.createdNodes.push(node);
          markApplied(1);
        }
      } else if (step.type === "dispatch") {
        if (selectorHasProtectedTarget(step.selector)) {
          markSkipped(elements.length);
          continue;
        }
        for (const element of elements) {
          const tag = element.tagName.toLowerCase();
          const type = String(element.getAttribute("type") || "").toLowerCase();
          if (
            step.event === "click" &&
            (tag === "a" || type === "submit" || type === "image" || (tag === "button" && (!type || type === "submit")))
          ) {
            markSkipped(1);
            continue;
          }
          element.dispatchEvent(new Event(step.event, { bubbles: true, cancelable: true }));
          markApplied(1);
        }
      }
    }
  };

  try {
    await runSteps(program.steps || []);
  } catch (error) {
    addError(error && error.message ? error.message : "Automation execution failed.");
  }

  return summary;
}

async function cleanupTabAutomation(tabId, allFrames) {
  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId,
        allFrames: Boolean(allFrames)
      },
      func: cleanupAutomationRuntime,
      world: "ISOLATED",
      injectImmediately: true
    });
    return results.reduce((total, result) => total + ((result.result && result.result.cleaned) || 0), 0);
  } catch {
    return 0;
  }
}

function emptyAutomationSummary() {
  return {
    applied: 0,
    skipped: 0,
    errors: []
  };
}

function aggregateAutomationResults(results) {
  return results.reduce(
    (aggregate, result) => {
      const value = result.result || {};
      aggregate.applied += Number(value.applied) || 0;
      aggregate.skipped += Number(value.skipped) || 0;
      if (Array.isArray(value.errors)) {
        aggregate.errors.push(...value.errors.slice(0, 12 - aggregate.errors.length));
      }
      return aggregate;
    },
    emptyAutomationSummary()
  );
}

async function runAutomationInTab(tabId, allFrames, program) {
  if (!program || !Array.isArray(program.steps) || program.steps.length === 0) {
    return emptyAutomationSummary();
  }

  const results = await chrome.scripting.executeScript({
    target: {
      tabId,
      allFrames: Boolean(allFrames)
    },
    func: executeAutomationProgram,
    args: [program],
    world: "ISOLATED",
    injectImmediately: true
  });
  return aggregateAutomationResults(results);
}

function targetFor(tabId, allFrames) {
  return {
    tabId,
    allFrames: Boolean(allFrames)
  };
}

async function replaceExistingDeployment(tabId, allFrames) {
  const previousRecord = await getStoredInjection(tabId);
  await removeStoredCss(tabId, previousRecord);
  const cleanedHooks = await cleanupTabAutomation(
    tabId,
    Boolean(allFrames) || Boolean(previousRecord && previousRecord.allFrames)
  );
  return {
    previousRecord,
    cleanedHooks
  };
}

export async function deployLayoutPayload(tabId, payload, options) {
  if (!Number.isInteger(tabId)) {
    throw new InjectionError("invalid_tab", "An active browser tab is required.");
  }
  if (!isPlainObject(payload)) {
    throw new InjectionError("invalid_payload", "The layout payload must be an object.");
  }

  const css = validateCss(payload.css);
  const program = parseAutomationProgram(payload.javascript);
  const allFrames = Boolean(options && options.allFrames);
  const { cleanedHooks } = await replaceExistingDeployment(tabId, allFrames);
  const target = targetFor(tabId, allFrames);

  let insertedCss = false;
  try {
    if (css) {
      await chrome.scripting.insertCSS({
        target,
        css,
        origin: "USER"
      });
      insertedCss = true;
    }

    const automation = await runAutomationInTab(tabId, allFrames, program);

    await chrome.storage.session.set({
      [sessionKey(tabId)]: {
        css,
        allFrames,
        injectedAt: Date.now(),
        mode: "applied"
      }
    });

    return {
      cssInjected: insertedCss,
      automation,
      cleanedHooks
    };
  } catch (error) {
    if (insertedCss) {
      try {
        await chrome.scripting.removeCSS({
          target,
          css,
          origin: "USER"
        });
      } catch {
        // Preserve the original injection error.
      }
    }
    await cleanupTabAutomation(tabId, allFrames);
    if (error instanceof InjectionError) {
      throw error;
    }
    throw new InjectionError("deployment_failed", "Could not inject the generated layout: " + String(error.message || error).slice(0, 500));
  }
}

/**
 * Injects only the validated CSS and keeps the validated AutomationProgram in
 * session storage. The caller can explicitly commit or discard the preview.
 */
export async function previewLayoutPayload(tabId, payload, options) {
  if (!Number.isInteger(tabId)) {
    throw new InjectionError("invalid_tab", "An active browser tab is required.");
  }
  if (!isPlainObject(payload)) {
    throw new InjectionError("invalid_payload", "The layout payload must be an object.");
  }

  const css = validateCss(payload.css);
  const program = parseAutomationProgram(payload.javascript);
  const allFrames = Boolean(options && options.allFrames);
  const { cleanedHooks } = await replaceExistingDeployment(tabId, allFrames);
  const target = targetFor(tabId, allFrames);
  let insertedCss = false;

  try {
    if (css) {
      await chrome.scripting.insertCSS({
        target,
        css,
        origin: "USER"
      });
      insertedCss = true;
    }

    await chrome.storage.session.set({
      [sessionKey(tabId)]: {
        css,
        allFrames,
        injectedAt: Date.now(),
        mode: "preview",
        program
      }
    });

    return {
      cssInjected: insertedCss,
      automation: emptyAutomationSummary(),
      cleanedHooks,
      preview: true
    };
  } catch (error) {
    if (insertedCss) {
      try {
        await chrome.scripting.removeCSS({
          target,
          css,
          origin: "USER"
        });
      } catch {
        // Preserve the original injection error.
      }
    }
    throw new InjectionError(
      "preview_failed",
      "Could not inject the generated preview: " + String(error.message || error).slice(0, 500)
    );
  }
}

export async function commitPreview(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new InjectionError("invalid_tab", "An active browser tab is required.");
  }

  const record = await getStoredInjection(tabId);
  if (!record || record.mode !== "preview") {
    throw new InjectionError("no_preview", "There is no active preview to keep in this tab.");
  }

  const program = isPlainObject(record.program)
    ? record.program
    : { version: 1, steps: [] };
  let automation;
  try {
    automation = await runAutomationInTab(tabId, Boolean(record.allFrames), program);
  } catch (error) {
    throw new InjectionError(
      "preview_commit_failed",
      "Could not apply the preview automation: " + String(error.message || error).slice(0, 500)
    );
  }

  await chrome.storage.session.set({
    [sessionKey(tabId)]: {
      css: typeof record.css === "string" ? record.css : "",
      allFrames: Boolean(record.allFrames),
      injectedAt: record.injectedAt || Date.now(),
      committedAt: Date.now(),
      mode: "applied"
    }
  });

  return {
    committed: true,
    cssInjected: Boolean(record.css),
    automation
  };
}

export async function discardPreview(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new InjectionError("invalid_tab", "An active browser tab is required.");
  }

  const record = await getStoredInjection(tabId);
  if (!record || record.mode !== "preview") {
    throw new InjectionError("no_preview", "There is no active preview to discard in this tab.");
  }

  const removedCss = await removeStoredCss(tabId, record);
  const cleanedHooks = await cleanupTabAutomation(tabId, Boolean(record.allFrames));
  return {
    discarded: true,
    removedCss,
    cleanedHooks
  };
}

export async function getDeploymentState(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }
  const record = await getStoredInjection(tabId);
  if (!record) {
    return null;
  }
  return {
    mode: record.mode === "preview" ? "preview" : "applied",
    hasCss: Boolean(record.css),
    allFrames: Boolean(record.allFrames),
    injectedAt: Number(record.injectedAt) || null
  };
}

export async function getPersistableLayoutCss(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new InjectionError("invalid_tab", "An active browser tab is required.");
  }
  const record = await getStoredInjection(tabId);
  const css = record && typeof record.css === "string" ? record.css : "";
  if (!css.trim()) {
    throw new InjectionError("no_persistable_css", "There is no generated CSS in this tab to save as a userscript.");
  }
  return {
    css,
    allFrames: Boolean(record.allFrames),
    mode: record.mode === "preview" ? "preview" : "applied"
  };
}

export async function clearDeploymentState(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  await chrome.storage.session.remove(sessionKey(tabId));
}

export async function removeLastInjectedCss(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new InjectionError("invalid_tab", "An active browser tab is required.");
  }

  const record = await getStoredInjection(tabId);
  const removedCss = await removeStoredCss(tabId, record);
  const cleanedHooks = await cleanupTabAutomation(tabId, Boolean(record && record.allFrames));
  return {
    removedCss,
    cleanedHooks
  };
}
