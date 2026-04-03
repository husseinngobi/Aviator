// WebSocket Sniffer for browser DevTools
// Paste this in your browser console to log all WebSocket messages in real time
(function() {
  const open = window.WebSocket.prototype.open || window.WebSocket.prototype.constructor;
  const wsInstances = [];
  const origWebSocket = window.WebSocket;

  window.WebSocket = function(...args) {
    const ws = new origWebSocket(...args);
    wsInstances.push(ws);

    ws.addEventListener('message', function(event) {
      try {
        let data = event.data;
        try { data = JSON.parse(event.data); } catch {}
        console.log('[WS MESSAGE]', data);
      } catch (e) {
        console.warn('[WS ERROR]', e);
      }
    });

    ws.addEventListener('open', function() {
      console.log('[WS OPEN]', ws.url);
    });

    ws.addEventListener('close', function() {
      console.log('[WS CLOSE]', ws.url);
    });

    ws.addEventListener('error', function(e) {
      console.warn('[WS ERROR]', e);
    });

    return ws;
  };
  window.WebSocket.prototype = origWebSocket.prototype;
  window.WebSocket.__proto__ = origWebSocket;

  console.log('✅ WebSocket sniffer injected. All messages will be logged in the console.');
})();
