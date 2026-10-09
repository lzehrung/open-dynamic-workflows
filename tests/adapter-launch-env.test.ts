/**
 * `adapterLaunchEnv` builds the environment that odw checks an adapter's CLI in,
 * and that `Bridge` launches it with. On Windows a name is one variable whatever
 * its letter case. So a name in the adapter `env` must replace the host variable
 * of that name in every spelling, or the host value wins and the adapter value is
 * lost.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig, listAdapters } from "../src/adapters/config.js";
import { adapterLaunchEnv, probeCommand } from "../src/adapters/executable.js";
import type { Adapter } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";

const adapterWith = (env?: Record<string, string>): Adapter => ({
  name: "demo",
  command: ["demo"],
  ...(env ? { env } : {}),
});

/** Remove temp directories. On Windows, a child that just exited can hold its working directory for a moment. */
function removeDirs(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("on win32, every spelling of a name in the adapter env replaces every spelling in the host", () => {
  const spellings = ["PATH", "Path", "path"];
  for (const hostName of spellings) {
    for (const adapterName of spellings) {
      const env = adapterLaunchEnv(adapterWith({ [adapterName]: "adapter" }), "win32", {
        [hostName]: "host",
        Keep: "keep",
      });
      assert.deepEqual(env, { [adapterName]: "adapter", Keep: "keep" }, `host ${hostName}, adapter ${adapterName}`);
    }
  }
});

test("on win32, the case rule holds for PATHEXT and for any other name, and it removes every host spelling", () => {
  const host = { PATH: "host", Path: "host two", PATHEXT: ".EXE", Home: "host home", Keep: "keep" };
  const hostBefore = { ...host };
  const env = adapterLaunchEnv(adapterWith({ path: "adapter", pathext: ".cmd", HOME: "adapter home" }), "win32", host);
  assert.deepEqual(env, { path: "adapter", pathext: ".cmd", HOME: "adapter home", Keep: "keep" });
  assert.deepEqual(host, hostBefore, "the host object is not changed");

  // The default host is the real process environment. Building a launch environment must not change it.
  const processBefore = JSON.stringify(process.env);
  adapterLaunchEnv(adapterWith({ path: "adapter", pathext: ".cmd" }), "win32");
  assert.equal(JSON.stringify(process.env), processBefore);
});

test("on win32, a later name in the adapter env replaces an earlier one that differs only in case", () => {
  const adapter = adapterWith({ PATH: "first", Path: "second" });
  assert.deepEqual(adapterLaunchEnv(adapter, "win32", {}), { Path: "second" });
});

test("on other platforms, names match exactly: another spelling stays beside the adapter's value", () => {
  // Without an adapter env there is nothing to merge, so the launch keeps the process environment.
  for (const platform of ["win32", "linux"] as const) {
    assert.equal(adapterLaunchEnv(adapterWith(), platform, { PATH: "/bin" }), undefined, platform);
  }
  for (const platform of ["linux", "darwin"] as const) {
    const host = { PATH: "host", Keep: "keep" };
    assert.deepEqual(
      adapterLaunchEnv(adapterWith({ Path: "adapter" }), platform, host),
      { PATH: "host", Path: "adapter", Keep: "keep" },
      platform,
    );
    assert.deepEqual(
      adapterLaunchEnv(adapterWith({ PATH: "adapter" }), platform, host),
      { PATH: "adapter", Keep: "keep" },
      platform,
    );
    assert.deepEqual(
      adapterLaunchEnv(adapterWith({ PATH: "first", Path: "second" }), platform, {}),
      { PATH: "first", Path: "second" },
      platform,
    );
  }
});

test("on win32, a CLI is found through the adapter's Path and PathExt even when the host spells them otherwise", () => {
  const hostDir = mkdtempSync(join(tmpdir(), "odw launchenv-"));
  const cliDir = mkdtempSync(join(tmpdir(), "odw launchenv-"));
  try {
    writeFileSync(join(cliDir, "odw-case-cli.exe"), "");
    // The host PATH holds no CLI, and the host PATHEXT does not list `.exe`.
    const host = { PATH: hostDir, PATHEXT: ".cmd" };
    assert.deepEqual(probeCommand("odw-case-cli", host, "win32"), { status: "missing" });
    const env = adapterLaunchEnv(adapterWith({ Path: cliDir, pathext: ".exe" }), "win32", host);
    assert.deepEqual(probeCommand("odw-case-cli", env, "win32"), { status: "ready" });
  } finally {
    removeDirs(hostDir, cliDir);
  }
});

test(
  "on Windows, an adapter env that spells PATH in lower case still decides where odw finds and launches its CLI",
  { skip: process.platform !== "win32" },
  async () => {
    const cliDir = mkdtempSync(join(tmpdir(), "odw launchenv-"));
    const workDir = mkdtempSync(join(tmpdir(), "odw launchenv-"));
    try {
      // A copy of Node. Its arguments `-p 'ok'` make it print `ok`. The host PATH does not hold it.
      copyFileSync(execPath, join(cliDir, "odw-case-cli.exe"));
      // A name in lower case sorts after every other spelling. Before the fix, the host entry won
      // that tie, whether the host spells the name `PATH` or `Path`.
      const config = defaultConfig();
      config.adapters = {
        casecli: {
          name: "casecli",
          command: ["odw-case-cli", "-p", "'ok'"],
          env: { path: cliDir, pathext: ".exe" },
        },
      };
      const [row] = listAdapters(config);
      assert.equal(row!.installed, true);
      const outcome = await new Bridge(config, { source: workDir }).run({ prompt: "hi", adapter: "casecli" });
      assert.equal(outcome.text, "ok");
    } finally {
      removeDirs(cliDir, workDir);
    }
  },
);
