/**
 * The thin subprocess boundary (L1).
 *
 * The only place that actually spawns an external process. Everything above it
 * is expressed in terms of {@link CliResult}, which keeps the higher layers
 * testable without real agent accounts — a test injects a fake runner with the
 * same signature.
 *
 * A timeout, a cancellation, the output limit, or a missing executable is
 * reported *through the result* (`termination` / `timedOut` / a non-zero
 * `returncode` with the reason on stderr) rather than as a thrown error, so
 * the caller has one uniform thing to inspect.
 */

import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { CliResult } from "./types.js";
import { resolveWindowsLaunch } from "./executable.js";

export interface RunCommandOptions {
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Seconds before the process tree is ended; omit for no timeout. */
  timeout?: number;
  /** Combined stdout+stderr bytes to retain before ending the process tree; omit for a safe default. */
  maxOutputBytes?: number;
  /** Aborting ends the process tree. The result reports `termination: "cancelled"`; an already-aborted signal starts no process. */
  signal?: AbortSignal;
  /** Called with each retained stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void;
}

/** The injectable contract for executing a command. */
export type CommandRunner = (command: string[], options?: RunCommandOptions) => Promise<CliResult>;

export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Why ODW ended a process (see {@link CliResult.termination}). */
type Termination = NonNullable<CliResult["termination"]>;

/** POSIX: how long a process tree gets to exit after SIGTERM before it receives SIGKILL. */
const KILL_GRACE_MS = 2000;
/** POSIX: longest wait for signaled processes to exit after SIGKILL. */
const SIGKILL_SETTLE_MS = 1000;

/** POSIX: the longest wait for one `ps` snapshot of the process table. */
const SNAPSHOT_TIMEOUT_MS = 1000;
/** Windows: longest wait for a taskkill helper before falling back to child.kill(). */
const TASKKILL_TIMEOUT_MS = 5000;

/** How long a terminated call waits for a straggler's inherited pipes to close. */
const CLOSE_GRACE_MS = 2000;

/**
 * The longest a terminated call takes to settle. A caller that bounds its own
 * wait on the runner (the chat shutdown) must allow at least this long.
 */
export const MAX_TERMINATION_MS =
  Math.max(2 * SNAPSHOT_TIMEOUT_MS + KILL_GRACE_MS + SIGKILL_SETTLE_MS, TASKKILL_TIMEOUT_MS) + CLOSE_GRACE_MS;

const execFileAsync = promisify(execFile);

/**
 * POSIX: the descendants of `roots`, from one async `ps` snapshot, or null when
 * `ps` fails or overruns. Harnesses such as omp start tools in their own process
 * group, which a group signal misses, so take the snapshot before any signal.
 */
async function posixDescendants(roots: Iterable<number>): Promise<Set<number> | null> {
  const queue = [...roots];
  const found = new Set<number>();
  let table: string;
  try {
    table = (
      await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
        encoding: "utf8",
        timeout: SNAPSHOT_TIMEOUT_MS,
        killSignal: "SIGKILL",
      })
    ).stdout;
  } catch {
    return null; // no usable `ps`: say so, the group signal still reaches the child's own group
  }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const list = children.get(ppid!);
    if (list) list.push(pid!);
    else children.set(ppid!, [pid!]);
  }
  while (queue.length > 0) {
    for (const pid of children.get(queue.pop()!) ?? []) {
      if (found.has(pid)) continue;
      found.add(pid);
      queue.push(pid);
    }
  }
  return found;
}

/** The longest prefix of `text` that fits in `max` UTF-8 bytes, without splitting a character. */
function utf8Prefix(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8").subarray(0, max);
  const n = buf.length;
  if (n === 0) return "";
  // Start of the last character in the buffer.
  let start = n - 1;
  while (start > 0 && (buf[start]! & 0xc0) === 0x80) start--;
  const lead = buf[start]!;
  const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  // Keep the last character only when it is whole.
  const end = start + need <= n ? n : start;
  return buf.subarray(0, end).toString("utf8");
}

