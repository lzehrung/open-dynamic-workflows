/**
 * Atomic file replacement that also works on Windows, where a rename fails with
 * EPERM, EACCES, or EBUSY while another process has the file open (for example
 * a reader of `status.json`). The lock lasts milliseconds, so retry for up to
 * 500 ms. The retry blocks the thread.
 */

import { renameSync, rmSync } from "node:fs";

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_LIMIT_MS = 500;
const MAX_DELAY_MS = 20;

/** Rename `tmp` over `path`; retry transient Windows sharing errors. */
export function replaceFile(tmp: string, path: string): void {
  const deadline = Date.now() + RETRY_LIMIT_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !RETRY_CODES.has(code) || Date.now() >= deadline) {
        rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(Math.min(2 ** attempt, MAX_DELAY_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

/** Block the thread for `ms` milliseconds (writers here are synchronous). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
