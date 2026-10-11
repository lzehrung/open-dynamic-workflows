/**
 * Process control: a timeout, a stop, and the output limit end the whole
 * process tree and record why. Chat Host runs Codex through the same runner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execPath } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { defaultConfig } from "../src/adapters/config.js";
import { DEFAULT_MAX_OUTPUT_BYTES, MAX_TERMINATION_MS, runCommand } from "../src/adapters/runner.js";
import { cliOk, type CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { buildContext } from "../src/context.js";
import { MemoryControl } from "../src/control.js";
import { FileControl } from "../src/runtime/file-control.js";
import { RunStopped } from "../src/errors.js";
import { MemorySink } from "../src/events.js";
import { createPrimitives } from "../src/primitives.js";
import { ChatStore, type ChatSessionRecord } from "../src/runtime/chat-store.js";
import { startRun, waitFor } from "../src/runtime/launcher.js";
import { RunStore } from "../src/runtime/run-store.js";
import { foldAgents, summarize } from "../src/runtime/runs-view.js";
import { createDefaultChatRunner, startServer, type ChatTurnRunner } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";

// --- helpers -----------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "odw-pc-"));
}

function cleanup(dir: string): void {
  // On Windows a killed process can hold its working directory for a moment.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Write a CommonJS fixture script and return its path. */
function fixture(dir: string, name: string, source: string): string {
  const path = join(dir, `${name}.cjs`);
  writeFileSync(path, source);
  return path;
}

/** Poll for a side effect of a real child process (a file). No event announces it. */
async function waitUntil(done: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Hang guard only: turn a stuck call into a test failure instead of a stuck test run. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}
/** A reparented POSIX child can be a zombie: it cannot run even if kill(0) finds its PID. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (process.platform === "win32") return true;
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return state !== "" && !state.startsWith("Z");
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false; // exited after kill(0)
    throw err;
  }
}

function grandchildPid(result: CliResult): number {
  const pid = Number(result.stdout.match(/^grandchild (\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "the child reported its grandchild PID");
  return pid;
}

/**
 * Assert that a surviving process never writes `path`. A killed process leaves
 * no event to await, and a fake clock cannot advance a real OS process. So wait
 * in real time until `ms` after `since`, which is past the moment a survivor
 * would have written the file.
 */
async function assertNeverWritten(path: string, since: number, ms: number, message: string): Promise<void> {
  await sleep(Math.max(0, since + ms - Date.now()));
  assert.equal(existsSync(path), false, message);
}

/**
 * A child that starts a detached grandchild running `grandchild` (CommonJS
 * source), prints the grandchild's PID, and idles. `childTrap` is extra source
 * for the child.
 *
 * The grandchild runs detached, as a harness tool can (omp starts its shell
 * tools this way). On Windows that takes it out of libuv's job object, so only
 * `taskkill /T` reaches it. On POSIX it starts its own session and process
 * group, so only the parent-link snapshot reaches it, not the group signal.
 */
function detachedGrandchildFixture(dir: string, grandchild: string, childTrap = ""): string {
  return fixture(
    dir,
    "tree",
    [
      'const { spawn } = require("node:child_process");',
      childTrap,
      `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], {`,
      "  detached: true,",
      '  stdio: "ignore",',
      "  windowsHide: true,",
      "});",
      'process.stdout.write("grandchild " + grandchild.pid + "\\n");',
      "setTimeout(() => {}, 30000);", // idle; ends on its own if a test fails
    ].join("\n"),
  );
}

/**
 * The detached grandchild writes `marker` after `delayMs`, so the marker stays
 * away only if the whole tree ends first. `ignoreSigterm` makes the named
 * processes ignore SIGTERM.
 */
function treeFixture(
  dir: string,
  marker: string,
  delayMs: number,
  ignoreSigterm: "none" | "tree" | "grandchild" = "none",
): string {
  const trap = 'process.on("SIGTERM", () => {});';
  const grandchildTrap = ignoreSigterm === "none" ? "" : trap;
  const childTrap = ignoreSigterm === "tree" ? trap : "";
  const grandchild = `${grandchildTrap}setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), ${delayMs});`;
  return detachedGrandchildFixture(dir, grandchild, childTrap);
}

/**
 * The shape of omp's shell tool (`sh -c '...; sleep 60'`): the detached
 * grandchild has a child of its own, which stays in the grandchild's process
 * group. That great-grandchild writes `ready` when it runs and `marker` after
 * `delayMs`. Only a snapshot that follows the parent links through the detached
 * grandchild reaches it.
 */
function deepTreeFixture(dir: string, ready: string, marker: string, delayMs: number): string {
  const greatGrandchild = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(ready)}, "1");`,
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "alive"), ${delayMs});`,
  ].join("\n");
  const grandchild = [
    `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(greatGrandchild)}], {`,
    '  stdio: "ignore",',
    "  windowsHide: true,",
    "});",
    "setTimeout(() => {}, 30000);",
  ].join("\n");
  return detachedGrandchildFixture(dir, grandchild);
}

/**
 * A detached grandchild that ignores SIGTERM and, when one arrives, starts a
 * new detached process: a descendant that did not exist when the tree was
 * snapshotted. The grandchild writes `ready` once it handles SIGTERM, and the
 * PID of the new process into `spawned` once it has started it. The new
 * process idles until something ends it.
 */
function sigtermSpawnFixture(dir: string, ready: string, spawned: string): string {
  const grandchild = [
    'const fs = require("node:fs");',
    'process.on("SIGTERM", () => {',
    `  const late = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });`,
    `  fs.writeFileSync(${JSON.stringify(spawned)}, String(late.pid));`,
    "});",
    `fs.writeFileSync(${JSON.stringify(ready)}, "1");`,
    "setTimeout(() => {}, 30000);",
  ].join("\n");
  return detachedGrandchildFixture(dir, grandchild);
}

const cancelled = (): CliResult => ({
  returncode: -1,
  stdout: "",
  stderr: "",
  timedOut: false,
  termination: "cancelled",
  duration: 0,
});

