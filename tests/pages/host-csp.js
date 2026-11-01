import { createRuntime } from "/dist/index.js";

window.__log = [];
const log = (s) => window.__log.push(s);
log("PAGE-RAN");
log("INJECTED " + (window.__injected ?? "blocked"));

// The widget tests what a host's CSP takes from it: its script, its style and its
// `data:` image. The window's load event waits for the image. Firefox can give an
// empty computed style until it has laid out the frame, so the read tries again.
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
try {
  createRuntime({
    capabilities: [{ name: "probe.report", description: "result", handler: (p) => { log("REPORT " + JSON.stringify(p)); return true; } }],
    startTimeoutMs: 1500,
    onWidgetFault: (f) => log(`FAULT ${f.widgetId} ${f.kind}`),
  }).render(`<style>#styled { color: rgb(1, 2, 3); }</style><div id="styled">x</div><img id="pixel" src="${PIXEL}"><script>
    function read() {
      var color = getComputedStyle(document.getElementById("styled")).color;
      if (color === "") { setTimeout(read, 20); return; }
      var b = document.createElement("button");
      b.setAttribute("onclick", "window.__handler = 'ran'");
      b.click();
      marzi.call("probe.report", { color: color, image: document.getElementById("pixel").naturalWidth > 0 ? "loaded" : "failed", handler: window.__handler || "blocked" });
    }
    addEventListener("load", read);
  </script>`, document.getElementById("slot"), { id: "w" });
} catch (error) {
  log("THROW " + error.name);
}

// Control: this timer starts after `render`, and waits past its `startTimeoutMs`.
setTimeout(() => log("PAST-START-TIMEOUT"), 1600);
