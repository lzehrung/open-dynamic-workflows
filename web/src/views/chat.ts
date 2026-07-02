/**
 * Chat Host view.
 *
 * The data comes from the local `/api/chat/*` backend. A hosted turn can attach
 * a real ODW run; the tool card is hydrated from the same run stream as Jobs.
 */
import { t } from "../i18n";
import type {
  ChatMessage,
  ChatSession,
  ChatSessionState,
  ChatSessionSummary,
  ChatToolStatus,
} from "../types";
import { esc, fmtClock } from "../util";

function stateBadge(state: ChatSessionState | ChatToolStatus): string {
  const label =
    state === "running" ? t("running") : state === "done" ? t("done") : state === "idle" ? t("idle") : t(state);
  const cls = state === "running" ? "running" : state === "failed" || state === "stale" ? state : "done";
  return `<span class="badge ${cls}"><span class="d"></span>${esc(label)}</span>`;
}

function sessionRow(s: ChatSessionSummary, activeId: string | null): string {
  const on = s.id === activeId ? " on" : "";
  const last = s.lastMessage || t("No messages yet.");
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
  const who = m.role === "user" ? t("You") : "Codex";
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
    `<div class="tool-head"><span class="tool-name">${esc(tool.name)}</span>${stateBadge(tool.status)}</div>` +
    `<div class="tool-title">${esc(tool.workflow)}</div>` +
    `<div class="tool-sub"><span class="mono">${esc(tool.runId)}</span><span>${t("phase")}: ${esc(tool.phase)}</span></div>` +
    `<div class="tool-progress"><i style="width:${Math.round(tool.progress * 100)}%"></i></div>` +
    `<div class="tool-events">${eventRows || `<div class="tool-event"><em>${t("Waiting for events...")}</em></div>`}</div>` +
    result +
    `</div></div>`
  );
}

function linkedRuns(session: ChatSession): string {
  if (session.linkedRuns.length === 0) {
    return `<div class="chat-empty-side">${t("No linked ODW runs yet.")}</div>`;
  }
  return session.linkedRuns
    .map(
      (r) =>
        `<div class="linked-run" data-run="${esc(r.runId)}">` +
        `<div><b>${esc(r.workflow)}</b><span>${esc(r.runId)}</span></div>` +
        `<em>${esc(t(r.state))}</em>` +
        `<i><u style="width:${Math.round(r.progress * 100)}%"></u></i>` +
        `</div>`,
    )
    .join("");
}

function timeline(session: ChatSession | null): string {
  const linked = session?.linkedRuns.length ?? 0;
  const running = session?.linkedRuns.some(
    (r) => r.state === "running" || r.state === "pending" || r.state === "stale",
  );
  const rows = [
    ["user_message", session ? "stored by local server" : "waiting"],
    ["host_turn", running ? "watching ODW run" : session ? "idle" : "waiting"],
    ["odw_bridge", linked ? `${linked} linked run(s)` : "waiting"],
    ["tool_result", session?.linkedRuns.some((r) => r.state === "done") ? "available" : "pending"],
  ];
  return rows.map((r) => `<div class="host-step"><b>${r[0]}</b><span>${esc(t(r[1]))}</span></div>`).join("");
}

function emptyThread(draft: string): string {
  return (
    `<section class="chat-thread">` +
    `<div class="empty"><div class="gh">${t("No chat sessions yet")}</div><div>${t("Create a hosted turn to start.")}</div></div>` +
    `<footer class="chat-composer">` +
    `<textarea id="chat-input" rows="3" placeholder="${esc(t("Create a session first."))}">${esc(draft)}</textarea>` +
    `<div class="chat-compose-actions"><span>${t("The local backend will store messages and linked runs.")}</span>` +
    `<button class="btn primary disabled">${t("Send")}</button></div>` +
    `</footer>` +
    `</section>`
  );
}

export function renderChat(
  sessions: ChatSessionSummary[] | null,
  session: ChatSession | null,
  draft: string,
  activeId: string | null,
): string {
  const list = sessions ?? [];
  const rows =
    sessions === null
      ? `<div class="chat-empty-side">${t("Loading chat sessions...")}</div>`
      : list.length
        ? list.map((s) => sessionRow(s, activeId)).join("")
        : `<div class="chat-empty-side">${t("No chat sessions yet.")}</div>`;
  const thread = session
    ? `<section class="chat-thread">` +
      `<header class="chat-thread-head">` +
      `<div><h1>${esc(session.title)}</h1><p>${esc(session.source)}</p></div>` +
      `<div class="chat-head-tags"><span>Codex host</span><span>ODW bridge</span><span>${t("live data")}</span></div>` +
      `</header>` +
      `<div class="chat-messages">${session.messages.map(messageHtml).join("")}</div>` +
      `<footer class="chat-composer">` +
      `<textarea id="chat-input" rows="3" placeholder="${esc(t("Ask Codex. Mention ODW or workflow to attach a local run."))}">${esc(draft)}</textarea>` +
      `<div class="chat-compose-actions"><span>${t("Messages are stored by the local backend.")}</span>` +
      `<button class="btn primary" data-chat-send="1">${t("Send")}</button></div>` +
      `</footer>` +
      `</section>`
    : emptyThread(draft);
  return (
    `<div class="chat-page">` +
    `<aside class="chat-list">` +
    `<div class="chat-list-head"><div><h2>${t("Chat Host")}</h2><span>${t("local backend")}</span></div>` +
    `<button class="btn secondary sm" data-chat-new="1">${t("+ New")}</button></div>` +
    `<div class="chat-sessions">${rows}</div>` +
    `</aside>` +
    thread +
    `<aside class="chat-side">` +
    `<section><h3>${t("Host activity")}</h3>${timeline(session)}</section>` +
    `<section><h3>${t("Linked ODW runs")}</h3>${session ? linkedRuns(session) : `<div class="chat-empty-side">${t("No linked ODW runs yet.")}</div>`}</section>` +
    `<section><h3>${t("Tool contract")}</h3>` +
    `<pre>{\n  "tool": "odw.run",\n  "workflow": "${CHAT_HOST_HINT}",\n  "args": { ... }\n}</pre></section>` +
    `</aside>` +
    `</div>`
  );
}

const CHAT_HOST_HINT = "chat-host-bridge";
