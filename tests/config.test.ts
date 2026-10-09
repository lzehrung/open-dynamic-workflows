import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import {
  defaultConfig,
  executableCandidates,
  listAdapters,
  loadConfig,
  resolveAdapter,
  resolveClaudeWorkflowsRoot,
  resolveConcurrency,
  resolveRunsRoot,
} from "../src/adapters/config.js";
import { Bridge } from "../src/bridge.js";
import { AdapterExecutionError, AdapterNotFound } from "../src/errors.js";
import { CURSOR_AGENT_CMD } from "./windows-launcher-fixtures.js";

test("defaultConfig ships all nine built-in adapters", () => {
  const cfg = defaultConfig();
  for (const name of ["codex", "claude", "gemini", "qwen", "kimi", "omp", "kilo", "opencode", "cursor"]) {
    assert.ok(cfg.adapters[name], `expected built-in adapter '${name}'`);
  }
});

test("new built-ins declare their automation, model, workspace, and output contracts", () => {
  const { adapters } = defaultConfig();
  assert.deepEqual(adapters.omp!.flags?.model, ["--model"]);
  assert.deepEqual(adapters.omp!.command, [
    "omp",
    "--print",
    "--no-session",
    "--approval-mode",
    "yolo",
    "--cwd",
    "{workspace}",
  ]);
  assert.equal(adapters.omp!.stdin, "{prompt}");
  assert.deepEqual(adapters.gemini!.command, [
    "gemini",
    "--approval-mode",
    "auto_edit",
    "--prompt",
    "{prompt}",
  ]);
});

// Independent literals: this test guards permission flags against accidental
// change, so it must not import the values from src/adapters/builtin.ts.
test("every built-in adapter has its exact command, stdin, flags, output and label", () => {
  const jsonl = { format: "jsonl", eventType: "text", textPath: ["part", "text"], select: "last" };
  const expected = {
    codex: {
      name: "codex",
      label: "Codex CLI",
      command: [
        "codex",
        "--search",
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--cd",
        "{workspace}",
        "-",
      ],
      stdin: "{prompt}",
      flags: { model: ["--model"] },
    },
    claude: {
      name: "claude",
      label: "Claude Code",
      command: [
        "claude",
        "--print",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "WebSearch",
        "WebFetch",
        "--no-session-persistence",
      ],
      stdin: "{prompt}",
      flags: { model: ["--model"] },
    },
    gemini: {
      name: "gemini",
      label: "Gemini CLI",
      command: ["gemini", "--approval-mode", "auto_edit", "--prompt", "{prompt}"],
      flags: { model: ["--model"] },
    },
    qwen: {
      name: "qwen",
      label: "Qwen Code",
      command: ["qwen", "--approval-mode", "auto-edit", "--output-format", "text", "{prompt}"],
      flags: { model: ["--model"] },
    },
    kimi: {
      name: "kimi",
      label: "Kimi CLI",
      command: ["kimi", "--work-dir", "{workspace}", "--print", "--input-format", "text", "--output-format", "text"],
      stdin: "{prompt}",
      flags: { model: ["--model"] },
    },
    omp: {
      name: "omp",
      label: "Oh My Pi",
      command: ["omp", "--print", "--no-session", "--approval-mode", "yolo", "--cwd", "{workspace}"],
      stdin: "{prompt}",
      flags: { model: ["--model"] },
    },
    kilo: {
      name: "kilo",
      label: "Kilo Code",
      command: ["kilo", "run", "--format", "json", "--auto", "--dir", "{workspace}"],
      stdin: "{prompt}",
      flags: { model: ["--model"] },
      output: jsonl,
    },
    opencode: {
      name: "opencode",
      label: "OpenCode",
      command: ["opencode", "run", "--format", "json", "--auto", "--dir", "{workspace}"],
      stdin: "{prompt}",
      flags: { model: ["--model"] },
      output: jsonl,
    },
    cursor: {
      name: "cursor",
      label: "Cursor Agent CLI",
      command: ["agent", "--print", "--force", "--trust", "--output-format", "text", "--workspace", "{workspace}"],
      stdin: "{prompt}",
      flags: { model: ["--model"] },
    },
  };
  const { adapters } = defaultConfig();
  assert.deepEqual(Object.keys(adapters).sort(), Object.keys(expected).sort());
  for (const [name, spec] of Object.entries(expected)) {
    assert.deepEqual(adapters[name], spec, `built-in adapter '${name}'`);
  }
});

