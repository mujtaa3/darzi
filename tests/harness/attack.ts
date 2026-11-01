/**
 * Helpers for driving an attack page.
 *
 * Every attack page keeps a `window.__log` of strings and reports widget
 * results through a `probe.report` capability. Tests wait on log CONDITIONS,
 * never on timers — three separate lessons taught us that timers lie in
 * virtual time, in background windows, and around frame boundaries.
 */
import type { Page } from "@playwright/test";

export interface Attack {
  /** Resolve once some log line contains `text`. */
  untilLog(text: string, ms?: number): Promise<void>;
  /** Resolve once at least `n` log lines start with `prefix`. */
  untilCount(prefix: string, n: number, ms?: number): Promise<void>;
  /** Everything logged so far. */
  log(): Promise<string[]>;
  /** Log lines starting with `prefix`, prefix removed. */
  logged(prefix: string): Promise<string[]>;
  /** Parsed `REPORT` lines (JSON after the prefix). */
  reports(): Promise<Record<string, unknown>[]>;
}

export async function openAttack(page: Page, name: string): Promise<Attack> {
  // `name` may carry a query: "webrtc?mode=control" → /tests/pages/webrtc.html?mode=control
  const [file, query] = name.split("?");
  await page.goto(`/tests/pages/${file}.html${query ? "?" + query : ""}`, { waitUntil: "load" });

  const log = () => page.evaluate(() => (window as unknown as { __log: string[] }).__log);

  return {
    // NB: waitForFunction(fn, ARG, options) — options is the third parameter.
    async untilLog(text, ms = 15_000) {
      await page.waitForFunction(
        (t) => (window as unknown as { __log: string[] }).__log.some((l) => l.includes(t)),
        text,
        { timeout: ms },
      );
    },
    async untilCount(prefix, n, ms = 15_000) {
      await page.waitForFunction(
        ([p, k]) => (window as unknown as { __log: string[] }).__log.filter((l) => l.startsWith(p)).length >= k,
        [prefix, n] as [string, number],
        { timeout: ms },
      );
    },
    log,
    async logged(prefix) {
      return (await log()).filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
    },
    async reports() {
      return (await log())
        .filter((l) => l.startsWith("REPORT "))
        .map((l) => JSON.parse(l.slice(7)) as Record<string, unknown>);
    },
  };
}

/**
 * Remove `AbortSignal.any` and `AbortSignal.timeout` from each document of this
 * page, before its scripts run. Call it before `openAttack`. darzi must not need
 * them: Safari got `any` only in 17.4, and `timeout` only in 16.
 */
export async function removeNewAbortFunctions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const signal = AbortSignal as unknown as { any?: unknown; timeout?: unknown };
    delete signal.any;
    delete signal.timeout;
  });
}

/** A brief settle after the control has landed, for anything still in flight. */
export const settle = (page: Page, ms = 600) => page.waitForTimeout(ms);
