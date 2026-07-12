import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withWorkspace } from "../src/workspace.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** A one-commit repo with a.txt — the smallest worktree-able source. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-src-"));
  writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  return dir;
}

test("worktree mode isolates via a real git worktree and diffs edits AND new files", async () => {
  const src = makeRepo();
  try {
    const diff = await withWorkspace(src, "worktree", async (ws) => {
      assert.notEqual(ws.path, src, "worktree must be a separate directory");
      assert.ok(existsSync(join(ws.path, "a.txt")), "worktree has the committed tree");
      await writeFile(join(ws.path, "a.txt"), "line1\nCHANGED\n");
      await writeFile(join(ws.path, "brand-new.txt"), "hello\n");
      return ws.diff();
    });
    assert.match(diff, /a\/a\.txt/);
    assert.match(diff, /^\+CHANGED$/m);
    // intent-to-add makes brand-new files part of the diff too
    assert.match(diff, /brand-new\.txt/);
    assert.match(diff, /^\+hello$/m);
    // the real source tree is untouched, and the worktree is gone from git
    assert.equal(await readFile(join(src, "a.txt"), "utf8"), "line1\nline2\n");
    const worktrees = git(src, "worktree", "list", "--porcelain");
    assert.equal(worktrees.trim().split("\n\n").length, 1, "only the main worktree remains");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("worktree mode on a non-git directory fails with an actionable error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-plain-"));
  try {
    await assert.rejects(
      withWorkspace(dir, "worktree", async () => "unreachable"),
      /needs a git repository/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inplace mode runs in the source and yields no diff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-plain-"));
  writeFileSync(join(dir, "a.txt"), "x\n");
  try {
    const out = await withWorkspace(dir, "inplace", async (ws) => {
      assert.equal(ws.path, dir);
      return ws.diff();
    });
    assert.equal(out, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
