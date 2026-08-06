import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { runCommand } from "../src/adapters/runner.js";

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

test(
  "Windows PATH command shims run through their PowerShell companion without shell interpolation",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw-runner-shim-"));
    try {
      const name = "odw-runner-shim";
      writeFileSync(join(dir, `${name}.cmd`), "@echo off\r\nexit /b 99\r\n");
      writeFileSync(
        join(dir, `${name}.ps1`),
        'param([string]$Value)\n$body = [Console]::In.ReadToEnd()\n[Console]::Out.Write(\"$Value|$body\")\n',
      );
      const result = await runCommand([name, "safe&literal"], {
        stdin: "stdin-value",
        env: { ...process.env, PATH: dir, PATHEXT: ".CMD" } as Record<string, string>,
      });
      assert.equal(result.returncode, 0);
      assert.equal(result.stdout, "safe&literal|stdin-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
