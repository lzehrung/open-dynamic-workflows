import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { loadConfig } from "../src/adapters/config.js";
import { waitFor } from "../src/runtime/launcher.js";
import { ChatStore } from "../src/runtime/chat-store.js";
import { RunStore } from "../src/runtime/run-store.js";
import {
  CHAT_HOST_WORKFLOW_SOURCE,
  nonLoopbackBindWarning,
  startServer,
  type ChatTurnRunner,
  type ServeHandle,
} from "../src/runtime/server.js";

// Regression tests for the dashboard server's request guards.

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-guards-"));

async function boot(root: string, host: string): Promise<ServeHandle> {
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ workflowsRoot: join(root, "gwf") }));
  return startServer({
    store: new RunStore(join(root, "runs")),
    port: 0,
    host,
    cwd: root,
    config: loadConfig(configPath),
    configPath,
    claudeProjectsRoot: join(root, "no-claude"),
  });
}

/** Send a raw request to 127.0.0.1; resolves the status, or -1 when the socket errors. */
function rawRequest(
  port: number,
  options: { method: string; path: string; headers: Record<string, string>; body?: string },
): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    const req = request({ host: "127.0.0.1", port, path: options.path, method: options.method, headers: options.headers }, (res) => {
      res.resume();
      res.on("end", () => resolvePromise(res.statusCode ?? 0));
    });
    req.on("error", () => resolvePromise(-1));
    req.end(options.body);
  });
}

