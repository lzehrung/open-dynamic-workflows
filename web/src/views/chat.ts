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

interface ChatRenderState {
  creating: boolean;
  sending: boolean;
  error: string;
  missingId: string | null;
  writable: boolean;
}

const SYSTEM_MESSAGES = {
  "chat.ready":
    "This local Chat Host session is ready. Mention ODW or workflow to attach a real ODW run to the turn.",
  "chat.linked":
    "I linked this turn to a local ODW run. The tool card will update from the run stream as it settles.",
  "chat.recorded":
    "I recorded this turn in the local Chat Host. Mention ODW or workflow when you want this conversation to attach a run.",
} as const;

const LEGACY_MESSAGE_KIND = new Map<string, keyof typeof SYSTEM_MESSAGES>(
  Object.entries(SYSTEM_MESSAGES).map(([kind, text]) => [text, kind as keyof typeof SYSTEM_MESSAGES]),
);

const EVENT_LABELS: Record<string, string> = {
  run_started: "Run started",
  run_finished: "Run finished",
  run_failed: "Run failed",
  run_stopped: "Run stopped",
  phase_started: "Phase started",
  agent_started: "Agent started",
  agent_finished: "Agent finished",
  agent_failed: "Agent failed",
  log: "Log",
};

function stateBadge(state: ChatSessionState | ChatToolStatus): string {
  const label =
    state === "running" ? t("running") : state === "done" ? t("done") : state === "idle" ? t("idle") : t(state);
  const cls = state === "running" ? "running" : state === "failed" || state === "stale" ? state : "done";
  return `<span class="badge ${cls}"><span class="d"></span>${esc(label)}</span>`;
}

function messageText(m: ChatMessage): string {
  const kind = m.kind ?? LEGACY_MESSAGE_KIND.get(m.text);
  return kind ? t(SYSTEM_MESSAGES[kind]) : m.text;
}

function eventTypeLabel(type: string): string {
  return t(EVENT_LABELS[type] ?? type);
}

function eventDetailLabel(label: string): string {
  if (label === "run requested") return t("run requested");
  return label;
}

function errorBanner(error: string): string {
  return error ? `<div class="chat-error" role="alert">${esc(t(error))}</div>` : "";
}

function sessionRow(s: ChatSessionSummary, activeId: string | null): string {
  const on = s.id === activeId ? " on" : "";
  const lastKind = LEGACY_MESSAGE_KIND.get(s.lastMessage);
  const last = lastKind ? t(SYSTEM_MESSAGES[lastKind]) : s.lastMessage || t("No messages yet.");
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
  const text = messageText(m);
  return (
    `<div class="chat-msg ${m.role}">` +
    `<div class="chat-avatar">${m.role === "user" ? "U" : "C"}</div>` +
    `<div class="chat-bubble"><div class="chat-msg-head"><b>${who}</b><span>${fmtClock(m.ts)}</span></div>` +
    `<div class="chat-text">${esc(text)}</div></div>` +
    `</div>`
  );
}

function toolCard(m: ChatMessage): string {
  const tool = m.tool!;
  const eventRows = tool.events
    .map(
      (e) =>
        `<div class="tool-event"><span>${fmtClock(e.ts)}</span><b>${esc(eventTypeLabel(e.type))}</b><em>${esc(eventDetailLabel(e.label))}</em></div>`,
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
    [t("User message"), session ? t("stored by local server") : t("waiting")],
    [t("Host turn"), running ? t("watching ODW run") : session ? t("idle") : t("waiting")],
    [t("ODW bridge"), linked ? t("{n} linked runs", { n: linked }) : t("waiting")],
    [t("Tool result"), session?.linkedRuns.some((r) => r.state === "done") ? t("available") : t("pending")],
  ];
  return rows.map((r) => `<div class="host-step"><b>${esc(r[0])}</b><span>${esc(r[1])}</span></div>`).join("");
}

function disabledComposer(draft: string, hint: string, error: string): string {
  return (
    `<footer class="chat-composer">` +
    errorBanner(error) +
    `<textarea id="chat-input" rows="3" placeholder="${esc(t("Create a session first."))}" disabled>${esc(draft)}</textarea>` +
    `<div class="chat-compose-actions"><span>${esc(t(hint))}</span>` +
    `<button class="btn primary disabled" disabled aria-disabled="true">${t("Send")}</button></div>` +
    `</footer>`
  );
}

