/**
 * App entry: hash router + a route-aware poller, all read-only.
 *
 * The run list stays live over SSE (store.connect). The focused data for the
 * current route — a run's DAG/logs, the Activity firehose, the Workspace list —
 * is refreshed on a gentle interval while that route is shown. Rendering is a
 * full innerHTML swap of the active view; the shell (toolbar/rail/status) and the
 * view are recomputed from store state on every emit. A click layer delegates
 * navigation and the few read-only affordances (select node, copy id, tabs).
 */
import { rail, statusbar, toolbar, type Route } from "./shell";
import { store } from "./store";
import { renderActivity } from "./views/activity";
import { renderChat } from "./views/chat";
import { renderJob, type JobTab } from "./views/job";
import { renderJobs } from "./views/jobs";
import { renderSettings } from "./views/settings";
import { orderedWorkflows, renderWorkspace, wfKey } from "./views/workspace";
import type { WorkflowDetail } from "./types";
import { api } from "./api";
import { getLang, setLang, t as tr, type Lang } from "./i18n";

/** Reflect the chosen language on <html lang> (a11y + correct CJK shaping). */
function applyDocLang(): void {
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
}

const root = document.getElementById("app")!;

// --- view-local UI state (not in the store) ---
let jobTab: JobTab = "graph";
let selectedAi: number | null = null;
let wfActive: string | null = null;
let wfDetail: WorkflowDetail | null = null;
let poll: number | null = null;
let chatDraft = "";
let activeChatId: string | null = null;
let composingChatInput = false;
let deferredRender = false;
let chatScrollToBottomOnNextRender = false;

const CHAT_STICKY_BOTTOM_PX = 32;

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const [view, ...rest] = h.split("/");
  switch (view) {
    case "chat":
      return { view: "chat", param: rest.length ? decodeURIComponent(rest[0]!) : null };
    case "workspace":
      return { view: "workspace", param: rest.length ? decodeURIComponent(rest[0]!) : null };
    case "jobs":
      return { view: "jobs", param: null };
    case "job": {
      // #/job/<runId>[/<tab>] — the trailing tab segment is optional.
      const last = rest[rest.length - 1];
      if (last === "logs" || last === "result" || last === "graph") {
        jobTab = last;
        return { view: "job", param: rest.slice(0, -1).join("/") || null };
      }
      jobTab = "graph";
      return { view: "job", param: rest.join("/") || null };
    }
    case "settings":
      return { view: "settings", param: null };
    default:
      if (h && view !== "activity") history.replaceState(null, "", "#/activity");
      return { view: "activity", param: null };
  }
}

function currentRoute(): Route {
  return parseHash();
}

function viewHtml(route: Route): string {
  switch (route.view) {
    case "chat":
      return renderChat(store.chatSessions, store.chat, chatDraft, activeChatId, {
        creating: store.chatCreating,
        sending: store.chatSending,
        error: store.chatError,
        missingId: store.chatMissingId,
        writable: store.capabilities.writable,
      });
    case "activity":
      return renderActivity();
    case "workspace":
      return renderWorkspace(wfActive, wfDetail);
    case "jobs":
      return renderJobs();
    case "job":
      return renderJob(jobTab, selectedAi);
    case "settings":
      return renderSettings(store.settings);
  }
}

function render(): void {
  if (composingChatInput && document.activeElement?.id === "chat-input") {
    deferredRender = true;
    return;
  }
  const route = currentRoute();
  const chatScroll = captureChatScroll(route);
  // render() is a full innerHTML swap fired on every store emit (SSE pushes,
  // 1.2s job poll). Capture focus + caret on our own form fields and restore
  // them after the swap so typing survives a repaint.
  const focus = captureFocus();
  root.innerHTML =
    `<div class="app">` +
    toolbar(route) +
    rail(route) +
    `<div class="main">${viewHtml(route)}</div>` +
    statusbar() +
    `</div>`;
  restoreFocus(focus);
  restoreChatScroll(chatScroll, route);
}

function hasStreamingChatAssistant(): boolean {
  return Boolean(store.chat?.messages.some((m) => m.role === "assistant" && m.status === "streaming"));
}

function refreshChatComposer(): void {
  const btn = root.querySelector<HTMLButtonElement>("[data-chat-send]");
  if (!btn) return;
  const locked = store.chatSending || hasStreamingChatAssistant() || !store.capabilities.writable;
  const canSend = Boolean(store.chat && activeChatId && chatDraft.trim() && !locked);
  btn.disabled = !canSend;
  btn.classList.toggle("disabled", !canSend);
  if (canSend) btn.removeAttribute("aria-disabled");
  else btn.setAttribute("aria-disabled", "true");
}

