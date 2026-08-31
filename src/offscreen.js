const CLIPBOARD_MESSAGE = "frameweave.offscreen.clipboard.v1";

function errorMessage(error) {
  return String(error && error.message ? error.message : error || "Clipboard write failed.").slice(0, 500);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== CLIPBOARD_MESSAGE) {
    return;
  }
  const text = typeof message.text === "string" ? message.text : "";
  if (text.length > 1000000) {
    sendResponse({ ok: false, error: "Clipboard text exceeds the 1 MB safety limit." });
    return;
  }
  void navigator.clipboard.writeText(text)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});