const succeeded = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0 });

function bridgeConfig() {
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  return config;
}

// --- runCommand: process tree and termination reason --------------------------------

test("a timeout ends the whole process tree and records why", async () => {
  const dir = tempDir();
  try {
    const marker = join(dir, "marker");
    const started = Date.now();
    const r = await within(runCommand([execPath, treeFixture(dir, marker, 3500)], { timeout: 2 }), 20_000, "runCommand");
    assert.equal(r.termination, "timeout");
    assert.equal(r.timedOut, true);
    assert.equal(r.returncode, -1);
    assert.equal(cliOk(r), false);
    assert.match(r.stdout, /^grandchild \d+/, "the fixture started its grandchild before the timeout");
    await assertNeverWritten(marker, started, 5500, "the grandchild survived the timeout");
  } finally {
    cleanup(dir);
  }
});

test("an abort ends the whole process tree, keeps partial output, and records cancelled", async () => {
  const dir = tempDir();
  try {
    const marker = join(dir, "marker");
    const controller = new AbortController();
    const started = Date.now();
    const r = await within(
      runCommand([execPath, treeFixture(dir, marker, 3000)], {
        signal: controller.signal,
        // The fixture prints once its grandchild runs: abort then.
        onStdout: () => controller.abort(),
      }),
      20_000,
      "runCommand",
    );
    assert.equal(r.termination, "cancelled");
    assert.equal(r.timedOut, false);
    assert.equal(r.returncode, -1);
    assert.equal(cliOk(r), false);
    assert.match(r.stdout, /^grandchild \d+/);
    await assertNeverWritten(marker, started, 4500, "the grandchild survived the abort");
  } finally {
    cleanup(dir);
  }
});

test("a timeout waits for SIGKILL to end a SIGTERM-ignoring descendant", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const kill = process.kill;
  let deliveredKill = 0;
  try {
    const ready = join(dir, "ready");
    const grandchild = [
      'process.on("SIGTERM", () => {});',
      `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "1");`,
      "setTimeout(() => {}, 30000);",
    ].join("\n");
    const running = runCommand([execPath, detachedGrandchildFixture(dir, grandchild)], { timeout: 1.5 });
    await waitUntil(() => existsSync(ready), "the grandchild to install its SIGTERM handler");
    // Send real SIGKILL on the next event-loop turn. A result that only waits
    // for signal submission now exposes the live descendant at once.
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal !== "SIGKILL") return kill(pid, signal);
      setImmediate(() => {
        try {
          kill(pid, signal);
          deliveredKill++;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        }
      });
      return true;
    }) as typeof process.kill;
    const result = await within(running, 15_000, "timeout tree end");
    assert.equal(result.termination, "timeout");
    assert.equal(isRunning(grandchildPid(result)), false, "the descendant still runs after the timeout result");
    assert.doesNotMatch(result.stderr, /could not be confirmed gone/, "the tree end was verified");
    assert.equal(result.treeCleanup, "verified");
    assert.ok(deliveredKill > 0, "SIGKILL reached the process before the result");
  } finally {
    process.kill = kill;
    cleanup(dir);
  }
});

test("an abort waits for a SIGTERM-ignoring descendant to die before returning", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  try {
    const ready = join(dir, "ready");
    const controller = new AbortController();
    const grandchild = [
      'process.on("SIGTERM", () => {});',
      `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "1");`,
      "setTimeout(() => {}, 30000);",
    ].join("\n");
    const running = runCommand([execPath, detachedGrandchildFixture(dir, grandchild)], { signal: controller.signal });
    await waitUntil(() => existsSync(ready), "the grandchild to install its SIGTERM handler");
    controller.abort();
    const result = await within(running, 15_000, "cancelled tree end");
    assert.equal(result.termination, "cancelled");
    assert.equal(isRunning(grandchildPid(result)), false, "the descendant still runs after the cancelled result");
  } finally {
    cleanup(dir);
  }
});

test("an ordinary SIGTERM stop waits for the descendant and does not send SIGKILL", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const kill = process.kill;
  let forced = false;
  try {
    const ready = join(dir, "ready");
    const stopped = join(dir, "stopped");
    const grandchild = [
      'const fs = require("node:fs");',
      `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(stopped)}, "1"); setTimeout(() => process.exit(0), 400); });`,
      `fs.writeFileSync(${JSON.stringify(ready)}, "1");`,
      "setTimeout(() => {}, 30000);",
    ].join("\n");
    const controller = new AbortController();
    const running = runCommand([execPath, detachedGrandchildFixture(dir, grandchild)], { signal: controller.signal });
    await waitUntil(() => existsSync(ready), "the grandchild to install its SIGTERM handler");
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === "SIGKILL") forced = true;
      return kill(pid, signal);
    }) as typeof process.kill;
    controller.abort();
    const result = await within(running, 15_000, "ordinary tree end");
    assert.equal(result.termination, "cancelled");
    assert.ok(existsSync(stopped), "the descendant handled SIGTERM");
    assert.equal(isRunning(grandchildPid(result)), false, "the descendant still runs after the result");
    assert.equal(forced, false, "SIGKILL was reached for an ordinary stop");
  } finally {
    process.kill = kill;
    cleanup(dir);
  }
});

