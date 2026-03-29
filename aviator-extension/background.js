// Detect when you open Fortebet and start the debugger
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.includes('fortebet.ug')) {
        chrome.debugger.attach({ tabId: tabId }, "1.3", () => {
            chrome.debugger.sendCommand({ tabId: tabId }, "Network.enable");
            console.log("Monitoring started on Fortebet.");
        });
    }
});

// Capture every WebSocket frame
chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === "Network.webSocketFrameReceived") {
        const payload = params.response.payloadData;
        
        // This is where we send the data to your VS Code project's backend
        // We'll build the 'http://localhost:5000/data' receiver in Phase 2
        fetch("http://localhost:5000/data", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                raw: payload,
                timestamp: Date.now()
            })
        }).catch(err => {
            // Server might be off, that's fine
        });
    }
});