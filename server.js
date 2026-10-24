/**
 * The backend for the finance app (and the older demos).
 *
 * This exists for one reason: **the API key must never reach the browser.**
 * marzi's own rule is that secrets stay on the host page or its backend, and a
 * demo that leaked its key into a <script> tag would be teaching the opposite.
 * This is also the realistic shape — a real adopter calls their own model from
 * their own backend and hands marzi the result.
 *
 * marzi itself remains a pure frontend library. This server is the *app*.
 * The finance endpoints (transactions, budgets, notes) live in app/api.js;
 * this file handles generation and static files.
 *
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node server.js
 *   open http://127.0.0.1:8000/
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { catalog, handleFinanceApi } from "./app/api.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT) || 8000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// The capability catalog now belongs to the finance app (app/api.js) — its
// descriptions embed the real month range of the loaded data, so they are
// computed rather than pasted here.
function catalogForPrompt() {
  return catalog().map((c) => `- \`${c.name}\`\n  ${c.description}`).join("\n\n");
}

/**
 * Libraries the app vendors for widgets. The `description` teaches the model;
 * the actual source text is registered client-side (app/widgets.html fetches
 * app/vendor/*.js and hands it to createRuntime). Rolling pin: updating the
 * vendored file updates every widget on its next render.
 */
const LIBRARIES = [
  {
    name: "chartjs",
    file: "vendor/chart.umd.js", // path under app/, fetched by the studio page
    description:
      "Chart.js v4, already loaded — available as the global `Chart`.\n" +
      "  Use: `new Chart(document.getElementById('c'), { type, data, options })`\n" +
      "  with a <canvas id=\"c\"></canvas> in your markup. Core Chart.js only:\n" +
      "  no plugins, no date adapters, no external fonts. Prefer it over\n" +
      "  hand-drawn bars whenever the request calls for a real chart.",
  },
];

function librariesForPrompt() {
  if (LIBRARIES.length === 0) return "(none)";
  return LIBRARIES.map((l) => `- \`${l.name}\`\n  ${l.description}`).join("\n\n");
}

/** Pull the three blocks out of the model's reply. */
function parseWidget(text) {
  // Be forgiving about markdown fences the model may add around the whole reply.
  const cleaned = text.replace(/^\s*```[a-z]*\s*/i, "").replace(/```\s*$/, "");

  const grab = (tag) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(cleaned);
    return m ? m[1].trim() : null;
  };

  const html = grab("widget");
  if (!html) {
    throw new Error("model did not return a <widget> block");
  }

  const capsRaw = grab("capabilities") ?? "";
  const libsRaw = grab("libs") ?? "";
  return {
    title: grab("title") ?? "Untitled widget",
    capabilities: capsRaw.split(",").map((s) => s.trim()).filter(Boolean),
    libs: libsRaw.split(",").map((s) => s.trim()).filter(Boolean),
    html,
    raw: cleaned,
  };
}

const client = new Anthropic(); // resolves ANTHROPIC_API_KEY from the environment

/** Load a prompt template and fill its placeholders. */
async function buildPrompt(file, slots) {
  const template = await readFile(join(ROOT, "prompts", file), "utf8");
  // The template file carries a header explaining itself; everything from the
  // first horizontal rule onward is the actual prompt.
  const prompt = template.slice(template.indexOf("\n---\n") + 5);
  // One pass with a function replacer. Text inserted for one slot is never
  // scanned again for another slot's placeholder, and `$&`, `$'` and the other
  // `$` patterns in the text stay literal (a string replacement expands them).
  return prompt.replace(/\{\{([A-Z]+)\}\}/g, (match, name) => (Object.hasOwn(slots, name) ? slots[name] : match));
}

// Widget-authored text, made fit for a prompt and a terminal: at most `max`
// characters, well-formed, on one line, no control characters, no backticks.
function cleanText(text, max) {
  return String(text).slice(0, max).toWellFormed()
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/`/g, "'")
    .trim();
}

const position = (v) => (Number.isInteger(v) && v >= 1 && v < 1_000_000 ? v : undefined);

/**
 * A fault arrives from the page, which got it from the widget, so check it
 * again here: rebuild the four fields marzi defines, and nothing else.
 */
function readFault(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.message !== "string") {
    throw new Error("missing 'fault' (the error the widget reported)");
  }
  const line = position(raw.line);
  return {
    name: typeof raw.name === "string" ? cleanText(raw.name, 40) : "",
    message: cleanText(raw.message, 300) || "no message",
    line,
    column: line === undefined ? undefined : position(raw.column),
  };
}

/** The FAULT lines, as the header of prompts/widget-repair.md describes them. */
function faultForPrompt({ name, message, line, column }) {
  const where = line === undefined
    ? "not reported"
    : `line ${line}${column === undefined ? "" : `, column ${column}`} of the code above`;
  return [name && `Error: ${name}`, `Message: ${message}`, `Where: ${where}`].filter(Boolean).join("\n");
}

/** Send a finished prompt to the model and parse the widget out of the reply. */
async function runModel(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Run:  export ANTHROPIC_API_KEY=sk-ant-...  then restart the server.",
    );
  }

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`model refused: ${response.stop_details?.explanation ?? "no reason given"}`);
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const widget = parseWidget(text);
  widget.usage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
  };
  return widget;
}

async function generate(request) {
  return runModel(await buildPrompt("widget-author.md", {
    CAPABILITIES: catalogForPrompt(),
    LIBRARIES: librariesForPrompt(),
    REQUEST: request,
  }));
}

/**
 * Revise an existing widget. `previousBody` is model-written code that may
 * have been influenced by hostile data on an earlier run — the template
 * frames it as material to revise, never as instructions (cross-time
 * injection). This endpoint is record-agnostic on purpose: the page owns its
 * record; generation knows nothing about storage.
 */
async function refine(request, previousBody) {
  return runModel(await buildPrompt("widget-refine.md", {
    CAPABILITIES: catalogForPrompt(),
    LIBRARIES: librariesForPrompt(),
    PREVIOUS: previousBody,
    REQUEST: request,
  }));
}

/**
 * Repair a version whose code crashed. Both inputs are untrusted: the body is
 * model-written code, and the fault is text the running widget produced
 * (readFault has already rebuilt and cleaned it). The template frames both as
 * material to work from, never as instructions.
 */
async function repair(previousBody, fault) {
  return runModel(await buildPrompt("widget-repair.md", {
    CAPABILITIES: catalogForPrompt(),
    LIBRARIES: librariesForPrompt(),
    PREVIOUS: previousBody,
    FAULT: faultForPrompt(fault),
  }));
}

/**
 * Generation spends model credits, so only Ledger's own pages may ask for it.
 * Another site can make the browser POST here, but only as a form or plain
 * text: a JSON body needs a CORS preflight, which this server never grants.
 * The Host check stops DNS rebinding (a foreign name that resolves to us).
 */
function fromOurPages(req) {
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  const origin = req.headers.origin;
  return (req.headers["content-type"] ?? "").startsWith("application/json")
    && (!origin || origin === `http://${host}`);
}

