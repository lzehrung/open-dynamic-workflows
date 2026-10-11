import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, join, resolve, win32 } from "node:path";

import type { Adapter } from "./types.js";

/**
 * Read one environment variable. On Windows the name is case-insensitive; when
 * several spellings exist, the first in sorted order wins, as in Node's `spawn`.
 */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const upper = name.toUpperCase();
  let spelling: string | undefined;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper && (spelling === undefined || key < spelling)) spelling = key;
  }
  return spelling === undefined ? undefined : env[spelling];
}

/** Candidate executable names under one platform's resolution rules. */
export function executableCandidates(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  pathext: string | undefined = envValue(process.env, "PATHEXT", platform),
): string[] {
  if (platform !== "win32" || extname(cmd)) return [cmd];
  const raw = pathext?.trim() || ".COM;.EXE;.BAT;.CMD";
  const seen = new Set<string>([cmd.toLowerCase()]);
  const candidates = [cmd];
  for (const value of raw.split(";")) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const suffix = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    const candidate = cmd + suffix;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * True when PATH selects the command: it has no directory part. On Windows that
 * also rules out a backslash and a drive, as in `C:tool.exe`.
 */
export function isBareCommand(cmd: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return !cmd.includes("/");
  return !cmd.includes("/") && !cmd.includes("\\") && win32.parse(cmd).root === "";
}

/** Resolve an executable exactly as the selected platform would search for it. */
export function resolveExecutable(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const generated = executableCandidates(cmd, platform, envValue(env, "PATHEXT", platform));
  // Windows tries PATHEXT before an extensionless shell script. This matters for
  // npm-style installs that contain both `tool` (POSIX shim) and `tool.cmd`.
  const candidates = platform === "win32" && generated.length > 1 ? [...generated.slice(1), generated[0]!] : generated;
  const explicit = !isBareCommand(cmd, platform);
  // Read PATH as the OS does: an empty entry is the current directory, and a
  // missing PATH has a default list on Windows only.
  let dirs: string[];
  if (explicit) {
    dirs = [""];
  } else {
    const pathVar = envValue(env, "PATH", platform);
    if (pathVar !== undefined) {
      dirs = pathVar.split(platform === "win32" ? ";" : delimiter).map((dir) => (dir === "" ? "." : dir));
    } else if (platform === "win32") {
      const root = envValue(env, "SystemRoot", platform) ?? "C:\\Windows";
      dirs = [".", join(root, "System32"), root];
    } else {
      dirs = [];
    }
  }
  for (const dir of dirs) {
    for (const candidate of candidates) {
      // Absolute, so the launch cannot re-resolve it against the agent's workspace.
      const path = explicit ? resolve(candidate) : resolve(dir, candidate);
      try {
        if (!statSync(path).isFile()) continue; // a directory is not a command
        if (platform === "win32") return path;
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** The first PATH entry with this name, even a directory. Used only to explain a failure. */
function findOnPathLoosely(cmd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return null;
  const explicit = !isBareCommand(cmd, platform);
  const raw = envValue(env, "PATH", platform) ?? "";
  const dirs = explicit ? [""] : raw.split(platform === "win32" ? ";" : delimiter).map((dir) => (dir === "" ? "." : dir));
  const candidates = executableCandidates(cmd, platform, envValue(env, "PATHEXT", platform));
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const path = explicit ? resolve(candidate) : resolve(dir, candidate);
      try {
        if (existsSync(path)) return path;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Where the docs explain how odw starts a Windows launcher. */
export const WINDOWS_LAUNCHERS_DOC = '"Windows launchers" in references/adapters.md';

/** What odw can do with an adapter command on one platform. */
export type CommandProbe =
  /** An executable resolves, and odw can start it. */
  | { status: "ready" }
  /** No executable resolves. */
  | { status: "missing" }
  /** An executable resolves, but odw cannot start it. `problem` says why. */
  | { status: "unlaunchable"; problem: string };

/**
 * The environment an adapter's CLI runs with: `process.env` with the adapter's
 * `env` on top, or `undefined` when there is no `env`. `Bridge` and
 * `listAdapters` both use it, so the check and the launch agree. On Windows an
 * adapter name replaces the host name in any letter case (`Path` replaces `PATH`).
 */
export function adapterLaunchEnv(
  adapter: Adapter,
  platform: NodeJS.Platform = process.platform,
  host: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (!adapter.env) return undefined;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(host)) {
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(adapter.env)) {
    if (platform === "win32") {
      const upper = name.toUpperCase();
      for (const existing of Object.keys(env)) {
        if (existing.toUpperCase() === upper) delete env[existing];
      }
    }
    env[name] = value;
  }
  return env;
}

/**
 * Whether an adapter command can run in `env`. Every "is this CLI installed"
 * check uses this. On Windows only an `.exe`, a `.com`, or an npm `.cmd` shim
 * can run.
 */
export function probeCommand(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CommandProbe {
  const resolved = resolveExecutable(cmd, env, platform) ?? findOnPathLoosely(cmd, env, platform);
  if (!resolved) return { status: "missing" };
  if (platform !== "win32") return { status: "ready" };
  const launch = planWindowsLaunch(cmd, resolved, [], env);
  return "error" in launch ? { status: "unlaunchable", problem: launch.problem } : { status: "ready" };
}

// An npm cmd-shim is about 400 bytes. A larger file is not a shim.
const MAX_SHIM_BYTES = 64 * 1024;

// The quoted script at the end of a launch line, before `%*`. Capture group 1 is
// the directory variable, and group 2 is the script.
const SHIM_SCRIPT = /"(%(?:dp0%|~dp0)\\)([^"%]+)"(?= +%\*$)/i;

/**
 * Normalize a shim for comparison (lower case, single spaces, no `@`, no blank
 * lines), and replace each launch-line script with `{script}`.
 */
function readShim(text: string): { lines: string[]; scripts: Set<string> } {
  const lines: string[] = [];
  const scripts = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const marked = line.replace(SHIM_SCRIPT, (match, dp0: string, script: string) => {
      // The batch file runs the script under `%dp0%\`. A rooted or drive-relative
      // path would make a direct launch run another file, so leave the line as is:
      // it then matches no template.
      if (win32.parse(script).root !== "" || script.includes(":")) return match;
      scripts.add(script);
      return `"${dp0}{script}"`;
    });
    lines.push(marked.replace(/^@\s*/, "").replace(/\s+/g, " ").toLowerCase());
  }
  return { lines, scripts };
}

// The exact text that each npm `cmd-shim` version writes for a Node script. A
// file is a shim only when it matches one entry in full: a reordered, missing,
// or extra line can change what the batch file does.
const SHIM_TEMPLATES: readonly (readonly string[])[] = [
  // cmd-shim 9.0.2 and later.
  String.raw`
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\{script}" %*
`,
  // cmd-shim 4.1.0 to 9.0.1.
  String.raw`
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\{script}" %*
`,
  // cmd-shim 3.0.3 to 4.0.2.
  String.raw`
@ECHO off
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

"%_prog%"  "%dp0%\{script}" %*
ENDLOCAL
EXIT /b %errorlevel%
:find_dp0
SET dp0=%~dp0
EXIT /b
`,
  // cmd-shim 3.0.2. It is the one above, but `EXIT /b` does not pass `%errorlevel%`.
  String.raw`
@ECHO off
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

"%_prog%"  "%dp0%\{script}" %*
ENDLOCAL
EXIT /b
:find_dp0
SET dp0=%~dp0
EXIT /b
`,
  // cmd-shim 2.1.0.
  String.raw`
@SETLOCAL

@IF EXIST "%~dp0\node.exe" (
  @SET "_prog=%~dp0\node.exe"
) ELSE (
  @SET "_prog=node"
  @SET PATHEXT=%PATHEXT:;.JS;=;%
)

"%_prog%"  "%~dp0\{script}" %*
@ENDLOCAL
`,
  // cmd-shim 1.1.2 to 2.0.2.
  String.raw`
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\{script}" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\{script}" %*
)
`,
  // cmd-shim 1.1.0 to 1.1.1.
  String.raw`
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\{script}" %*
) ELSE (
  node  "%~dp0\{script}" %*
)
`,
  // The shim that Node's installer writes for `corepack`. pnpm writes it too.
  String.raw`
@SETLOCAL
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\{script}" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\{script}" %*
)
`,
].map((text) => readShim(text).lines);

/**
 * The script that an npm cmd-shim runs with Node, relative to the shim, or null
 * when the text is not a known shim.
 */
export function parseNpmCmdShim(text: string): { script: string } | null {
  const { lines, scripts } = readShim(text);
  // Every launch line must run the same script.
  if (scripts.size !== 1) return null;
  const known = SHIM_TEMPLATES.some(
    (template) => template.length === lines.length && template.every((line, i) => line === lines[i]),
  );
  return known ? { script: [...scripts][0]! } : null;
}

type LaunchPlan = { executable: string; args: string[] } | { error: string; problem: string };

/** A launch failure. `problem` is the first sentence of `error`, without the end mark. */
function launchFailure(cmd: string, problem: string, advice?: string): { error: string; problem: string } {
  return { error: `failed to launch '${cmd}': ${problem}${advice ? `. ${advice}` : ""}`, problem };
}

/**
 * How to start a command on Windows without a shell, which can change arguments
 * and stdin: an `.exe` or `.com` directly, and an npm shim as `node <script>`.
 * Anything else is an error. `probeCommand` uses the same plan.
 */
export function resolveWindowsLaunch(cmd: string, args: string[], env: NodeJS.ProcessEnv): LaunchPlan {
  const resolved = resolveExecutable(cmd, env, "win32") ?? findOnPathLoosely(cmd, env, "win32");
  // Not found: `spawn` reports the missing command.
  if (!resolved) return { executable: cmd, args };
  return planWindowsLaunch(cmd, resolved, args, env);
}

/** The launch step for a command that resolved to `resolved`. */
function planWindowsLaunch(cmd: string, resolved: string, args: string[], env: NodeJS.ProcessEnv): LaunchPlan {
  const extension = win32.extname(resolved).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    // A directory named `tool.exe` is not a program.
    let file = false;
    try {
      file = statSync(resolved).isFile();
    } catch {
      file = false;
    }
    if (!file) return launchFailure(cmd, `'${resolved}' is not a file`);
    return { executable: resolved, args };
  }
  // A script or an extensionless file needs an interpreter named in `command`.
  if (extension !== ".cmd" && extension !== ".bat") {
    return launchFailure(
      cmd,
      `'${resolved}' is a script that Windows cannot start directly`,
      'Set the adapter "command" to an interpreter and the script, for example ["node", "<script>"]. ' +
        `See ${WINDOWS_LAUNCHERS_DOC}.`,
    );
  }

  // npm writes `.cmd` shims only, so a `.bat` file is never one.
  let shim: { script: string } | null = null;
  if (extension === ".cmd") {
    let text = "";
    try {
      if (statSync(resolved).size <= MAX_SHIM_BYTES) text = readFileSync(resolved, "utf8");
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      return launchFailure(cmd, `could not read batch launcher '${resolved}': ${reason}`);
    }
    shim = parseNpmCmdShim(text);
  }
  if (!shim) {
    return launchFailure(
      cmd,
      `'${resolved}' is a batch launcher that odw cannot run`,
      "odw runs executables and npm shims for Node scripts. " +
        'Set the adapter "command" to the real executable or to an explicit interpreter. ' +
        `See ${WINDOWS_LAUNCHERS_DOC}.`,
    );
  }
  const shimDir = win32.dirname(resolved);
  const script = win32.resolve(shimDir, shim.script);
  if (!existsSync(script)) {
    return launchFailure(
      cmd,
      `npm shim '${resolved}' runs '${script}', which does not exist`,
      'Reinstall the package, or set the adapter "command" to the real executable.',
    );
  }
  // As the shim does: `node.exe` next to the shim, else `node.exe` on PATH.
  const bundled = win32.resolve(shimDir, "node.exe");
  let adjacent: string | null = null;
  try {
    if (statSync(bundled).isFile()) adjacent = bundled; // a directory named node.exe is not Node
  } catch {
    adjacent = null;
  }
  const node = adjacent ?? resolveExecutable("node.exe", env, "win32");
  if (!node) {
    return launchFailure(
      cmd,
      `npm shim '${resolved}' needs Node.js, but odw found no 'node.exe' next to the shim or on PATH`,
      'Add Node.js to PATH, or set the adapter "command" to the real executable.',
    );
  }
  // An absolute path keeps `spawn` from resolving the program against the child's cwd.
  return { executable: win32.resolve(node), args: [script, ...args] };
}