type ChatScrollSnapshot = { sessionId: string; scrollTop: number; nearBottom: boolean };

const chatScrollBySession = new Map<string, ChatScrollSnapshot>();

function renderedChatSessionId(route: Route): string | null {
  if (route.view !== "chat") return null;
  return store.chat?.id ?? activeChatId ?? route.param ?? null;
}

function messageListChatId(el: HTMLElement, route: Route): string | null {
  return el.dataset.chatId ?? renderedChatSessionId(route);
}

function snapshotChatScroll(sessionId: string, el: HTMLElement): ChatScrollSnapshot {
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  return {
    sessionId,
    scrollTop: el.scrollTop,
    nearBottom: distanceFromBottom <= CHAT_STICKY_BOTTOM_PX,
  };
}

function rememberChatScroll(snap: ChatScrollSnapshot): void {
  chatScrollBySession.set(snap.sessionId, snap);
}

function captureChatScroll(route: Route): ChatScrollSnapshot | null {
  const el = root.querySelector<HTMLElement>(".chat-messages");
  const sessionId = el ? messageListChatId(el, route) : null;
  if (!sessionId || !el) return null;
  const snap = snapshotChatScroll(sessionId, el);
  rememberChatScroll(snap);
  return snap;
}

function applyChatScroll(sessionId: string, mode: "bottom" | "position", scrollTop = 0): void {
  const route = currentRoute();
  if (route.view !== "chat") return;
  const el = root.querySelector<HTMLElement>(".chat-messages");
  if (!el) return;
  if (messageListChatId(el, route) !== sessionId) return;
  const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  el.scrollTop = mode === "bottom" ? el.scrollHeight : Math.min(scrollTop, maxScrollTop);
  rememberChatScroll(snapshotChatScroll(sessionId, el));
}

function restoreChatPosition(sessionId: string, snap: ChatScrollSnapshot): void {
  if (snap.nearBottom) applyChatScroll(sessionId, "bottom");
  else applyChatScroll(sessionId, "position", snap.scrollTop);

  // Full DOM swaps happen before the browser has always finished settling grid /
  // flex scroll metrics. A one-frame confirmation keeps the restored position
  // from being lost when the chat thread is rebuilt during polling or streaming.
  window.requestAnimationFrame(() => {
    if (snap.nearBottom) applyChatScroll(sessionId, "bottom");
    else applyChatScroll(sessionId, "position", snap.scrollTop);
  });
}

function restoreChatScroll(snap: ChatScrollSnapshot | null, route: Route): void {
  const el = root.querySelector<HTMLElement>(".chat-messages");
  const sessionId = el ? messageListChatId(el, route) : renderedChatSessionId(route);
  if (!sessionId || !el) {
    if (route.view !== "chat") chatScrollToBottomOnNextRender = false;
    return;
  }
  if (chatScrollToBottomOnNextRender) {
    chatScrollToBottomOnNextRender = false;
    const next = snapshotChatScroll(sessionId, el);
    rememberChatScroll({ ...next, nearBottom: true });
    restoreChatPosition(sessionId, { ...next, nearBottom: true });
    return;
  }
  const saved = snap?.sessionId === sessionId ? snap : chatScrollBySession.get(sessionId);
  if (!saved) return;
  restoreChatPosition(sessionId, saved);
}

const FOCUSABLE_IDS = new Set(["chat-input"]);
type FocusSnapshot = { id: string; start: number | null; end: number | null } | null;

function captureFocus(): FocusSnapshot {
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el || !el.id || !FOCUSABLE_IDS.has(el.id)) return null;
  // selectionStart is null on <select> and some input types — guard it.
  const start = "selectionStart" in el ? el.selectionStart : null;
  const end = "selectionEnd" in el ? el.selectionEnd : null;
  return { id: el.id, start, end };
}

