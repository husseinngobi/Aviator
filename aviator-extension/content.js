(() => {
    if (window.__WS_MONITOR_CONTENT_ACTIVE__) return;
    window.__WS_MONITOR_CONTENT_ACTIVE__ = true;

    const OriginalWebSocket = window.WebSocket;

    window.WebSocket = function (...args) {
        const socket = new OriginalWebSocket(...args);

        socket.addEventListener("message", (event) => {
            window.postMessage(
                {
                    source: "ws-monitor",
                    type: "message",
                    url: socket.url,
                    payload: event.data
                },
                "*"
            );
        });

        return socket;
    };

    window.WebSocket.prototype = OriginalWebSocket.prototype;
})();