function emptyThread(draft: string, status: ChatRenderState): string {
  const newAttrs = status.creating || !status.writable ? ` disabled aria-disabled="true"` : "";
  return (
    `<section class="chat-thread">` +
    `<div class="empty"><div class="gh">${t("No chat sessions yet")}</div><div>${t("Create a hosted turn to start.")}</div>` +
    `<div class="chat-empty-actions"><button class="btn secondary" data-chat-new="1"${newAttrs}>${status.creating ? t("Creating...") : t("+ New")}</button></div></div>` +
    disabledComposer(draft, "The local backend will store messages and linked runs.", status.error) +
    `</section>`
  );
}

function missingThread(
  draft: string,
  missingId: string,
  sessions: ChatSessionSummary[] | null,
  status: ChatRenderState,
): string {
  const first = sessions?.[0]?.id ?? null;
  const newAttrs = status.creating || !status.writable ? ` disabled aria-disabled="true"` : "";
  const openFirst = first
    ? `<button class="btn secondary" data-chat-session="${esc(first)}">${t("Open latest session")}</button>`
    : "";
  return (
    `<section class="chat-thread">` +
    `<div class="empty"><div class="gh">${t("Chat session not found")}</div>` +
    `<div class="codehint">${esc(missingId)}</div>` +
    `<div class="chat-empty-actions">${openFirst}<button class="btn primary" data-chat-new="1"${newAttrs}>${status.creating ? t("Creating...") : t("+ New")}</button></div></div>` +
    disabledComposer(draft, "Choose an existing session or create a new one.", status.error) +
    `</section>`
  );
}

export function renderChat(
  sessions: ChatSessionSummary[] | null,
  session: ChatSession | null,
  draft: string,
  activeId: string | null,
  status: ChatRenderState,
): string {
  const list = sessions ?? [];
  const rows =
    sessions === null
      ? `<div class="chat-empty-side">${t("Loading chat sessions...")}</div>`
      : list.length
        ? list.map((s) => sessionRow(s, activeId)).join("")
        : `<div class="chat-empty-side">${t("No chat sessions yet.")}</div>`;
  const canSend = Boolean(session && draft.trim() && !status.sending && status.writable);
  const sendAttrs = canSend ? "" : ` disabled aria-disabled="true"`;
  const sendClass = canSend ? "" : " disabled";
  const thread = status.missingId
    ? missingThread(draft, status.missingId, sessions, status)
    : session
    ? `<section class="chat-thread">` +
      `<header class="chat-thread-head">` +
      `<div><h1>${esc(session.title)}</h1><p>${esc(session.source)}</p></div>` +
      `<div class="chat-head-actions"><div class="chat-head-tags"><span>${t("Codex host")}</span><span>${t("ODW bridge")}</span><span>${t("live data")}</span></div>` +
      `<button class="btn ghost danger sm" data-chat-delete="${esc(session.id)}">${t("Delete")}</button></div>` +
      `</header>` +
      `<div class="chat-messages">${session.messages.map(messageHtml).join("")}</div>` +
      `<footer class="chat-composer">` +
      errorBanner(status.error) +
      `<textarea id="chat-input" rows="3" placeholder="${esc(t("Ask Codex. Mention ODW or workflow to attach a local run."))}"${status.sending || !status.writable ? " disabled" : ""}>${esc(draft)}</textarea>` +
      `<div class="chat-compose-actions"><span>${t("Messages are stored by the local backend.")}</span>` +
      `<button class="btn primary${sendClass}" data-chat-send="1"${sendAttrs}>${status.sending ? t("Sending...") : t("Send")}</button></div>` +
      `</footer>` +
      `</section>`
    : emptyThread(draft, status);
  const newAttrs = status.creating || !status.writable ? ` disabled aria-disabled="true"` : "";
  return (
    `<div class="chat-page">` +
    `<aside class="chat-list">` +
    `<div class="chat-list-head"><div><h2>${t("Chat Host")}</h2><span>${t("local backend")}</span></div>` +
    `<button class="btn secondary sm" data-chat-new="1"${newAttrs}>${status.creating ? t("Creating...") : t("+ New")}</button></div>` +
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
