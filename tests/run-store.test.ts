import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { replaceFile } from "../src/runtime/replace-file.js";
import { JsonlSink, RunStore } from "../src/runtime/run-store.js";

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-runs-"));

test("create writes meta + status; reads round-trip", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/x/wf.js", args: { n: 1 }, source: "/src" });
    assert.ok(store.exists(id));
    assert.equal(store.readMeta(id).script, "/x/wf.js");
    assert.deepEqual(store.readMeta(id).args, { n: 1 });
    assert.equal(store.readStatus(id).state, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updateStatus merges; result/control round-trip; listRuns", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: "/src" });
    store.updateStatus(id, { state: "running", dispatched: 2 });
    assert.equal(store.readStatus(id).state, "running");
    assert.equal(store.readStatus(id).dispatched, 2);
    store.writeResult(id, { ok: true });
    assert.deepEqual(store.readResult(id), { ok: true });
    store.writeControl(id, "stop");
    assert.equal(store.readControl(id), "stop");
    // listRuns now returns {runId, workflowName}; this run had no name → bucket stem.
    assert.deepEqual(store.listRuns(), [{ runId: id, workflowName: "wf" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R1: create buckets a run under runs/<slug(workflowName)>/<runId> and records the name", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({
      script: "/x/deep.js",
      args: null,
      source: "/s",
      workflowName: "Deep Research", // contains a space → slugified for the bucket
    });
    assert.ok(existsSync(join(root, "Deep-Research", id, "meta.json")), "bucketed by slug");
    assert.equal(store.readMeta(id).workflowName, "Deep Research", "true name kept in meta");
    assert.equal(store.readStatus(id).state, "pending", "a pending run already knows its bucket");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R1/R2: a fresh store locates a bucketed run by id across buckets (no memo)", () => {
  const root = tempRoot();
  try {
    const id = new RunStore(root).create({
      script: "x.js",
      args: { n: 1 },
      source: "/s",
      workflowName: "alpha",
    });
    const fresh = new RunStore(root); // cold cache: must scan buckets
    assert.ok(fresh.exists(id));
    assert.deepEqual(fresh.readMeta(id).args, { n: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2: listRuns walks two levels, newest first, and tolerates a legacy flat run", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const bucketed = store.create({ script: "a.js", args: null, source: "/s", workflowName: "alpha" });
    // A pre-bucket flat run: <root>/<legacyId>/meta.json (older timestamp prefix).
    const legacyId = "20200101-000000-aaaaaa";
    mkdirSync(join(root, legacyId), { recursive: true });
    writeFileSync(join(root, legacyId, "meta.json"), JSON.stringify({ runId: legacyId, script: "old.js" }));

    const refs = new RunStore(root).listRuns();
    const ids = refs.map((r) => r.runId);
    assert.ok(ids.includes(bucketed), "bucketed run listed");
    assert.ok(ids.includes(legacyId), "legacy flat run listed");
    assert.ok(ids.indexOf(bucketed) < ids.indexOf(legacyId), "newest (2026) before oldest (2020)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3: listRunsForWorkflow reads only that workflow's bucket", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const a = store.create({ script: "a.js", args: null, source: "/s", workflowName: "alpha" });
    store.create({ script: "b.js", args: null, source: "/s", workflowName: "beta" });
    const refs = store.listRunsForWorkflow("alpha");
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.runId, a);
    assert.equal(refs[0]!.workflowName, "alpha");
    assert.deepEqual(store.listRunsForWorkflow("nonexistent"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JsonlSink appends and readEvents parses each line", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: "/src" });
    const sink = new JsonlSink(store.eventsPath(id));
    sink.emit({ ts: 1, type: "log", message: "a" });
    sink.emit({ ts: 2, type: "log", message: "b" });
    const events = store.readEvents(id);
    assert.equal(events.length, 2);
    assert.equal(events[1]!.message, "b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "status writes succeed on Windows while another process reads status.json",
  { skip: process.platform !== "win32" },
  async () => {
    const root = tempRoot();
    const store = new RunStore(root);
    const id = store.create({ script: "s.js", args: null, source: root, workflowName: "s" });
    const statusPath = join(store.runDir(id), "status.json");
    // A separate process polls the file, as `odw run --wait` and the dashboard do.
    const reader = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('fs');const p=${JSON.stringify(statusPath)};process.stdout.write('ready');` +
          "const end=Date.now()+20000;const pause=new Int32Array(new SharedArrayBuffer(4));while(Date.now()<end){try{fs.readFileSync(p)}catch{}Atomics.wait(pause,0,0,2)}",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const exited = once(reader, "exit");
    try {
      await once(reader.stdout!, "data"); // the reader is polling
      for (let i = 0; i < 3000; i++) store.updateStatus(id, { state: "running", n: i });
      assert.equal(store.readStatus(id).n, 2999);
    } finally {
      reader.kill();
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a rename that stays blocked on Windows fails after the retry limit and removes the temp file",
  { skip: process.platform !== "win32" },
  () => {
    const root = tempRoot();
    const target = join(root, "status.json");
    const tmp = `${target}.tmp`;
    writeFileSync(target, "{}");
    writeFileSync(tmp, "{\"n\":1}");
    // An open handle blocks the replacement for the whole retry period.
    const fd = openSync(target, "r");
    try {
      const started = Date.now();
      // Windows reports the same blocked replacement with any of these codes.
      const transient = new Set(["EPERM", "EACCES", "EBUSY"]);
      assert.throws(
        () => replaceFile(tmp, target),
        (err: NodeJS.ErrnoException) => transient.has(err.code ?? ""),
        "the rename failed with a code that the retry does not treat as transient",
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 400 && elapsed < 2_000, `retried for ${elapsed} ms`);
      assert.equal(existsSync(tmp), false, "the temp file is removed");
    } finally {
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