test("a hung Windows taskkill helper cannot keep a cancelled call open", { skip: process.platform !== "win32" }, async () => {
  const dir = tempDir();
  const helperStarted = join(dir, "helper-started");
  const originalRoot = process.env.SystemRoot;
  const originalOptions = process.env.NODE_OPTIONS;
  let childPid: number | undefined;
  let helperPid: number | undefined;
  try {
    const system32 = join(dir, "System32");
    mkdirSync(system32);
    copyFileSync(execPath, join(system32, "taskkill.exe"));
    const preload = fixture(dir, "hang-helper", [
      `require("node:fs").writeFileSync(${JSON.stringify(helperStarted)}, String(process.pid));`,
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    ].join("\n"));
    const started = join(dir, "started");
    const command = fixture(dir, "command", [
      `require("node:fs").writeFileSync(${JSON.stringify(started)}, String(process.pid));`,
      "setTimeout(() => {}, 30000);",
    ].join("\n"));
    const controller = new AbortController();
    const running = runCommand([execPath, command], { signal: controller.signal });
    await waitUntil(() => existsSync(started), "the command to start");
    childPid = Number(readFileSync(started, "utf8"));
    process.env.SystemRoot = dir;
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    controller.abort();
    const result = await within(running, 12_000, "hung taskkill fallback");
    assert.equal(result.termination, "cancelled");
    // taskkill failed or stalled: only the child was killed, so odw must not
    // claim a clean tree end.
    assert.match(result.stderr, /the process tree could not be confirmed gone/);
    // Node 24 on Windows aborts at startup when SystemRoot is not a real Windows
    // directory, so the stand-in helper can exit at once instead of hanging. The
    // call must end through the `child.kill()` fallback either way. Only a
    // helper that started and hung proves the 5 s bound; Node 22 runs it.
    if (existsSync(helperStarted)) helperPid = Number(readFileSync(helperStarted, "utf8"));
    assert.equal(isRunning(childPid), false, "the fallback left the command running");
    if (helperPid !== undefined) assert.equal(isRunning(helperPid), false, "the hung helper still runs");
  } finally {
    if (originalRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalRoot;
    if (originalOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalOptions;
    if (existsSync(helperStarted)) helperPid = Number(readFileSync(helperStarted, "utf8"));
    for (const pid of [childPid, helperPid]) {
      if (pid && isRunning(pid)) process.kill(pid, "SIGKILL");
    }
    cleanup(dir);
  }
});

test("a timeout ends a deeper tree: the child of a detached grandchild is found through it", async () => {
  const dir = tempDir();
  try {
    const ready = join(dir, "ready");
    const marker = join(dir, "marker");
    const started = Date.now();
    const r = await within(
      runCommand([execPath, deepTreeFixture(dir, ready, marker, 4000)], { timeout: 2 }),
      20_000,
      "runCommand",
    );
    assert.equal(r.termination, "timeout");
    assert.ok(existsSync(ready), "the great-grandchild ran before the timeout");
    await assertNeverWritten(marker, started, 5500, "the great-grandchild survived the timeout");
  } finally {
    cleanup(dir);
  }
});

test("an abort ends a deeper tree: the child of a detached grandchild is found through it", async () => {
  const dir = tempDir();
  try {
    const ready = join(dir, "ready");
    const marker = join(dir, "marker");
    const controller = new AbortController();
    const running = runCommand([execPath, deepTreeFixture(dir, ready, marker, 3000)], { signal: controller.signal });
    await waitUntil(() => existsSync(ready), "the great-grandchild to start");
    const abortedAt = Date.now();
    controller.abort();
    const r = await within(running, 20_000, "runCommand");
    assert.equal(r.termination, "cancelled");
    await assertNeverWritten(marker, abortedAt, 3800, "the great-grandchild survived the abort");
  } finally {
    cleanup(dir);
  }
});

test("an already-aborted signal starts no process", async () => {
  const dir = tempDir();
  try {
    const marker = join(dir, "marker");
    const script = fixture(dir, "start", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");`);
    const controller = new AbortController();
    controller.abort();
    const r = await runCommand([execPath, script], { signal: controller.signal });
    assert.equal(r.termination, "cancelled");
    assert.equal(r.returncode, -1);
    assert.equal(r.timedOut, false);
    // A started fixture writes its marker well within a second.
    await assertNeverWritten(marker, Date.now(), 1000, "a process started despite the aborted signal");
  } finally {
    cleanup(dir);
  }
});

test("the output limit ends the process and records why", async () => {
  const chunks: string[] = [];
  const r = await within(
    runCommand(
      [
        execPath,
        "-e",
        "for (let i = 0; i < 1024; i++) process.stdout.write('x'.repeat(1024)); setTimeout(() => {}, 10000)",
      ],
      { maxOutputBytes: 4096, onStdout: (chunk) => chunks.push(chunk) },
    ),
    20_000,
    "runCommand",
  );
  assert.equal(r.termination, "output_limit");
  assert.equal(r.timedOut, false);
  assert.equal(r.returncode, 1);
  assert.equal(cliOk(r), false);
  assert.equal(r.stdout.length, 4096);
  assert.equal(chunks.join(""), r.stdout, "onStdout received exactly the retained text");
});

test("the output limit keeps whole characters: a split character is dropped, never replaced", async () => {
  // "é" is 2 UTF-8 bytes and "世" is 3. A cap that splits one must not retain
  // U+FFFD, which is 3 bytes and would push the retained output past the cap.
  const source = 'process.stdout.write("é世"); setTimeout(() => {}, 10000)';
  const first = await runCommand([execPath, "-e", source], { maxOutputBytes: 1 });
  assert.equal(first.termination, "output_limit");
  assert.equal(first.stdout, "");
  assert.ok(Buffer.byteLength(first.stdout, "utf8") <= 1);

  const second = await runCommand([execPath, "-e", source], { maxOutputBytes: 4 });
  assert.equal(second.termination, "output_limit");
  assert.equal(second.stdout, "é"); // "世" does not fit in the remaining 2 bytes
  assert.ok(Buffer.byteLength(second.stdout, "utf8") <= 4);
  assert.ok(!second.stdout.includes("\u{FFFD}"));

  // A character that fits whole must be kept whole: its bytes must not grow.
  const whole = await runCommand([execPath, "-e", source], { maxOutputBytes: 5 });
  assert.equal(whole.stdout, "é世");
  assert.ok(Buffer.byteLength(whole.stdout, "utf8") <= 5);
  const two = await runCommand([execPath, "-e", 'process.stdout.write("éx")'], { maxOutputBytes: 2 });
  assert.equal(two.stdout, "é"); // the whole 2-byte character, not a replacement
  const three = await runCommand([execPath, "-e", 'process.stdout.write("aéx")'], { maxOutputBytes: 3 });
  assert.equal(three.stdout, "aé");
  for (const r of [whole, two, three]) assert.ok(!r.stdout.includes("\u{FFFD}"));
});

test("onStdout receives each stdout chunk as it arrives, and nothing from stderr", async () => {
  const chunks: string[] = [];
  const r = await runCommand(
    [
      execPath,
      "-e",
      // The second write comes later, so the two chunks cannot merge.
      "process.stderr.write('err'); process.stdout.write('one'); setTimeout(() => process.stdout.write('two'), 300)",
    ],
    { onStdout: (chunk) => chunks.push(chunk) },
  );
  assert.equal(r.returncode, 0);
  assert.equal(r.termination, undefined);
  assert.equal(r.stdout, "onetwo");
  assert.equal(r.stderr, "err");
  assert.equal(chunks.join(""), "onetwo");
  assert.ok(chunks.length >= 2, "the chunks arrived separately, not once at exit");
});

test("a finished command leaves no abort listener on a shared signal", async () => {
  const controller = new AbortController();
  await runCommand([execPath, "-e", "0"], { signal: controller.signal });
  await runCommand(["this-command-does-not-exist-odw"], { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("cliOk is false for every termination, even with exit code 0", () => {
  for (const termination of ["timeout", "cancelled", "output_limit"] as const) {
    assert.equal(cliOk({ ...succeeded("done"), termination }), false);
  }
});

// A descendant that ignores SIGTERM after the direct child has exited is covered by the
// two tests "a timeout waits for a SIGTERM-ignoring descendant" and "an abort waits for ...".
test(
  "a ps that ignores SIGTERM cannot hang the tree end",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    const originalPath = process.env.PATH ?? "";
    try {
      const ready = join(dir, "ready");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      // The runner takes its snapshots with `ps`. This one swallows SIGTERM, so
      // the snapshot timeout must end it (SIGKILL), or the tree end waits forever.
      writeFileSync(join(bin, "ps"), "#!/bin/sh\ntrap '' TERM\nsleep 30\n", { mode: 0o755 });
      process.env.PATH = `${bin}${delimiter}${originalPath}`;

      const grandchild = [
        'process.on("SIGTERM", () => {});',
        `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "1");`,
        "setTimeout(() => {}, 30000);",
      ].join("\n");
      const controller = new AbortController();
      const running = runCommand([execPath, detachedGrandchildFixture(dir, grandchild)], { signal: controller.signal });
      await waitUntil(() => existsSync(ready), "the grandchild to install its SIGTERM handler");
      const abortedAt = Date.now();
      controller.abort();
      // Before the snapshot used a forceful kill, this waited forever.
      const r = await within(running, 15_000, "tree end with a stuck ps");
      assert.ok(Date.now() - abortedAt <= MAX_TERMINATION_MS, "a call settles within MAX_TERMINATION_MS");
      assert.equal(r.termination, "cancelled");
      // The snapshot could not list the tree, so odw must not claim a clean end.
      assert.match(r.stderr, /the process tree could not be confirmed gone/);
      assert.equal(r.treeCleanup, "unverified", "the result must carry the cleanup state");
    } finally {
      process.env.PATH = originalPath;
      cleanup(dir);
    }
  },
);

test(
  "a process tree that ignores SIGTERM, direct child included, is ended by SIGKILL",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      const ready = join(dir, "ready");
      const grandchild = [
        'process.on("SIGTERM", () => {});',
        `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "1");`,
        "setTimeout(() => {}, 30000);",
      ].join("\n");
      const controller = new AbortController();
      const running = runCommand([execPath, detachedGrandchildFixture(dir, grandchild, 'process.on("SIGTERM", () => {});')], {
        signal: controller.signal,
      });
      await waitUntil(() => existsSync(ready), "the grandchild to install its SIGTERM handler");
      controller.abort();
      const r = await within(running, 20_000, "runCommand");
      assert.equal(r.termination, "cancelled");
      assert.equal(isRunning(grandchildPid(r)), false, "the grandchild outlived SIGKILL");
    } finally {
      cleanup(dir);
    }
  },
);

test(
  "the SIGKILL escalation finds a process that the tree started during the grace period",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      const ready = join(dir, "ready");
      const spawned = join(dir, "spawned");
      const controller = new AbortController();
      const running = runCommand([execPath, sigtermSpawnFixture(dir, ready, spawned)], {
        signal: controller.signal,
      });
      await waitUntil(() => existsSync(ready), "the grandchild to handle SIGTERM");
      controller.abort();
      const r = await within(running, 20_000, "runCommand");
      assert.equal(r.termination, "cancelled");
      // SIGTERM reached the grandchild, which started a process that the first snapshot could not know.
      await waitUntil(
        () => existsSync(spawned) && readFileSync(spawned, "utf8") !== "",
        "the grandchild to start a new process on SIGTERM",
      );
      // The call resolves only when the tree is gone, so that process is dead now.
      assert.equal(isRunning(Number(readFileSync(spawned, "utf8"))), false, "a process started during the grace period survived SIGKILL");
    } finally {
      cleanup(dir);
    }
  },
);

test(
  "ending a process tree does not block the caller while ps takes its snapshot",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    const originalPath = process.env.PATH ?? "";
    try {
      const ready = join(dir, "ready");
      const marker = join(dir, "marker");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      // The runner finds `ps` through PATH. This one waits until `released`
      // exists, notes that it saw the file, then runs the real `ps`. If ending
      // the tree blocked the caller, nothing could create the file in time:
      // `ps` would only time out, the snapshot would be empty, and the detached
      // descendants would survive.
      writeFileSync(
        join(bin, "ps"),
        [
          "#!/bin/sh",
          "n=0",
          'while [ ! -e "${0%/*}/released" ]; do',
          "  n=$((n + 1))",
          '  [ "$n" -gt 250 ] && exit 1', // about 5 s: a stuck test fails instead of hanging
          "  sleep 0.02",
          "done",
          ': > "${0%/*}/released-seen"',
          'PATH="${PATH#*:}"',
          'exec ps "$@"',
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}${delimiter}${originalPath}`;

      const controller = new AbortController();
      const running = runCommand([execPath, deepTreeFixture(dir, ready, marker, 3000)], { signal: controller.signal });
      await waitUntil(() => existsSync(ready), "the process tree to start");
      const abortedAt = Date.now();
      controller.abort();
      // Reached only if abort() returned while `ps` still waited.
      writeFileSync(join(bin, "released"), "1");

      const r = await within(running, 20_000, "runCommand");
      assert.equal(r.termination, "cancelled");
      assert.ok(existsSync(join(bin, "released-seen")), "ps timed out before it was released: abort() blocked the caller");
      await assertNeverWritten(marker, abortedAt, 3800, "the tree survived: the snapshot never completed");
    } finally {
      process.env.PATH = originalPath;
      cleanup(dir);
    }
  },
);

// --- bridge, primitives: a cancelled agent stops the run ---------------------------

test("a cancelled adapter call throws RunStopped and is never retried", async () => {
  let calls = 0;
  const bridge = new Bridge(bridgeConfig(), {
    runner: async () => {
      calls++;
      return cancelled();
    },
  });
  // A schema allows schema retries; a cancelled attempt must not use them.
  await assert.rejects(() => bridge.run({ prompt: "x", schema: { type: "object" } }), RunStopped);
  assert.equal(calls, 1);
});

test("an unverified cleanup travels with the stop", async () => {
  const bridge = new Bridge(bridgeConfig(), {
    runner: async () => ({ ...cancelled(), treeCleanup: "unverified" }),
  });
  await assert.rejects(
    () => bridge.run({ prompt: "x" }),
    (err: RunStopped) => {
      assert.equal(err.treeCleanup, "unverified");
      return true;
    },
  );
});

test("aborting the bridge signal ends the running call with RunStopped", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const bridge = new Bridge(bridgeConfig(), {
    signal: controller.signal,
    runner: (_command, options) =>
      new Promise<CliResult>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(cancelled()), { once: true });
        entered();
      }),
  });
  const pending = bridge.run({ prompt: "x" });
  await running;
  controller.abort();
  await assert.rejects(pending, RunStopped);
});

test("an already-aborted bridge signal stops before any attempt starts", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const bridge = new Bridge(bridgeConfig(), {
    signal: controller.signal,
    runner: async () => {
      calls++;
      return succeeded("x");
    },
  });
  await assert.rejects(() => bridge.run({ prompt: "x" }), RunStopped);
  assert.equal(calls, 0);
});

test("RunStopped inside parallel() fails the whole run and settles every started agent", async () => {
  const config = bridgeConfig();
  const sink = new MemorySink();
  const bridge = new Bridge(config, { runner: async () => cancelled() });
  const p = createPrimitives({ ...buildContext(config, { sink }), bridge });
  await assert.rejects(() => p.parallel([() => p.agent("a"), () => p.agent("b")]), RunStopped);
  const agents = foldAgents(sink.events);
  assert.deepEqual(
    agents.map((a) => a.state),
    ["failed", "failed"],
    "no agent stays open",
  );
  assert.match(String(agents[0]!.error), /run was stopped/);
});

test("a fatal error before an agent starts emits no agent events", async () => {
  const config = bridgeConfig();
  const sink = new MemorySink();
  const control = new MemoryControl();
  control.stop();
  const p = createPrimitives(buildContext(config, { sink, control }));
  await assert.rejects(() => p.agent("x"), RunStopped);
  assert.deepEqual(sink.events, []);
});

// --- worker: stop ends the running agent ------------------------------------------

/** An in-process run whose only agent call runs the fixture script `agent`. */
function createAgentRun(
  root: string,
  agent: string,
  options: { script?: string; timeout?: number } = {},
): { store: RunStore; id: string } {
  const store = new RunStore(root);
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "mock",
      adapters: { mock: { command: [execPath, agent], stdin: "{prompt}", ...(options.timeout ? { timeout: options.timeout } : {}) } },
    }),
  );
  const script = join(root, "stopwf.js");
  writeFileSync(
    script,
    options.script ?? "export const meta = { name: 'stopwf', description: 'd' }\nreturn await agent('SLOW')",
  );
  return { store, id: store.create({ script, args: null, source: root, configPath }) };
}

test("stop ends a running agent, settles it in the run view, and records stopped", async () => {
  const root = tempDir();
  try {
    const agentStarted = join(root, "agent-started");
    const agentFinished = join(root, "agent-finished");
    const agent = fixture(
      root,
      "slow-agent",
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(agentStarted)}, "1");`,
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(agentFinished)}, "1"), 3000);`,
      ].join("\n"),
    );
    const { store, id } = createAgentRun(root, agent);

    const running = executeRun(store.runDir(id));
    await waitUntil(() => existsSync(agentStarted), "the agent process to start");
    const startedAt = Date.now();
    store.writeControl(id, "stop");

    assert.equal(await within(running, 15_000, "executeRun"), "stopped");
    assert.equal(store.readStatus(id).state, "stopped");
    const agents = foldAgents(store.readEvents(id));
    assert.deepEqual(
      agents.map((a) => a.state),
      ["failed"],
      "a stopped run leaves no open agent",
    );
    assert.match(String(agents[0]!.error), /run was stopped/);
    assert.equal(summarize(store, id).counts.running, 0);

    // The agent would finish about 3 s after it started.
    await assertNeverWritten(agentFinished, startedAt, 3800, "the agent kept running after the stop");
  } finally {
    cleanup(root);
  }
});

test("stop ends the whole process tree of a running agent, including a detached grandchild's child", async () => {
  const root = tempDir();
  try {
    const ready = join(root, "ready");
    const marker = join(root, "marker");
    const { store, id } = createAgentRun(root, deepTreeFixture(root, ready, marker, 3000));

    const running = executeRun(store.runDir(id));
    await waitUntil(() => existsSync(ready), "the agent's process tree to start");
    const readyAt = Date.now();
    store.writeControl(id, "stop");

    assert.equal(await within(running, 15_000, "executeRun"), "stopped");
    assert.equal(store.readStatus(id).state, "stopped");
    // The great-grandchild would write its marker about 3 s after it started.
    await assertNeverWritten(marker, readyAt, 3800, "the agent's descendants survived the stop");
  } finally {
    cleanup(root);
  }
});

test(
  "the run worker finishes the SIGKILL step before it exits after a stop",
  { skip: process.platform === "win32" },
  async () => {
    const root = tempDir();
    try {
      const ready = join(root, "ready");
      // A detached grandchild that ignores SIGTERM: only the SIGKILL step ends it.
      const grandchild = [
        'process.on("SIGTERM", () => {});',
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
        "setTimeout(() => {}, 30000);",
      ].join("\n");
      const agent = detachedGrandchildFixture(root, grandchild);
      const configPath = join(root, "odw.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({ defaultAdapter: "mock", adapters: { mock: { command: [execPath, agent], stdin: "{prompt}" } } }),
      );
      const script = join(root, "stopwf.js");
      writeFileSync(script, "export const meta = { name: 'stopwf', description: 'd' }\nreturn await agent('SLOW')");
      // A real detached worker: it exits as soon as the run is over.
      const { runId, store } = startRun(script, { source: root, runsRoot: join(root, "runs"), configPath });
      await waitUntil(() => existsSync(ready) && readFileSync(ready, "utf8") !== "", "the agent's detached grandchild to start");
      store.writeControl(runId, "stop");
      // `waitFor` returns after the worker has exited.
      const status = await within(waitFor(store, runId, { timeoutMs: 15_000, pollIntervalMs: 50 }), 20_000, "waitFor");
      assert.equal(status.state, "stopped");
      assert.equal(isRunning(Number(readFileSync(ready, "utf8"))), false, "the grandchild outlived the worker");
    } finally {
      cleanup(root);
    }
  },
);

// --- Chat Host: Codex runs through the shared runner --------------------------------

function chatTurn(cwd: string, signal?: AbortSignal) {
  const session: ChatSessionRecord = {
    id: "chat_test",
    title: "t",
    source: cwd,
    state: "idle",
    updatedAt: 0,
    messages: [],
    linkedRuns: [],
  };
  return { session, prompt: "PROMPT TEXT", cwd, signal };
}

function runChatTurn(runner: ChatTurnRunner, cwd: string, onChunk: (chunk: string) => void, signal?: AbortSignal) {
  return within(runner(chatTurn(cwd, signal), onChunk), 30_000, "chat turn");
}

test("the default chat runner streams Codex output, strips ANSI, and sends the prompt on stdin", async () => {
  const dir = tempDir();
  try {
    const codex = fixture(
      dir,
      "codex",
      String.raw`
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  process.stdout.write("\x1b[1mhello\x1b[0m\n");
  setTimeout(() => process.stdout.write(JSON.stringify({ args: process.argv.slice(2), stdin })), 300);
});
`,
    );
    const chunks: string[] = [];
    await runChatTurn(createDefaultChatRunner({ command: [execPath, codex] }), dir, (chunk) => chunks.push(chunk));
    assert.ok(chunks.length >= 2, "the output streamed in separate chunks");
    const text = chunks.join("");
    assert.ok(text.startsWith("hello\n"), "ANSI sequences are stripped");
    const seen = JSON.parse(text.slice("hello\n".length)) as { args: string[]; stdin: string };
    assert.equal(seen.stdin, "PROMPT TEXT");
    assert.equal(seen.args[0], "exec");
    assert.equal(seen.args.at(-1), "-");
    assert.equal(seen.args[seen.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(seen.args[seen.args.indexOf("--cd") + 1], dir);
  } finally {
    cleanup(dir);
  }
});

test("the default chat runner rejects with the exit code and the stderr tail", async () => {
  const dir = tempDir();
  try {
    const codex = fixture(dir, "codex", 'process.stderr.write("boom\\n"); process.exit(3);');
    await assert.rejects(
      runChatTurn(createDefaultChatRunner({ command: [execPath, codex] }), dir, () => {}),
      /codex exited with 3: boom/,
    );
  } finally {
    cleanup(dir);
  }
});

test("the default chat runner rejects when the Codex run times out", async () => {
  const dir = tempDir();
  try {
    const codex = fixture(dir, "codex", 'process.stdout.write("partial"); setTimeout(() => {}, 30000);');
    const chunks: string[] = [];
    await assert.rejects(
      runChatTurn(createDefaultChatRunner({ command: [execPath, codex], timeout: 2 }), dir, (chunk) => chunks.push(chunk)),
      /codex timed out after 2s/,
    );
    assert.equal(chunks.join(""), "partial", "output before the timeout was streamed");
  } finally {
    cleanup(dir);
  }
});

test("the default chat runner rejects when its signal aborts, and starts nothing if already aborted", async () => {
  const dir = tempDir();
  try {
    const started = join(dir, "started");
    const codex = fixture(
      dir,
      "codex",
      `require("node:fs").writeFileSync(${JSON.stringify(started)}, "1"); process.stdout.write("partial"); setTimeout(() => {}, 30000);`,
    );
    const runner = createDefaultChatRunner({ command: [execPath, codex] });
    const controller = new AbortController();
    await assert.rejects(
      runChatTurn(runner, dir, () => controller.abort(), controller.signal),
      /codex was cancelled/,
    );

    rmSync(started);
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(runChatTurn(runner, dir, () => {}, preAborted.signal), /codex was cancelled/);
    // A started fixture writes its file well within a second.
    await assertNeverWritten(started, Date.now(), 1000, "a Codex process started despite the aborted signal");
  } finally {
    cleanup(dir);
  }
});

test("the default chat runner rejects when Codex output reaches the output limit", async () => {
  const dir = tempDir();
  try {
    const codex = fixture(
      dir,
      "codex",
      [
        "const chunk = Buffer.alloc(1024 * 1024, 120);",
        "for (let i = 0; i < 40; i++) process.stdout.write(chunk);",
        "setTimeout(() => {}, 30000);",
      ].join("\n"),
    );
    let received = 0;
    await assert.rejects(
      runChatTurn(createDefaultChatRunner({ command: [execPath, codex] }), dir, (chunk) => {
        received += chunk.length;
      }),
      new RegExp(`codex output exceeded ${DEFAULT_MAX_OUTPUT_BYTES} bytes`),
    );
    assert.equal(received, DEFAULT_MAX_OUTPUT_BYTES, "the retained output is capped at the limit");
  } finally {
    cleanup(dir);
  }
});

/**
 * Start a server whose Chat Host runs the `codex` fixture, send one chat
 * message, and close the server once `ready` exists, so during the turn.
 * Returns the stored reply and when the turn was seen running.
 */
async function closeServerDuringChatTurn(dir: string, codex: string, ready: string) {
  const proj = join(dir, "proj");
  mkdirSync(proj);
  const store = new RunStore(join(dir, "runs"));
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: proj,
    claudeProjectsRoot: join(dir, "no-claude"),
    chatRunner: createDefaultChatRunner({ command: [execPath, codex] }),
  });
  try {
    const json = { "content-type": "application/json" };
    const session = (await fetch(`${handle.url}/api/chat/sessions`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ source: proj }),
    }).then((r) => r.json())) as ChatSessionRecord;
    await fetch(`${handle.url}/api/chat/sessions/${session.id}/messages`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "a plain chat message" }),
    });
    await waitUntil(() => existsSync(ready), "the Codex process to start");
    const startedAt = Date.now();
    await within(handle.close(), 15_000, "server close");

    // close() waits for the turn, so its failure is already stored.
    const reply = new ChatStore(store.root, proj).get(session.id)!.messages.at(-1)!;
    return { startedAt, reply };
  } finally {
    await handle.close();
  }
}

test("closing the server ends a running Chat Host Codex turn and records the failure", async () => {
  const dir = tempDir();
  try {
    const started = join(dir, "codex-started");
    const late = join(dir, "codex-late");
    const codex = fixture(
      dir,
      "codex",
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(started)}, "1");`,
        // A Codex process that outlives the server would write this file.
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, "1"), 3000);`,
        "setTimeout(() => {}, 30000);",
      ].join("\n"),
    );
    const { startedAt, reply } = await closeServerDuringChatTurn(dir, codex, started);
    assert.equal(reply.role, "assistant");
    assert.equal(reply.status, "failed");
    assert.match(reply.text, /codex was cancelled/);

    await assertNeverWritten(late, startedAt, 3500, "the Codex process outlived the server");
  } finally {
    cleanup(dir);
  }
});

test("closing the server ends the whole process tree of a Chat Host Codex turn", async () => {
  const dir = tempDir();
  try {
    const ready = join(dir, "ready");
    const marker = join(dir, "marker");
    // Codex starts a tool in its own process group, and the tool starts a child.
    const codex = deepTreeFixture(dir, ready, marker, 3000);
    const { startedAt } = await closeServerDuringChatTurn(dir, codex, ready);
    await assertNeverWritten(marker, startedAt, 3800, "a descendant of the Codex process outlived the server");
  } finally {
    cleanup(dir);
  }
});

test("a stop does not publish the terminal status before the agents settle", async () => {
  const states: string[] = [];
  const control = new FileControl({
    readAction: () => "stop",
    onState: (state) => states.push(state),
  });
  await assert.rejects(() => control.checkpoint(), RunStopped);
  // The worker reports "stopped" once every agent has settled. An observer that
  // sees it earlier would return before the process tree is gone.
  assert.deepEqual(states, []);
});

test(
  "a terminated call does not wait forever on a descendant that holds its pipes",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      const started = join(dir, "started");
      // A detached grandchild that inherits the pipes keeps them open after the
      // child exits, so `close` would never fire. It leaves the parent chain at
      // once, so the tree end cannot find it either.
      // The grandchild reports in only after its parent is gone, so the abort
      // arrives when the process is already out of the parent chain and holds
      // the pipes on its own.
      const grandchild = [
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(started)}, "1"), 300);`,
        "setTimeout(() => process.exit(0), 8000);",
      ].join("");
      const source = [
        'const { spawn } = require("node:child_process");',
        `spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] });`,
        "process.exit(0);",
      ].join("\n");
      const controller = new AbortController();
      const running = runCommand([execPath, "-e", source], { signal: controller.signal });
      await waitUntil(() => existsSync(started), "the descendant to start");
      controller.abort();
      // Before the bounded stream wait, this never resolved.
      const r = await within(running, 5_000, "a call with a pipe-holding descendant");
      assert.equal(r.termination, "cancelled");
      assert.equal(r.treeCleanup, "unverified", "the child had exited, so a descendant could not be found");
    } finally {
      cleanup(dir);
    }
  },
);

