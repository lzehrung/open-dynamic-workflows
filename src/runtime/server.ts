/**
 * The dashboard server (L5): a read-only window onto the run directory.
 *
 * `odw serve` starts a tiny node:http server (zero runtime deps — same promise
 * as the rest of the engine) that folds the run directory through
 * {@link ./runs-view} and serves it as JSON + an SSE live stream, plus the
 * embedded single-page dashboard. It owns no workflow state: every read goes to
 * the same {@link RunStore} the CLI uses, so a run started by `odw run` in any
 * project shows up here with no coupling between the two processes.
 *
 * Endpoints:
 *   GET  /                       the dashboard HTML
 *   GET  /api/runs               [RunSummary] (newest first)
 *   GET  /api/runs/:id           RunDetail
 *   GET  /api/runs/:id/events    raw events (optionally ?since=N for the tail)
 *   GET  /api/stream             text/event-stream; pushes the run list on change
 *   GET  /api/adapters           [AdapterListing] — the Launch view's agent picker
 *   POST /api/generate           { task, adapter?, source? } → { runId } (generation run)
 *   POST /api/runs               { script | name, args?, adapter?, source? } → { runId }
 *   POST /api/workflows          { name, source, scope, projectDir? } → { path } (save)
 *   POST /api/runs/:id/control   { action: pause|resume|stop } → writeControl
 *
 * Security: binds 127.0.0.1 by default. The run list aggregates every project's
 * runs (prompts, results) — both ODW's own runs root AND, with the default
 * `claudeJobsScope: "all"`, Claude Code's `~/.claude/projects` across every repo
 * — so exposing it off-loopback is opt-in. The Claude side is strictly read-only
 * (control is refused) and surfaces a run's metadata + author `log()` lines +
 * final result, NOT raw agent transcripts; narrow it with `claudeJobsScope:
 * "project"` to the served repo + its worktrees.
 *
 * Write-path security (launch.md §3.5): POST /api/runs accepts inline scripts —
 * an HTTP handle on "drive a local coding agent" — so the realistic threat is a
 * hostile web page reaching loopback through the user's browser, not the local
 * machine (local processes can already run code). Defenses:
 *   1. writeGuard on every POST: Content-Type must be application/json (kills
 *      CORS "simple requests") and, when an Origin header is present, it must be
 *      same-origin.
 *   2. Host-header allowlist on loopback binds (DNS-rebinding guard, all routes).
 *   3. Off-loopback binds (--host) refuse every write with 409 — the dashboard
 *      can be viewed remotely, the launch pad cannot; token auth is a future
 *      opt-in gate.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listAdapters,
  loadConfig,
  resolveClaudeProjectsRoot,
  resolveClaudeWorkflowsRoot,
  resolveWorkflowsRoot,
} from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { DASHBOARD_HTML } from "../dashboard.generated.js";
import { loadWorkflowScript } from "../loader.js";
import { SKILL_MD } from "../skill.generated.js";
import { GENERATE_WORKFLOW_SOURCE, PATTERNS_DIGEST } from "../workflows/generate-workflow.js";
import { ClaudeRunSource } from "./claude-run-source.js";
import {
  ChatStore,
  type ChatMessage,
  type ChatSessionRecord,
  type ChatSessionState,
  type ChatToolCall,
} from "./chat-store.js";
import { startRun, startRunFromSource } from "./launcher.js";
import { OdwRunSource } from "./odw-run-source.js";
import type { RunSource } from "./run-source.js";
import { RunStore } from "./run-store.js";
import type { RunDisplayState, RunSummary } from "./runs-view.js";
import { listWorkflowSummaries, workflowDetail } from "./workflows-view.js";
import { isValidWorkflowName } from "../workflows/resolve.js";

export interface ServeOptions {
  store: RunStore;
  port?: number;
  host?: string;
  /** Anchors the project-local `.odw/workflows` lookup for /api/workflows. */
  cwd?: string;
  /** Config whose `workflowsRoot` is the global managed dir. Defaults to loadConfig(null). */
  config?: Config;
  /** Path of the config file behind `config`, forwarded to launched runs so a
   *  worker loads the SAME adapters/settings the server validated against. */
  configPath?: string | null;
  /** Root of Claude Code's per-project run store. Defaults to `~/.claude/projects`. */
  claudeProjectsRoot?: string | null;
  /** Which Claude runs to surface: "all" projects (default) or just the served repo + worktrees. */
  claudeJobsScope?: "all" | "project";
  /** Test seam for Chat Host's Codex-backed assistant stream. Defaults to `codex exec`. */
  chatRunner?: ChatTurnRunner;
}