test("a body under the cap in characters but over it in UTF-8 bytes is rejected", async () => {
  const root = tempRoot();
  const handle = await boot(root, "127.0.0.1");
  try {
    // 200 Ki characters is under 512 Ki characters, but each "世" is 3 UTF-8 bytes: 600 KiB.
    const body = JSON.stringify({ script: "世".repeat(200 * 1024) });
    assert.ok(body.length < 512 * 1024);
    assert.ok(Buffer.byteLength(body, "utf8") > 512 * 1024);
    const status = await rawRequest(handle.port, {
      method: "POST",
      path: "/api/chat/sessions",
      headers: { "content-type": "application/json" },
      body,
    });
    // The server answers 400 and drains the rest: the response must arrive.
    assert.equal(status, 400);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a loopback bind refuses a request with a foreign Host header", async () => {
  const root = tempRoot();
  const handle = await boot(root, "127.0.0.1");
  try {
    const status = await rawRequest(handle.port, { method: "GET", path: "/api/runs", headers: { host: "evil.example" } });
    assert.equal(status, 403);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Hosts that bind a non-loopback address, or a loopback spelling ODW does not
// accept. Each one is read-only and unauthenticated. `reach` is the address a
// local client uses to connect. macOS has no `127.0.0.2` alias, so that case
// cannot bind there.
const READ_ONLY_BINDS: Array<{ host: string; reach: string; skip?: string }> = [
  { host: "0.0.0.0", reach: "127.0.0.1" },
  { host: "127.0.0.2", reach: "127.0.0.2", ...(process.platform === "darwin" ? { skip: "macOS has no 127.0.0.2 alias" } : {}) },
  { host: "0:0:0:0:0:0:0:1", reach: "[::1]" },
];

for (const { host, reach, skip } of READ_ONLY_BINDS) {
  test(`a bind to ${host} refuses a JSON write with 409 and serves unauthenticated settings`, { skip }, async () => {
    const root = tempRoot();
    const handle = await boot(root, host);
    try {
      const base = `http://${reach}:${handle.port}`;
      const res = await fetch(`${base}/api/chat/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 409);
      const sessions = (await (await fetch(`${base}/api/chat/sessions`)).json()) as unknown[];
      assert.equal(sessions.length, 0);
      // The warning names settings because this read needs no authentication.
      const settings = await fetch(`${base}/api/settings`);
      assert.equal(settings.status, 200);
      const view = (await settings.json()) as { writable: boolean; adapters: Array<{ command: string }> };
      assert.equal(view.writable, false);
      assert.ok(view.adapters.some((a) => a.command.length > 0));
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Chat Host archives the fixed workflow source and ignores client-supplied code", async () => {
  const root = tempRoot();
  const proj = tempRoot();
  const store = new RunStore(root);
  const mockAgent = "process.stdin.resume().on('end',()=>process.stdout.write('mock ODW task result'))";
  // The worker reads the config file, so the mock adapter must live there.
  const configPath = join(proj, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "mock",
      adapters: { mock: { command: [execPath, "-e", mockAgent], stdin: "{prompt}" } },
    }),
  );
  const chatRunner: ChatTurnRunner = async (_req, onChunk) => onChunk("mock codex reply");
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: proj,
    config: loadConfig(configPath),
    configPath,
    claudeProjectsRoot: join(root, "no-claude"),
    chatRunner,
  });
  try {
    const created = (await fetch(`${handle.url}/api/chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: proj }),
    }).then((r) => r.json())) as { id: string };

    const injected = 'export const meta = { name: "injected" }\nreturn "pwned"\n';
    const updated = (await fetch(`${handle.url}/api/chat/sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Use ODW workflow routing for this local turn.",
        workflow: injected,
        script: injected,
        code: injected,
        source: proj,
      }),
    }).then((r) => r.json())) as { linkedRuns: Array<{ runId: string }> };
    assert.equal(updated.linkedRuns.length, 1);
    const runId = updated.linkedRuns[0]!.runId;

    const archived = readFileSync(join(store.runDir(runId), "workflow.js"), "utf8");
    assert.equal(archived, CHAT_HOST_WORKFLOW_SOURCE);

    // Let the worker and the follow-up chat turn finish before the temp dirs go away.
    // The worker is a real child process with no in-process completion signal, so poll.
    await waitFor(store, runId, { timeoutMs: 5000 });
    const started = Date.now();
    for (;;) {
      const session = (await fetch(`${handle.url}/api/chat/sessions/${created.id}`).then((r) => r.json())) as {
        state?: string;
      };
      if (session.state === "done" || Date.now() - started > 2500) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("nonLoopbackBindWarning names the host, the accepted hosts, and the exposure", () => {
  for (const host of ["0.0.0.0", "192.168.1.20", "127.0.0.2", "0:0:0:0:0:0:0:1"]) {
    const warning = nonLoopbackBindWarning(host);
    assert.ok(warning, `expected a warning for ${host}`);
    assert.ok(warning.includes(`warning: ${host} is not 127.0.0.1, localhost, or ::1`), `names ${host} and the accepted hosts`);
    assert.match(warning, /settings \(adapter commands and local paths\)/);
    assert.match(warning, /no authentication/i);
    assert.match(warning, /Writes are refused/);
  }
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.equal(nonLoopbackBindWarning(host), null);
  }
});

/** Send a raw request whose body arrives as the given byte slices. */
function rawRequestSlices(
  port: number,
  options: { method: string; path: string; headers: Record<string, string>; slices: Buffer[] },
): Promise<{ status: number; text: string }> {
  return new Promise((resolvePromise) => {
    const req = request(
      { host: "127.0.0.1", port, path: options.path, method: options.method, headers: options.headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", () => resolvePromise({ status: -1, text: "" }));
    const writeNext = (i: number): void => {
      if (i >= options.slices.length) {
        req.end();
        return;
      }
      req.write(options.slices[i]!, () => setTimeout(() => writeNext(i + 1), 10));
    };
    writeNext(0);
  });
}

test("a UTF-8 character split across request chunks is not corrupted", async () => {
  const root = tempRoot();
  const handle = await boot(root, "127.0.0.1");
  try {
    const probe = join(root, "prøbe-世界");
    mkdirSync(probe, { recursive: true });
    const body = Buffer.from(JSON.stringify({ source: probe }), "utf8");
    // Split inside "ø" (2 bytes) and inside "世" (3 bytes).
    const cutOne = body.indexOf(Buffer.from("ø", "utf8")) + 1;
    const cutTwo = body.indexOf(Buffer.from("世", "utf8")) + 2;
    assert.ok(cutOne > 0 && cutTwo > cutOne);
    const slices = [body.subarray(0, cutOne), body.subarray(cutOne, cutTwo), body.subarray(cutTwo)];
    const res = await rawRequestSlices(handle.port, {
      method: "POST",
      path: "/api/chat/sessions",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      slices,
    });
    assert.equal(res.status, 200, res.text);
    assert.ok(!res.text.includes("\u{FFFD}"), "the split character became a replacement character");
    const created = JSON.parse(res.text) as { source?: string };
    assert.ok(String(created.source).includes("prøbe-世界"));
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A chat session whose linked run finishes during the test. The stores are
 * driven directly: on a non-loopback bind the HTTP writes are refused, which is
 * the case under test. Returns what a later GET of the session shows.
 */
async function completedChatRun(host: string): Promise<{ resultMessage: boolean; turns: number }> {
  const root = tempRoot();
  const runsRoot = join(root, "runs");
  const store = new RunStore(runsRoot);
  let turns = 0;
  const chatRunner: ChatTurnRunner = async (_req, onChunk) => {
    turns++;
    onChunk("mock codex reply");
  };
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ workflowsRoot: join(root, "gwf") }));
  const handle = await startServer({
    store,
    port: 0,
    host,
    cwd: root,
    config: loadConfig(configPath),
    configPath,
    claudeProjectsRoot: join(root, "no-claude"),
    chatRunner,
  });
  try {
    const chat = new ChatStore(runsRoot, root);
    const session = chat.create(root);
    // The run starts after the server: the sync only reports runs of this server.
    const runId = store.create({ script: "/x/g.js", args: null, source: root, workflowName: "g" });
    chat.appendToolRun(session.id, runId, "g");
    store.updateStatus(runId, { state: "done", dispatched: 1, spentTokens: 0 });
    turns = 0; // count only what the read below starts

    const res = await fetch(`${handle.url}/api/chat/sessions/${session.id}`);
    assert.equal(res.status, 200);
    const seen = (await res.json()) as { messages: Array<{ kind?: string }> };
    // A started turn calls the runner soon after; give it a moment to arrive.
    for (let i = 0; i < 40 && turns === 0; i++) await new Promise((r) => setTimeout(r, 25));
    return {
      resultMessage: seen.messages.some((m) => m.kind === "chat.odw_result"),
      turns,
    };
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("a non-loopback read is passive: it never appends a run result or starts a chat turn", async () => {
  const offLoopback = await completedChatRun("0.0.0.0");
  assert.equal(offLoopback.resultMessage, false, "the read appended a run result message");
  assert.equal(offLoopback.turns, 0, "the read started a chat turn");
});

test("a loopback read reports a finished run to its chat session", async () => {
  const loopback = await completedChatRun("127.0.0.1");
  assert.equal(loopback.resultMessage, true);
  assert.ok(loopback.turns >= 1, "the loopback read did not start the follow-up chat turn");
});
