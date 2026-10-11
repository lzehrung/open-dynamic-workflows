/**
 * Environment policy: `envPolicy` decides which host variables an agent CLI
 * gets, an adapter's `env` applies after it, and the host environment still
 * finds the executable. Chat Host's Codex follows the same policy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { execPath } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { buildChildEnv } from "../src/adapters/env.js";
import { runCommand } from "../src/adapters/runner.js";
import type { Config, EnvPolicy } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { ConfigError } from "../src/errors.js";
import type { ChatMessage, ChatSessionRecord } from "../src/runtime/chat-store.js";
import { RunStore } from "../src/runtime/run-store.js";
import { createDefaultChatRunner, startServer, type ChatTurnRunner } from "../src/runtime/server.js";

// --- buildChildEnv -----------------------------------------------------------

test("inherit passes every defined host variable except the denied names", () => {
  const host: NodeJS.ProcessEnv = { PATH: "/bin", SECRET: "s3cret", TOKEN: "t", EMPTY: "", UNSET: undefined };
  const everything = { PATH: "/bin", SECRET: "s3cret", TOKEN: "t", EMPTY: "" };
  assert.deepEqual(buildChildEnv({ mode: "inherit" }, undefined, host, "linux"), everything);
  assert.deepEqual(buildChildEnv({ mode: "inherit", deny: [] }, undefined, host, "linux"), everything);
  assert.deepEqual(buildChildEnv({ mode: "inherit", deny: ["SECRET", "TOKEN"] }, undefined, host, "linux"), {
    PATH: "/bin",
    EMPTY: "",
  });
});

test("allowlist passes only the named host variables and adds nothing", () => {
  const host = { PATH: "/bin", HOME: "/home/u", SECRET: "s3cret" };
  assert.deepEqual(buildChildEnv({ mode: "allowlist", allow: ["PATH", "MISSING"] }, undefined, host, "linux"), {
    PATH: "/bin",
  });
  assert.deepEqual(buildChildEnv({ mode: "allowlist", allow: [] }, undefined, host, "linux"), {});
});

test("set applies after the policy: it adds, overrides, and restores a removed variable", () => {
  const host = { A: "host-a", SECRET: "s3cret" };
  assert.deepEqual(buildChildEnv({ mode: "inherit" }, { A: "set-a", B: "set-b" }, host, "linux"), {
    A: "set-a",
    B: "set-b",
    SECRET: "s3cret",
  });
  assert.deepEqual(buildChildEnv({ mode: "inherit", deny: ["SECRET"] }, { SECRET: "from-config" }, host, "linux"), {
    A: "host-a",
    SECRET: "from-config",
  });
  assert.deepEqual(buildChildEnv({ mode: "allowlist", allow: ["A"] }, { B: "set-b" }, host, "linux"), {
    A: "host-a",
    B: "set-b",
  });
});

test("the result is a new object and the host, policy, and set stay unchanged", () => {
  const host = { A: "1", Path: "p" };
  const policy: EnvPolicy = { mode: "inherit", deny: ["X"] };
  const set = { PATH: "new" };
  for (const platform of ["linux", "win32"] as const) {
    const env = buildChildEnv(policy, set, host, platform);
    assert.notEqual(env, host, platform);
    assert.deepEqual(host, { A: "1", Path: "p" }, platform);
    assert.deepEqual(policy, { mode: "inherit", deny: ["X"] }, platform);
    assert.deepEqual(set, { PATH: "new" }, platform);
  }
});

test("on win32, deny and allow compare names without case", () => {
  const host = { Path: "C:\\host", SystemRoot: "C:\\Windows", Secret: "s3cret" };
  assert.deepEqual(buildChildEnv({ mode: "inherit", deny: ["PATH", "SECRET"] }, undefined, host, "win32"), {
    SystemRoot: "C:\\Windows",
  });
  // The allowlist keeps the host's spelling of each name.
  assert.deepEqual(buildChildEnv({ mode: "allowlist", allow: ["path", "systemroot"] }, undefined, host, "win32"), {
    Path: "C:\\host",
    SystemRoot: "C:\\Windows",
  });
});

test("on win32, set leaves exactly one key for a name, whatever its case", () => {
  const inherit: EnvPolicy = { mode: "inherit" };
  const upperOverHost = buildChildEnv(inherit, { PATH: "C:\\config" }, { Path: "C:\\host", Other: "x" }, "win32");
  assert.deepEqual(upperOverHost, { PATH: "C:\\config", Other: "x" });

  const mixedOverHost = buildChildEnv(inherit, { Path: "C:\\config" }, { PATH: "C:\\host", Other: "x" }, "win32");
  assert.deepEqual(mixedOverHost, { Path: "C:\\config", Other: "x" });

  // The policy removed the variable. set still adds it back, once.
  const denyPath: EnvPolicy = { mode: "inherit", deny: ["path"] };
  const restored = buildChildEnv(denyPath, { PATH: "C:\\config" }, { Path: "C:\\host" }, "win32");
  assert.deepEqual(restored, { PATH: "C:\\config" });
});

test("on other platforms, names compare exactly", () => {
  const host = { Path: "mixed", PATH: "upper" };
  assert.deepEqual(buildChildEnv({ mode: "inherit", deny: ["PATH"] }, undefined, host, "linux"), { Path: "mixed" });
  assert.deepEqual(buildChildEnv({ mode: "allowlist", allow: ["path"] }, undefined, host, "linux"), {});
  assert.deepEqual(buildChildEnv({ mode: "inherit" }, { PATH: "set" }, host, "linux"), { Path: "mixed", PATH: "set" });
});

test("the platform defaults to the running one", () => {
  const env = buildChildEnv({ mode: "inherit", deny: ["path"] }, undefined, { PATH: "x" });
  assert.deepEqual(env, process.platform === "win32" ? {} : { PATH: "x" });
});

// --- config ------------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "odw-env-"));
}

function cleanup(dir: string): void {
  // On Windows a process that just exited can hold its working directory for a moment.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Write `raw` as an `odw.config.json` in `dir` and load it. */