export interface ServeHandle {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface ChatTurnRequest {
  session: ChatSessionRecord;
  prompt: string;
  cwd: string;
}

export type ChatTurnRunner = (req: ChatTurnRequest, onChunk: (chunk: string) => void) => Promise<void>;

const DEFAULT_PORT = 4317;
const DEFAULT_HOST = "127.0.0.1";
const RUN_ID = /^[A-Za-z0-9._-]+$/;
const CONTROL_ACTIONS = new Set(["pause", "resume", "stop"]);
/** Body cap for write endpoints; inline scripts are the largest legitimate payload. */
const MAX_BODY_BYTES = 512 * 1024;

const CHAT_HOST_WORKFLOW_NAME = "chat-host-bridge";
const CHAT_HOST_WORKFLOW_SOURCE = `
export const meta = {
  name: "${CHAT_HOST_WORKFLOW_NAME}",
  description: "Run a local Chat Host task asynchronously and return its answer.",
  phases: [{ title: "Capture" }, { title: "Execute" }, { title: "Return" }],
}

phase("Capture")
log("Captured a local Chat Host turn.")
const task = typeof args?.prompt === "string" ? args.prompt.trim() : ""
if (!task) throw new Error("chat-host-bridge needs args.prompt")

phase("Execute")
const answer = await agent([
  "You are executing an asynchronous Open Dynamic Workflows task requested from the Chat Host UI.",
  "Complete the user's request as the primary deliverable.",
  "Return the final answer only. Do not describe internal ODW plumbing unless it is directly relevant.",
  "Prefer the user's language. Include concise source links or citations when the task depends on external facts.",
  "",
  "User request:",
  task,
].join("\\n"), { label: "chat-task" })

phase("Return")
return answer
`;

const TERMINAL_RUN_STATES = new Set<RunDisplayState>(["done", "failed", "stopped"]);

const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_HOST_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Whether the server was bound to a loopback address (the default). */
function isLoopbackBind(host: string): boolean {
  return LOOPBACK_BINDS.has(host);
}

/** The hostname part of a Host header, with any port stripped ([::1]:p safe). */
function hostHeaderName(header: string): string {
  const h = header.trim();
  if (h.startsWith("[")) return h.replace(/\]:\d+$/, "]"); // [::1]:4317 → [::1]
  return h.replace(/:\d+$/, "");
}

/**
 * The write-path gate shared by every POST (launch.md §3.5). Returns true when
 * the request may proceed; otherwise the response has been written.
 */
function writeGuard(req: IncomingMessage, res: ServerResponse, boundHost: string): boolean {
  if (!isLoopbackBind(boundHost)) {
    sendJson(res, 409, { error: "writes are loopback-only; token auth is a future opt-in" });
    return false;
  }
  // Compare the MIME *essence* (type/subtype before any ";" parameters), not a
  // substring: `text/plain; x=application/json` is a CORS "simple request" and
  // must NOT pass, while `application/json; charset=utf-8` must.
  const essence = String(req.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (essence !== "application/json") {
    sendJson(res, 415, { error: "write requests require Content-Type: application/json" });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      sendJson(res, 403, { error: "cross-origin write requests are rejected" });
      return false;
    }
  }
  return true;
}

/**
 * Read and JSON-parse a request body. Resolves `undefined` on invalid/empty
 * JSON OR when the body exceeds {@link MAX_BODY_BYTES} (the caller turns that
 * into a 400). Settling exactly once is guaranteed even on `destroy()`, whose
 * abort emits neither `end` nor `error` — a `close` listener catches it, so the
 * awaiting handler never hangs and the oversized buffer is dropped.
 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolvePromise) => {
    let body = "";
    let settled = false;
    const settle = (value: Record<string, unknown> | undefined): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        settle(undefined); // too large → caller responds 400; stop buffering
        req.destroy();
      }
    });
    req.on("error", () => settle(undefined));
    req.on("close", () => settle(undefined)); // covers destroy() with no error
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}") as unknown;
        settle(
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined,
        );
      } catch {
        settle(undefined);
      }
    });
  });
}

/** Every source's summaries, merged and sorted newest-first (the unified run list). */
function allSummaries(sources: RunSource[]): RunSummary[] {
  return sources.flatMap((s) => s.listSummaries()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** The source that owns + has this run, or null. Ids are disjoint, so at most one matches. */
function sourceForRun(sources: RunSource[], runId: string): RunSource | null {
  return sources.find((s) => s.owns(runId) && s.exists(runId)) ?? null;
}

/** Start the dashboard server. Resolves once it is listening. */
export function startServer(options: ServeOptions): Promise<ServeHandle> {
  const { store } = options;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? loadConfig(null);
  const configPath = options.configPath ?? null;
  const sources: RunSource[] = [
    new OdwRunSource(store),
    // Default scope "all": the observatory aggregates every project's Claude runs,
    // mirroring how the global runs root already aggregates ODW runs. The scope can
    // be narrowed to the served repo + its worktrees via claudeJobsScope.
    new ClaudeRunSource({
      projectsRoot: options.claudeProjectsRoot ?? resolveClaudeProjectsRoot(),
      cwd,
      scope: options.claudeJobsScope ?? config.settings.claudeJobsScope,
    }),
  ];
  const chat = new ChatStore(store.root, cwd);
  const clients = new Set<ServerResponse>();
  const chatRuntime = createChatRuntime(options.chatRunner, (sessionId) => broadcastChat(clients, sessionId));

  const server = createServer((req, res) => {
    handle(req, res, { sources, store, chat, chatRuntime, clients, cwd, config, configPath, boundHost: host }).catch((err) => {
      try {
        sendJson(res, 500, { error: (err as Error).message ?? "internal error" });
      } catch {
        /* response already gone */
      }
    });
  });

  // Push the run list to every SSE client when the runs root changes, and on a
  // 1s tick as a floor (fs.watch recursion is platform-spotty; the tick keeps
  // liveness correct everywhere without hammering — folding is cache-gated).
  let watcher: FSWatcher | null = null;
  let lastSig = "";
  const broadcast = (force = false) => {
    syncCompletedChatRuns(chat, sources, chatRuntime);
    if (clients.size === 0) return;
    const runs = allSummaries(sources);
    const sig = JSON.stringify(runs.map((r) => [r.runId, r.state, r.counts, r.progress]));
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const frame = `event: runs\ndata: ${JSON.stringify(runs)}\n\n`;
    for (const c of clients) safeWrite(c, frame, clients);
  };
  const tick = setInterval(() => broadcast(false), 1000);
  tick.unref?.();
  try {
    watcher = watch(store.root, { recursive: true }, () => broadcast(false));
  } catch {
    watcher = null; // no recursive watch on this platform — the 1s tick covers us
  }

  return new Promise<ServeHandle>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`port ${port} is already in use — try \`odw serve --port <n>\``));
      } else {
        reject(err);
      }
    });
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
      resolve({
        url: `http://${shown}:${boundPort}`,
        port: boundPort,
        host,
        close: () => closeServer(server, clients, tick, watcher),
      });
    });
  });
}

