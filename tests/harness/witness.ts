/**
 * The witness — the only party whose word counts for "did anything leave?"
 *
 * A page cannot be trusted to report on itself, so every containment test
 * stands a server *outside* the browser and asks it afterwards. Two ears:
 * an HTTP counter (arrivals tallied by their `via` query key) and a UDP
 * socket (for anything that talks below HTTP, such as STUN).
 *
 * Worker-scoped: one instance per test worker, reset by each test.
 */
import { test as base } from "@playwright/test";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";

export const WITNESS_HTTP = "http://127.0.0.1:9999/witness";
export const WITNESS_UDP_PORT = 3478;

export interface Witness {
  /** Base URL for HTTP arrivals; append `?via=<label>`. */
  http: string;
  /** Every label that arrived, with counts. */
  hits(): Map<string, number>;
  /** Labels that arrived starting with `prefix`. */
  arrived(prefix: string): string[];
  /** UDP datagrams received since the last reset. */
  udp(): number;
  reset(): void;
}

export const test = base.extend<Record<string, never>, { witness: Witness }>({
  witness: [
    async ({}, use) => {
      const hits = new Map<string, number>();
      let udp = 0;

      const http = createServer((req, res) => {
        const via = new URL(req.url ?? "/", "http://x").searchParams.get("via") ?? "?";
        hits.set(via, (hits.get(via) ?? 0) + 1);
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
        res.end("ok");
      });
      await new Promise<void>((r) => http.listen(9999, "127.0.0.1", r));

      const sock = createSocket("udp4");
      sock.on("message", () => { udp += 1; });
      await new Promise<void>((r) => sock.bind(WITNESS_UDP_PORT, "127.0.0.1", r));

      await use({
        http: WITNESS_HTTP,
        hits: () => new Map(hits),
        arrived: (prefix) => [...hits.keys()].filter((k) => k.startsWith(prefix)).sort(),
        udp: () => udp,
        reset: () => { hits.clear(); udp = 0; },
      });

      http.close();
      sock.close();
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
