/**
 * The in-frame helper — marzi's *other* program.
 *
 * This is not TypeScript that we compile; it is a string of plain JavaScript we
 * inject into every widget document. It has to be a string because the jail has
 * no network: the frame cannot fetch a script from anywhere, so the code must
 * arrive inside the document itself.
 *
 * ⚠️ THIS CODE IS NOT TRUSTED AND IS NOT PART OF THE SECURITY MODEL.
 * It runs in the jail, in the same JavaScript world as the model's code, which
 * means widget code can overwrite `window.marzi`, tamper with these functions,
 * or ignore them entirely and speak to the port directly. That is fine. The
 * stub exists for the *convenience* of well-behaved widgets. Every rule that
 * actually matters is enforced on the host side of the wall, where hostile code
 * cannot reach.
 */
export const FRAME_STUB = `
(function () {
  var port = null;      // our end of the private line, once it arrives
  var queue = [];       // messages sent before the line was connected
  var pending = {};     // id -> { resolve, reject, timer } for calls awaiting a reply
  var nextId = 1;

  // Last resort only. The host answers its own timeouts with a JSON-RPC error,
  // so this fires solely when NO answer arrives at all — the widget was
  // destroyed mid-call, or the port never connected. Deliberately generous, so
  // the host's own (configurable, 30s by default) deadline always wins first;
  // a stub that gave up earlier would report a timeout the host never saw.
  var NO_ANSWER_MS = 60000;

  function transmit(message) {
    if (port) { port.postMessage(message); } else { queue.push(message); }
  }

  window.marzi = {
    /**
     * Ask the host for something. Returns a Promise.
     *
     * Safe to call before the line is up: the message waits in the queue. The
     * host may refuse — from rung 5 it will, whenever the capability was not
     * granted — and a refusal rejects the promise.
     */
    call: function (method, params) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        var timer = setTimeout(function () {
          if (!pending[id]) { return; }
          delete pending[id];
          reject(new Error("no answer from the host"));
        }, NO_ANSWER_MS);
        pending[id] = { resolve: resolve, reject: reject, timer: timer };
        transmit({ jsonrpc: "2.0", id: id, method: method, params: params });
      });
    }
  };

  // Tell the host when the widget's own code throws, so it can show something
  // useful instead of a blank box. A notification: no id, no reply expected.
  // The host clamps and escapes this — it is widget-authored text.
  window.addEventListener("error", function (event) {
    var where = event.lineno ? " (line " + event.lineno + ")" : "";
    transmit({
      jsonrpc: "2.0",
      method: "marzi/fault",
      params: { message: String(event.message || "script error").slice(0, 300) + where }
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason && event.reason.message ? event.reason.message : event.reason;
    transmit({
      jsonrpc: "2.0",
      method: "marzi/fault",
      params: { message: "unhandled rejection: " + String(reason).slice(0, 300) }
    });
  });

  // Listen BEFORE announcing ourselves, so we cannot miss the reply.
  window.addEventListener("message", function (event) {
    if (port) { return; }                     // accept exactly one port, ever
    if (event.source !== parent) { return; }  // and only from our embedder
    if (!event.data || event.data.marzi !== "port") { return; }

    var incoming = event.ports && event.ports[0];
    if (!incoming) { return; }

    port = incoming;
    port.onmessage = function (e) {
      var msg = e.data;
      if (!msg || typeof msg !== "object") { return; }

      // Match the reply to its request by id — the whole point of JSON-RPC.
      var waiting = pending[msg.id];
      if (!waiting) { return; }
      delete pending[msg.id];
      clearTimeout(waiting.timer);

      if (msg.error) {
        waiting.reject(new Error(msg.error.message || "call failed"));
      } else {
        waiting.resolve(msg.result);
      }
    };

    while (queue.length) { port.postMessage(queue.shift()); }
  });

  // Announce on the party line. targetOrigin "*" is fine here precisely because
  // this message carries nothing: it is a knock on the door, not a payload.
  parent.postMessage({ marzi: "ready" }, "*");
})();
`;