function closeServer(
  server: Server,
  clients: Set<ServerResponse>,
  tick: NodeJS.Timeout,
  watcher: FSWatcher | null,
): Promise<void> {
  clearInterval(tick);
  watcher?.close();
  for (const c of clients) c.end();
  clients.clear();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

interface HandleContext {
  sources: RunSource[];
  store: RunStore;
  chat: ChatStore;
  chatRuntime: ChatRuntime;
  clients: Set<ServerResponse>;
  cwd: string;
  config: Config;
  configPath: string | null;
  /** The address the server was bound to (drives the write/Host policy). */
  boundHost: string;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandleContext): Promise<void> {
  const { sources, store, chat, chatRuntime, clients, cwd, config, configPath, boundHost } = ctx;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    // DNS-rebinding guard: on a loopback bind, a browser reaching this server
    // through a hostile DNS name carries that name in Host — refuse it outright
    // (reads too: the run list is sensitive). Off-loopback binds are explicit
    // opt-ins to remote reads, so the allowlist does not apply there.
    if (isLoopbackBind(boundHost)) {
      const header = req.headers.host;
      if (header && !LOOPBACK_HOST_NAMES.has(hostHeaderName(header))) {
        sendJson(res, 403, { error: `unexpected Host '${header}' — refusing (DNS rebinding guard)` });
        return;
      }
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (method === "GET" && path === "/api/runs") {
      sendJson(res, 200, allSummaries(sources));
      return;
    }
    if (method === "GET" && path === "/api/stream") {
      openStream(res, sources, clients);
      return;
    }
    if (method === "GET" && path === "/api/adapters") {
      sendJson(res, 200, listAdapters(config));
      return;
    }
    if (method === "GET" && path === "/api/capabilities") {
      // The SPA hides write affordances (Launch form, Run/Save/Stop) when writes
      // are refused, so a remotely-viewed off-loopback dashboard shows no dead
      // buttons. Mirrors the writeGuard's loopback-only rule exactly.
      sendJson(res, 200, { writable: isLoopbackBind(boundHost) });
      return;
    }
    if (method === "GET" && path === "/api/settings") {
      sendJson(res, 200, settingsView(store, config, cwd, configPath, boundHost));
      return;
    }
    if (method === "GET" && path === "/api/chat/sessions") {
      syncCompletedChatRuns(chat, sources, chatRuntime);
      sendJson(
        res,
        200,
        chat.list().map((s) => hydrateChatSummary(s, chat.get(s.id), sources)),
      );
      return;
    }
    if (method === "POST" && path === "/api/chat/sessions") {
      if (!writeGuard(req, res, boundHost)) return;
      await postChatSession(req, res, chat, sources, cwd);
      return;
    }
    const chatMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)(\/messages)?$/);
    if (chatMatch) {
      const sessionId = decodeURIComponent(chatMatch[1]!);
      const sub = chatMatch[2];
      if (method === "GET" && !sub) {
        syncCompletedChatRuns(chat, sources, chatRuntime);
        const session = chat.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: `no such chat session: ${sessionId}` });
          return;
        }
        sendJson(res, 200, hydrateChatSession(session, sources));
        return;
      }
      if (method === "DELETE" && !sub) {
        if (!writeGuard(req, res, boundHost)) return;
        await deleteChatSession(req, res, chat, sessionId);
        return;
      }
      if (method === "POST" && sub === "/messages") {
        if (!writeGuard(req, res, boundHost)) return;
        await postChatMessage(req, res, chat, chatRuntime, sources, store, config, configPath, sessionId);
        return;
      }
    }
    if (method === "POST" && path === "/api/generate") {
      if (!writeGuard(req, res, boundHost)) return;
      await postGenerate(req, res, store, config, configPath, cwd);
      return;
    }
    if (method === "POST" && path === "/api/runs") {
      if (!writeGuard(req, res, boundHost)) return;
      await postRuns(req, res, store, config, configPath, cwd);
      return;
    }
    if (method === "POST" && path === "/api/workflows") {
      if (!writeGuard(req, res, boundHost)) return;
      await postWorkflows(req, res, store, config, cwd);
      return;
    }
    if (method === "GET" && path === "/api/workflows") {
      sendJson(res, 200, listWorkflowSummaries(cwd, config, store));
      return;
    }
    const wfMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
    if (method === "GET" && wfMatch) {
      const name = decodeURIComponent(wfMatch[1]!);
      // Optional ?provider= disambiguates a cross-provider name collision (so a
      // shadowed Claude workflow's source is reachable); ignored if not odw|claude.
      const p = url.searchParams.get("provider");
      const provider = p === "odw" || p === "claude" ? p : undefined;
      const det = workflowDetail(cwd, config, store, name, provider);
      if (!det) {
        sendJson(res, 404, { error: `no such workflow: ${name}` });
        return;
      }
      sendJson(res, 200, det);
      return;
    }

    const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/events|\/control|\/result)?$/);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]!);
      const sub = runMatch[2];
      // Writes are gated before any run lookup: an off-loopback bind refuses
      // outright (no run-existence oracle), and CSRF posture comes first.
      if (method === "POST" && sub === "/control" && !writeGuard(req, res, boundHost)) return;
      // Route to the source that owns this id (ODW's RunStore, or Claude Code's).
      const src = RUN_ID.test(runId) ? sourceForRun(sources, runId) : null;
      if (!src) {
        sendJson(res, 404, { error: `no such run: ${runId}` });
        return;
      }
      if (method === "GET" && !sub) {
        const det = src.detail(runId);
        if (!det) {
          sendJson(res, 404, { error: `no such run: ${runId}` });
          return;
        }
        sendJson(res, 200, det);
        return;
      }
      if (method === "GET" && sub === "/events") {
        const since = Number(url.searchParams.get("since") ?? "0") || 0;
        sendJson(res, 200, src.events(runId, since));
        return;
      }
      if (method === "GET" && sub === "/result") {
        const { has, value } = src.result(runId);
        if (!has) {
          sendJson(res, 404, { error: "no result for this run" });
          return;
        }
        sendJson(res, 200, { value });
        return;
      }
      if (method === "POST" && sub === "/control") {
        // A read-only source (Claude) refuses control with a 409 before any work.
        if (src.controlError) {
          sendJson(res, 409, { error: src.controlError });
          return;
        }
        await controlRun(req, res, src, runId);
        return;
      }
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message ?? "internal error" });
  }
}

