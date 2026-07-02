/**
 * Chat Host mockup.
 *
 * This is intentionally frontend-only for now. It models the product shape of
 * an ODW Chat Host without depending on the future server/session APIs.
 */
import { t } from "../i18n";
import { esc, fmtClock } from "../util";

type ChatRole = "user" | "assistant" | "tool";
type ChatSessionState = "running" | "idle" | "done";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
  tool?: MockToolCall;
}

interface MockToolCall {
  name: "odw.run" | "odw.generate";
  status: "running" | "done";
  workflow: string;
  runId: string;
  progress: number;
  phase: string;
  events: Array<{ type: string; label: string; ts: number }>;
  result?: string;
}

interface MockSession {
  id: string;
  title: string;
  source: string;
  state: ChatSessionState;
  updatedAt: number;
  messages: ChatMessage[];
  linkedRuns: Array<{ runId: string; workflow: string; state: string; progress: number }>;
}

const now = Math.floor(Date.now() / 1000);

let seq = 100;
export let chatDraft = "";
export let activeChatId = "chat-host";

const sessions: MockSession[] = [
  {
    id: "chat-host",
    title: "Codex host orchestration",
    source: "/home/xingzheng/repos/open-dynamic-workflows",
    state: "running",
    updatedAt: now - 22,
    linkedRuns: [
      { runId: "20260702-142910-a81c9d", workflow: "deep-research", state: "running", progress: 0.62 },
      { runId: "20260702-142744-992ad1", workflow: "generate-workflow", state: "done", progress: 1 },
    ],
    messages: [
      {
        id: "m1",
        role: "user",
        ts: now - 280,
        text: "Use Codex as the local agent, but let the outer web host call ODW whenever the task needs fan-out.",
      },
      {
        id: "m2",
        role: "assistant",
        ts: now - 245,
        text: "I can run this as a hosted turn. I will keep the Codex thread alive, request an ODW workflow through the host, then fold the result back into the conversation.",
      },
      {
        id: "m3",
        role: "tool",
        ts: now - 210,
        text: "ODW run requested by Codex.",
        tool: {
          name: "odw.run",
          status: "running",
          workflow: "deep-research",
          runId: "20260702-142910-a81c9d",
          progress: 0.62,
          phase: "Verify",
          events: [
            { type: "run_started", label: "run started", ts: now - 210 },
            { type: "phase_started", label: "Research", ts: now - 192 },
            { type: "agent_finished", label: "source-map", ts: now - 121 },
            { type: "phase_started", label: "Verify", ts: now - 54 },
          ],
        },
      },
      {
        id: "m4",
        role: "assistant",
        ts: now - 34,
        text: "The host is streaming ODW events into this session. Once the run completes, the tool result will be attached to this turn and Codex can produce the final answer.",
      },
    ],
  },
  {
    id: "review-loop",
    title: "Review loop prototype",
    source: "/tmp/odw-scratch",
    state: "idle",
    updatedAt: now - 920,
    linkedRuns: [{ runId: "20260702-132401-31bbf4", workflow: "codex-claude-loop", state: "done", progress: 1 }],
    messages: [
      {
        id: "r1",
        role: "user",
        ts: now - 1280,
        text: "Sketch a multi-agent review loop where one agent implements and another verifies.",
      },
      {
        id: "r2",
        role: "tool",
        ts: now - 1120,
        text: "ODW generated and ran a review workflow.",
        tool: {
          name: "odw.generate",
          status: "done",
          workflow: "codex-claude-loop",
          runId: "20260702-132401-31bbf4",
          progress: 1,
          phase: "Complete",
          events: [
            { type: "run_started", label: "run started", ts: now - 1120 },
            { type: "agent_finished", label: "implementer", ts: now - 980 },
            { type: "agent_finished", label: "reviewer", ts: now - 922 },
          ],
          result: "Loop completed with one implementation pass and one verification pass.",
        },
      },
      {
        id: "r3",
        role: "assistant",
        ts: now - 912,
        text: "The run completed. The next version should add explicit approval checkpoints before applying edits.",
      },
    ],
  },
];

