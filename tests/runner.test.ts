import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { execPath } from "node:process";

import { isBareCommand, parseNpmCmdShim, probeCommand, resolveExecutable, resolveWindowsLaunch } from "../src/adapters/executable.js";
import { defaultConfig, listAdapters } from "../src/adapters/config.js";
import { runCommand } from "../src/adapters/runner.js";
import { CURSOR_AGENT_CMD } from "./windows-launcher-fixtures.js";

test("captures stdout and a clean exit", async () => {
  const r = await runCommand([execPath, "-e", "process.stdout.write('hello')"]);
  assert.equal(r.returncode, 0);
  assert.equal(r.stdout, "hello");
  assert.equal(r.timedOut, false);
});

test("passes stdin through to the process", async () => {
  const r = await runCommand([execPath, "-e", "process.stdin.pipe(process.stdout)"], {
    stdin: "echo-me",
  });
  assert.equal(r.stdout, "echo-me");
});

test("a non-zero exit is reported, not thrown", async () => {
  const r = await runCommand([execPath, "-e", "process.exit(3)"]);
  assert.equal(r.returncode, 3);
});

test("a missing executable becomes returncode 127", async () => {
  const r = await runCommand(["this-command-does-not-exist-odw"]);
  assert.equal(r.returncode, 127);
  assert.match(r.stderr, /failed to launch/);
});

// npm's cmd-shim writes a `.cmd` file for each global bin. Its template changes
// between cmd-shim versions. Each builder below returns one template. `script` is
// the target relative to the shim directory. `program` is what the shim starts.
// Each builder matches the real output of the cmd-shim versions in its comment.
const CRLF = "\r\n";
const GOTO_PREFIX = "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ";
const PATHEXT_LINE = "  SET PATHEXT=%PATHEXT:;.JS;=;%";
const SHIM_HEAD = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
];
const progBlock = (program: string, extra: string[]): string[] => [
  `IF EXIST "%dp0%\\${program}.exe" (`,
  `  SET "_prog=%dp0%\\${program}.exe"`,
  ") ELSE (",
  `  SET "_prog=${program}"`,
  ...extra,
  ")",
  "",
];
// cmd-shim 4.1.0 to 9.0.1. Today's npm writes this template (a real `codex.cmd` matches it).
const cmdShim4 = (script: string, program = "node"): string =>
  [
    ...SHIM_HEAD,
    ...progBlock(program, [PATHEXT_LINE]),
    `${GOTO_PREFIX}"%_prog%"  "%dp0%\\${script}" %*`,
    "",
  ].join(CRLF);
// cmd-shim 9.0.2: the PATHEXT change moves from the ELSE block into the launch line.
const cmdShim9 = (script: string, program = "node"): string =>
  [
    ...SHIM_HEAD,
    ...progBlock(program, []),
    `${GOTO_PREFIX}set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${script}" %*`,
    "",
  ].join(CRLF);
// cmd-shim 3.0.3 and 4.0.2: the launch line stands alone. `ENDLOCAL` and a subroutine follow it.
const cmdShim3 = (script: string, program = "node"): string =>
  [
    "@ECHO off",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    ...progBlock(program, [PATHEXT_LINE]),
    `"%_prog%"  "%dp0%\\${script}" %*`,
    "ENDLOCAL",
    "EXIT /b %errorlevel%",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    "",
  ].join(CRLF);
// cmd-shim 3.0.2: the same as 3.0.3, but the first `EXIT /b` does not pass `%errorlevel%`.
const cmdShim302 = (script: string, program = "node"): string =>
  cmdShim3(script, program).replace("EXIT /b %errorlevel%", "EXIT /b");
// cmd-shim 2.1.0: `_prog` holds `%~dp0`, and the lines start with `@`.
const cmdShim2 = (script: string, program = "node"): string =>
  [
    "@SETLOCAL",
    "",
    `@IF EXIST "%~dp0\\${program}.exe" (`,
    `  @SET "_prog=%~dp0\\${program}.exe"`,
    ") ELSE (",
    `  @SET "_prog=${program}"`,
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `"%_prog%"  "%~dp0\\${script}" %*`,
    "@ENDLOCAL",
    "",
  ].join(CRLF);