function loadJson(dir: string, raw: unknown): Config {
  const path = join(dir, "odw.config.json");
  writeFileSync(path, JSON.stringify(raw));
  return loadConfig(path, { quiet: true });
}

test("a top-level and a per-adapter envPolicy both load", () => {
  const dir = tempDir();
  try {
    const config = loadJson(dir, {
      envPolicy: { mode: "allowlist", allow: ["PATH", "HOME"] },
      adapters: {
        strict: { command: ["x"], envPolicy: { mode: "inherit", deny: ["AWS_SECRET_ACCESS_KEY"] } },
        loose: { command: ["y"], envPolicy: { mode: "inherit" } },
      },
    });
    assert.deepEqual(config.settings.envPolicy, { mode: "allowlist", allow: ["PATH", "HOME"] });
    assert.deepEqual(config.adapters.strict!.envPolicy, { mode: "inherit", deny: ["AWS_SECRET_ACCESS_KEY"] });
    assert.deepEqual(config.adapters.loose!.envPolicy, { mode: "inherit" });
  } finally {
    cleanup(dir);
  }
});

const BAD_MODE = /envPolicy\.mode' must be 'inherit' or 'allowlist'/;
const BAD_ALLOW = /envPolicy\.allow' must be an array of non-empty strings/;
const BAD_DENY = /envPolicy\.deny' must be an array of non-empty strings/;

