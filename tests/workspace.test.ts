import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defaultConfig } from "../src/adapters/config.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { AdapterExecutionError, RunStopped } from "../src/errors.js";
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
      // Agents habitually stage and even commit — that must not hide work,
      // because the diff is taken against the pinned base commit.
      git(ws.path, "add", "a.txt");
      git(ws.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "agent commit");
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

test("worktree mode maps a repo SUBDIRECTORY source to the matching subdir", async () => {
  const src = makeRepo();
  const sub = join(src, "packages", "foo");
  try {
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "f.txt"), "sub\n");
    git(src, "add", "-A");
    git(src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "sub");
    const diff = await withWorkspace(sub, "worktree", async (ws) => {
      assert.ok(ws.path.endsWith(join("packages", "foo")), `agent lands in the subdir, got ${ws.path}`);
      assert.ok(existsSync(join(ws.path, "f.txt")));
      await writeFile(join(ws.path, "f.txt"), "edited\n");
      return ws.diff();
    });
    assert.match(diff, /packages\/foo\/f\.txt/);
    assert.equal(await readFile(join(sub, "f.txt"), "utf8"), "sub\n");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("a worktree the agent LOCKED is still cleaned up completely", async () => {
  const src = makeRepo();
  try {
    await withWorkspace(src, "worktree", async (ws) => {
      git(src, "worktree", "lock", ws.path);
      return null;
    });
    const worktrees = git(src, "worktree", "list", "--porcelain");
    assert.equal(worktrees.trim().split("\n\n").length, 1, "no stale locked registration");
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

// --- a worktree is kept when a leftover process may still use it ------------------

const stoppedCall = (termination: "cancelled" | "timeout", treeCleanup: "verified" | "unverified"): CliResult => ({
  returncode: -1,
  stdout: "",
  stderr: "",
  timedOut: termination === "timeout",
  termination,
  treeCleanup,
  duration: 0,
});

/** Run one worktree-isolated call whose runner reports `result`; return what the call saw and threw. */
async function stoppedWorktreeCall(
  src: string,
  result: CliResult,
  whileRunning?: (cwd: string) => void,
): Promise<{ cwd: string; error: unknown }> {
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  let cwd = "";
  const bridge = new Bridge(config, {
    source: src,
    runner: async (_command, options) => {
      cwd = options?.cwd ?? "";
      whileRunning?.(cwd);
      return result;
    },
  });
  const error = await bridge.run({ prompt: "x", isolation: "worktree" }).then(
    () => null,
    (err: unknown) => err,
  );
  return { cwd, error };
}

test("retain keeps the worktree after the call and returns its root", async () => {
  const src = makeRepo();
  let kept: string | null = null;
  try {
    await withWorkspace(src, "worktree", async (ws) => {
      kept = ws.retain();
    });
    assert.ok(kept, "a worktree workspace returns its root");
    assert.ok(existsSync(join(kept!, "a.txt")), "the kept worktree still has its files");
    assert.match(git(src, "worktree", "list"), /odw-wt-/);
    assert.equal(await withWorkspace(src, "inplace", async (ws) => ws.retain()), null);
  } finally {
    if (kept) git(src, "worktree", "remove", "--force", kept);
    rmSync(src, { recursive: true, force: true });
  }
});

test("a cancelled call with an unverified process tree keeps its worktree and names it", async () => {
  const src = makeRepo();
  let cwd = "";
  try {
    const seen = await stoppedWorktreeCall(src, stoppedCall("cancelled", "unverified"));
    cwd = seen.cwd;
    assert.ok(seen.error instanceof RunStopped);
    assert.equal(seen.error.treeCleanup, "unverified");
    assert.ok(seen.error.message.includes(cwd), "the stop names the kept worktree");
    // The path is named, but never spliced into a shell command: a directory name
    // can hold `$(...)` or quotes.
    assert.ok(seen.error.message.includes("git worktree remove --force"));
    assert.ok(!seen.error.message.includes(`--force "${cwd}"`) && !seen.error.message.includes(`--force '${cwd}'`));
    assert.ok(existsSync(cwd), "the worktree is still there");
  } finally {
    if (cwd) git(src, "worktree", "remove", "--force", cwd);
    rmSync(src, { recursive: true, force: true });
  }
});

test("a timed-out call with an unverified process tree keeps its worktree and names it", async () => {
  const src = makeRepo();
  let cwd = "";
  try {
    const seen = await stoppedWorktreeCall(src, stoppedCall("timeout", "unverified"));
    cwd = seen.cwd;
    assert.ok(seen.error instanceof AdapterExecutionError);
    assert.ok(seen.error.message.includes(cwd), "the failure names the kept worktree");
    assert.ok(existsSync(cwd), "the worktree is still there");
  } finally {
    if (cwd) git(src, "worktree", "remove", "--force", cwd);
    rmSync(src, { recursive: true, force: true });
  }
});

test("a stopped call whose process tree is verified gone still removes its worktree", async () => {
  const src = makeRepo();
  try {
    const seen = await stoppedWorktreeCall(src, stoppedCall("cancelled", "verified"));
    assert.ok(seen.error instanceof RunStopped);
    assert.equal(seen.error.message, "run was stopped");
    assert.equal(existsSync(seen.cwd), false, "a verified end leaves nothing behind");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("an unverified stop keeps the worktree before any git step can fail into a removal", async () => {
  const src = makeRepo();
  let cwd = "";
  try {
    // The agent breaks the worktree's git link, so a later `git diff` would fail.
    const seen = await stoppedWorktreeCall(src, stoppedCall("timeout", "unverified"), (dir) =>
      rmSync(join(dir, ".git"), { force: true }),
    );
    cwd = seen.cwd;
    assert.ok(seen.error instanceof AdapterExecutionError, "the call fails as a timeout, not as a git error");
    assert.ok(seen.error.message.includes(cwd), "the failure names the kept worktree");
    assert.ok(existsSync(cwd), "the worktree is still there");
  } finally {
    if (cwd) rmSync(dirname(cwd), { recursive: true, force: true });
    git(src, "worktree", "prune");
    rmSync(src, { recursive: true, force: true });
  }
});
