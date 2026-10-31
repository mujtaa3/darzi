/**
 * The attack suite's web server: static files from tests/ and dist/, nothing else.
 *
 * A test page needs only itself and the built runtime it imports
 * (/dist/index.js). No page calls an API, so this server has no model client
 * and no app data. It has one route: /witness-local counts each request, as the
 * witness does, for loads that a page sends to its own origin. /witness-local-hits
 * returns the labels so far, and clears them.
 *
 * The pages must come from a real http origin rather than file://, because
 * browsers do not load module scripts from file URLs.
 *
 * No security headers, on purpose. A srcdoc frame inherits its parent page's
 * CSP, so a header here would change what the suite measures (README, "Your
 * page's CSP").
 *
 *   PORT=8009 node tests/server.js     # Playwright starts it: playwright.config.ts
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT) || 8009;

// The only folders a request may read from.
const SERVABLE = [join(ROOT, "tests"), join(ROOT, "dist")];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// The labels that reached /witness-local.
const localHits = new Set();

const server = createServer(async (req, res) => {
  // Only the path is used. A fixed base means a strange Host header cannot
  // make this throw, and nothing here trusts the Host header for anything.
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/witness-local") {
    localHits.add(new URL(req.url ?? "/", "http://localhost").searchParams.get("via") ?? "?");
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (pathname === "/witness-local-hits") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([...localHits].sort()));
    localHits.clear();
    return;
  }

  // Browsers ask for this uninvited; answer quietly.
  if (pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  // `normalize` folds "..", and the prefix check keeps the result inside
  // the two folders.
  const filePath = join(ROOT, normalize(pathname));
  if (!SERVABLE.some((dir) => filePath.startsWith(dir + "/"))) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use; the suite needs it free.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`attack-suite pages → http://127.0.0.1:${PORT}/tests/pages/`);
});