// --- settings + chat host endpoints ------------------------------------------

function settingsView(
  store: RunStore,
  config: Config,
  cwd: string,
  configPath: string | null,
  boundHost: string,
): Record<string, unknown> {
  return {
    cwd,
    configPath,
    runsRoot: store.root,
    writable: isLoopbackBind(boundHost),
    claudeJobsScope: config.settings.claudeJobsScope,
    adapters: listAdapters(config).map((a) => ({
      ...a,
      command: config.adapters[a.name]?.command.join(" ") ?? "",
    })),
    workflowRoots: [
      { provider: "odw", scope: "project", label: ".odw/workflows", path: join(cwd, ".odw", "workflows") },
      { provider: "claude", scope: "project", label: ".claude/workflows", path: join(cwd, ".claude", "workflows") },
      {
        provider: "odw",
        scope: "global",
        label: "~/.odw/workflows",
        path: resolveWorkflowsRoot(config.settings.workflowsRoot),
      },
      {
        provider: "claude",
        scope: "global",
        label: "~/.claude/workflows",
        path: resolveClaudeWorkflowsRoot(config.settings.claudeWorkflowsRoot),
      },
    ],
  };
}

const ODW_INTENT_RE = /\bodw\b|workflow|agent|fan[- ]?out|并行|工作流|智能体/i;
const NEGATED_ODW_RE = [
  /(?:不|别|不要|无需|不用|禁止).{0,12}(?:触发|启动|运行|创建|发起|调用)?\s*(?:odw|workflow|agent|fan[- ]?out|工作流|智能体)/i,
  /(?:不触发|不要触发|无需触发|不用触发|别触发)\s*(?:odw|workflow|agent|fan[- ]?out|工作流|智能体)/i,
  /(?:do not|don't|dont|without|avoid|skip|no need to|no)\s+(?:trigger|start|run|create|launch|call)?\s*(?:odw|workflow|agent|fan[- ]?out)/i,
  /(?:odw|workflow|agent|fan[- ]?out|工作流|智能体).{0,16}(?:不触发|不要|不用|无需|别|without|do not|don't|dont|avoid|skip)/i,
];

function wantsOdw(text: string): boolean {
  if (!ODW_INTENT_RE.test(text)) return false;
  return !NEGATED_ODW_RE.some((re) => re.test(text));
}

interface ChatRuntime {
  runner: ChatTurnRunner;
  activeSessions: Set<string>;
  serverStartedAt: number;
  notify(sessionId: string): void;
}

function createChatRuntime(runner?: ChatTurnRunner, notify?: (sessionId: string) => void): ChatRuntime {
  return {
    runner: runner ?? createDefaultChatRunner(),
    activeSessions: new Set(),
    serverStartedAt: Math.floor(Date.now() / 1000),
    notify: notify ?? (() => {}),
  };
}

function createDefaultChatRunner(): ChatTurnRunner {
  return ({ prompt, cwd }, onChunk) =>
    new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--cd",
          cwd,
          "--color",
          "never",
          "-",
        ],
        { cwd, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => onChunk(stripAnsi(String(chunk))));
      child.stderr.on("data", (chunk) => {
        stderr += stripAnsi(String(chunk));
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        const tail = stderr.trim().slice(-1600);
        reject(new Error(`codex exited with ${code ?? signal ?? "unknown"}${tail ? `: ${tail}` : ""}`));
      });
      child.stdin.end(prompt);
    });
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function hasStreamingAssistant(session: ChatSessionRecord): boolean {
  return session.messages.some((m) => m.role === "assistant" && m.status === "streaming");
}