function restoreFocus(snap: FocusSnapshot): void {
  if (!snap) return;
  const el = document.getElementById(snap.id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return;
  el.focus();
  if (snap.start != null && "setSelectionRange" in el) {
    try {
      el.setSelectionRange(snap.start, snap.end ?? snap.start);
    } catch {
      /* type doesn't support selection ranges — focus alone is enough */
    }
  }
}

// --- per-route data loading + polling ---
async function enterRoute(): Promise<void> {
  const route = currentRoute();
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
  if (route.view === "activity") {
    await store.loadActivity();
    poll = window.setInterval(() => store.loadActivity(), 1500);
  } else if (route.view === "chat") {
    if (store.chatSessions === null) await store.loadChatSessions();
    const ids = new Set((store.chatSessions ?? []).map((s) => s.id));
    const first = store.chatSessions?.[0]?.id ?? null;
    const remembered = activeChatId && ids.has(activeChatId) ? activeChatId : null;
    const want = route.param ?? remembered ?? first;
    activeChatId = want;
    if (want) {
      await store.loadChatSession(want);
      if (store.chatMissingId === want) {
        render();
        return;
      }
      poll = window.setInterval(async () => {
        const r = currentRoute();
        const current = r.param ?? activeChatId;
        if (r.view !== "chat" || current !== want) return;
        await store.loadChatSession(want);
      }, 1500);
    } else {
      store.chat = null;
      store.chatMissingId = null;
      store.chatError = "";
      render();
    }
  } else if (route.view === "workspace") {
    if (store.workflows === null) await store.loadWorkflows();
    // Default-select the first workflow (or the routed one). Keys are provider:name.
    // Use render order so the default highlight matches the visually-first row.
    const first = store.workflows ? orderedWorkflows(store.workflows)[0] : undefined;
    const want = route.param ?? wfActive ?? (first ? wfKey(first) : null);
    if (want && want !== wfActive) await selectWorkflow(want, false);
    else render();
  } else if (route.view === "jobs") {
    render();
  } else if (route.view === "settings") {
    if (store.settings === null) await store.loadSettings();
    render();
  } else if (route.view === "job" && route.param) {
    if (store.run?.runId !== route.param) {
      store.clearRun();
      selectedAi = null;
      render();
    }
    await store.loadRun(route.param);
    if (jobTab === "result") await store.loadResult(route.param);
    poll = window.setInterval(async () => {
      const r = currentRoute();
      if (r.view !== "job" || r.param !== route.param) return;
      await store.loadRun(route.param!);
      if (jobTab === "result" && !store.resultLoaded) await store.loadResult(route.param!);
    }, 1200);
  } else {
    render();
  }
}

async function selectWorkflow(key: string, navigate = true): Promise<void> {
  wfActive = key;
  wfDetail = null;
  render();
  // key is `provider:name`; name has no colon, so split on the first one. Tolerate
  // a bare name (old bookmark) by treating the whole thing as the name.
  const i = key.indexOf(":");
  const provider = i >= 0 ? key.slice(0, i) : undefined;
  const name = i >= 0 ? key.slice(i + 1) : key;
  try {
    wfDetail = await api.workflow(name, provider);
    // Normalize to the canonical provider:name so a bare-name (old-bookmark) key
    // still highlights its list row, which compares against wfKey(w).
    if (wfDetail) wfActive = wfKey(wfDetail);
  } catch {
    wfDetail = null;
  }
  render();
  if (navigate && location.hash !== `#/workspace/${encodeURIComponent(key)}`) {
    history.replaceState(null, "", `#/workspace/${encodeURIComponent(key)}`);
  }
}

function go(hash: string): void {
  if (location.hash === hash) return;
  location.hash = hash;
}

function goOrReload(hash: string): void {
  if (location.hash === hash) void enterRoute();
  else go(hash);
}

function chatRoute(id: string | null): string {
  return id ? `#/chat/${encodeURIComponent(id)}` : "#/chat";
}

async function sendChat(): Promise<void> {
  const text = chatDraft.trim();
  const id = activeChatId;
  if (!id || store.chatMissingId) {
    store.chatError = "Create a session first.";
    store.emit();
    return;
  }
  if (!text) {
    chatDraft = "";
    store.chatError = "Message text is required.";
    store.emit();
    return;
  }
  if (store.chatSending) return;
  const updated = await store.sendChatMessage(id, text);
  if (updated) {
    activeChatId = updated.id;
    chatDraft = "";
    chatScrollToBottomOnNextRender = true;
    render();
  }
}

// --- click delegation (read-only affordances only) ---
root.addEventListener(
  "scroll",
  (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("chat-messages")) return;
    const route = currentRoute();
    const sessionId = messageListChatId(target, route);
    if (!sessionId) return;
    rememberChatScroll(snapshotChatScroll(sessionId, target));
  },
  true,
);

