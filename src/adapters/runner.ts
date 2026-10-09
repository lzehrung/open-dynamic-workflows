/**
 * The thin subprocess boundary (L1).
 *
 * The only place that actually spawns an external process. Everything above it
 * is expressed in terms of {@link CliResult}, which keeps the higher layers
 * testable without real agent accounts — a test injects a fake runner with the
 * same signature.
 *
 * A timeout or a missing executable is reported *through the result*
 * (`timedOut` / a non-zero `returncode` with the reason on stderr) rather than
 * as a thrown error, so the caller has one uniform thing to inspect.
 */

import { spawn } from "node:child_process";

import type { CliResult } from "./types.js";
import { resolveExecutable, resolveWindowsLaunch } from "./executable.js";

export interface RunCommandOptions {
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Seconds before the process is killed; omit for no timeout. */
  timeout?: number;
  /** Combined stdout+stderr bytes to retain before killing; omit for a safe default. */
  maxOutputBytes?: number;
}

/** The injectable contract for executing a command. */
export type CommandRunner = (command: string[], options?: RunCommandOptions) => Promise<CliResult>;

export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

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
    } else {
      // `spawn` resolves a relative PATH entry, and a relative command such as
      // `./bin/agent`, against `options.cwd`, while the readiness probe resolves
      // them against the directory of odw. Run the file that the probe finds, so
      // both agree. A command that the probe cannot find must not launch at all:
      // `spawn` would search for it again, relative to the agent workspace.
      const found = resolveExecutable(cmd, env, process.platform);
      if (!found) {
        resolve({
          returncode: 127,
          stdout: "",
          stderr: `failed to launch '${cmd}': not found, or not an executable file, on the PATH of the launch environment`,
          timedOut: false,
          duration: elapsed(),
        });
        return;
      }
      executable = found;
    }

    const child = spawn(executable, spawnArgs, {
      cwd: options.cwd,
      env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputBytes = 0;
    let outputExceeded = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: CliResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    if (options.timeout != null) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeout * 1000);
    }

    const appendLimited = (stream: "stdout" | "stderr", d: string): void => {
      if (outputExceeded) return;
      if (!hasOutputLimit) {
        if (stream === "stdout") stdout += d;
        else stderr += d;
        return;
      }
      const bytes = Buffer.byteLength(d);
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const chunk = bytes <= remaining ? d : Buffer.from(d).subarray(0, remaining).toString("utf8");
        if (stream === "stdout") stdout += chunk;
        else stderr += chunk;
      }
      outputBytes += bytes;
      if (bytes > remaining) {
        outputExceeded = true;
        child.kill("SIGKILL");
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
      finish({
        returncode: 127,
        stdout: "",
        stderr: `failed to launch '${cmd}': ${err.message}`,
        timedOut: false,
        duration: elapsed(),
      });
    });

    child.on("close", (code, signal) => {
      // A process killed by a signal reports code===null. Distinguish our own
      // timeout kill (already flagged) from an external/crash signal (SIGSEGV,
      // OOM SIGKILL, …) so a crash is never mistaken for a clean exit (0).
      let returncode: number;
      if (outputExceeded) returncode = 1;
      else if (timedOut) returncode = -1;
      else if (code !== null) returncode = code;
      else returncode = signal ? 128 : 1;
      const note = signal && !timedOut ? `\n[process terminated by signal ${signal}]` : "";
      const outputNote = outputExceeded
        ? `\n[process output exceeded ${maxOutputBytes} bytes; terminated]`
        : "";
      finish({ returncode, stdout, stderr: stderr + note + outputNote, timedOut, duration: elapsed() });
    });

    // The child may close stdin before consuming all input; an unhandled EPIPE
    // on the write would otherwise crash the whole process. Swallow it — the
    // real outcome arrives via the 'close'/'error' handlers above.
    child.stdin.on("error", () => {});
    if (options.stdin != null) child.stdin.write(options.stdin);
    child.stdin.end();
  });
};