export function setChatDraft(value: string): void {
  chatDraft = value;
}

export function selectChatSession(id: string): void {
  if (sessions.some((s) => s.id === id)) activeChatId = id;
}

export function createMockSession(): string {
  const id = `mock-${++seq}`;
  sessions.unshift({
    id,
    title: "Untitled hosted turn",
    source: "/home/xingzheng/repos/open-dynamic-workflows",
    state: "idle",
    updatedAt: Math.floor(Date.now() / 1000),
    linkedRuns: [],
    messages: [
      {
        id: `msg-${++seq}`,
        role: "assistant",
        ts: Math.floor(Date.now() / 1000),
        text: "This is a frontend-only mock session. Send a message to see how a Codex turn and ODW tool card will render.",
      },
    ],
  });
  activeChatId = id;
  chatDraft = "";
  return id;
}

export function sendMockChatMessage(): void {
  const text = chatDraft.trim();
  if (!text) return;
  const session = currentSession();
  const ts = Math.floor(Date.now() / 1000);
  session.messages.push({ id: `msg-${++seq}`, role: "user", text, ts });
  const wantsOdw = /\bodw\b|workflow|agent|fan[- ]?out|并行|工作流/i.test(text);
  if (wantsOdw) {
    const runId = `mock-${ts}-${(++seq).toString(16)}`;
    session.messages.push({
      id: `msg-${++seq}`,
      role: "tool",
      text: "Codex requested an ODW workflow through the host bridge.",
      ts: ts + 1,
      tool: {
        name: "odw.run",
        status: "running",
        workflow: "fan-out-reduce",
        runId,
        progress: 0.36,
        phase: "Draft",
        events: [
          { type: "run_started", label: "run started", ts: ts + 1 },
          { type: "phase_started", label: "Draft", ts: ts + 2 },
          { type: "agent_started", label: "draft-1", ts: ts + 3 },
        ],
      },
    });
    session.linkedRuns.unshift({ runId, workflow: "fan-out-reduce", state: "running", progress: 0.36 });
    session.state = "running";
  }
  session.messages.push({
    id: `msg-${++seq}`,
    role: "assistant",
    ts: ts + 2,
    text: wantsOdw
      ? "Mock: the web host captured the ODW request and is streaming the workflow as a tool card. The future server will replace this mock append with real Codex and ODW events."
      : "Mock: this turn stays inside the hosted Codex conversation. No ODW call was requested.",
  });
  session.updatedAt = ts + 2;
  chatDraft = "";
}

function currentSession(): MockSession {
  return sessions.find((s) => s.id === activeChatId) ?? sessions[0]!;
}

function stateBadge(state: ChatSessionState): string {
  const label = state === "running" ? t("running") : state === "done" ? t("done") : t("idle");
  return `<span class="badge ${state === "running" ? "running" : "done"}"><span class="d"></span>${esc(label)}</span>`;
}

function sessionRow(s: MockSession): string {
  const on = s.id === activeChatId ? " on" : "";
  const last = s.messages[s.messages.length - 1]?.text ?? "";
  return (
    `<button class="chat-session${on}" data-chat-session="${esc(s.id)}">` +
    `<span class="chat-session-top"><b>${esc(s.title)}</b>${stateBadge(s.state)}</span>` +
    `<span class="chat-session-msg">${esc(last)}</span>` +
    `<span class="chat-session-meta">${esc(s.source)} · ${fmtClock(s.updatedAt)}</span>` +
    `</button>`
  );
}

function messageHtml(m: ChatMessage): string {
  if (m.role === "tool" && m.tool) return toolCard(m);
  const who = m.role === "user" ? "You" : "Codex";
  return (
    `<div class="chat-msg ${m.role}">` +
    `<div class="chat-avatar">${m.role === "user" ? "U" : "C"}</div>` +
    `<div class="chat-bubble"><div class="chat-msg-head"><b>${who}</b><span>${fmtClock(m.ts)}</span></div>` +
    `<div class="chat-text">${esc(m.text)}</div></div>` +
    `</div>`
  );
}

