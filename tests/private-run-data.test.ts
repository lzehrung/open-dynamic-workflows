import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import { ChatStore } from "../src/runtime/chat-store.js";
import { RunStore } from "../src/runtime/run-store.js";

// Run and chat data can hold secrets. On POSIX, a permissive umask (0o022)
// must not make that data readable by other local users. Windows ignores
// POSIX modes, so these tests run on POSIX only.

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Run `fn` with umask 0o022 (the common default), then restore the old umask. */
async function withUmask<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.umask(0o022);
  try {
    return await fn();
  } finally {
    process.umask(previous);
  }
}

test(
  "an inline run keeps its directories at 0700 and its files at 0600",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-run-"));
    try {
      await withUmask(async () => {
        const runsRoot = join(tmp, "runs");
        const { runId, store } = startRunFromSource(
          "export const meta = { name: 'private', description: 'x' }\nreturn 1\n",
          { runsRoot },
        );
        const status = await waitFor(store, runId, { timeoutMs: 10000, pollIntervalMs: 20 });
        assert.equal(status.state, "done");

        const runDir = store.runDir(runId);
        assert.equal(mode(runsRoot), 0o700, "runs root");
        assert.equal(mode(dirname(runDir)), 0o700, "bucket");
        assert.equal(mode(runDir), 0o700, "run dir");
        for (const file of ["meta.json", "status.json", "result.json", "events.jsonl", "worker.log", "worker.pid", "workflow.js"]) {
          assert.equal(mode(join(runDir, file)), 0o600, file);
        }
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "a chat session keeps _chat at 0700 and sessions.json at 0600",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-chat-"));
    try {
      await withUmask(() => {
        const runsRoot = join(tmp, "runs");
        const chat = new ChatStore(runsRoot, tmp);
        const session = chat.create();
        chat.appendUserMessage(session.id, "hello");

        assert.equal(mode(join(runsRoot, "_chat")), 0o700, "_chat dir");
        assert.equal(mode(join(runsRoot, "_chat", "sessions.json")), 0o600, "sessions.json");
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "create() makes an existing loose workflow bucket private and leaves an existing runs root alone",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-upgrade-"));
    try {
      await withUmask(() => {
        const runsRoot = join(tmp, "runs");
        mkdirSync(runsRoot);
        chmodSync(runsRoot, 0o755);
        const bucket = join(runsRoot, "legacy");
        mkdirSync(bucket);
        chmodSync(bucket, 0o755);

        const store = new RunStore(runsRoot);
        const runId = store.create({ script: "/x/legacy.js", args: null, source: tmp, workflowName: "legacy" });

        assert.equal(mode(runsRoot), 0o755, "existing runs root keeps its mode");
        assert.equal(mode(bucket), 0o700, "bucket");
        assert.equal(mode(store.runDir(runId)), 0o700, "run dir");
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "a ChatStore write makes an existing loose _chat directory private",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-chatdir-"));
    try {
      await withUmask(() => {
        const runsRoot = join(tmp, "runs");
        const chatDir = join(runsRoot, "_chat");
        mkdirSync(chatDir, { recursive: true });
        chmodSync(chatDir, 0o755);

        new ChatStore(runsRoot, tmp).create();

        assert.equal(mode(chatDir), 0o700, "_chat dir");
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "a stale loose sessions.json.tmp does not leak into sessions.json",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-staletmp-"));
    try {
      await withUmask(() => {
        const runsRoot = join(tmp, "runs");
        const chatDir = join(runsRoot, "_chat");
        mkdirSync(chatDir, { recursive: true });
        const stale = join(chatDir, "sessions.json.tmp");
        writeFileSync(stale, "stale");
        chmodSync(stale, 0o644);

        // The write removes the stale temp file, then renames a new private temp file to sessions.json.
        new ChatStore(runsRoot, tmp).create();

        assert.equal(mode(join(chatDir, "sessions.json")), 0o600, "sessions.json");
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "error.json and control.json are created at 0600",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-errctl-"));
    try {
      await withUmask(() => {
        const store = new RunStore(join(tmp, "runs"));
        const runId = store.create({ script: "/x/failing.js", args: null, source: tmp, workflowName: "failing" });
        store.writeError(runId, { message: "boom" });
        store.writeControl(runId, "stop");

        const runDir = store.runDir(runId);
        assert.equal(mode(join(runDir, "error.json")), 0o600, "error.json");
        assert.equal(mode(join(runDir, "control.json")), 0o600, "control.json");
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "a workflow bucket that is a symlink is refused: odw never chmods or writes through it",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-symlink-"));
    try {
      await withUmask(() => {
        const runsRoot = join(tmp, "runs");
        mkdirSync(runsRoot, { recursive: true });
        const outside = join(tmp, "outside");
        mkdirSync(outside);
        chmodSync(outside, 0o755);
        symlinkSync(outside, join(runsRoot, "evil"));

        const store = new RunStore(runsRoot);
        assert.throws(
          () => store.create({ script: "/x/evil.js", args: null, source: tmp, workflowName: "evil" }),
          /symlink/,
        );
        assert.equal(mode(outside), 0o755, "the symlink target keeps its mode");
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "a chat directory that is a symlink is refused on read too",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-chatlink-"));
    try {
      const runsRoot = join(tmp, "runs");
      mkdirSync(runsRoot, { recursive: true });
      const outside = join(tmp, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(runsRoot, "_chat"));

      const chat = new ChatStore(runsRoot, tmp);
      assert.throws(() => chat.list(), /symlink/);
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "a FIFO at a bucket path is refused, not opened",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-fifo-"));
    try {
      const runsRoot = join(tmp, "runs");
      mkdirSync(runsRoot, { recursive: true });
      const bucket = join(runsRoot, "evil");
      // The race window is closed by opening the directory with O_DIRECTORY: a
      // FIFO there can block an O_RDONLY open forever.
      assert.equal(spawnSync("mkfifo", [bucket]).status, 0);
      const store = new RunStore(runsRoot);
      assert.throws(() => store.create({ script: "/x/evil.js", args: null, source: tmp, workflowName: "evil" }));
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "reading an existing loose _chat makes it private, and reading an absent one creates nothing",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "odw-private-legacy-"));
    try {
      await withUmask(() => {
        const runsRoot = join(tmp, "runs");
        mkdirSync(runsRoot, { mode: 0o700 });
        const chat = new ChatStore(runsRoot, tmp);
        assert.deepEqual(chat.list(), []);
        assert.equal(existsSync(join(runsRoot, "_chat")), false, "a read creates no directory");

        // An older version left the directory loose.
        mkdirSync(join(runsRoot, "_chat"));
        chmodSync(join(runsRoot, "_chat"), 0o755);
        assert.deepEqual(chat.list(), []);
        assert.equal(mode(join(runsRoot, "_chat")), 0o700, "a list alone makes the directory private");
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