test("config example preserves every built-in adapter contract", () => {
  const config = loadConfig(join(process.cwd(), "odw.config.example.json"));
  for (const [name, adapter] of Object.entries(defaultConfig().adapters)) {
    assert.deepEqual(config.adapters[name], adapter, `example adapter '${name}' must match its built-in`);
  }
});

test("loadConfig merges a user file over the built-ins (user wins)", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(
      p,
      JSON.stringify({
        defaultAdapter: "codex",
        concurrency: 3,
        claudeWorkflowsRoot: "/tmp/claude-workflows",
        adapters: {
          mine: {
            command: ["my", "{prompt}"],
            output: { format: "jsonl", eventType: "answer", textPath: ["payload", "text"], select: "last" },
          },
        },
      }),
    );
    const cfg = loadConfig(p);
    assert.equal(cfg.settings.defaultAdapter, "codex");
    assert.equal(cfg.settings.concurrency, 3);
    assert.equal(cfg.settings.claudeWorkflowsRoot, "/tmp/claude-workflows");
    assert.ok(cfg.adapters.mine, "user adapter present");
    assert.ok(cfg.adapters.claude, "built-ins still present");
    assert.deepEqual(cfg.adapters.mine!.command, ["my", "{prompt}"]);
    assert.deepEqual(cfg.adapters.mine!.output, {
      format: "jsonl",
      eventType: "answer",
      textPath: ["payload", "text"],
      select: "last",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claudeJobsScope defaults to 'all'; only an explicit 'project' narrows it", () => {
  assert.equal(defaultConfig().settings.claudeJobsScope, "all");
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const write = (v: unknown) => {
      const p = join(dir, "odw.config.json");
      writeFileSync(p, JSON.stringify({ claudeJobsScope: v }));
      return loadConfig(p).settings.claudeJobsScope;
    };
    assert.equal(write("project"), "project");
    assert.equal(write("all"), "all");
    assert.equal(write("garbage"), "all"); // unknown value falls back to the default
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAdapter falls back to defaultAdapter and errors clearly", () => {
  const cfg = defaultConfig();
  cfg.settings.defaultAdapter = "claude";
  assert.equal(resolveAdapter(cfg).name, "claude");
  assert.equal(resolveAdapter(cfg, "codex").name, "codex");
  assert.throws(() => resolveAdapter(cfg, "nope"), AdapterNotFound);
});

test("resolveConcurrency: explicit wins; auto is bounded to [1,16]", () => {
  assert.equal(resolveConcurrency(5), 5);
  const auto = resolveConcurrency(null);
  assert.ok(auto >= 1 && auto <= 16, `auto concurrency out of range: ${auto}`);
});

test("resolveRunsRoot defaults under home, honours an explicit path", () => {
  assert.match(resolveRunsRoot(null), /\.odw[\\/]runs$/);
  assert.equal(resolveRunsRoot("/tmp/x"), "/tmp/x");
});

test("resolveClaudeWorkflowsRoot honours explicit root and CLAUDE_CONFIG_DIR", () => {
  const old = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.match(resolveClaudeWorkflowsRoot(null), /\.claude[\\/]workflows$/);
    assert.equal(resolveClaudeWorkflowsRoot("/tmp/claude-wf"), "/tmp/claude-wf");
    process.env.CLAUDE_CONFIG_DIR = "/tmp/custom-claude";
    assert.equal(resolveClaudeWorkflowsRoot(null), join("/tmp/custom-claude", "workflows"));
  } finally {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = old;
  }
});