// cmd-shim 2.0.0 to 2.0.2: no `_prog` variable. Each branch of the IF starts Node.
// No newline ends the file.
const oldestShim = (script: string, program = "node"): string =>
  [
    `@IF EXIST "%~dp0\\${program}.exe" (`,
    `  "%~dp0\\${program}.exe"  "%~dp0\\${script}" %*`,
    ") ELSE (",
    "  @SETLOCAL",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  ${program}  "%~dp0\\${script}" %*`,
    ")",
  ].join(CRLF);
// cmd-shim 1.1.0 to 1.1.1: no `SETLOCAL` and no `PATHEXT` change. No newline ends the file.
const cmdShim1 = (script: string, program = "node"): string =>
  [
    `@IF EXIST "%~dp0\\${program}.exe" (`,
    `  "%~dp0\\${program}.exe"  "%~dp0\\${script}" %*`,
    ") ELSE (",
    `  ${program}  "%~dp0\\${script}" %*`,
    ")",
  ].join(CRLF);
// The variant that Node's installer ships as `corepack.cmd` (a real file matches it).
const nodeInstallerShim = (script: string, program = "node"): string =>
  [
    "@SETLOCAL",
    `@IF EXIST "%~dp0\\${program}.exe" (`,
    `  "%~dp0\\${program}.exe"  "%~dp0\\${script}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  ${program}  "%~dp0\\${script}" %*`,
    ")",
    "",
  ].join(CRLF);
const SHIM_TEMPLATES = {
  cmdShim9,
  cmdShim4,
  cmdShim3,
  cmdShim302,
  cmdShim2,
  oldestShim,
  cmdShim1,
  nodeInstallerShim,
};

test("parseNpmCmdShim reads the script from every npm cmd-shim template", () => {
  const script = "node_modules\\probe\\bin\\cli.js";
  for (const [name, shim] of Object.entries(SHIM_TEMPLATES)) {
    assert.deepEqual(parseNpmCmdShim(shim(script)), { script }, name);
  }
});

test("parseNpmCmdShim keeps the script path as written and accepts LF line endings", () => {
  const script = "..\\My Tools\\Pkg\\Cli.js";
  for (const [name, shim] of Object.entries(SHIM_TEMPLATES)) {
    assert.deepEqual(parseNpmCmdShim(shim(script)), { script }, name);
    assert.deepEqual(parseNpmCmdShim(shim(script).replaceAll(CRLF, "\n")), { script }, name);
  }
});

test("parseNpmCmdShim ignores letter case, spacing, and blank lines outside the script path", () => {
  const script = "node_modules\\Probe\\Bin\\Cli.js";
  for (const [name, shim] of Object.entries(SHIM_TEMPLATES)) {
    const respaced = shim(script)
      .split(CRLF)
      .map((line) => `\t  ${line.toLowerCase().replaceAll(" ", "   ").replace(script.toLowerCase(), script)}  `)
      .join("\n\n");
    assert.deepEqual(parseNpmCmdShim(respaced), { script }, name);
  }
});

test("parseNpmCmdShim rejects a shim whose program is not Node", () => {
  for (const [name, shim] of Object.entries(SHIM_TEMPLATES)) {
    assert.deepEqual(parseNpmCmdShim(shim("x.js")), { script: "x.js" }, name);
    assert.equal(parseNpmCmdShim(shim("x.js", "bash")), null, name);
  }
});

test("parseNpmCmdShim rejects batch files that do more than start Node", () => {
  const rejected: Record<string, string> = {
    "empty file": "",
    "plain batch file": "@echo off\r\nexit /b 99\r\n",
    "PowerShell launcher (Cursor agent.cmd)": CURSOR_AGENT_CMD,
    "native program (no Node)": [...SHIM_HEAD, '"%dp0%\\bin\\tool.exe"   %*', ""].join(CRLF),
    "extra environment setup": cmdShim4("x.js").replace(
      `CALL :find_dp0${CRLF}`,
      `CALL :find_dp0${CRLF}SET NODE_PATH=C:\\libs${CRLF}`,
    ),
    "Node flag before the script": cmdShim4("x.js").replace('"  "%dp0%', '" --harmony "%dp0%'),
    "extra arguments before %*": cmdShim4("x.js").replace(" %*", " --flag %*"),
    "launch lines run different scripts": oldestShim("a.js").replace(
      'node  "%~dp0\\a.js"',
      'node  "%~dp0\\b.js"',
    ),
  };
  for (const [name, text] of Object.entries(rejected)) {
    assert.equal(parseNpmCmdShim(text), null, name);
  }
});

test("parseNpmCmdShim rejects known lines that are in the wrong shape", () => {
  // Move the launch line of cmd-shim 3 to just after `CALL :find_dp0`.
  const lines = cmdShim3("x.js").split(CRLF);
  const launch = lines.findIndex((line) => line.startsWith('"%_prog%"'));
  const launchFirst = [...lines.slice(0, 3), lines[launch]!, ...lines.slice(3, launch), ...lines.slice(launch + 1)];
  const rejected: Record<string, string> = {
    // The batch file ends at `EXIT /b`. It never starts a program, and `_prog` has no value.
    "EXIT /b before the launch line": ["EXIT /b", '"%_prog%"  "%~dp0\\x.js" %*'].join(CRLF),
    "EXIT /b before the launch line, after the full setup": cmdShim4("x.js").replace(
      "endLocal &",
      `EXIT /b${CRLF}endLocal &`,
    ),
    "launch line before the setup": launchFirst.join(CRLF),
    "no _prog value in the ELSE branch": cmdShim4("x.js").replace(`  SET "_prog=node"${CRLF}`, ""),
    "no _prog value in the IF branch": cmdShim4("x.js").replace(`  SET "_prog=%dp0%\\node.exe"${CRLF}`, ""),
    "no _prog assignment at all": cmdShim2("x.js")
      .split(CRLF)
      .filter((line) => !line.includes("_prog="))
      .join(CRLF),
    "setup of one template with the launch line of another": cmdShim4("x.js").replace(
      /^endLocal.*$/m,
      '"%~dp0\\node.exe"  "%~dp0\\x.js" %*',
    ),
  };
  for (const [name, text] of Object.entries(rejected)) {
    assert.equal(parseNpmCmdShim(text), null, name);
  }
});

test("parseNpmCmdShim rejects every template with one line removed, repeated, or swapped", () => {
  for (const [name, shim] of Object.entries(SHIM_TEMPLATES)) {
    // Blank lines do nothing, so the base text has none. It must still parse.
    const lines = shim("x.js")
      .split(CRLF)
      .filter((line) => line.trim() !== "");
    assert.deepEqual(parseNpmCmdShim(lines.join(CRLF)), { script: "x.js" }, name);
    const mutants: string[][] = [];
    for (let i = 0; i < lines.length; i++) {
      mutants.push(lines.filter((_, at) => at !== i));
      mutants.push([...lines.slice(0, i + 1), ...lines.slice(i)]);
      if (lines[i + 1] !== undefined && lines[i] !== lines[i + 1]) {
        mutants.push([...lines.slice(0, i), lines[i + 1]!, lines[i]!, ...lines.slice(i + 2)]);
      }
    }
    for (const mutant of mutants) {
      assert.equal(parseNpmCmdShim(mutant.join(CRLF)), null, `${name}:\n${mutant.join("\n")}`);
    }
  }
});

// A probe CLI behind an npm shim. It prints its argv, the hex of every stdin byte,
// and the Node that runs it.
const PROBE_CLI = [
  "const chunks = [];",
  "process.stdin.on('data', (chunk) => chunks.push(chunk));",
  "process.stdin.on('end', () => {",
  "  const stdin = Buffer.concat(chunks).toString('hex');",
  "  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin, node: process.execPath }));",
  "});",
].join("\n");
// npm also writes a `<name>.ps1` shim. This one leaves a marker file if anything runs it.
const TRAP_MARKER = "powershell-ran.txt";
const POWERSHELL_TRAP = `Set-Content -Path (Join-Path $PSScriptRoot '${TRAP_MARKER}') -Value 'ran'\n`;
// A CLI behind an npm shim that leaves a marker file next to the shim if Node runs it.
const NODE_MARKER = "node-ran.txt";
const MARKER_CLI = `require("node:fs").writeFileSync(require("node:path").join(__dirname, "..", "..", "${NODE_MARKER}"), "ran");\n`;
const SHIM_ARGV = ['say "hi" there', "", "a&b|c", "100%"];
const SHIM_STDIN = "héllo – 世界 🚀\nline2";

function writeProbeShim(dir: string, name: string): void {
  mkdirSync(join(dir, "node_modules", "probe"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "probe", "cli.js"), PROBE_CLI);
  writeFileSync(join(dir, `${name}.cmd`), cmdShim4("node_modules\\probe\\cli.js"));
  writeFileSync(join(dir, `${name}.ps1`), POWERSHELL_TRAP);
}

const shimEnv = (path: string): Record<string, string> =>
  ({ ...process.env, PATH: path, PATHEXT: ".CMD" }) as Record<string, string>;

const sameFile = (a: string, b: string): boolean =>
  realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

// Run the probe shim with SHIM_ARGV and SHIM_STDIN. Assert that both arrive unchanged.
async function runProbeShim(command: string, env: Record<string, string>): Promise<{ node: string }> {
  const result = await runCommand([command, ...SHIM_ARGV], { stdin: SHIM_STDIN, env });
  assert.equal(result.returncode, 0, result.stderr);
  const probe = JSON.parse(result.stdout) as { argv: string[]; stdin: string; node: string };
  assert.deepEqual(probe.argv, SHIM_ARGV);
  assert.equal(probe.stdin, Buffer.from(SHIM_STDIN).toString("hex"));
  return probe;
}

test(
  "Windows npm shims run their script with the node.exe next to them, and argv and stdin arrive unchanged",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw runner shim-"));
    try {
      writeProbeShim(dir, "odw-probe");
      copyFileSync(execPath, join(dir, "node.exe"));
      // The command is a path, and PATH holds no Node. Only the copy next to the shim can run the script.
      const systemDir = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      const probe = await runProbeShim(join(dir, "odw-probe.cmd"), shimEnv(systemDir));
      assert.ok(sameFile(probe.node, join(dir, "node.exe")), probe.node);
      assert.equal(existsSync(join(dir, TRAP_MARKER)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "Windows npm shims without a node.exe next to them use node from PATH",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw runner shim-"));
    try {
      writeProbeShim(dir, "odw-probe");
      const probe = await runProbeShim("odw-probe", shimEnv([dir, dirname(execPath)].join(delimiter)));
      assert.ok(sameFile(probe.node, execPath), probe.node);
      assert.equal(existsSync(join(dir, TRAP_MARKER)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "Windows npm shims fail with a clear error when Node or the shim script is missing",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw runner shim-"));
    try {
      writeProbeShim(dir, "odw-probe");
      const noNode = await runCommand(["odw-probe"], { env: shimEnv(dir) });
      assert.equal(noNode.returncode, 127);
      assert.match(noNode.stderr, /failed to launch 'odw-probe': .* needs Node\.js/);

      writeFileSync(join(dir, "odw-gone.cmd"), cmdShim4("node_modules\\gone\\cli.js"));
      const noScript = await runCommand(["odw-gone"], { env: shimEnv(dir) });
      assert.equal(noScript.returncode, 127);
      assert.match(noScript.stderr, /failed to launch 'odw-gone': .* does not exist/);
      assert.ok(noScript.stderr.includes(join(dir, "node_modules", "gone", "cli.js")), noScript.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "Windows batch launchers that are not npm shims are rejected, and no interpreter runs",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw runner shim-"));
    try {
      for (const extension of ["cmd", "bat"]) {
        const name = `odw-${extension}-launcher`;
        writeFileSync(join(dir, `${name}.${extension}`), '@echo off\r\necho ran> "%~dp0odw-batch-ran"\r\nexit /b 99\r\n');
        writeFileSync(join(dir, `${name}.ps1`), POWERSHELL_TRAP);
        const result = await runCommand([name, "safe&literal"], {
          stdin: "stdin-value",
          env: { ...shimEnv(dir), PATHEXT: ".CMD;.BAT" },
        });
        const resolved = join(dir, `${name}.${extension.toUpperCase()}`);
        assert.equal(result.returncode, 127, name);
        assert.equal(result.stdout, "");
        assert.ok(
          result.stderr.startsWith(`failed to launch '${name}': '${resolved}' is a batch launcher`),
          result.stderr,
        );
        assert.match(result.stderr, /explicit interpreter/);
        assert.match(result.stderr, /Windows launchers/);
        assert.equal(existsSync(join(dir, TRAP_MARKER)), false, name);
        // cmd.exe would run the batch file itself and leave this marker.
        assert.equal(existsSync(join(dir, "odw-batch-ran")), false, `${name}: cmd.exe ran the batch file`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "Windows starts Node for an npm shim in a .cmd file, and never for the same text in a .bat file",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw runner shim-"));
    try {
      mkdirSync(join(dir, "node_modules", "marker"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "marker", "cli.js"), MARKER_CLI);
      const marker = join(dir, NODE_MARKER);
      const env = { ...shimEnv([dir, dirname(execPath)].join(delimiter)), PATHEXT: ".CMD;.BAT" };
      for (const [template, shim] of Object.entries(SHIM_TEMPLATES)) {
        // Every real template, once as a `.bat` file and once as a `.cmd` file.
        const text = shim("node_modules\\marker\\cli.js");
        writeFileSync(join(dir, "odw-as-bat.bat"), text);
        writeFileSync(join(dir, "odw-as-cmd.cmd"), text);

        const asBat = await runCommand(["odw-as-bat", "--flag"], { env });
        assert.equal(asBat.returncode, 127, template);
        assert.equal(asBat.stdout, "", template);
        assert.match(
          asBat.stderr,
          /^failed to launch 'odw-as-bat': '.*odw-as-bat\.BAT' is a batch launcher that odw cannot run\. /,
          template,
        );
        assert.equal(existsSync(marker), false, `${template}: Node started for the .bat file`);

        const asCmd = await runCommand(["odw-as-cmd", "--flag"], { env });
        assert.equal(asCmd.returncode, 0, `${template}: ${asCmd.stderr}`);
        assert.equal(existsSync(marker), true, `${template}: Node did not start for the .cmd file`);
        rmSync(marker);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "Windows batch launchers that cannot be read report the read error",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw runner shim-"));
    try {
      // A directory with a launcher name resolves on PATH but cannot be read as a file.
      mkdirSync(join(dir, "odw-unreadable.cmd"));
      const result = await runCommand(["odw-unreadable"], { env: { ...shimEnv(dir), PATHEXT: ".CMD" } });
      assert.equal(result.returncode, 127);
      assert.match(result.stderr, /could not read batch launcher '.*odw-unreadable\.CMD': EISDIR/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "Windows PATH executables use their resolved PATHEXT path",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw-runner-exe-"));
    try {
      const name = "odw-runner-exe";
      copyFileSync(execPath, join(dir, `${name}.exe`));
      const result = await runCommand([name, "--version"], {
        env: { ...process.env, PATH: dir, PATHEXT: ".EXE" } as Record<string, string>,
      });
      assert.equal(result.returncode, 0);
      assert.match(result.stdout, /^v\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test("probeCommand tells a missing command from a launcher that odw cannot run", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw probe-"));
  try {
    writeFileSync(join(dir, "agent.cmd"), CURSOR_AGENT_CMD);
    writeFileSync(join(dir, "odw-native.exe"), "");
    const env = { PATH: dir, PATHEXT: ".cmd;.exe" };
    assert.deepEqual(probeCommand("odw-native", env, "win32"), { status: "ready" });
    assert.deepEqual(probeCommand("odw-absent", env, "win32"), { status: "missing" });
    assert.deepEqual(probeCommand("agent", env, "win32"), {
      status: "unlaunchable",
      problem: `'${join(dir, "agent.cmd")}' is a batch launcher that odw cannot run`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("resolveWindowsLaunch and probeCommand give the same problem for each launch failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw probe-"));
  try {
    writeFileSync(join(dir, "odw-plain.cmd"), "@echo off\r\nexit /b 99\r\n"); // not an npm shim
    writeFileSync(join(dir, "odw-gone.cmd"), cmdShim4("node_modules\\gone\\cli.js")); // no such script
    mkdirSync(join(dir, "odw-dir.cmd")); // cannot be read as a file
    const env = { PATH: dir, PATHEXT: ".cmd" };
    for (const name of ["odw-plain", "odw-gone", "odw-dir"]) {
      const launch = resolveWindowsLaunch(name, ["--flag"], env);
      if (!("error" in launch)) assert.fail(`${name} must not launch`);
      assert.ok(launch.error.startsWith(`failed to launch '${name}': ${launch.problem}`), launch.error);
      assert.deepEqual(probeCommand(name, env, "win32"), { status: "unlaunchable", problem: launch.problem });
    }
    // A command that is not found passes through, so that `spawn` reports it.
    assert.deepEqual(resolveWindowsLaunch("odw-absent", ["--flag"], env), {
      executable: "odw-absent",
      args: ["--flag"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a .bat file is never an npm shim, but the same text in a .cmd file is", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw ext-"));
  try {
    // The script of the shim does not exist, so an accepted shim stops at that check. A `.bat`
    // file stops earlier, because it is not a shim. No host can hold a script at a Windows path
    // for another host, so this holds on every host.
    const script = "node_modules\\probe\\cli.js";
    let count = 0;
    for (const [template, shim] of Object.entries(SHIM_TEMPLATES)) {
      // PATHEXT sets the case of the file name that odw finds. Only Windows ignores that case.
      for (const extension of [".bat", ".BAT", ".cmd", ".CMD"]) {
        const name = `odw-ext-${count++}`;
        const path = join(dir, name + extension);
        writeFileSync(path, shim(script));
        const env = { PATH: dir, PATHEXT: extension };
        const what = `${template} as ${extension}`;

        const probe = probeCommand(name, env, "win32");
        const launch = resolveWindowsLaunch(name, [], env);
        if (probe.status !== "unlaunchable" || !("error" in launch)) assert.fail(`${what} must not launch`);
        assert.equal(launch.problem, probe.problem, what);
        if (extension.toLowerCase() === ".bat") {
          assert.equal(probe.problem, `'${path}' is a batch launcher that odw cannot run`, what);
        } else {
          assert.match(probe.problem, /^npm shim '.*' runs '.*cli\.js', which does not exist$/, what);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("on Windows, only .exe and .com files start directly; a script or a file with no extension does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw native-"));
  try {
    const at = (file: string): string => join(dir, file);
    // A bare name resolves through PATHEXT. A name with a path is used as written, so its
    // letter case is the case of the file. Each name finds exactly one file.
    const cases: Array<[command: string, path: string, native: boolean]> = [
      ["odw-exe", at("odw-exe.exe"), true],
      ["odw-com", at("odw-com.com"), true],
      [at("odw-upper.EXE"), at("odw-upper.EXE"), true],
      [at("odw-upper.COM"), at("odw-upper.COM"), true],
      ["odw-ps1", at("odw-ps1.ps1"), false],
      [at("odw-explicit.ps1"), at("odw-explicit.ps1"), false],
      ["odw-js", at("odw-js.js"), false],
      ["odw-vbs", at("odw-vbs.vbs"), false],
      ["odw-noext", at("odw-noext"), false],
    ];
    for (const [, path] of cases) writeFileSync(path, "");
    const env = { PATH: dir, PATHEXT: ".exe;.com;.ps1;.js;.vbs" };
    for (const [command, path, native] of cases) {
      const probe = probeCommand(command, env, "win32");
      const launch = resolveWindowsLaunch(command, ["--flag"], env);
      if (native) {
        assert.deepEqual(probe, { status: "ready" }, command);
        assert.deepEqual(launch, { executable: path, args: ["--flag"] }, command);
        continue;
      }
      const problem = `'${path}' is a script that Windows cannot start directly`;
      assert.deepEqual(probe, { status: "unlaunchable", problem }, command);
      if (!("error" in launch)) assert.fail(`${command} must not launch`);
      assert.equal(launch.problem, problem, command);
      assert.ok(launch.error.startsWith(`failed to launch '${command}': ${problem}. `), launch.error);
      assert.match(launch.error, /interpreter and the script/, command);
      assert.match(launch.error, /Windows launchers/, command);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("probeCommand does not inspect launchers on other platforms", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw probe-"));
  try {
    writeFileSync(join(dir, "agent.cmd"), CURSOR_AGENT_CMD);
    chmodSync(join(dir, "agent.cmd"), 0o755);
    // On Linux, `agent.cmd` is only a file name, and PATHEXT does not apply.
    assert.deepEqual(probeCommand("agent.cmd", { PATH: dir }, "linux"), { status: "ready" });
    assert.deepEqual(probeCommand("agent", { PATH: dir, PATHEXT: ".cmd" }, "linux"), { status: "missing" });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Windows reads PATH and PATHEXT in any letter case, and other platforms read the exact name", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw env-"));
  const other = mkdtempSync(join(tmpdir(), "odw env-"));
  try {
    writeFileSync(join(dir, "odw-case.cmd"), "");
    writeFileSync(join(other, "odw-case.cmd"), "");
    writeFileSync(join(dir, "node.exe"), "");
    // A plain copy of process.env keeps the case of its keys, for example `Path`.
    const env = { Path: dir, PathExt: ".cmd;.exe" };
    assert.equal(resolveExecutable("odw-case", env, "win32"), join(dir, "odw-case.cmd"));
    assert.equal(resolveExecutable("node.exe", env, "win32"), join(dir, "node.exe"));
    assert.equal(resolveExecutable("odw-case", env, "linux"), null);
    // Two spellings of one name: the first in sorted order wins, not the first key.
    for (const both of [
      { Path: other, PATH: dir, PATHEXT: ".cmd" },
      { path: other, Path: dir, PathExt: ".cmd" },
    ]) {
      assert.equal(resolveExecutable("odw-case", both, "win32"), join(dir, "odw-case.cmd"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A copy of process.env with no PATH and no PATHEXT, whatever their case.
function envWithoutPath(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^path(ext)?$/i.test(key)) env[key] = value;
  }
  return env;
}

test(
  "Windows odw reads the PATH spelling that spawn gives the child",
  { skip: process.platform !== "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "odw env-"));
    const other = mkdtempSync(join(tmpdir(), "odw env-"));
    try {
      writeFileSync(join(dir, "odw-case.cmd"), "");
      writeFileSync(join(other, "odw-case.cmd"), "");
      // Two spellings of PATH. The key `path` comes first, but `Path` sorts first. Node's
      // `spawn` keeps `Path` for the child, so odw must read `Path` too.
      const env = { ...envWithoutPath(), path: other, Path: dir, PATHEXT: ".cmd" };
      const child = spawnSync(execPath, ["-p", "process.env.PATH"], { env, encoding: "utf8" });
      assert.equal(child.stdout.trim(), dir);
      assert.equal(resolveExecutable("odw-case", env, "win32"), join(dir, "odw-case.cmd"));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "Windows npm shims run when the environment spells PATH and PATHEXT as Path and PathExt",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw runner shim-"));
    const mixedCaseEnv = (path: string): Record<string, string> => ({
      ...envWithoutPath(),
      Path: path,
      PathExt: ".CMD",
    });
    try {
      writeProbeShim(dir, "odw-probe");
      // A bare command: `Path` finds the shim, and it finds the Node that runs the script.
      const bare = await runProbeShim("odw-probe", mixedCaseEnv([dir, dirname(execPath)].join(delimiter)));
      assert.ok(sameFile(bare.node, execPath), bare.node);
      // An explicit shim path: only the Node fallback reads `Path`.
      const explicit = await runProbeShim(join(dir, "odw-probe.cmd"), mixedCaseEnv(dirname(execPath)));
      assert.ok(sameFile(explicit.node, execPath), explicit.node);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "Windows probeCommand and runCommand agree on what can run",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw runner shim-"));
    try {
      writeProbeShim(dir, "odw-shim");
      copyFileSync(execPath, join(dir, "odw-native.exe"));
      writeFileSync(join(dir, "odw-agent.cmd"), CURSOR_AGENT_CMD);
      writeFileSync(join(dir, "odw-batch.bat"), "@echo off\r\nexit /b 0\r\n");
      writeFileSync(join(dir, "odw-gone.cmd"), cmdShim4("node_modules\\gone\\cli.js"));
      writeFileSync(join(dir, "odw-script.ps1"), POWERSHELL_TRAP);
      writeFileSync(join(dir, "odw-js.js"), "process.exit(0);\n");
      writeFileSync(join(dir, "odw-noext"), "");
      const env = { ...shimEnv([dir, dirname(execPath)].join(delimiter)), PATHEXT: ".EXE;.CMD;.BAT;.PS1;.JS" };
      const expected = {
        "odw-shim": "ready",
        "odw-native": "ready",
        "odw-agent": "unlaunchable",
        "odw-batch": "unlaunchable",
        "odw-gone": "unlaunchable",
        "odw-script": "unlaunchable",
        "odw-js": "unlaunchable",
        "odw-noext": "unlaunchable",
        "odw-absent": "missing",
      };
      for (const [name, status] of Object.entries(expected)) {
        const probe = probeCommand(name, env);
        assert.equal(probe.status, status, name);
        const result = await runCommand([name], { stdin: "", env });
        // A command that the probe calls ready runs. Any other command fails to launch.
        assert.equal(result.returncode, status === "ready" ? 0 : 127, `${name}: ${result.stderr}`);
        if (probe.status === "unlaunchable") {
          assert.ok(result.stderr.includes(probe.problem), `${name}: ${result.stderr}`);
        }
      }
      assert.equal(existsSync(join(dir, TRAP_MARKER)), false, "nothing ran the .ps1 script");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "a Windows adapter whose first token is a .ps1 script is not installed, and its launch fails with the same problem",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw runner script-"));
    try {
      const script = join(dir, "odw-agent.ps1");
      writeFileSync(script, POWERSHELL_TRAP); // leaves a marker file if anything runs it
      const config = defaultConfig();
      config.adapters = { scripted: { name: "scripted", command: [script, "--flag"] } };
      const problem = `'${script}' is a script that Windows cannot start directly`;

      const [row] = listAdapters(config);
      assert.equal(row!.installed, false);
      assert.equal(row!.launchProblem, problem);

      const result = await runCommand([script, "--flag"], { stdin: "stdin-value" });
      assert.equal(result.returncode, 127);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.startsWith(`failed to launch '${script}': ${problem}. `), result.stderr);
      assert.match(result.stderr, /interpreter and the script/);
      assert.match(result.stderr, /Windows launchers/);
      assert.equal(existsSync(join(dir, TRAP_MARKER)), false, "nothing ran the script");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test("a timeout kills the process and flags timedOut", async () => {
  const r = await runCommand([execPath, "-e", "setTimeout(() => {}, 10000)"], { timeout: 0.2 });
  assert.equal(r.timedOut, true);
});

test("runaway output is capped before it can exhaust the worker heap", async () => {
  const r = await runCommand(
    [
      execPath,
      "-e",
      "for (let i = 0; i < 1024; i++) process.stdout.write('x'.repeat(1024)); setTimeout(() => {}, 10000)",
    ],
    { maxOutputBytes: 4096 },
  );
  assert.notEqual(r.returncode, 0);
  assert.equal(r.timedOut, false);
  assert.ok(Buffer.byteLength(r.stdout) <= 4096);
  assert.match(r.stderr, /process output exceeded 4096 bytes/);
});

test("an empty PATH entry means the current directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-empty-path-"));
  const originalCwd = process.cwd();
  try {
    const name = "odw-empty-entry";
    writeFileSync(join(dir, name), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    writeFileSync(join(dir, `${name}.exe`), "MZ", { mode: 0o755 });
    process.chdir(dir);
    // The empty entry of PATH is the current directory.
    assert.ok(resolveExecutable(name, { PATH: delimiter }, process.platform), "an empty PATH entry");
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a Windows drive-relative command is not a bare name", () => {
  for (const cmd of ["C:tool.exe", "C:\\tool.exe", ".\\tool.exe", "dir\\tool.exe", "dir/tool.exe", "\\\\host\\share\\tool.exe"]) {
    assert.equal(isBareCommand(cmd, "win32"), false, cmd);
  }
  assert.equal(isBareCommand("tool", "win32"), true);
  // On POSIX a colon and a backslash are file-name characters.
  assert.equal(isBareCommand("C:tool", "linux"), true);
  assert.equal(isBareCommand("a\\b", "linux"), true);
  assert.equal(isBareCommand("./tool", "linux"), false);
});

test("a missing PATH searches no directory on POSIX, as it always did", () => {
  assert.equal(resolveExecutable("sh", {}, "linux"), null);
  assert.equal(resolveExecutable("odw-not-on-any-path", {}, "linux"), null);
});

test(
  "a missing PATH still finds a command in the Windows default list",
  { skip: process.platform !== "win32" },
  () => {
    assert.ok(resolveExecutable("cmd", { SystemRoot: process.env.SystemRoot }, "win32"), "cmd.exe is in System32");
  },
);

test(
  "POSIX runs a relative command against the directory of odw, as the probe does",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "odw-relcmd-"));
    const originalCwd = process.cwd();
    try {
      const odwDir = join(root, "odw");
      const workspace = join(root, "workspace");
      for (const [dir, text] of [[odwDir, "odw"], [workspace, "workspace"]] as const) {
        mkdirSync(join(dir, "bin"), { recursive: true });
        writeFileSync(join(dir, "bin", "agent"), `#!/bin/sh\necho ${text}\n`, { mode: 0o755 });
      }
      process.chdir(odwDir);
      const r = await runCommand(["./bin/agent"], { cwd: workspace });
      assert.equal(r.stdout.trim(), "odw", "the probed file is the launched file");
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "POSIX does not launch a command that the probe cannot find, even if the workspace has a file of that name",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "odw-unresolved-"));
    const originalCwd = process.cwd();
    try {
      const odwDir = join(root, "odw");
      const workspace = join(root, "workspace");
      mkdirSync(odwDir, { recursive: true });
      mkdirSync(join(workspace, "bin"), { recursive: true });
      const marker = join(root, "ran");
      writeFileSync(join(workspace, "bin", "agent"), `#!/bin/sh\necho x > ${marker}\n`, { mode: 0o755 });
      process.chdir(odwDir);
      for (const [command, env] of [
        [["./bin/agent"], {}],
        [["agent"], { PATH: "bin" }],
        [["agent"], { PATH: "" }],
        [["agent"], {}],
      ] as const) {
        const r = await runCommand([...command], { env: { ...env }, cwd: workspace });
        assert.equal(r.returncode, 127, JSON.stringify(command));
        assert.match(r.stderr, /failed to launch/);
      }
      assert.equal(existsSync(marker), false, "the workspace file never ran");
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "POSIX runs the file that the probe finds, not a same-named file under the workspace",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "odw-relpath-"));
    const originalCwd = process.cwd();
    try {
      const odwDir = join(root, "odw");
      const workspace = join(root, "workspace");
      for (const [dir, text] of [[odwDir, "odw"], [workspace, "workspace"]] as const) {
        mkdirSync(join(dir, "bin"), { recursive: true });
        writeFileSync(join(dir, "bin", "odw-same-name"), `#!/bin/sh\necho ${text}\n`, { mode: 0o755 });
      }
      process.chdir(odwDir);
      // The relative entry `bin` means two different files; the probe and the launch must pick one.
      const env = { PATH: "bin" };
      assert.ok(resolveExecutable("odw-same-name", env, process.platform)?.startsWith(realpathSync(odwDir)));
      const r = await runCommand(["odw-same-name"], { env, cwd: workspace });
      assert.equal(r.stdout.trim(), "odw");
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test("a directory that shares a command's name is skipped, and results are absolute", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-resolve-dirs-"));
  const originalCwd = process.cwd();
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(join(first, "odw-dir-cmd"), { recursive: true }); // a directory, not a command
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, "odw-dir-cmd"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    writeFileSync(join(second, "odw-dir-cmd.exe"), "MZ", { mode: 0o755 });

    // Compare real paths: macOS holds /var as a symlink to /private/var.
    const realSecond = realpathSync(second);
    const found = resolveExecutable("odw-dir-cmd", { PATH: `${first}${delimiter}${second}` }, process.platform);
    assert.ok(found, "the command resolves");
    assert.ok(isAbsolute(found), `the result must be absolute, got ${found}`);
    assert.ok(realpathSync(found).startsWith(realSecond), `the directory entry must be skipped, got ${found}`);

    // A relative PATH entry is read against the cwd of odw, and the result stays absolute.
    process.chdir(root);
    const relative = resolveExecutable("odw-dir-cmd", { PATH: "second" }, process.platform);
    assert.ok(relative && isAbsolute(relative), `a relative entry must give an absolute path, got ${relative}`);
    assert.ok(realpathSync(relative).startsWith(realSecond), `got ${relative}`);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test(
  "on POSIX, readiness needs an executable file: a directory is not a command",
  { skip: process.platform === "win32" }, // access X_OK is a no-op on Windows
  () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-loose-"));
  try {
    mkdirSync(join(dir, "odw-loose-dir"));
    writeFileSync(join(dir, "odw-loose-file"), "not executable on POSIX", { mode: 0o644 });
    assert.deepEqual(probeCommand("odw-loose-dir", { PATH: dir }, "linux"), { status: "missing" });
    assert.deepEqual(probeCommand("odw-loose-file", { PATH: dir }, "linux"), { status: "missing" });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  },
);

test("a shim whose script is rooted is not an npm shim", () => {
  // npm writes a script next to the shim. A rooted capture would let the direct
  // launch run a different file than the batch text.
  assert.equal(parseNpmCmdShim(cmdShim4("C:\\evil.js")), null);
  assert.equal(parseNpmCmdShim(cmdShim4("\\evil.js")), null);
  assert.equal(parseNpmCmdShim(cmdShim4("/evil.js")), null);
  // A drive-relative path is not absolute, but win32.resolve still leaves the shim directory.
  assert.equal(parseNpmCmdShim(cmdShim4("C:evil.js")), null);
  assert.equal(parseNpmCmdShim(cmdShim4("..\\ok.js:stream")), null);
  assert.ok(parseNpmCmdShim(cmdShim4("..\\ok.js")), "a relative script is fine");
});

test("a directory named tool.exe is not launchable", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-native-dir-"));
  try {
    mkdirSync(join(dir, "odw-dir-exe.exe"));
    // The candidate name follows the PATHEXT spelling, so ask for the lower case one.
    const env = { PATH: dir, PATHEXT: ".exe" };
    const expected = { status: "unlaunchable", problem: `'${join(dir, "odw-dir-exe.exe")}' is not a file` };
    assert.deepEqual(probeCommand("odw-dir-exe", env, "win32"), expected);
    const launch = resolveWindowsLaunch("odw-dir-exe", [], env);
    assert.ok("error" in launch, "it must not launch");
    assert.equal(launch.problem, expected.problem);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Windows paths in the plan: run this one where the host is Windows.
test("a directory named node.exe next to the shim falls back to PATH", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "odw-node-dir-"));
  try {
    const shimDir = join(root, "shim");
    const pathDir = join(root, "path");
    mkdirSync(join(shimDir, "node.exe"), { recursive: true }); // a directory, not Node
    mkdirSync(pathDir, { recursive: true });
    writeFileSync(join(pathDir, "node.exe"), "MZ", { mode: 0o755 });
    mkdirSync(join(shimDir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(shimDir, "node_modules", "x", "cli.js"), "");
    writeFileSync(join(shimDir, "odw-shim.cmd"), cmdShim4("node_modules\\x\\cli.js"));
    const env = { PATH: pathDir, PATHEXT: ".cmd" };
    const plan = resolveWindowsLaunch(join(shimDir, "odw-shim.cmd"), [], env);
    assert.ok(!("error" in plan), JSON.stringify(plan));
    assert.equal(plan.executable, join(pathDir, "node.exe"), "the PATH fallback, not the directory");
    assert.deepEqual(probeCommand(join(shimDir, "odw-shim.cmd"), env, "win32"), { status: "ready" });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
