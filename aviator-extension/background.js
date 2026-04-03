chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id) return;

    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
            if (window.__WS_MONITOR_ACTIVE__) return;
            window.__WS_MONITOR_ACTIVE__ = true;

            const OriginalWebSocket = window.WebSocket;
            const monitorStore = [];

            window.WebSocket = function (...args) {
                const socket = new OriginalWebSocket(...args);

                socket.addEventListener("open", () => {
                    console.log("[WS MONITOR] open", socket.url);
                });

                socket.addEventListener("message", (event) => {
                    let payload = event.data;

                    try {
                        payload = JSON.parse(event.data);
                    } catch {
                        payload = event.data;
                    }

                    monitorStore.push({
                        url: socket.url,
                        timestamp: Date.now(),
                        payload
                    });

                    console.log("[WS MONITOR] message", payload);
                });

                socket.addEventListener("error", (error) => {
                    console.warn("[WS MONITOR] error", error);
                });

                socket.addEventListener("close", () => {
                    console.log("[WS MONITOR] close", socket.url);
                });

                return socket;
            };

            window.WebSocket.prototype = OriginalWebSocket.prototype;
            console.log("[WS MONITOR] injected");
            window.__WS_MONITOR_STORE__ = monitorStore;
        }
    });
});