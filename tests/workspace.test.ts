import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SETTINGS } from "../src/adapters/builtin.js";
import { withWorkspace } from "../src/workspace.js";

function makeSource(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-src-"));
  writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
  return dir;
}

test("copy mode isolates the tree and diffs the agent's changes", async () => {
  const src = makeSource();
  try {
    const diff = await withWorkspace(src, "copy", async (ws) => {
      assert.notEqual(ws.path, src, "copy must run in a separate directory");
      await writeFile(join(ws.path, "a.txt"), "line1\nCHANGED\n");
      return ws.diff();
    });
    assert.match(diff, /a\/a\.txt/);
    assert.match(diff, /^-line2$/m);
    assert.match(diff, /^\+CHANGED$/m);
    // the real source tree must be untouched
    assert.equal(await readFile(join(src, "a.txt"), "utf8"), "line1\nline2\n");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("the default workspace mode is inplace (Claude Code Workflow-tool parity)", () => {
  assert.equal(DEFAULT_SETTINGS.workspaceMode, "inplace");
});

test("copy mode skips sockets instead of dying on them", async () => {
  const src = makeSource();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(join(src, "live.sock"), resolve);
  });
  try {
    // Before the non-regular-file filter, fs.cp threw ERR_FS_CP_SOCKET here —
    // which is exactly what a run launched from a directory containing a Unix
    // socket (e.g. $HOME) used to die on.
    await withWorkspace(src, "copy", async (ws) => {
      assert.equal(await readFile(join(ws.path, "a.txt"), "utf8"), "line1\nline2\n");
      assert.equal(existsSync(join(ws.path, "live.sock")), false, "socket must be skipped");
    });
  } finally {
    server.close();
    rmSync(src, { recursive: true, force: true });
  }
});

test("copy mode skips unreadable directories instead of failing the workspace", async () => {
  const src = makeSource();
  const locked = join(src, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "secret.txt"), "nope");
  chmodSync(locked, 0o000);
  try {
    await withWorkspace(src, "copy", async (ws) => {
      assert.equal(await readFile(join(ws.path, "a.txt"), "utf8"), "line1\nline2\n");
      assert.equal(existsSync(join(ws.path, "locked")), false, "unreadable dir must be skipped");
    });
  } finally {
    chmodSync(locked, 0o755);
    rmSync(src, { recursive: true, force: true });
  }
});

test("inplace mode runs in the source and yields no diff", async () => {
  const src = makeSource();
  try {
    const out = await withWorkspace(src, "inplace", async (ws) => {
      assert.equal(ws.path, src);
      return ws.diff();
    });
    assert.equal(out, "");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});