function toolCard(m: ChatMessage): string {
  const tool = m.tool!;
  const eventRows = tool.events
    .map(
      (e) =>
        `<div class="tool-event"><span>${fmtClock(e.ts)}</span><b>${esc(e.type)}</b><em>${esc(e.label)}</em></div>`,
    )
    .join("");
  const result = tool.result ? `<div class="tool-result">${esc(tool.result)}</div>` : "";
  return (
    `<div class="chat-msg tool">` +
    `<div class="chat-avatar">O</div>` +
    `<div class="tool-card">` +
    `<div class="tool-head"><span class="tool-name">${esc(tool.name)}</span>${stateBadge(tool.status === "running" ? "running" : "done")}</div>` +
    `<div class="tool-title">${esc(tool.workflow)}</div>` +
    `<div class="tool-sub"><span class="mono">${esc(tool.runId)}</span><span>${t("phase")}: ${esc(tool.phase)}</span></div>` +
    `<div class="tool-progress"><i style="width:${Math.round(tool.progress * 100)}%"></i></div>` +
    `<div class="tool-events">${eventRows}</div>` +
    result +
    `</div></div>`
  );
}

function linkedRuns(session: MockSession): string {
  if (session.linkedRuns.length === 0) {
    return `<div class="chat-empty-side">${t("No linked ODW runs yet.")}</div>`;
  }
  return session.linkedRuns
    .map(
      (r) =>
        `<div class="linked-run">` +
        `<div><b>${esc(r.workflow)}</b><span>${esc(r.runId)}</span></div>` +
        `<em>${esc(r.state)}</em>` +
        `<i><u style="width:${Math.round(r.progress * 100)}%"></u></i>` +
        `</div>`,
    )
    .join("");
}

function timeline(session: MockSession): string {
  const rows = [
    ["user_message", "captured in session"],
    ["codex_turn", session.state === "running" ? "streaming mock events" : "idle"],
    ["odw_bridge", session.linkedRuns.length ? `${session.linkedRuns.length} linked run(s)` : "waiting"],
    ["tool_result", session.linkedRuns.some((r) => r.state === "done") ? "available" : "pending"],
  ];
  return rows.map((r) => `<div class="host-step"><b>${r[0]}</b><span>${esc(r[1])}</span></div>`).join("");
}

export function renderChat(): string {
  const session = currentSession();
  return (
    `<div class="chat-page">` +
    `<aside class="chat-list">` +
    `<div class="chat-list-head"><div><h2>${t("Chat Host")}</h2><span>${t("frontend mock")}</span></div>` +
    `<button class="btn secondary sm" data-chat-new="1">${t("+ New")}</button></div>` +
    `<div class="chat-sessions">${sessions.map(sessionRow).join("")}</div>` +
    `</aside>` +
    `<section class="chat-thread">` +
    `<header class="chat-thread-head">` +
    `<div><h1>${esc(session.title)}</h1><p>${esc(session.source)}</p></div>` +
    `<div class="chat-head-tags"><span>Codex host</span><span>ODW bridge</span><span>mock data</span></div>` +
    `</header>` +
    `<div class="chat-messages">${session.messages.map(messageHtml).join("")}</div>` +
    `<footer class="chat-composer">` +
    `<textarea id="chat-input" rows="3" placeholder="${esc(t("Ask Codex. Mention ODW or workflow to render a mocked tool call."))}">${esc(chatDraft)}</textarea>` +
    `<div class="chat-compose-actions"><span>${t("No server calls yet — this is a mock interaction.")}</span>` +
    `<button class="btn primary" data-chat-send="1">${t("Send")}</button></div>` +
    `</footer>` +
    `</section>` +
    `<aside class="chat-side">` +
    `<section><h3>${t("Host activity")}</h3>${timeline(session)}</section>` +
    `<section><h3>${t("Linked ODW runs")}</h3>${linkedRuns(session)}</section>` +
    `<section><h3>${t("Tool contract")}</h3>` +
    `<pre>{\n  "tool": "odw.run",\n  "workflow": "fan-out-reduce",\n  "args": { ... }\n}</pre></section>` +
    `</aside>` +
    `</div>`
  );
}
