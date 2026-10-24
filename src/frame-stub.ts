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
     * host may refuse (an unregistered name, malformed params, the rate limit),
     * and a refusal rejects the promise.
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
    },

    /**
     * Persist one small JSON value for THIS widget; it comes back from
     * loadState on a future render of the same saved widget. The host caps
     * the size and may refuse — handle rejection like any other call.
     */
    saveState: function (value) {
      return window.marzi.call("marzi/saveState", { value: value });
    },

    /** Resolves with the saved value, or null if nothing was ever saved. */
    loadState: function () {
      return window.marzi.call("marzi/loadState");
    }
  };

  // Tell the host when the widget's own code throws, so it can say what broke
  // instead of leaving a blank box. A notification: no id, no reply expected.
  // Every field is a claim the host checks: it rebuilds, clamps and positions
  // them itself, because widget code can reach this listener like the rest of
  // the stub.
  window.addEventListener("error", function (event) {
    var error = event.error;
    transmit({
      jsonrpc: "2.0",
      method: "marzi/fault",
      params: {
        message: String(event.message || "script error").slice(0, 300),
        // The error's class, when the thrown value has one: "TypeError".
        name: error && typeof error.name === "string" ? error.name.slice(0, 40) : undefined,
        // Where the browser says it happened, in lines of this whole document.
        // The host knows where the widget's own HTML starts in it and does the
        // subtraction, so this stays the browser's raw number.
        line: event.lineno,
        column: event.colno
      }
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    var text = reason && reason.message ? reason.message : reason;
    transmit({
      jsonrpc: "2.0",
      method: "marzi/fault",
      // A rejection has a reason but no position: nothing threw on a line.
      params: {
        message: ("unhandled rejection: " + String(text)).slice(0, 300),
        name: reason && typeof reason.name === "string" ? reason.name.slice(0, 40) : undefined
      }
    });
  });

  // The host is TWO levels up. Directly above us sits the warden — an inert
  // frame the host wraps around us so its frame-src 'none' governs our
  // navigation. It carries no script and we never talk to it; the host
  // addresses our window straight through it. (No backticks in this file's
  // comments: the whole stub is one template literal.)
  var host = parent.parent;

  // Listen BEFORE announcing ourselves, so we cannot miss the reply.
  window.addEventListener("message", function (event) {
    if (port) { return; }                     // accept exactly one port, ever
    if (event.source !== host) { return; }    // and only from the host
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
  host.postMessage({ marzi: "ready" }, "*");
})();
`;