function existingDir(path: string): string | null {
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

function chatWorkingDir(session: ChatSessionRecord, fallback: string): string {
  return existingDir(session.source) ?? existingDir(fallback) ?? scratchSourceDir();
}

function formatTranscriptMessage(message: ChatMessage): string | null {
  if (message.kind === "chat.ready") return null;
  if (message.role === "tool") {
    const tool = message.tool;
    if (!tool) return `Tool: ${message.text}`;
    const result = tool.result ? `\nTool result:\n${tool.result}` : "";
    return `Tool ${tool.name} (${tool.status}) ${tool.workflow} ${tool.runId}: ${message.text}${result}`;
  }
  const who = message.role === "user" ? "User" : "Assistant";
  if (!message.text.trim() && message.status === "streaming") return null;
  return `${who}: ${message.text}`;
}

function buildCodexChatPrompt(session: ChatSessionRecord, assistantMessageId: string): string {
  const transcript = session.messages
    .filter((m) => m.id !== assistantMessageId)
    .map(formatTranscriptMessage)
    .filter((m): m is string => m !== null)
    .slice(-24)
    .join("\n\n");
  return [
    "You are Codex replying inside the Open Dynamic Workflows Chat Host UI.",
    "Answer the latest user message directly and naturally. Prefer the user's language.",
    "This is a hosted conversation; use the transcript for context.",
    "When the transcript contains an ODW run completion user message, continue from that result.",
    "Do not modify files unless the user explicitly asks for code changes in this chat.",
    "",
    "Conversation transcript:",
    transcript || "(empty)",
    "",
    "Return only the next assistant message.",
  ].join("\n");
}

function startChatCodexTurn(
  chat: ChatStore,
  sessionId: string,
  runtime: ChatRuntime,
  fallbackCwd: string,
): ChatSessionRecord | null {
  const current = chat.get(sessionId);
  if (!current || hasStreamingAssistant(current) || runtime.activeSessions.has(sessionId)) return current;
  const withPlaceholder = chat.appendAssistantMessage(sessionId, "", undefined, "streaming");
  runtime.notify(sessionId);
  const placeholder = withPlaceholder.messages[withPlaceholder.messages.length - 1]!;
  const prompt = buildCodexChatPrompt(withPlaceholder, placeholder.id);
  const cwd = chatWorkingDir(withPlaceholder, fallbackCwd);
  let text = "";
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = () => {
    flushTimer = null;
    chat.updateMessage(sessionId, placeholder.id, { text });
    runtime.notify(sessionId);
  };
  const queueFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 80);
    flushTimer.unref?.();
  };

  runtime.activeSessions.add(sessionId);
  void Promise.resolve()
    .then(() =>
      runtime.runner({ session: withPlaceholder, prompt, cwd }, (chunk) => {
        if (!chunk) return;
        text += chunk;
        queueFlush();
      }),
    )
    .then(() => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const finalText = text.trimEnd() || "Codex finished without producing text.";
      chat.updateMessage(sessionId, placeholder.id, { text: finalText, status: "done" });
      runtime.notify(sessionId);
    })
    .catch((err) => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const existing = text.trimEnd();
      const errorText = `Codex stream failed: ${(err as Error).message ?? String(err)}`;
      chat.updateMessage(sessionId, placeholder.id, {
        text: existing ? `${existing}\n\n${errorText}` : errorText,
        status: "failed",
      });
      runtime.notify(sessionId);
    })
    .finally(() => {
      runtime.activeSessions.delete(sessionId);
    });
  return chat.get(sessionId);
}

function chatStateFrom(states: RunDisplayState[], fallback: ChatSessionState): ChatSessionState {
  if (states.some((s) => s === "pending" || s === "running" || s === "paused" || s === "stale")) return "running";
  if (states.length > 0 && states.every((s) => s === "done" || s === "failed" || s === "stopped")) return "done";
  return fallback;
}

