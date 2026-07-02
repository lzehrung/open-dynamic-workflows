import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ChatRole = "user" | "assistant" | "tool";
export type ChatSessionState = "running" | "idle" | "done";
export type ChatToolStatus = "running" | "done" | "failed" | "stale";
export type ChatMessageKind = "chat.ready" | "chat.linked" | "chat.recorded";

export interface ChatToolEvent {
  type: string;
  label: string;
  ts: number;
}

export interface ChatToolCall {
  name: "odw.run" | "odw.generate";
  status: ChatToolStatus;
  workflow: string;
  runId: string;
  progress: number;
  phase: string;
  events: ChatToolEvent[];
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
  kind?: ChatMessageKind;
  tool?: ChatToolCall;
}

export interface ChatLinkedRunRef {
  runId: string;
  workflow: string;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  source: string;
  state: ChatSessionState;
  updatedAt: number;
  messages: ChatMessage[];
  linkedRuns: ChatLinkedRunRef[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  source: string;
  state: ChatSessionState;
  updatedAt: number;
  lastMessage: string;
  linkedRuns: number;
}

const STORAGE_VERSION = 1;

interface ChatFile {
  version: number;
  sessions: ChatSessionRecord[];
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled hosted turn";
  return clean.length > 54 ? `${clean.slice(0, 51)}...` : clean;
}

function validMessage(value: unknown): value is ChatMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant" || m.role === "tool") &&
    typeof m.text === "string" &&
    typeof m.ts === "number" &&
    (m.kind === undefined || m.kind === "chat.ready" || m.kind === "chat.linked" || m.kind === "chat.recorded")
  );
}

function validSession(value: unknown): value is ChatSessionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    typeof s.source === "string" &&
    (s.state === "running" || s.state === "idle" || s.state === "done") &&
    typeof s.updatedAt === "number" &&
    Array.isArray(s.messages) &&
    s.messages.every(validMessage) &&
    Array.isArray(s.linkedRuns)
  );
}

export class ChatStore {
  private readonly file: string;

  constructor(root: string, private readonly defaultSource: string) {
    this.file = join(root, "_chat", "sessions.json");
  }

  list(): ChatSessionSummary[] {
    return this.read().sessions.map((s) => ({
      id: s.id,
      title: s.title,
      source: s.source,
      state: s.state,
      updatedAt: s.updatedAt,
      lastMessage: s.messages[s.messages.length - 1]?.text ?? "",
      linkedRuns: s.linkedRuns.length,
    }));
  }

  get(id: string): ChatSessionRecord | null {
    return this.read().sessions.find((s) => s.id === id) ?? null;
  }

  create(source?: string): ChatSessionRecord {
    const ts = now();
    const session: ChatSessionRecord = {
      id: newId("chat"),
      title: "Untitled hosted turn",
      source: source?.trim() || this.defaultSource,
      state: "idle",
      updatedAt: ts,
      linkedRuns: [],
      messages: [
        {
          id: newId("msg"),
          role: "assistant",
          ts,
          kind: "chat.ready",
          text: "This local Chat Host session is ready. Mention ODW or workflow to attach a real ODW run to the turn.",
        },
      ],
    };
    const data = this.read();
    data.sessions.unshift(session);
    this.write(data);
    return session;
  }

  appendUserMessage(id: string, text: string): ChatSessionRecord {
    const data = this.read();
    const session = data.sessions.find((s) => s.id === id);
    if (!session) throw new Error(`no such chat session: ${id}`);
    const ts = now();
    session.messages.push({ id: newId("msg"), role: "user", text, ts });
    if (session.title === "Untitled hosted turn") session.title = titleFrom(text);
    session.updatedAt = ts;
    this.write(data);
    return session;
  }

  appendAssistantMessage(id: string, text: string, kind?: ChatMessageKind): ChatSessionRecord {
    const data = this.read();
    const session = data.sessions.find((s) => s.id === id);
    if (!session) throw new Error(`no such chat session: ${id}`);
    const ts = now();
    session.messages.push({ id: newId("msg"), role: "assistant", text, ts, ...(kind ? { kind } : {}) });
    session.updatedAt = ts;
    this.write(data);
    return session;
  }

  appendToolRun(id: string, runId: string, workflow: string): ChatSessionRecord {
    const data = this.read();
    const session = data.sessions.find((s) => s.id === id);
    if (!session) throw new Error(`no such chat session: ${id}`);
    const ts = now();
    session.linkedRuns.unshift({ runId, workflow });
    session.messages.push({
      id: newId("msg"),
      role: "tool",
      text: "ODW run requested by the local Chat Host.",
      ts,
      tool: {
        name: "odw.run",
        status: "running",
        workflow,
        runId,
        progress: 0,
        phase: "Starting",
        events: [{ type: "run_started", label: "run requested", ts }],
      },
    });
    session.state = "running";
    session.updatedAt = ts;
    this.write(data);
    return session;
  }

  delete(id: string): boolean {
    const data = this.read();
    const next = data.sessions.filter((s) => s.id !== id);
    if (next.length === data.sessions.length) return false;
    data.sessions = next;
    this.write(data);
    return true;
  }

  private read(): ChatFile {
    if (!existsSync(this.file)) return { version: STORAGE_VERSION, sessions: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { version: STORAGE_VERSION, sessions: [] };
      }
      const sessions = (parsed as { sessions?: unknown }).sessions;
      if (!Array.isArray(sessions)) return { version: STORAGE_VERSION, sessions: [] };
      return { version: STORAGE_VERSION, sessions: sessions.filter(validSession) };
    } catch {
      return { version: STORAGE_VERSION, sessions: [] };
    }
  }

  private write(data: ChatFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}