const INVALID_POLICIES: Array<[what: string, policy: unknown, message: RegExp]> = [
  ["a string", "allowlist", /must be an object/],
  ["null", null, /must be an object/],
  ["an array", [], /must be an object/],
  ["no mode", { deny: ["A"] }, BAD_MODE],
  ["an unknown mode", { mode: "block" }, BAD_MODE],
  ["a mode that is not a string", { mode: 1 }, BAD_MODE],
  ["allow with inherit", { mode: "inherit", allow: ["A"] }, /allow' is only valid with mode 'allowlist'/],
  ["deny with allowlist", { mode: "allowlist", allow: ["A"], deny: ["B"] }, /deny' is only valid with mode 'inherit'/],
  ["an allowlist without allow", { mode: "allowlist" }, /allow' is required/],
  ["allow that is not an array", { mode: "allowlist", allow: "PATH" }, BAD_ALLOW],
  ["an empty allow name", { mode: "allowlist", allow: ["PATH", ""] }, BAD_ALLOW],
  ["a non-string allow name", { mode: "allowlist", allow: [1] }, BAD_ALLOW],
  ["deny that is not an array", { mode: "inherit", deny: "SECRET" }, BAD_DENY],
  ["an empty deny name", { mode: "inherit", deny: [""] }, BAD_DENY],
  ["an unknown key", { mode: "inherit", denny: ["A"] }, /envPolicy\.denny' is not a known key/],
];

test("every invalid envPolicy shape is a ConfigError, at the top level and in an adapter", () => {
  const dir = tempDir();
  try {
    for (const [what, policy, message] of INVALID_POLICIES) {
      const expectError = (owner: RegExp, raw: unknown): void => {
        assert.throws(
          () => loadJson(dir, raw),
          (err: unknown) => {
            assert.ok(err instanceof ConfigError, `${what}: expected a ConfigError, got ${String(err)}`);
            assert.match(err.message, owner, what);
            assert.match(err.message, message, what);
            return true;
          },
        );
      };
      expectError(/^config 'envPolicy/, { envPolicy: policy });
      expectError(/^adapter 'mine' 'envPolicy/, { adapters: { mine: { command: ["x"], envPolicy: policy } } });
    }
  } finally {
    cleanup(dir);
  }
});

test("envPolicy is a known key at the top level and in an adapter", () => {
  assert.deepEqual(
    collectConfigWarnings({
      envPolicy: { mode: "allowlist", allow: ["PATH"] },
      adapters: { mine: { command: ["x"], envPolicy: { mode: "inherit", deny: ["A"] } } },
    }),
    [],
  );
});

// --- Bridge and Chat Host, with the real process runner ----------------------

const SECRET = "ODW_ENV_TEST_SECRET";
const KEEP = "ODW_ENV_TEST_KEEP";
const HOST_VARS = { [SECRET]: "s3cret", [KEEP]: "keep" };

type Seen = Record<string, string | null>;

/**
 * Run `fn` in a fresh temp dir while this process, the host, has `vars` set.
 * Afterwards, restore the host environment and remove the dir.
 */
async function inHost(vars: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> {
  const saved = Object.keys(vars).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, vars);
  const dir = tempDir();
  try {
    await fn(dir);
  } finally {
    cleanup(dir);
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Write a Node script that prints what it sees for `names` as JSON; an unset name is `null`. */
function writeProbe(dir: string, names: string[]): string {
  const path = join(dir, "probe.cjs");
  writeFileSync(
    path,
    `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, process.env[n] ?? null]))));`,
  );
  return path;
}

interface ProbeSetup {
  /** The top-level `envPolicy`. */
  policy?: unknown;
  /** The adapter's own `envPolicy`. */
  adapterPolicy?: unknown;
  /** The adapter's `env`. */
  env?: Record<string, string>;
  /** The first command token. It defaults to the absolute path of Node. */
  node?: string;
}

/**
 * Load a config file with one probe adapter, run it through a real Bridge and
 * the real process runner, and return what the child process saw.
 */
async function probe(dir: string, names: string[], setup: ProbeSetup = {}): Promise<Seen> {
  const config = loadJson(dir, {
    defaultAdapter: "probe",
    ...(setup.policy ? { envPolicy: setup.policy } : {}),
    adapters: {
      probe: {
        command: [setup.node ?? execPath, writeProbe(dir, names)],
        ...(setup.adapterPolicy ? { envPolicy: setup.adapterPolicy } : {}),
        ...(setup.env ? { env: setup.env } : {}),
      },
    },
  });
  const outcome = await new Bridge(config, { source: dir }).run({ prompt: "probe" });
  return JSON.parse(outcome.text) as Seen;
}

test("a denied variable does not reach the agent CLI, and the others do", async () => {
  await inHost(HOST_VARS, async (dir) => {
    const seen = await probe(dir, [SECRET, KEEP], { policy: { mode: "inherit", deny: [SECRET] } });
    assert.deepEqual(seen, { [SECRET]: null, [KEEP]: "keep" });
  });
});

test("an allowlist passes only the allowed variable to the agent CLI", async () => {
  await inHost(HOST_VARS, async (dir) => {
    const seen = await probe(dir, [SECRET, KEEP], { policy: { mode: "allowlist", allow: [KEEP] } });
    assert.deepEqual(seen, { [SECRET]: null, [KEEP]: "keep" });
  });
});

test("without an envPolicy, the agent CLI inherits the host variables", async () => {
  await inHost(HOST_VARS, async (dir) => {
    const seen = await probe(dir, [SECRET, KEEP]);
    assert.deepEqual(seen, { [SECRET]: "s3cret", [KEEP]: "keep" });
  });
});

test("an adapter envPolicy replaces the top-level policy; it does not merge with it", async () => {
  await inHost(HOST_VARS, async (dir) => {
    const loosened = await probe(dir, [SECRET, KEEP], {
      policy: { mode: "inherit", deny: [SECRET] },
      adapterPolicy: { mode: "inherit" },
    });
    assert.deepEqual(loosened, { [SECRET]: "s3cret", [KEEP]: "keep" });

    const tightened = await probe(dir, [SECRET, KEEP], {
      policy: { mode: "allowlist", allow: [] },
      adapterPolicy: { mode: "inherit", deny: [KEEP] },
    });
    assert.deepEqual(tightened, { [SECRET]: "s3cret", [KEEP]: null });
  });
});

test("adapter env values apply after the policy", async () => {
  await inHost(HOST_VARS, async (dir) => {
    // The policy removes the variable. The adapter's env sets it again.
    const restored = await probe(dir, [SECRET, KEEP], {
      policy: { mode: "inherit", deny: [SECRET] },
      env: { [SECRET]: "from-config" },
    });
    assert.deepEqual(restored, { [SECRET]: "from-config", [KEEP]: "keep" });

    // Under an allowlist, env still adds a variable that the list does not name.
    const added = await probe(dir, [SECRET, KEEP], {
      policy: { mode: "allowlist", allow: [] },
      env: { [KEEP]: "from-config" },
    });
    assert.deepEqual(added, { [SECRET]: null, [KEEP]: "from-config" });
  });
});

// The bare command name of the running Node: `node` on every platform. `odw` must find it
// with the host PATH after the policy has removed PATH from the child.
const BARE_NODE = basename(execPath, extname(execPath));
// Node's own directory leads the host PATH, so the bare name resolves on every machine.
const HOST_WITH_NODE = { ...HOST_VARS, PATH: [dirname(execPath), process.env.PATH ?? ""].join(delimiter) };

test("a bare command name still starts when the policy removes PATH", async () => {
  await inHost(HOST_WITH_NODE, async (dir) => {
    const seen = await probe(dir, [SECRET], { policy: { mode: "allowlist", allow: [] }, node: BARE_NODE });
    assert.deepEqual(seen, { [SECRET]: null });
  });
});

// Node adds PATH to every Windows child, so only other platforms can assert its absence.
test(
  "an allowlist without PATH leaves the child without PATH",
  { skip: process.platform === "win32" },
  async () => {
    await inHost(HOST_WITH_NODE, async (dir) => {
      const seen = await probe(dir, ["PATH"], { policy: { mode: "allowlist", allow: [] }, node: BARE_NODE });
      assert.deepEqual(seen, { PATH: null });
    });
  },
);

test(
  "on Windows, names compare without case from the config to the child",
  { skip: process.platform !== "win32" },
  async () => {
    await inHost({ ...HOST_VARS, ODW_ENV_CASE: "host" }, async (dir) => {
      // A deny entry in another case still removes the host variable.
      const denied = await probe(dir, [SECRET], { policy: { mode: "inherit", deny: [SECRET.toLowerCase()] } });
      assert.deepEqual(denied, { [SECRET]: null });
      // An env name in another case replaces the host variable. One value reaches the child.
      const replaced = await probe(dir, ["ODW_ENV_CASE"], { env: { Odw_Env_Case: "config" } });
      assert.deepEqual(replaced, { ODW_ENV_CASE: "config" });
    });
  },
);

test("runCommand finds the executable in searchEnv, not in the environment it gives the child", async () => {
  const dir = tempDir();
  try {
    // A copy of Node under a unique name, in a directory that only searchEnv names.
    const name = "odw-env-probe";
    if (process.platform === "win32") copyFileSync(execPath, join(dir, `${name}.exe`));
    else symlinkSync(execPath, join(dir, name));
    const searchEnv = { PATH: dir, PATHEXT: ".EXE" };

    const found = await runCommand([name, "-e", "process.stdout.write('found')"], { env: {}, searchEnv });
    assert.equal(found.returncode, 0, found.stderr);
    assert.equal(found.stdout, "found");

    // A name that searchEnv does not hold is a failed launch, not a crash.
    const missing = await runCommand(["odw-env-missing"], { env: {}, searchEnv });
    assert.equal(missing.returncode, 127);
    assert.match(missing.stderr, /failed to launch 'odw-env-missing'/);
  } finally {
    cleanup(dir);
  }
});

test("a command that searchEnv does not find is not launched through the child's PATH", async () => {
  const childDir = tempDir();
  const hostDir = tempDir();
  try {
    // The executable exists only in a directory that the CHILD environment names.
    const name = "odw-env-childonly";
    if (process.platform === "win32") copyFileSync(execPath, join(childDir, `${name}.exe`));
    else symlinkSync(execPath, join(childDir, name));

    const result = await runCommand([name, "-e", "process.stdout.write('launched')"], {
      env: { PATH: childDir, PATHEXT: ".EXE" },
      searchEnv: { PATH: hostDir, PATHEXT: ".EXE" },
    });
    assert.equal(result.returncode, 127);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /failed to launch 'odw-env-childonly'/);
  } finally {
    cleanup(childDir);
    cleanup(hostDir);
  }
});

test("an already-aborted call is cancelled, even when searchEnv does not find the command", async () => {
  const hostDir = tempDir();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runCommand(["odw-env-missing"], {
      env: {},
      searchEnv: { PATH: hostDir, PATHEXT: ".EXE" },
      signal: controller.signal,
    });
    assert.equal(result.termination, "cancelled");
    assert.equal(result.stderr, "");
  } finally {
    cleanup(hostDir);
  }
});

test("a command found through a relative searchEnv PATH entry runs, whatever options.cwd is", async () => {
  const base = tempDir();
  const elsewhere = tempDir();
  const originalCwd = process.cwd();
  try {
    // The entry `bin` is relative to the cwd of odw. `spawn` would look in options.cwd.
    const name = "odw-env-relative";
    mkdirSync(join(base, "bin"));
    if (process.platform === "win32") copyFileSync(execPath, join(base, "bin", `${name}.exe`));
    else symlinkSync(execPath, join(base, "bin", name));
    process.chdir(base);

    const result = await runCommand([name, "-e", "process.stdout.write('ran')"], {
      env: {},
      searchEnv: { PATH: "bin", PATHEXT: ".EXE" },
      cwd: elsewhere,
    });
    assert.equal(result.returncode, 0, result.stderr);
    assert.equal(result.stdout, "ran");
  } finally {
    process.chdir(originalCwd);
    cleanup(base);
    cleanup(elsewhere);
  }
});

/** Run one chat turn and return the JSON that the probe printed. */
async function runChat(runner: ChatTurnRunner, cwd: string): Promise<Seen> {
  const session: ChatSessionRecord = {
    id: "chat_env",
    title: "t",
    source: cwd,
    state: "idle",
    updatedAt: 0,
    messages: [],
    linkedRuns: [],
  };
  const chunks: string[] = [];
  await runner({ session, prompt: "PROMPT", cwd }, (chunk) => chunks.push(chunk));
  return JSON.parse(chunks.join("")) as Seen;
}

test("the default chat runner gives Codex only the environment it is given", async () => {
  await inHost(HOST_VARS, async (dir) => {
    const codex = writeProbe(dir, [SECRET, KEEP]);
    const run = (env?: Record<string, string>) =>
      runChat(createDefaultChatRunner({ command: [execPath, codex], ...(env ? { env } : {}) }), dir);

    // `startServer` builds this environment the same way. The server test below starts it for real.
    const config = loadJson(dir, { envPolicy: { mode: "inherit", deny: [SECRET] } });
    const denied = buildChildEnv(config.settings.envPolicy, undefined, process.env);
    assert.deepEqual(await run(denied), { [SECRET]: null, [KEEP]: "keep" });

    const allowed = buildChildEnv({ mode: "allowlist", allow: [KEEP] }, undefined, process.env);
    assert.deepEqual(await run(allowed), { [SECRET]: null, [KEEP]: "keep" });

    // With no env, Codex inherits the environment of odw, as before.
    assert.deepEqual(await run(), { [SECRET]: "s3cret", [KEEP]: "keep" });
  });
});

test("the default chat runner starts a bare command name when the policy removes PATH", async () => {
  await inHost(HOST_WITH_NODE, async (dir) => {
    const env = buildChildEnv({ mode: "allowlist", allow: [KEEP] }, undefined, process.env);
    const codex = writeProbe(dir, [SECRET, KEEP]);
    const seen = await runChat(createDefaultChatRunner({ command: [BARE_NODE, codex], env }), dir);
    assert.deepEqual(seen, { [SECRET]: null, [KEEP]: "keep" });
  });
});

// --- the real server ---------------------------------------------------------

/** The `.cmd` shim that npm writes for a Node script (cmd-shim 4.1.0 to 9.0.1). odw starts it as Node plus the script. */
function npmCmdShim(script: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    "",
  ].join("\r\n");
}

/**
 * Put a fake `codex` into `bin`. It writes what it sees for `names` to `seenFile`, prints a
 * line, and exits. On Windows it is an npm shim, so odw starts it through its shim route.
 * Elsewhere it is a Node script, with a package.json beside it that makes it CommonJS
 * whatever the directories above it say.
 */
function writeFakeCodex(bin: string, names: string[], seenFile: string): void {
  const source = [
    'const fs = require("node:fs");',
    `const seen = Object.fromEntries(${JSON.stringify(names)}.map((name) => [name, process.env[name] ?? null]));`,
    `fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify(seen));`,
    'process.stdout.write("fake codex ran");',
  ].join("\n");
  if (process.platform === "win32") {
    mkdirSync(join(bin, "node_modules", "fake-codex"), { recursive: true });
    writeFileSync(join(bin, "node_modules", "fake-codex", "cli.cjs"), source);
    writeFileSync(join(bin, "codex.cmd"), npmCmdShim("node_modules\\fake-codex\\cli.cjs"));
    return;
  }
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node\n${source}\n`);
  chmodSync(join(bin, "codex"), 0o755);
}

/** The last message of a chat session, once it is a finished assistant reply. */
async function finishedReply(url: string, sessionId: string, timeoutMs = 15_000): Promise<ChatMessage> {
  // Poll the stored session. The deadline only turns a stuck turn into a failed test.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = (await fetch(`${url}/api/chat/sessions/${sessionId}`).then((r) => r.json())) as ChatSessionRecord;
    const reply = session.messages.at(-1);
    if (reply?.role === "assistant" && reply.status !== "streaming") return reply;
    if (Date.now() > deadline) throw new Error(`the chat turn did not finish: ${JSON.stringify(reply)}`);
    await sleep(25);
  }
}

test("the server gives its default Chat Host Codex the environment that the top-level envPolicy allows", async () => {
  const vars = {
    ...HOST_VARS,
    PATH: process.env.PATH ?? "",
    ...(process.platform === "win32" ? { PATHEXT: ".EXE;.CMD" } : {}),
  };
  await inHost(vars, async (dir) => {
    const bin = join(dir, "bin");
    const proj = join(dir, "proj");
    const seenFile = join(dir, "seen.json");
    mkdirSync(bin);
    mkdirSync(proj);
    writeFakeCodex(bin, [SECRET, KEEP], seenFile);
    // The fake is the first `codex` on the host PATH, and the directory of Node follows it. No
    // other `codex` can start. `inHost` restores PATH.
    process.env.PATH = [bin, dirname(execPath)].join(delimiter);

    // The policy comes from the config, as in `odw serve`. No chat runner is injected, so the
    // server builds its own default runner. That runner is the subject of this test.
    const config = loadJson(dir, { envPolicy: { mode: "inherit", deny: [SECRET] } });
    const handle = await startServer({
      store: new RunStore(join(dir, "runs")),
      port: 0,
      host: "127.0.0.1",
      cwd: proj,
      config,
      claudeProjectsRoot: join(dir, "no-claude"),
    });
    try {
      const json = { "content-type": "application/json" };
      const session = (await fetch(`${handle.url}/api/chat/sessions`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ source: proj }),
      }).then((r) => r.json())) as ChatSessionRecord;
      const posted = await fetch(`${handle.url}/api/chat/sessions/${session.id}/messages`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ text: "a plain chat message" }),
      });
      assert.equal(posted.status, 200);

      const reply = await finishedReply(handle.url, session.id);
      assert.equal(reply.status, "done", reply.text);
      // The fake Codex lost the denied secret and kept the other variable.
      assert.deepEqual(JSON.parse(readFileSync(seenFile, "utf8")), { [SECRET]: null, [KEEP]: "keep" });
    } finally {
      await handle.close();
    }
  });
});

test("a config without envPolicy keeps the inherit default", async () => {
  assert.deepEqual(buildChildEnv(undefined, undefined, { A: "1", B: "2" }), { A: "1", B: "2" });

  // A programmatic Config from before envPolicy existed: no key at all.
  const config = defaultConfig();
  config.adapters.demo = { name: "demo", command: ["demo"] };
  config.settings.defaultAdapter = "demo";
  delete (config.settings as { envPolicy?: unknown }).envPolicy;
  const marker = "ODW_ENV_INHERIT_DEFAULT";
  process.env[marker] = "keep";
  try {
    let seen: Record<string, string> | undefined;
    const bridge = new Bridge(config, {
      runner: async (_command, options) => {
        seen = options?.env;
        return { returncode: 0, stdout: "ok", stderr: "", timedOut: false, duration: 0 };
      },
    });
    await bridge.run({ prompt: "x" });
    assert.ok(seen, "the CLI was launched");
    assert.equal(seen[marker], "keep", "the host variable is inherited");
  } finally {
    delete process.env[marker];
  }
});

test("the Chat Host builds its environment per turn", async () => {
  const dir = tempDir();
  const marker = "ODW_ENV_PER_TURN";
  const original = process.env[marker];
  try {
    const probe = writeProbe(dir, [marker]);
    const runner = createDefaultChatRunner({
      command: [execPath, probe],
      env: () => buildChildEnv(undefined, undefined, process.env),
    });
    process.env[marker] = "first";
    assert.deepEqual(await runChat(runner, dir), { [marker]: "first" });
    // A value that changes after the first turn must reach the next launch.
    process.env[marker] = "second";
    assert.deepEqual(await runChat(runner, dir), { [marker]: "second" });
  } finally {
    if (original === undefined) delete process.env[marker];
    else process.env[marker] = original;
    cleanup(dir);
  }
});

test("an environment entry named __proto__ is kept as its own entry", () => {
  const host: Record<string, string> = {};
  Object.defineProperty(host, "__proto__", { value: "host", enumerable: true, writable: true, configurable: true });
  const out = buildChildEnv({ mode: "inherit" }, undefined, host);
  assert.equal(Object.getOwnPropertyDescriptor(out, "__proto__")?.value, "host");

  const set: Record<string, string> = {};
  Object.defineProperty(set, "__proto__", { value: "adapter", enumerable: true, writable: true, configurable: true });
  const out2 = buildChildEnv({ mode: "inherit" }, set, host);
  assert.equal(Object.getOwnPropertyDescriptor(out2, "__proto__")?.value, "adapter");
});

test(
  "on POSIX a backslash in a name is not a separator: the host PATH alone selects",
  { skip: process.platform === "win32" },
  async () => {
    const hostDir = tempDir();
    const childDir = tempDir();
    try {
      const name = "odw-env-backslash\\tool";
      const script = join(childDir, name);
      writeFileSync(script, "#!/bin/sh\necho ran\n", { mode: 0o755 });
      const result = await runCommand([name], {
        env: { PATH: childDir },
        searchEnv: { PATH: hostDir },
      });
      assert.equal(result.returncode, 127, result.stdout);
      assert.match(result.stderr, /not found in the PATH of the host environment/);
    } finally {
      cleanup(hostDir);
      cleanup(childDir);
    }
  },
);

test("a property inherited from Object.prototype does not reach the child process", async () => {
  const env = { ...process.env };
  const proto = Object.prototype as Record<string, string>;
  proto.ODW_POLLUTED = "leak";
  try {
    const r = await runCommand([execPath, "-e", "process.stdout.write(String(process.env.ODW_POLLUTED))"], { env });
    assert.equal(r.stdout, "undefined", "only own entries are sent to the child");
  } finally {
    delete proto.ODW_POLLUTED;
  }
});
