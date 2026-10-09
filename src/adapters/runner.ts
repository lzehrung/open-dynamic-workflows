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
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { CliResult } from "./types.js";
import { resolveExecutable } from "./executable.js";

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
 * The longest a terminated call takes to settle: the slower of the two tree
 * ends (POSIX: two snapshots, the SIGTERM grace, and the SIGKILL settle;
 * Windows: one taskkill), then the pipe-close wait. Callers that bound their own
 * wait on a runner (the chat shutdown) must allow at least this long.
 */
export const MAX_TERMINATION_MS =
  Math.max(2 * SNAPSHOT_TIMEOUT_MS + KILL_GRACE_MS + SIGKILL_SETTLE_MS, TASKKILL_TIMEOUT_MS) + CLOSE_GRACE_MS;

const execFileAsync = promisify(execFile);

/**
 * POSIX: the live descendants of `roots`, from one `ps` snapshot. A harness can
 * start a tool in its own process group or session (omp does), which a group
 * signal misses. The parent links still reach the tool while its parents live,
 * so take the snapshot before any signal.
 *
 * The snapshot is asynchronous: ending a tree must not block the event loop,
 * which `odw serve` shares with its HTTP requests. If `ps` is missing, fails,
 * or is slow, the set is empty.
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

/**
 * The longest prefix of `text` whose UTF-8 encoding fits in `max` bytes. A
 * character that the cap splits is dropped, not replaced: U+FFFD is itself
 * three bytes, so a replacement character would break the cap and corrupt the
 * retained output.
 */
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
      const resolved = resolveExecutable(cmd, env, "win32");
      const extension = resolved ? extname(resolved).toLowerCase() : "";
      if (extension === ".cmd" || extension === ".bat") {
        const script = resolved!.slice(0, -extension.length) + ".ps1";
        if (!existsSync(script)) {
          resolve({
            returncode: 127,
            stdout: "",
            stderr:
              `failed to launch '${cmd}': Windows batch shim '${resolved}' has no companion PowerShell script; ` +
              "configure the adapter with a directly executable command",
            timedOut: false,
            duration: elapsed(),
          });
          return;
        }
        const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
        executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        spawnArgs = [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          ...args,
        ];
      } else if (resolved) {
        executable = resolved;
      }
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

    // POSIX: the child leads its own process group, so a group signal reaches
    // the tree, except processes that start a group of their own (see
    // endProcessTree). Windows: no `detached`; the child stays in libuv's
    // kill-on-close job object, and `taskkill /T` ends the tree.
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
    let hardStop: NodeJS.Timeout | undefined;
    let treeEnd: Promise<void> | undefined;
    // The tree end could not list the descendants, or could not see them exit, so
    // it cannot promise they are gone.
    let treeIncomplete = false;

    // End the child and every process it started. Best effort: a process that
    // leaves its parent chain (it daemonizes) is out of reach.
    const endProcessTree = (): Promise<void> => {
      const pid = child.pid;
      if (pid === undefined) return Promise.resolve(); // the launch failed; nothing runs
      // The direct child already exited, yet the call is still open: a descendant
      // holds its pipes. Its parent links are gone, so a snapshot from the child
      // cannot find it. The end is not confirmed.
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
                // taskkill did not end the tree. Only the child is killed, and a
                // detached grandchild can outlive it: say the end is unverified.
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
      // Snapshot before the first signal. A parent that exits loses its links
      // to any descendants that started their own process group or session.
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
        // A survivor can start more children during SIGTERM. Use only the
        // still-live PIDs as roots, then drop those that died during the snapshot.
        const late = await posixDescendants(live);
        if (late === null) treeIncomplete = true;
        for (const descendant of late ?? []) live.add(descendant);
        for (const member of live) if (!alive(member)) live.delete(member);
        if (groupLive && !alive(-pid)) groupLive = false;
        // A PID reused within one poll interval can still be signaled. A start
        // time check needs nonportable ps output, so accept that small risk.
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
        // Sending SIGKILL does not mean that the processes have exited. A
        // zombie can remain visible to kill(0), so bound this final wait.
        const settleDeadline = Date.now() + SIGKILL_SETTLE_MS;
        while (true) {
          for (const member of live) if (!alive(member)) live.delete(member);
          if (groupLive && !alive(-pid)) groupLive = false;
          if (!groupLive && live.size === 0) return;
          const remaining = settleDeadline - Date.now();
          if (remaining <= 0) {
            // A signaled process is still visible (it may be stuck in the
            // kernel, or a zombie nobody reaped): the end is not confirmed.
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
      // The direct child can be stuck so that it emits neither `exit` nor
      // `close` (for example in the kernel). Settle anyway after the bounded
      // tree end and pipe wait, and say that the end is not confirmed.
      hardStop = setTimeout(() => {
        treeIncomplete = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        void finish(() => buildResult(null, null));
      }, MAX_TERMINATION_MS);
      hardStop.unref?.();
    };
    const onAbort = (): void => terminate("cancelled");

    const finish = async (result: () => CliResult): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
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
      // An abort or timeout can win before an asynchronous launch error. Keep the
      // first termination reason: it is not an adapter failure.
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
    // A detached descendant can hold the inherited pipes open after the tree
    // end: `exit` fires, but `close` waits for every holder of stdout or stderr.
    // For a terminated call the tree is already gone, so stop waiting for the
    // streams of a straggler. The child can also exit before the termination
    // arrives, so both orders are covered.
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
