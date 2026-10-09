import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, join, resolve, win32 } from "node:path";

/**
 * Read one environment variable. Windows ignores the case of a name, but a plain
 * copy of `process.env` keeps the case it was given, for example `Path`. Such an
 * object can hold several spellings of one name. Then the first spelling in
 * sorted order wins. Node's `spawn` keeps that same spelling for the child, so
 * odw and the child read the same value. Other platforms use the exact name.
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
 * A bare command has no directory part, so PATH selects it. Only Windows reads a
 * backslash as a separator; on POSIX it is a normal character of a file name. A
 * Windows drive-relative name (`C:tool.exe`) names a directory too: it means the
 * current directory of that drive, not a PATH lookup.
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
  // The search must read PATH the way the OS does: an empty entry is the current
  // directory. A missing PATH has a default list on Windows only; on POSIX it
  // searches no directory, as it always did here.
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
      // Always absolute: a relative result would be re-resolved against the
      // workspace the agent runs in, not against the directory of odw.
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

/**
 * The first PATH entry with this name, file or not. A search must skip a
 * directory, but a user whose command points at one needs to hear it, so this
 * lookup only explains a failure.
 */
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
 * Tell whether an adapter command can run. `env` is the environment that finds
 * the executable: odw uses its own environment for this, so a `PATH` in an
 * adapter's `env` or `envPolicy` does not change the answer. Every caller that
 * asks "is this CLI installed" uses this one answer, so none of them counts a
 * command that the launch step refuses. Only Windows refuses a command that
 * resolves: there, odw starts only an `.exe` or `.com` file, and a `.cmd` file
 * that is an npm shim that Node can run. It never starts a `.bat` file, a
 * script, or a file with no extension.
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
 * Split the text of a shim into the lines that odw compares, and the scripts on
 * its launch lines. A compared line is in lower case, with single spaces and
 * without a leading `@`, which only turns off the echo of that line. A blank
 * line does not count. In a compared line, a script is `{script}`. The shim
 * templates below pass through this same step.
 */
function readShim(text: string): { lines: string[]; scripts: Set<string> } {
  const lines: string[] = [];
  const scripts = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const marked = line.replace(SHIM_SCRIPT, (match, dp0: string, script: string) => {
      // `win32.resolve` drops the shim directory for a rooted script, and it
      // reads a drive-relative one (`C:evil.js`) against the working directory of
      // that drive, while the batch file always runs it under `%dp0%\`. A colon
      // also names an alternate data stream. Keep the line unchanged so the file
      // does not match a known template.
      if (win32.parse(script).root !== "" || script.includes(":")) return match;
      scripts.add(script);
      return `"${dp0}{script}"`;
    });
    lines.push(marked.replace(/^@\s*/, "").replace(/\s+/g, " ").toLowerCase());
  }
  return { lines, scripts };
}

// npm writes a `.cmd` shim for each global bin. Its text depends on the version
// of npm's `cmd-shim` package. Each entry below is the whole text that one
// version writes for a Node script. A file is a shim only when it matches one
// entry from the first line to the last line. Known lines in another order, or
// with a line missing, do not start Node. For example, an `EXIT /b` before the
// launch line ends the file before the script runs. An extra line means the file
// does other work, for example it sets `NODE_PATH`. Starting only Node would
// skip that work, so odw does not run such a file. The `_prog` lines allow Node
// only. `{script}` stands for the script path in each launch line.
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
 * Read the text of an npm cmd-shim (the `.cmd` file that `npm install -g`
 * creates) and return the script it runs with Node, relative to the shim
 * directory. Returns null for any other text. This includes a file with the
 * known lines in a different order, a file that does other work, and a shim
 * whose program is not Node.
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
 * Decide how to start a command on Windows. Node's `spawn` starts only a native
 * executable: it refuses a batch file unless it uses a shell, and it cannot
 * start a script. A shell route can change arguments and stdin. So odw starts
 * an `.exe` or `.com` file directly. It runs an npm shim (a `.cmd` file) as Node
 * plus the shim's script, which keeps both unchanged. Any other `.cmd` launcher,
 * every `.bat` launcher, and every script or file with no extension is an error.
 * `probeCommand` uses the same plan, so the check and the launch agree.
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
    // A directory named `tool.exe` is not a program. The loose diagnostic lookup
    // can find one, and `spawn` would fail on it.
    let file = false;
    try {
      file = statSync(resolved).isFile();
    } catch {
      file = false;
    }
    if (!file) return launchFailure(cmd, `'${resolved}' is not a file`);
    return { executable: resolved, args };
  }
  // Without a shell, Windows starts only a native executable. A script such as a
  // `.ps1` or `.js` file, and a file with no extension, needs an interpreter that
  // the user names in `command`.
  if (extension !== ".cmd" && extension !== ".bat") {
    return launchFailure(
      cmd,
      `'${resolved}' is a script that Windows cannot start directly`,
      'Set the adapter "command" to an interpreter and the script, for example ["node", "<script>"]. ' +
        `See ${WINDOWS_LAUNCHERS_DOC}.`,
    );
  }

  // npm writes `.cmd` shims only. A `.bat` file is never an npm shim, whatever
  // its text, so odw does not read it.
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
  // Like the shim: Node next to the shim first, then Node on PATH. Only
  // `node.exe` qualifies. A `node.cmd` or an extensionless `node` cannot start.
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