root.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const nav = t.closest<HTMLElement>("[data-nav]");
  if (nav) {
    go(nav.dataset.nav!);
    return;
  }
  const runEl = t.closest<HTMLElement>("[data-run]");
  if (runEl) {
    go(`#/job/${encodeURIComponent(runEl.dataset.run!)}`);
    return;
  }
  const wfEl = t.closest<HTMLElement>("[data-wf]");
  if (wfEl) {
    void selectWorkflow(wfEl.dataset.wf!);
    return;
  }
  const chatSession = t.closest<HTMLElement>("[data-chat-session]");
  if (chatSession) {
    const id = chatSession.dataset.chatSession!;
    activeChatId = id;
    chatDraft = "";
    store.chatError = "";
    goOrReload(chatRoute(id));
    return;
  }
  if (t.closest("[data-chat-new]") && !store.chatCreating) {
    void (async () => {
      const created = await store.createChatSession();
      if (!created) return;
      activeChatId = created.id;
      chatDraft = "";
      goOrReload(chatRoute(created.id));
    })();
    return;
  }
  const deleteChat = t.closest<HTMLElement>("[data-chat-delete]");
  if (deleteChat && !store.chatCreating && !store.chatSending) {
    const id = deleteChat.dataset.chatDelete!;
    if (!window.confirm(tr("Delete this chat session?"))) return;
    void (async () => {
      const ok = await store.deleteChatSession(id);
      if (!ok) return;
      const next = store.chatSessions?.[0]?.id ?? null;
      activeChatId = next;
      chatDraft = "";
      goOrReload(chatRoute(next));
    })();
    return;
  }
  if (t.closest("[data-chat-send]")) {
    void sendChat();
    return;
  }
  const tabEl = t.closest<HTMLElement>("[data-tab]");
  if (tabEl) {
    const nextTab = tabEl.dataset.tab as JobTab;
    const r = currentRoute();
    jobTab = nextTab;
    if (r.param) {
      history.replaceState(null, "", `#/job/${encodeURIComponent(r.param)}/${nextTab}`);
      if (nextTab === "result") void store.loadResult(r.param);
    }
    render();
    return;
  }
  const langEl = t.closest<HTMLElement>("[data-lang]");
  if (langEl) {
    const next = langEl.dataset.lang as Lang;
    if (next !== getLang()) {
      setLang(next);
      applyDocLang();
      render();
    }
    return;
  }
  const nodeEl = t.closest<HTMLElement>("[data-ai]");
  if (nodeEl) {
    const ai = Number(nodeEl.dataset.ai);
    selectedAi = selectedAi === ai ? null : ai;
    render();
    return;
  }
  if (t.closest("[data-close]")) {
    selectedAi = null;
    render();
    return;
  }
  const stopEl = t.closest<HTMLElement>("[data-stop]");
  if (stopEl) {
    void api
      .control(stopEl.dataset.stop!, "stop")
      .then(() => store.loadRun(stopEl.dataset.stop!))
      .catch(() => {});
    return;
  }
  const copyEl = t.closest<HTMLElement>("[data-copy]");
  if (copyEl) {
    void navigator.clipboard?.writeText(copyEl.dataset.copy!).catch(() => {});
    copyEl.textContent = tr("✓ copied");
    setTimeout(() => render(), 900);
    return;
  }
});

// Form state must survive full innerHTML re-renders (SSE pushes repaint the
// app), so inputs write through to module state as the user types.
root.addEventListener("input", (ev) => {
  const el = ev.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (el.id === "chat-input") {
    chatDraft = el.value;
    if (store.chatError === "Message text is required." && el.value.trim()) {
      store.chatError = "";
      root.querySelector(".chat-error")?.remove();
    }
    refreshChatComposer();
  }
});

root.addEventListener("compositionstart", (ev) => {
  const el = ev.target as HTMLElement | null;
  if (el?.id === "chat-input") composingChatInput = true;
});

root.addEventListener("compositionend", (ev) => {
  const el = ev.target as HTMLTextAreaElement | null;
  if (el?.id !== "chat-input") return;
  composingChatInput = false;
  chatDraft = el.value;
  if (deferredRender) {
    deferredRender = false;
    render();
  } else {
    refreshChatComposer();
  }
});

root.addEventListener("keydown", (ev) => {
  const el = ev.target as HTMLTextAreaElement | null;
  if (el?.id === "chat-input" && ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    void sendChat();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selectedAi != null) {
    selectedAi = null;
    render();
  }
});

window.addEventListener("hashchange", () => {
  void enterRoute();
});

// Re-render on any store change (SSE run list, fetched detail, etc.).
store.subscribe(render);

// Boot. `?snap=1` is a screenshot/CI hook: poll once instead of opening the SSE
// stream, so a headless capture's virtual clock can settle (an open stream keeps
// the network "busy" forever). Harmless in normal use — no one passes it.
const snap = new URLSearchParams(location.search).get("snap") === "1";
applyDocLang();
if (!location.hash) location.hash = "#/activity";
if (!snap) store.connect();
// Learn whether this dashboard may write (loopback) so write affordances are
// hidden on a remotely-viewed off-loopback bind rather than failing on click.
void store.loadCapabilities();
void store.loadRuns().then(() => enterRoute());