// --- unconfirmed ends and parallel agents ---------------------------------------------

test(
  "a signaled process that stays visible is reported as an unverified end",
  { skip: process.platform === "win32" },
  async () => {
    const realKill = process.kill;
    // Every liveness probe (signal 0) sees its target alive, as a process stuck
    // in the kernel would look. Real signals still go through.
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0) return true;
      return realKill.call(process, pid, signal);
    }) as typeof process.kill;
    try {
      const controller = new AbortController();
      const running = runCommand([execPath, "-e", "setTimeout(() => {}, 30000)"], { signal: controller.signal });
      await sleep(500);
      controller.abort();
      const r = await within(running, 15_000, "an end that cannot be confirmed");
      assert.equal(r.termination, "cancelled");
      assert.equal(r.treeCleanup, "unverified", "an end that was not seen must not be reported as verified");
      assert.match(r.stderr, /could not be confirmed gone/);
    } finally {
      process.kill = realKill;
    }
  },
);

test("an unverified cleanup of any parallel agent is reported, even when a verified stop surfaces first", async () => {
  const config = bridgeConfig();
  const bridge = new Bridge(config, {
    runner: async (_command, options) => ({
      ...cancelled(),
      treeCleanup: options?.stdin?.includes("second-agent-marker") ? "unverified" : "verified",
    }),
  });
  const p = createPrimitives({ ...buildContext(config, { sink: new MemorySink() }), bridge });
  await assert.rejects(
    () => p.parallel([() => p.agent("first"), () => p.agent("second-agent-marker")]),
    (err: RunStopped) => {
      assert.equal(err.treeCleanup, undefined, "the surfaced stop is the verified one");
      return true;
    },
  );
  assert.equal(bridge.hasUnverifiedCleanup, true, "the run can still report the worst state");
});