test("a missing explicit config path throws", () => {
  assert.throws(() => loadConfig("/no/such/odw.config.json"));
});

test("an invalid adapter (no command) is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(p, JSON.stringify({ adapters: { bad: { label: "x" } } }));
    assert.throws(() => loadConfig(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid adapter output declarations are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(
      p,
      JSON.stringify({
        adapters: {
          bad: {
            command: ["bad"],
            output: { format: "jsonl", eventType: "text", textPath: [], select: "last" },
          },
        },
      }),
    );
    assert.throws(() => loadConfig(p), /output\.textPath/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows executable candidates honor PATHEXT without duplicating extensions", () => {
  assert.deepEqual(executableCandidates("agent", "win32", ".EXE;.CMD;.exe"), [
    "agent",
    "agent.EXE",
    "agent.CMD",
  ]);
  assert.deepEqual(executableCandidates("agent.cmd", "win32", ".EXE;.CMD"), ["agent.cmd"]);
  assert.deepEqual(executableCandidates("agent", "linux", ".EXE;.CMD"), ["agent"]);
});

// --- usability guardrails: unknown-key warnings & zero-config adapter pick ---

import { collectConfigWarnings } from "../src/adapters/config.js";
import { chmodSync, mkdirSync } from "node:fs";

test("collectConfigWarnings flags a nested 'settings' wrapper as ignored", () => {
  const warnings = collectConfigWarnings({
    settings: { defaultAdapter: "claude", runsRoot: "/tmp/x" },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /IGNORED/);
  assert.match(warnings[0]!, /"defaultAdapter", "runsRoot"/);
  assert.match(warnings[0]!, /top level/);
});

test("collectConfigWarnings suggests the nearest key for typos", () => {
  const warnings = collectConfigWarnings({ runsroot: "/tmp/x", defaultAdaptor: "codex" });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /did you mean "runsRoot"/);
  assert.match(warnings[1]!, /did you mean "defaultAdapter"/);
});

test("collectConfigWarnings flags unknown adapter fields", () => {
  const warnings = collectConfigWarnings({
    adapters: { mine: { command: ["x"], stdn: "{prompt}" } },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /adapter "mine"/);
  assert.match(warnings[0]!, /did you mean "stdin"/);
});

test("collectConfigWarnings is silent on a fully valid config and on comment keys", () => {
  assert.deepEqual(
    collectConfigWarnings({
      $comment: "hi",
      "//": "also a comment",
      defaultAdapter: "claude",
      concurrency: 4,
      adapters: {
        mine: {
          command: ["x"],
          stdin: "{prompt}",
          output: { format: "text" },
          $comment: "ok",
        },
      },
    }),
    [],
  );
});

test("loadConfig prints config warnings to stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(p, JSON.stringify({ settings: { runsRoot: "/tmp/x" } }));
    loadConfig(p);
    assert.match(captured, /odw: config warning:/);
    assert.match(captured, /IGNORED/);
  } finally {
    process.stderr.write = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAdapter with no default picks the sole adapter whose CLI is installed", async () => {
  await withPathDir(stubs("claude"), () => {
    const cfg = defaultConfig(); // nine builtins, defaultAdapter null
    assert.equal(resolveAdapter(cfg).name, "claude");
  });
});

test("resolveAdapter with no default and several installed CLIs errors with guidance", async () => {
  await withPathDir(stubs("claude", "codex"), () => {
    const cfg = defaultConfig();
    assert.throws(
      () => resolveAdapter(cfg),
      (err: Error) =>
        err instanceof AdapterNotFound &&
        /installed here: claude, codex/.test(err.message) &&
        /defaultAdapter/.test(err.message) &&
        // every suggested fix names a REAL installed adapter, and the
        // interactive way out (odw init) is discoverable from the error itself
        /odw init --adapter claude/.test(err.message) &&
        /pass --adapter claude to odw run/.test(err.message) &&
        /agent\(prompt, \{ adapter: "claude"/.test(err.message),
    );
  });
});

test("resolveAdapter with no default and no installed CLIs says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-path-"));
  const oldPath = process.env.PATH;
  try {
    mkdirSync(join(dir, "bin"), { recursive: true }); // empty PATH dir
    process.env.PATH = join(dir, "bin");
    const cfg = defaultConfig();
    assert.throws(
      () => resolveAdapter(cfg),
      (err: Error) => err instanceof AdapterNotFound && /none of their CLIs/.test(err.message),
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a launcher that odw cannot run is not an installed CLI -------------------

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Stub CLI files for `withPathDir`. Windows starts only `.exe` files, so a stub
 * there gets that extension.
 */
function stubs(...names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => [process.platform === "win32" ? `${name}.exe` : name, "#!/bin/sh\n"]),
  );
}

/**
 * Run `fn` with PATH set to a temp directory that holds `files` (made
 * executable), and with PATHEXT set to `.exe;.cmd`.
 */
async function withPathDir(files: Record<string, string>, fn: () => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "odw-launcher-"));
  const oldPath = process.env.PATH;
  const oldPathext = process.env.PATHEXT;
  try {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
      chmodSync(join(dir, name), 0o755);
    }
    process.env.PATH = dir;
    process.env.PATHEXT = ".exe;.cmd";
    await fn();
  } finally {
    restoreEnv("PATH", oldPath);
    restoreEnv("PATHEXT", oldPathext);
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "a Windows launcher that odw cannot run is not installed, so the default skips it",
  { skip: process.platform !== "win32" },
  async () => {
    // `agent.cmd` is Cursor's PowerShell launcher. `claude.exe` is a real kind of executable.
    await withPathDir({ "agent.cmd": CURSOR_AGENT_CMD, "claude.exe": "" }, () => {
      const cfg = defaultConfig();
      const rows = listAdapters(cfg);
      const cursor = rows.find((r) => r.name === "cursor")!;
      assert.equal(cursor.installed, false);
      assert.match(cursor.launchProblem ?? "", /agent\.cmd' is a batch launcher that odw cannot run$/);
      const claude = rows.find((r) => r.name === "claude")!;
      assert.equal(claude.installed, true);
      assert.equal(claude.launchProblem, undefined);
      // Only claude can run, so a bare agent() call uses it.
      assert.equal(resolveAdapter(cfg).name, "claude");
    });
  },
);

test(
  "resolveAdapter names a launcher that odw cannot run, not a missing CLI",
  { skip: process.platform !== "win32" },
  async () => {
    await withPathDir({ "agent.cmd": CURSOR_AGENT_CMD }, () => {
      assert.throws(
        () => resolveAdapter(defaultConfig()),
        (err: Error) =>
          err instanceof AdapterNotFound &&
          /cursor cannot run: .*agent\.cmd' is a batch launcher that odw cannot run/.test(err.message) &&
          !/none of their CLIs were found on PATH/.test(err.message),
      );
    });
    // Two CLIs can run, so the error lists them, and it still names the launcher that cannot.
    await withPathDir({ "agent.cmd": CURSOR_AGENT_CMD, "claude.exe": "", "codex.exe": "" }, () => {
      assert.throws(
        () => resolveAdapter(defaultConfig()),
        (err: Error) =>
          err instanceof AdapterNotFound &&
          /installed here: claude, codex; cursor cannot run: /.test(err.message) &&
          /odw init --adapter claude/.test(err.message),
      );
    });
  },
);

// --- the adapter's own env decides where its CLI is found ---------------------

/** The file name of an executable on this platform. */
const exeName = (name: string): string => (process.platform === "win32" ? `${name}.exe` : name);

/** Put a CLI that prints `ok` into `dir`. Windows needs a real `.exe`, so it gets a copy of Node. */
function writeOkCli(dir: string, name: string): void {
  if (process.platform === "win32") {
    copyFileSync(execPath, join(dir, exeName(name)));
    return;
  }
  writeFileSync(join(dir, name), "#!/bin/sh\nprintf ok\n");
  chmodSync(join(dir, name), 0o755);
}

test("listAdapters, resolveAdapter, and Bridge all find a CLI with the adapter's own env", async () => {
  const alphaDir = mkdtempSync(join(tmpdir(), "odw-alpha-"));
  const emptyDir = mkdtempSync(join(tmpdir(), "odw-empty-"));
  const workDir = mkdtempSync(join(tmpdir(), "odw-work-"));
  try {
    writeOkCli(alphaDir, "odw-alpha-cli");
    // The host PATH holds only the CLI of beta. The `-p 'ok'` arguments make Node print `ok`.
    await withPathDir({ [exeName("odw-beta-cli")]: "" }, async () => {
      const cfg = defaultConfig();
      cfg.adapters = {
        // The host PATH lacks the CLI of alpha, but the env of alpha holds it.
        alpha: { name: "alpha", command: ["odw-alpha-cli", "-p", "'ok'"], env: { PATH: alphaDir } },
        // The host PATH holds the CLI of beta, but the env of beta hides it.
        beta: { name: "beta", command: ["odw-beta-cli", "-p", "'ok'"], env: { PATH: emptyDir } },
      };
      assert.deepEqual(
        listAdapters(cfg).map((row) => [row.name, row.installed]),
        [
          ["alpha", true],
          ["beta", false],
        ],
      );
      assert.equal(resolveAdapter(cfg).name, "alpha");
      // The launch agrees with the check: alpha runs, and beta fails to launch.
      const bridge = new Bridge(cfg, { source: workDir });
      assert.equal((await bridge.run({ prompt: "hi", adapter: "alpha" })).text, "ok");
      await assert.rejects(
        () => bridge.run({ prompt: "hi", adapter: "beta" }),
        (err: Error) => err instanceof AdapterExecutionError && /failed to launch 'odw-beta-cli'/.test(err.message),
      );
    });
  } finally {
    for (const dir of [alphaDir, emptyDir, workDir]) rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a launcher that only the adapter's own env.PATH reaches is not installed, and the launch fails the same way",
  { skip: process.platform !== "win32" },
  async () => {
    const launcherDir = mkdtempSync(join(tmpdir(), "odw-launcher-"));
    const workDir = mkdtempSync(join(tmpdir(), "odw-work-"));
    try {
      writeFileSync(join(launcherDir, "odw-env-agent.cmd"), CURSOR_AGENT_CMD);
      // The host PATH holds an executable of that name. The env of the adapter reaches the launcher instead.
      await withPathDir({ "odw-env-agent.exe": "" }, async () => {
        const cfg = defaultConfig();
        cfg.adapters = {
          envagent: { name: "envagent", command: ["odw-env-agent"], env: { PATH: launcherDir } },
        };
        const [row] = listAdapters(cfg);
        assert.equal(row!.installed, false);
        assert.match(row!.launchProblem ?? "", /odw-env-agent\.cmd' is a batch launcher that odw cannot run$/);
        await assert.rejects(
          () => new Bridge(cfg, { source: workDir }).run({ prompt: "hi", adapter: "envagent" }),
          (err: Error) =>
            err instanceof AdapterExecutionError &&
            err.message.includes(`failed to launch 'odw-env-agent': ${row!.launchProblem}`),
        );
      });
    } finally {
      for (const dir of [launcherDir, workDir]) rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("resolveAdapter never names a CLI that cannot run", async () => {
  await withPathDir({ "agent.cmd": CURSOR_AGENT_CMD }, () => {
    // Nothing in this PATH can run: cursor's launcher is rejected and the rest are absent.
    assert.throws(
      () => resolveAdapter(defaultConfig()),
      (err: AdapterNotFound) => {
        assert.ok(!/--adapter \w/.test(err.message), `names a CLI that cannot run: ${err.message}`);
        assert.match(err.message, /install one of their CLIs/);
        return true;
      },
    );
  });
});