function toolStatus(state: RunDisplayState | undefined): ChatToolCall["status"] {
  if (state === "failed" || state === "stopped") return "failed";
  if (state === "stale") return "stale";
  if (state === "done") return "done";
  return "running";
}

function displayProgress(state: RunDisplayState | undefined, progress: number | undefined): number {
  const p = typeof progress === "number" && Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
  if (state === "done" || state === "failed" || state === "stopped") return Math.max(p, 1);
  return p;
}

function eventLabel(ev: Record<string, unknown>): string {
  if (typeof ev.label === "string") return ev.label;
  if (typeof ev.phase === "string") return ev.phase;
  if (typeof ev.message === "string") return ev.message;
  return String(ev.type ?? "event");
}

function resultText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasRunResultMessage(session: ChatSessionRecord, runId: string): boolean {
  return session.messages.some((m) => m.kind === "chat.odw_result" && m.text.includes(runId));
}

function syncCompletedChatRuns(chat: ChatStore, sources: RunSource[], runtime: ChatRuntime): void {
  for (const session of chat.records()) {
    if (hasStreamingAssistant(session) || runtime.activeSessions.has(session.id)) continue;
    for (const link of session.linkedRuns) {
      if (hasRunResultMessage(session, link.runId)) continue;
      const src = RUN_ID.test(link.runId) ? sourceForRun(sources, link.runId) : null;
      const detail = src?.detail(link.runId) ?? null;
      if (!detail || !TERMINAL_RUN_STATES.has(detail.state)) continue;
      if ((detail.createdAt ?? 0) < runtime.serverStartedAt) continue;
      const result = src?.result(link.runId);
      const value = result?.has ? resultText(result.value) : undefined;
      const title = detail.workflowName ?? detail.name ?? link.workflow;
      const text = [
        `ODW run ${link.runId} (${title}) finished with state "${detail.state}".`,
        value ? `Result:\n${value}` : "",
        detail.error ? `Error:\n${resultText(detail.error)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      chat.appendUserMessage(session.id, text, "chat.odw_result");
      startChatCodexTurn(chat, session.id, runtime, session.source);
      break;
    }
  }
}

function hydrateTool(tool: ChatToolCall, sources: RunSource[]): ChatToolCall {
  const src = RUN_ID.test(tool.runId) ? sourceForRun(sources, tool.runId) : null;
  if (!src) return tool;
  const detail = src.detail(tool.runId);
  if (!detail) return tool;
  const events = src.events(tool.runId, 0);
  const lastPhase =
    [...events]
      .reverse()
      .map((ev) => (typeof ev.phase === "string" ? ev.phase : null))
      .find((phase): phase is string => phase !== null) ??
    detail.phaseOrder[detail.phaseOrder.length - 1] ??
    detail.state;
  const result = src.result(tool.runId);
  return {
    ...tool,
    status: toolStatus(detail.state),
    workflow: detail.workflowName ?? detail.name ?? tool.workflow,
    progress: displayProgress(detail.state, detail.progress),
    phase: lastPhase,
    events: events.slice(-8).map((ev) => ({
      type: ev.type,
      label: eventLabel(ev),
      ts: ev.ts,
    })),
    ...(result.has ? { result: resultText(result.value) } : {}),
  };
}

function hydrateChatSession(session: ChatSessionRecord, sources: RunSource[]): Record<string, unknown> {
  const linkedRuns = session.linkedRuns.map((link) => {
    const src = RUN_ID.test(link.runId) ? sourceForRun(sources, link.runId) : null;
    const detail = src?.detail(link.runId) ?? null;
    return {
      runId: link.runId,
      workflow: detail?.workflowName ?? detail?.name ?? link.workflow,
      state: detail?.state ?? "stale",
      progress: displayProgress(detail?.state, detail?.progress),
    };
  });
  const messages = session.messages.map((message): ChatMessage => {
    if (!message.tool) return message;
    return { ...message, tool: hydrateTool(message.tool, sources) };
  });
  const messageStreaming = messages.some((m) => m.role === "assistant" && m.status === "streaming");
  return {
    ...session,
    state: messageStreaming
      ? "running"
      : chatStateFrom(
          linkedRuns.map((r) => r.state as RunDisplayState),
          session.state,
        ),
    linkedRuns,
    messages,
  };
}

function hydrateChatSummary(
  summary: ReturnType<ChatStore["list"]>[number],
  session: ChatSessionRecord | null,
  sources: RunSource[],
): Record<string, unknown> {
  if (!session) return { ...summary };
  const view = hydrateChatSession(session, sources) as {
    state: ChatSessionState;
    linkedRuns: Array<Record<string, unknown>>;
  };
  return { ...summary, state: view.state, linkedRuns: view.linkedRuns.length };
}

async function postChatSession(
  req: IncomingMessage,
  res: ServerResponse,
  chat: ChatStore,
  sources: RunSource[],
  cwd: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : cwd;
  const session = chat.create(source);
  sendJson(res, 200, hydrateChatSession(session, sources));
}

async function deleteChatSession(
  req: IncomingMessage,
  res: ServerResponse,
  chat: ChatStore,
  sessionId: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  if (!chat.delete(sessionId)) {
    sendJson(res, 404, { error: `no such chat session: ${sessionId}` });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function postChatMessage(
  req: IncomingMessage,
  res: ServerResponse,
  chat: ChatStore,
  chatRuntime: ChatRuntime,
  sources: RunSource[],
  store: RunStore,
  config: Config,
  configPath: string | null,
  sessionId: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    sendJson(res, 400, { error: "text must be a non-empty string" });
    return;
  }
  const existing = chat.get(sessionId);
  if (!existing) {
    sendJson(res, 404, { error: `no such chat session: ${sessionId}` });
    return;
  }
  if (hasStreamingAssistant(existing) || chatRuntime.activeSessions.has(sessionId)) {
    sendJson(res, 409, { error: "Codex is still responding in this chat session" });
    return;
  }
  chat.appendUserMessage(sessionId, text);
  if (wantsOdw(text)) {
    const launchBody = {
      adapter: typeof body.adapter === "string" ? body.adapter : undefined,
      source: typeof body.source === "string" && body.source ? body.source : existing.source,
    };
    const checked = checkLaunchInputs(res, config, launchBody);
    if (!checked) return;
    const { runId } = startRunFromSource(CHAT_HOST_WORKFLOW_SOURCE, {
      args: { prompt: text, sessionId },
      adapter: checked.adapter,
      source: checked.source,
      runsRoot: store.root,
      configPath,
      origin: "chat",
    });
    chat.appendToolRun(sessionId, runId, CHAT_HOST_WORKFLOW_NAME);
  } else {
    startChatCodexTurn(chat, sessionId, chatRuntime, existing.source);
  }
  const updated = chat.get(sessionId);
  if (!updated) {
    sendJson(res, 404, { error: `no such chat session: ${sessionId}` });
    return;
  }
  sendJson(res, 200, hydrateChatSession(updated, sources));
}

// --- write endpoints (launch.md §3.1) ------------------------------------------

/**
 * A stable, empty, copy-safe scratch directory used when a GUI launch names no
 * source. The serve process's cwd is NOT a safe default: when the desktop app
 * spawns the sidecar, that cwd is `/`, and copy-mode workspace isolation cannot
 * copy `/` into its own temp subdirectory (ERR_FS_CP_EINVAL). An empty scratch
 * dir copies instantly and lets generic workflows (those that don't read the
 * user's files) run; a workflow that must see project files needs an explicit
 * source, which is the correct requirement.
 */
function scratchSourceDir(): string {
  const dir = join(tmpdir(), "odw-launch-scratch");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Shared adapter/source validation for the two launch endpoints. */
function checkLaunchInputs(
  res: ServerResponse,
  config: Config,
  body: Record<string, unknown>,
): { adapter: string | null; source: string } | null {
  const adapter = typeof body.adapter === "string" && body.adapter ? body.adapter : null;
  if (adapter) {
    const known = listAdapters(config).find((a) => a.name === adapter);
    if (!known) {
      sendJson(res, 400, {
        error: `unknown adapter '${adapter}'; available: ${Object.keys(config.adapters).sort().join(", ")}`,
      });
      return null;
    }
    // A configured-but-not-installed adapter would spawn-ENOENT at the first
    // dispatch — fail here with an actionable message instead of a dead run.
    if (!known.installed) {
      sendJson(res, 400, {
        error: `adapter '${adapter}' is configured but its CLI was not found on PATH`,
      });
      return null;
    }
  }
  // An explicit source must exist; an empty one falls back to the scratch dir
  // (NOT the serve cwd, which is `/` under the desktop app).
  if (typeof body.source === "string" && body.source) {
    let isDir = false;
    try {
      isDir = statSync(body.source).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      sendJson(res, 400, { error: `source directory does not exist: ${body.source}` });
      return null;
    }
    return { adapter, source: body.source };
  }
  return { adapter, source: scratchSourceDir() };
}

/** POST /api/generate — start a generation run of the built-in generate-workflow. */
async function postGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  store: RunStore,
  config: Config,
  configPath: string | null,
  cwd: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const task = typeof body.task === "string" ? body.task.trim() : "";
  if (!task) {
    sendJson(res, 400, { error: "task must be a non-empty string" });
    return;
  }
  const checked = checkLaunchInputs(res, config, body);
  if (!checked) return;
  const { runId } = startRunFromSource(GENERATE_WORKFLOW_SOURCE, {
    args: { task, dialectDoc: SKILL_MD, patternsDigest: PATTERNS_DIGEST },
    adapter: checked.adapter,
    source: checked.source,
    runsRoot: store.root,
    configPath,
    origin: "launch",
  });
  sendJson(res, 200, { runId });
}

/** POST /api/runs — start a run from inline source or a managed-directory name. */
async function postRuns(
  req: IncomingMessage,
  res: ServerResponse,
  store: RunStore,
  config: Config,
  configPath: string | null,
  cwd: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const script = typeof body.script === "string" && body.script ? body.script : null;
  const name = typeof body.name === "string" && body.name ? body.name : null;
  if ((script === null) === (name === null)) {
    sendJson(res, 400, { error: "provide exactly one of 'script' (inline source) or 'name'" });
    return;
  }
  const checked = checkLaunchInputs(res, config, body);
  if (!checked) return;
  // Never hand a known-bad script to a worker: compile first, 400 with the error.
  if (script) {
    try {
      loadWorkflowScript(script, "workflow.js");
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return;
    }
  }
  try {
    const common = {
      args: body.args,
      adapter: checked.adapter,
      source: checked.source,
      runsRoot: store.root,
      configPath,
      origin: "launch",
    };
    const { runId } = script
      ? startRunFromSource(script, common)
      : startRun(name!, common);
    sendJson(res, 200, { runId });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    sendJson(res, /no workflow named/.test(message) ? 404 : 400, { error: message });
  }
}

/** POST /api/workflows — save a script into a managed directory (D4: collect). */
async function postWorkflows(
  req: IncomingMessage,
  res: ServerResponse,
  store: RunStore,
  config: Config,
  cwd: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  // Accept a user-typed filename ("review.js") as the name "review": the run-by-
  // name resolver keys on the stem, so saving the extension would create
  // "review.js.js" that `odw run review` could never find.
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  const name = rawName.replace(/\.(?:js|mjs|cjs)$/i, "");
  if (!isValidWorkflowName(name)) {
    sendJson(res, 400, { error: "name must use only letters, digits, '.', '_' or '-'" });
    return;
  }
  // The script content comes inline ('source') or from an existing run's
  // archived script ('fromRun') — the Save-to-Workspace path, where the browser
  // has the run id but not the file content.
  let source = typeof body.source === "string" ? body.source : "";
  if (!source && typeof body.fromRun === "string" && body.fromRun) {
    const runId = body.fromRun;
    if (!RUN_ID.test(runId) || !store.exists(runId)) {
      sendJson(res, 404, { error: `no such run: ${runId}` });
      return;
    }
    const script = store.readMeta(runId).script as string | undefined;
    try {
      source = script ? readFileSync(script, "utf8") : "";
    } catch {
      source = "";
    }
    if (!source) {
      sendJson(res, 400, { error: "the run has no readable script to save" });
      return;
    }
  }
  try {
    loadWorkflowScript(source, `${name}.js`);
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
    return;
  }
  const scope = body.scope === "project" ? "project" : "global";
  let projectDir = cwd;
  if (scope === "project" && typeof body.projectDir === "string" && body.projectDir) {
    try {
      if (!statSync(body.projectDir).isDirectory()) throw new Error("not a directory");
    } catch {
      sendJson(res, 400, { error: `projectDir does not exist: ${body.projectDir}` });
      return;
    }
    projectDir = body.projectDir;
  }
  const dir =
    scope === "project"
      ? join(projectDir, ".odw", "workflows")
      : resolveWorkflowsRoot(config.settings.workflowsRoot);
  const target = join(dir, `${name}.js`);
  if (existsSync(target)) {
    sendJson(res, 409, { error: `a workflow named '${name}' already exists at ${target}` });
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, source, "utf8");
  sendJson(res, 200, { path: target });
}

function openStream(
  res: ServerResponse,
  sources: RunSource[],
  clients: Set<ServerResponse>,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  clients.add(res);
  // Heartbeat so proxies/clients don't time the idle connection out.
  const beat = setInterval(() => safeWrite(res, ": ping\n\n", clients), 15000);
  beat.unref?.();
  const cleanup = () => {
    clearInterval(beat);
    clients.delete(res);
  };
  res.on("close", cleanup);
  res.on("error", cleanup); // a socket error must not become an uncaught throw
  safeWrite(res, ": connected\n\n", clients);
  safeWrite(res, `event: runs\ndata: ${JSON.stringify(allSummaries(sources))}\n\n`, clients);
}

function broadcastChat(clients: Set<ServerResponse>, sessionId: string): void {
  if (clients.size === 0) return;
  const frame = `event: chat\ndata: ${JSON.stringify({ sessionId })}\n\n`;
  for (const c of clients) safeWrite(c, frame, clients);
}

/** Write to an SSE client; on failure drop it from the pool. Never throws. */
function safeWrite(res: ServerResponse, data: string, clients: Set<ServerResponse>): void {
  try {
    res.write(data);
  } catch {
    clients.delete(res);
    try {
      res.end();
    } catch {
      /* already torn down */
    }
  }
}

async function controlRun(
  req: IncomingMessage,
  res: ServerResponse,
  src: RunSource,
  runId: string,
): Promise<void> {
  // CSRF posture (Content-Type + same-origin) is enforced by writeGuard upstream.
  const body = await readJsonBody(req);
  const action = body && typeof body.action === "string" ? body.action : undefined;
  if (!action || !CONTROL_ACTIONS.has(action)) {
    sendJson(res, 400, { error: "action must be one of pause, resume, stop" });
    return;
  }
  // The source applies the action (ODW maps resume→"running" for FileControl).
  src.control(runId, action);
  sendJson(res, 200, { ok: true, runId, action });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
