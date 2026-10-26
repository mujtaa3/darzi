/**
 * The in-frame helper. It runs inside each widget frame, before the widget's
 * own code, and gives that code the `marzi` object.
 *
 * Plain browser JavaScript, not a module. `npm run build` copies this text
 * into src/frame-stub.ts as the string FRAME_STUB, because the frame has no
 * network and cannot load a file.
 *
 * ⚠️ NOT TRUSTED, AND NOT PART OF THE SECURITY MODEL. Widget code runs in the
 * same JavaScript world, so it can change or replace all of this. The host
 * checks every message itself.
 */
(function () {
  var port = null;      // our end of the channel, after it arrives
  var queue = [];       // messages sent before the channel is ready
  var pending = {};     // id -> { resolve, reject, timer }, for calls that wait for a reply
  var nextId = 1;

  // A backstop only. The host answers its own timeouts with an error, so this
  // fires only when no answer comes at all: the widget was destroyed during
  // the call, or the channel never opened. It is long on purpose, so that the
  // host's deadline (callTimeoutMs, 30 s by default) comes first. That is true
  // only while callTimeoutMs is under 60 s.
  var NO_ANSWER_MS = 60000;

  // Send one message to the host. Before the port arrives, keep the message in
  // `queue`; the port's listener below sends the queue, in order, when the port
  // comes. So widget code can call marzi at once, during the parse.
  function transmit(message) {
    if (port) { port.postMessage(message); } else { queue.push(message); }
  }

  // The whole in-frame API: the one object that widget code uses. It has three
  // methods, and each returns a promise. The prompt templates teach the model
  // these three, and nothing else.
  window.marzi = {
    /**
     * Ask the host for something. Returns a promise.
     *
     * You can call it before the channel is ready: the message waits in the
     * queue. The host can refuse the call, for example for an unknown name,
     * bad params or the rate limit. A refusal rejects the promise.
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
     * Save one small JSON value for this widget. loadState returns it when the
     * host renders the same saved widget again. The host limits the size and
     * can refuse, so handle a rejection as for any call.
     */
    saveState: function (value) {
      return window.marzi.call("marzi/saveState", { value: value });
    },

    /** Resolves with the saved value, or with null when nothing was saved. */
    loadState: function () {
      return window.marzi.call("marzi/loadState");
    }
  };

  // Tell the host when the widget's code throws, so that the host can show
  // what broke instead of an empty box. This is a notification: no id, and no
  // reply. The host checks each field again, because widget code can reach
  // this listener too.
  window.addEventListener("error", function (event) {
    var error = event.error;
    transmit({
      jsonrpc: "2.0",
      method: "marzi/fault",
      params: {
        message: String(event.message || "script error").slice(0, 300),
        // The error's type, when the thrown value has one, for example "TypeError".
        name: error && typeof error.name === "string" ? error.name.slice(0, 40) : undefined,
        // The browser's position, in lines of this whole document. The host
        // knows where the widget HTML starts, and changes this into a line of
        // the widget HTML.
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
      // A failed promise has a reason but no position: nothing threw on a line.
      params: {
        message: ("unhandled rejection: " + String(text)).slice(0, 300),
        name: reason && typeof reason.name === "string" ? reason.name.slice(0, 40) : undefined
      }
    });
  });

  // The host page is two levels up. Directly above us is the warden: an outer
  // frame with no script, whose frame-src 'none' stops our navigation. We never
  // talk to the warden; the host reaches our window through it.
  var host = parent.parent;

  // Listen BEFORE we say "ready", so that we cannot miss the reply.
  window.addEventListener("message", function (event) {
    if (port) { return; }                     // accept one port for each load
    if (event.source !== host) { return; }    // and only from the host
    if (!event.data || event.data.marzi !== "port") { return; }

    var incoming = event.ports && event.ports[0];
    if (!incoming) { return; }

    port = incoming;
    port.onmessage = function (e) {
      var msg = e.data;
      if (!msg || typeof msg !== "object") { return; }

      // Find the waiting call by the reply's id. This is what JSON-RPC ids are for.
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

  // Say "ready" to the host. The target origin "*" is safe here, because the
  // message carries no data.
  host.postMessage({ marzi: "ready" }, "*");
})();