export const runCommand: CommandRunner = (command, options = {}) => {
  const started = Date.now();
  const elapsed = (): number => (Date.now() - started) / 1000;
  const [cmd, ...args] = command;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const hasOutputLimit = Number.isFinite(maxOutputBytes);

  return new Promise<CliResult>((resolve) => {
    if (!cmd) {
      resolve({ returncode: 127, stdout: "", stderr: "empty command", timedOut: false, duration: 0 });
      return;
    }

    let executable = cmd;
    let spawnArgs = args;
    const env = options.env ?? process.env;
    if (process.platform === "win32") {
      const launch = resolveWindowsLaunch(cmd, args, env);
      if ("error" in launch) {
        resolve({ returncode: 127, stdout: "", stderr: launch.error, timedOut: false, duration: elapsed() });
        return;
      }
      executable = launch.executable;
      spawnArgs = launch.args;
    }

    if (options.signal?.aborted) {
      resolve({
        returncode: -1,
        stdout: "",
        stderr: "",
        timedOut: false,
        termination: "cancelled",
        duration: elapsed(),
      });
      return;
    }

    // POSIX: the child leads its own process group, so a group signal reaches the
    // tree. Windows: the child stays in libuv's kill-on-close job; `taskkill /T` ends the tree.
    const child = spawn(executable, spawnArgs, {
      cwd: options.cwd,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let termination: Termination | undefined;
    let outputBytes = 0;
    let outputExceeded = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let treeEnd: Promise<void> | undefined;
    // Set when odw cannot confirm that the whole tree is gone.
    let treeIncomplete = false;

    // End the child and every process it started. Best effort: a process that
    // leaves its parent chain (it daemonizes) is out of reach.
    const endProcessTree = (): Promise<void> => {
      const pid = child.pid;
      if (pid === undefined) return Promise.resolve(); // the launch failed; nothing runs
      // The child already exited, so a snapshot cannot find its descendants.
      if (child.exitCode !== null || child.signalCode !== null) treeIncomplete = true;
      if (process.platform === "win32") {
        // The PID of an exited child can be reused, so target a live child only.
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
        // If taskkill fails or stalls, end at least the child itself.
        return new Promise<void>((done) => {
          try {
            const killer = spawn(`${systemRoot}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
            let finished = false;
            const finish = (fallback: boolean): void => {
              if (finished) return;
              finished = true;
              clearTimeout(limit);
              if (fallback) {
                // taskkill failed: only the child is killed, so the end is not confirmed.
                treeIncomplete = true;
                child.kill();
              }
              done();
            };
            const fail = (): void => {
              killer.kill();
              finish(true);
            };
            const limit = setTimeout(fail, TASKKILL_TIMEOUT_MS);
            killer.once("error", fail);
            killer.once("close", (code) => finish(code !== 0));
          } catch {
            treeIncomplete = true;
            child.kill();
            done();
          }
        });
      }
      // Snapshot before the first signal (see posixDescendants).
      return (async () => {
        const first = await posixDescendants([pid]);
        if (first === null) treeIncomplete = true;
        const descendants = first ?? [];
        const live = new Set([pid, ...descendants]);
        const alive = (target: number): boolean => {
          try {
            process.kill(target, 0);
            return true;
          } catch (err) {
            return (err as NodeJS.ErrnoException).code !== "ESRCH";
          }
        };
        let groupLive = true;
        try {
          process.kill(-pid, "SIGTERM");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGTERM");
        }
        for (const descendant of descendants) {
          try {
            process.kill(descendant, "SIGTERM");
          } catch {
            /* already gone */
          }
        }
        const deadline = Date.now() + KILL_GRACE_MS;
        while (true) {
          for (const member of live) if (!alive(member)) live.delete(member);
          if (groupLive && !alive(-pid)) groupLive = false;
          if (!groupLive && live.size === 0) return;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await delay(Math.min(50, remaining));
        }
        // Survivors may have started children during SIGTERM: snapshot again from them.
        const late = await posixDescendants(live);
        if (late === null) treeIncomplete = true;
        for (const descendant of late ?? []) live.add(descendant);
        for (const member of live) if (!alive(member)) live.delete(member);
        if (groupLive && !alive(-pid)) groupLive = false;
        // Known risk: a PID reused within one poll interval can still be signaled.
        if (groupLive) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
          }
        }
        for (const member of live) {
          if (member === pid && groupLive) continue; // the group signal covers its leader
          try {
            process.kill(member, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
        // Wait, with a bound, for the killed processes to disappear.
        const settleDeadline = Date.now() + SIGKILL_SETTLE_MS;
        while (true) {
          for (const member of live) if (!alive(member)) live.delete(member);
          if (groupLive && !alive(-pid)) groupLive = false;
          if (!groupLive && live.size === 0) return;
          const remaining = settleDeadline - Date.now();
          if (remaining <= 0) {
            // Still visible (stuck in the kernel, or an unreaped zombie): not confirmed.
            treeIncomplete = true;
            return;
          }
          await delay(Math.min(50, remaining));
        }
      })();
    };

    // The first reason wins; a later trigger (a timeout during the grace period) changes nothing.
    const terminate = (reason: Termination): void => {
      if (termination !== undefined || settled) return;
      termination = reason;
      treeEnd = endProcessTree();
      boundClose();
    };
    const onAbort = (): void => terminate("cancelled");

    const finish = async (result: () => CliResult): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      await treeEnd;
      resolve(result());
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeout != null) {
      timer = setTimeout(() => terminate("timeout"), options.timeout * 1000);
    }

    const retain = (stream: "stdout" | "stderr", text: string): void => {
      if (stream === "stderr") {
        stderr += text;
        return;
      }
      stdout += text;
      options.onStdout?.(text);
    };

    const appendLimited = (stream: "stdout" | "stderr", d: string): void => {
      if (outputExceeded) return;
      if (!hasOutputLimit) {
        retain(stream, d);
        return;
      }
      const bytes = Buffer.byteLength(d);
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        retain(stream, bytes <= remaining ? d : utf8Prefix(d, remaining));
      }
      outputBytes += bytes;
      if (bytes > remaining) {
        outputExceeded = true;
        terminate("output_limit");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      appendLimited("stdout", d);
    });
    child.stderr.on("data", (d: string) => {
      appendLimited("stderr", d);
    });

    child.on("error", (err) => {
      // A stop or timeout that came first is not a launch failure: keep it.
      void finish(() => ({
        returncode: termination !== undefined ? -1 : 127,
        stdout: "",
        stderr: `failed to launch '${cmd}': ${err.message}`,
        timedOut: termination === "timeout",
        ...(termination
          ? { termination, treeCleanup: treeIncomplete ? ("unverified" as const) : ("verified" as const) }
          : {}),
        duration: elapsed(),
      }));
    });

    const buildResult = (code: number | null, signal: NodeJS.Signals | null): CliResult => {
      // A process killed by a signal reports code===null. Distinguish our own
      // kill (recorded in `termination`) from an external/crash signal
      // (SIGSEGV, OOM SIGKILL, …) so a crash is never mistaken for a clean exit (0).
      let returncode: number;
      if (termination === "output_limit") returncode = 1;
      else if (termination !== undefined) returncode = -1;
      else if (code !== null) returncode = code;
      else returncode = signal ? 128 : 1;
      const note = signal && termination === undefined ? `\n[process terminated by signal ${signal}]` : "";
      const treeNote = treeIncomplete
        ? "\n[odw: the process tree could not be confirmed gone; a descendant may still run]"
        : "";
      const outputNote = outputExceeded
        ? `\n[process output exceeded ${maxOutputBytes} bytes; terminated]`
        : "";
      return {
        returncode,
        stdout,
        stderr: stderr + note + outputNote + treeNote,
        timedOut: termination === "timeout",
        ...(termination
          ? { termination, treeCleanup: treeIncomplete ? ("unverified" as const) : ("verified" as const) }
          : {}),
        duration: elapsed(),
      };
    };
    child.on("close", (code, signal) => {
      void finish(() => buildResult(code, signal));
    });
    // A descendant can hold the pipes open after the child exits, so `close` may
    // never fire. For a terminated call, stop waiting after CLOSE_GRACE_MS.
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const boundClose = (): void => {
      if (exited === null) return;
      const giveUp = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        void finish(() => buildResult(exited!.code, exited!.signal));
      }, CLOSE_GRACE_MS);
      giveUp.unref?.();
    };
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (termination !== undefined) boundClose();
    });

    // The child may close stdin before consuming all input; an unhandled EPIPE
    // on the write would otherwise crash the whole process. Swallow it — the
    // real outcome arrives via the 'close'/'error' handlers above.
    child.stdin.on("error", () => {});
    if (options.stdin != null) child.stdin.write(options.stdin);
    child.stdin.end();
  });
};