test(
  "a call whose child never reports an exit still settles after the bounded wait, unverified",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    const pidFile = join(dir, "pid");
    const realKill = process.kill;
    let pid = 0;
    // Real signals do nothing, as if the child were stuck in the kernel: it never
    // emits `exit` or `close`. Liveness probes (signal 0) still work.
    process.kill = ((target: number, signal?: string | number) => {
      if (signal === 0) return realKill.call(process, target, 0);
      return true;
    }) as typeof process.kill;
    try {
      const source = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
      const controller = new AbortController();
      const running = runCommand([execPath, "-e", source], { signal: controller.signal });
      await waitUntil(() => existsSync(pidFile), "the child to start");
      pid = Number(readFileSync(pidFile, "utf8"));
      controller.abort();
      // Before the termination-level fallback, this never resolved.
      const r = await within(running, MAX_TERMINATION_MS + 5_000, "a call with a stuck child");
      assert.equal(r.termination, "cancelled");
      assert.equal(r.treeCleanup, "unverified");
    } finally {
      process.kill = realKill;
      if (pid) {
        try {
          realKill.call(process, pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      cleanup(dir);
    }
  },
);

test("an output-limit stop is named in the failure, and an unverified tree is stated outside the stderr cut", async () => {
  const bridge = new Bridge(bridgeConfig(), {
    runner: async () => ({
      returncode: 1,
      stdout: "",
      stderr: "x".repeat(2000), // longer than the stderr excerpt: a note after it would be cut
      timedOut: false,
      termination: "output_limit",
      treeCleanup: "unverified",
      duration: 0,
    }),
  });
  await assert.rejects(
    () => bridge.run({ prompt: "x" }),
    (err: Error) => {
      assert.match(err.message, /exceeded its output limit/);
      assert.match(err.message, /process tree could not be confirmed gone/);
      return true;
    },
  );
});

test(
  "an unverified cleanup of a recoverable failure is reported on the finished run",
  { skip: process.platform === "win32" },
  async () => {
    const root = tempDir();
    const originalPath = process.env.PATH ?? "";
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      // A `ps` that swallows SIGTERM, so the tree end cannot list the descendants.
      writeFileSync(join(bin, "ps"), "#!/bin/sh\ntrap '' TERM\nsleep 30\n", { mode: 0o755 });
      process.env.PATH = `${bin}${delimiter}${originalPath}`;
      const agent = fixture(root, "sleepy-agent", "setTimeout(() => {}, 30000);");
      const { store, id } = createAgentRun(root, agent, {
        timeout: 1,
        // The timeout is a recoverable failure: parallel() turns it into a null slot.
        script: "export const meta = { name: 'stopwf', description: 'd' }\nconst r = await parallel([() => agent('SLOW')])\nreturn r.length",
      });
      assert.equal(await within(executeRun(store.runDir(id)), 30_000, "executeRun"), "done");
      assert.equal(store.readStatus(id).state, "done");
      assert.equal(store.readStatus(id).treeCleanup, "unverified", "a finished run still reports the cleanup state");
      const finished = store.readEvents(id).find((e) => e.type === "run_finished");
      assert.equal(finished?.treeCleanup, "unverified");
    } finally {
      process.env.PATH = originalPath;
      cleanup(root);
    }
  },
);

test(
  "a ps wrapper whose forked child holds the capture pipe does not hang the tree end",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    const originalPath = process.env.PATH ?? "";
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      // The background `sleep` inherits the pipes of `ps`. SIGKILL ends only the
      // wrapper, so the capture pipes stay open.
      writeFileSync(join(bin, "ps"), "#!/bin/sh\nsleep 30 &\nsleep 30\n", { mode: 0o755 });
      process.env.PATH = `${bin}${delimiter}${originalPath}`;
      const controller = new AbortController();
      const running = runCommand([execPath, "-e", "setTimeout(() => {}, 30000)"], { signal: controller.signal });
      await sleep(500);
      controller.abort();
      const r = await within(running, MAX_TERMINATION_MS + 5_000, "a tree end with a forking ps");
      assert.equal(r.termination, "cancelled");
      assert.equal(r.treeCleanup, "unverified", "no snapshot, so the end is not confirmed");
    } finally {
      process.env.PATH = originalPath;
      cleanup(dir);
    }
  },
);

test(
  "an abort that arrives before an asynchronous launch failure is kept as the termination",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      // Executable, but its interpreter does not exist: `spawn` reports the failure later, as an event.
      const broken = join(dir, "broken-launch");
      writeFileSync(broken, "#!/nonexistent/interpreter\n", { mode: 0o755 });
      const controller = new AbortController();
      const running = runCommand([broken], { signal: controller.signal });
      controller.abort();
      const r = await within(running, 10_000, "an aborted failed launch");
      assert.equal(r.termination, "cancelled", "the stop is not reported as an adapter failure");
      assert.match(r.stderr, /failed to launch/);
    } finally {
      cleanup(dir);
    }
  },
);