function readBody(req) {
  return new Promise((ok, no) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) no(new Error("request too large"));
    });
    req.on("end", () => ok(data));
    req.on("error", no);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const isGenerate = url.pathname === "/api/generate";
  const isRefine = url.pathname === "/api/refine";
  const isRepair = url.pathname === "/api/repair";
  if ((isGenerate || isRefine || isRepair) && req.method === "POST") {
    if (!fromOurPages(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "refused: generation is only for Ledger's own pages" }));
      return;
    }
    try {
      const { request, previous, fault } = JSON.parse(await readBody(req));
      if (!isRepair && (typeof request !== "string" || !request.trim())) {
        throw new Error("missing 'request'");
      }
      if (!isGenerate && (typeof previous !== "string" || !previous.trim())) {
        throw new Error("missing 'previous' (the current version's body)");
      }
      let widget;
      if (isRepair) {
        const clean = readFault(fault);
        // The fault is widget text, so the log shows only its class and sizes.
        console.log(`\n✚ repairing: ${clean.name || "error"}, ${clean.message.length}-char message` +
          `${clean.line ? `, line ${clean.line}` : ""}`);
        widget = await repair(previous, clean);
      } else if (isRefine) {
        console.log(`\n↻ refining: ${request}`);
        widget = await refine(request, previous);
      } else {
        console.log(`\n▸ generating: ${request}`);
        widget = await generate(request);
      }
      console.log(
        `  ✓ "${widget.title}"  caps=[${widget.capabilities.join(", ")}]  ` +
          `libs=[${widget.libs.join(", ")}]  ` +
          `${widget.html.length} bytes  (${widget.usage.input}→${widget.usage.output} tokens)`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(widget));
    } catch (error) {
      const message =
        error instanceof Anthropic.AuthenticationError
          ? "No valid API key. Set ANTHROPIC_API_KEY and restart the server."
          : error.message;
      console.error(`  ✗ ${message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (url.pathname === "/api/catalog") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(catalog()));
    return;
  }

  if (url.pathname === "/api/libraries") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(LIBRARIES.map(({ name, file }) => ({ name, file }))));
    return;
  }

  // The finance app's data endpoints. Everything under /api/ that isn't
  // generation belongs to it.
  if (url.pathname.startsWith("/api/")) {
    try {
      const body = req.method === "GET" ? null : JSON.parse((await readBody(req)) || "null");
      const handled = await handleFinanceApi(url, req.method, body);
      if (handled !== null) {
        res.writeHead(handled.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(handled.body));
        return;
      }
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
  }

  // The front door REDIRECTS rather than serving the app page at "/". Serving
  // content at a path it doesn't live at breaks relative URL resolution: the
  // page's ./style.css would resolve against "/", land outside the servable
  // directories, and 403 — an unstyled skeleton. (Found the hard way.)
  if (url.pathname === "/") {
    res.writeHead(302, { Location: "/app/" }).end();
    return;
  }
  // Browsers ask for this uninvited; answer quietly instead of 403-ing.
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  // Static files. Two defences, because this process holds an API key:
  //   1. `normalize` + a prefix check stop "../.." escaping the repo entirely.
  //   2. An allowlist of servable directories — the rest of the repo (source,
  //      node_modules, git config) is not the demo's to hand out.
  // Path traversal is the same bug our HTTP capability adapter will have to
  // defend against, so we may as well get it right here.
  let requested = url.pathname;
  if (requested.endsWith("/")) requested += "index.html"; // directory index
  const filePath = join(ROOT, normalize(requested));

  const SERVABLE = [join(ROOT, "demo"), join(ROOT, "dist"), join(ROOT, "app"), join(ROOT, "tests")];
  if (!SERVABLE.some((dir) => filePath.startsWith(dir + "/"))) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(content);
    console.log(`  200 ${url.pathname}`);
  } catch {
    res.writeHead(404).end("not found");
    console.log(`  404 ${url.pathname}`);
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use — something else is still listening.\n` +
        `Free it with:   lsof -ti:${PORT} | xargs kill\n` +
        `Or run on another port:   PORT=8001 node server.js\n`,
    );
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`marzi finance app → http://127.0.0.1:${PORT}/`);
  console.log(`older demos       → http://127.0.0.1:${PORT}/demo/studio.html`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("⚠  ANTHROPIC_API_KEY is not set — generation will fail until it is.");
  }
});
