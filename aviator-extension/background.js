chrome.runtime.onInstalled.addListener(() => {
    console.log("[WS TELEMETRY EXT] installed and ready");
});

chrome.runtime.onStartup.addListener(() => {
    console.log("[WS TELEMETRY EXT] startup complete");
});