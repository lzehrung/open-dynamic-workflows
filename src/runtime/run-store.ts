/**
 * The run directory: the file-backed seam between front and back.
 *
 * A run is a directory under `runsRoot`. The background worker writes to it; the
 * CLI reads from it. They never talk directly, which lets a run outlive the
 * command that started it and be observed from anywhere.
 *
 * Runs are bucketed by workflow so a run's owner is visible from its path and a
 * workflow's runs can be listed without scanning every run:
 *
 *   <runsRoot>/<workflow-slug>/<runId>/
 *     meta.json      immutable run description (script, args, source, config, workflowName)
 *     status.json    mutable state (running/paused/done/failed/stopped, counters)
 *     events.jsonl   append-only progress stream
 *     result.json    final return value (on success)
 *     error.json     message + stack (on failure)
 *     control.json   pause/resume/stop request written by the CLI
 *     worker.log     the worker process's stdout/stderr
 *
 * A `runId` is globally unique, so it stays the public handle: `runDir(runId)`
 * locates a run across buckets (and still finds pre-bucket flat runs under
 * `<runsRoot>/<runId>/`, so old run directories keep working).
 *
 * All JSON writes are atomic (temp file + rename) so a concurrent reader never
 * sees a half-written file.
 */

import {
  appendFileSync,
  constants,
  fchmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { EventSink, WorkflowEvent } from "../events.js";
import { replaceFile } from "./replace-file.js";

/** Terminal states: a run in one of these will not change again. */
export const TERMINAL_STATES = new Set(["done", "failed", "stopped"]);

const META = "meta.json";
const STATUS = "status.json";
const EVENTS = "events.jsonl";
const RESULT = "result.json";
const ERROR = "error.json";
const CONTROL = "control.json";
const LOG = "worker.log";

export interface CreateRunInput {
  /**
   * Absolute path of the script to run. With `inlineSource` set, pass "" — the
   * store writes the source as `workflow.js` inside the run directory and
   * records THAT path, so an inline script is archived with its run.
   */
  script: string;
  args: unknown;
  configPath?: string | null;
  source: string;
  budgetTotal?: number | null;
  /** The workflow's identity (meta.name). Drives the run's bucket; recorded in meta. */
  workflowName?: string | null;
  /** Workflow source to materialise inside the run dir (inline launches). */
  inlineSource?: string | null;
  /** Run-level adapter override: the default `agent()` adapter for this run. */
  adapter?: string | null;
  /** Where the run was initiated from (e.g. "chat" for Chat Host runs). */
  origin?: string | null;
}

/** A run plus the workflow it belongs to, returned by listing. */
export interface RunRef {
  runId: string;
  workflowName: string | null;
}

/** Optional fingerprints also identify rewrites when a filesystem reuses an inode. */
export interface EventsCursor {
  offset: number;
  ino?: number;
  prefix?: string;
  boundary?: string;
}

const CURSOR_WINDOW_BYTES = 128;

/** Owner-only modes for run data. The umask can only clear more bits. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Create `dir` (and missing parents) with `PRIVATE_DIR_MODE`, and make an
 * existing `dir` private too. `mkdir` applies its mode only to new
 * directories, so an older ODW version can leave a loose mode behind.
 * Windows ignores POSIX modes, so it skips the `chmod`.
 *
 * `dir` is one odw owns: a workflow bucket, a run directory, or `_chat`. On
 * POSIX odw refuses it when it is not odw's work:
 * - a symlink: `chmod` would follow it and make the target private, and later
 *   writes would land there;
 * - a directory owned by another user, root included: a user could pre-create it
 *   in a shared root, and `chmod` does not change its owner;
 * - a path that another user could change under odw: see {@link assertTrustedPath}.
 * The path is checked even when `dir` does not exist yet: a missing entry can be
 * raced into a symlink as well. Windows is unchanged: it ignores the modes, and a
 * junction there is a normal way to place the data.
 */
export function assertOwnedDir(dir: string): void {
  // POSIX only, like the modes. Windows stores use junctions and symlinks on
  // purpose, and its ACLs do this job.
  if (process.platform === "win32") return;
  assertTrustedPath(dirname(dir), dir);
  try {
    const entry = lstatSync(dir);
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing to use '${dir}': it is a symlink, not a directory odw owns`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && entry.uid !== uid) {
      throw new Error(`refusing to use '${dir}': it is owned by another user`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // nothing there yet
    throw err;
  }
}

const MAX_LINK_HOPS = 40;

/**
 * Walk `path` one component at a time, following a symlink only after checking
 * it. Node has no `openat`, so later I/O goes by path: the walk makes sure that no
 * other user can change what that path points to.
 * - Every directory on the way must be owned by the current user or by root, and
 *   must not let other users replace its entries (writable by the group or by
 *   anyone, without the sticky bit). With the sticky bit, or when only the owner
 *   can write it, an entry cannot be replaced by anyone else. A directory's owner
 *   can rename any entry in it, sticky bit or not, so it must be trusted.
 * - Every entry on the way, a symlink included, must be owned by the current user
 *   or by root: another user's symlink in a shared directory could be re-pointed
 *   after the check.
 * A missing component ends the walk: nothing exists below it yet.
 */
function assertTrustedPath(path: string, dir: string): void {
  const uid = process.getuid?.();
  const trusted = (owner: number): boolean => uid === undefined || owner === uid || owner === 0;
  const container = (directory: string): void => {
    const st = lstatSync(directory);
    if (!trusted(st.uid)) {
      throw new Error(
        `refusing to use '${dir}': '${directory}' on its path is owned by another user, who can replace entries in it. ` +
          "Use a runs root that you own.",
      );
    }
    if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) {
      throw new Error(
        `refusing to use '${dir}': '${directory}' on its path lets other users replace entries in it. ` +
          "Make it owner-only (chmod 700), or set the sticky bit (chmod +t).",
      );
    }
  };
  let remaining = resolve(path).split(sep).filter(Boolean);
  let current: string = sep;
  let hops = 0;
  try {
    while (remaining.length > 0) {
      container(current);
      const name = remaining.shift()!;
      const next = join(current, name);
      const entry = lstatSync(next);
      if (!trusted(entry.uid)) {
        throw new Error(`refusing to use '${dir}': '${next}' on its path is owned by another user`);
      }
      if (entry.isSymbolicLink()) {
        if (++hops > MAX_LINK_HOPS) throw new Error(`refusing to use '${dir}': too many symlinks on its path`);
        const target = readlinkSync(next);
        remaining = [...resolve(current, target).split(sep).filter(Boolean), ...remaining];
        current = sep;
        continue;
      }
      current = next;
    }
    container(current);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // nothing exists below this point
    throw err;
  }
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  assertOwnedDir(dir);
  if (process.platform === "win32") return;
  // Set the mode through a descriptor opened without following links: an entry
  // that is swapped in after the check cannot be followed. The parent check in
  // assertOwnedDir already rules out a parent that others can modify, so the
  // later path writes cannot be redirected either.
  let fd: number;
  try {
    // O_DIRECTORY too: a FIFO swapped in for the directory would block the
    // open instead of failing it.
    fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`refusing to use '${dir}': it is a symlink, not a directory odw owns`);
    }
    throw err;
  }
  try {
    fchmodSync(fd, PRIVATE_DIR_MODE);
  } finally {
    closeSync(fd);
  }
}

function readWindow(fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const count = readSync(fd, buf, 0, length, start);
  return buf.subarray(0, count).toString("base64");
}

export class RunStore {
  /** runId → its directory, primed on create/list so reads avoid a bucket scan. */
  private readonly dirCache = new Map<string, string>();

  constructor(readonly root: string) {}

  // --- creation & paths ------------------------------------------------------

  create(input: CreateRunInput): string {
    const runId = newRunId();
    const bucket = bucketFor(input.workflowName, input.inlineSource != null ? "workflow.js" : input.script);
    const dir = join(this.root, bucket, runId);
    // Run data holds args, output, and logs. Keep it private to the owner.
    // POSIX applies these modes; Windows ignores them.
    // ODW owns the workflow bucket and the run directory, so both become
    // private, also when they already exist (an upgrade from an older
    // version). A private bucket also protects the runs that older versions
    // created with loose modes inside it. Two limits: (a) a runs root that
    // already exists keeps its mode, because `runsRoot` can point at a shared
    // directory that ODW did not create, so the bucket names stay listable;
    // (b) old flat runs directly under the root (the layout before buckets)
    // keep their old modes.
    mkdirSync(this.root, { recursive: true, mode: PRIVATE_DIR_MODE });
    ensurePrivateDir(join(this.root, bucket));
    ensurePrivateDir(dir);
    this.dirCache.set(runId, dir);
    let script = input.script;
    if (input.inlineSource != null) {
      // Materialise the inline source before meta.json so a reader never sees a
      // meta that points at a not-yet-written file.
      script = join(dir, "workflow.js");
      writeFileSync(script, input.inlineSource, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    }
    writeJson(join(dir, META), {
      runId,
      script,
      args: input.args ?? null,
      configPath: input.configPath ?? null,
      source: input.source,
      budgetTotal: input.budgetTotal ?? null,
      workflowName: input.workflowName ?? null,
      adapter: input.adapter ?? null,
      origin: input.origin ?? null,
      // First-class fact (not inferred from path topology): the script lives in
      // this run dir because it was launched from inline source. Drives the
      // worker's run-by-name divergence exemption and `odw rerun` re-archival.
      inline: input.inlineSource != null,
      createdAt: now(),
    });
    writeJson(join(dir, STATUS), { runId, state: "pending", dispatched: 0, updatedAt: now() });
    return runId;
  }

  /** Locate a run's directory by id, across buckets (and legacy flat layout). */
  runDir(runId: string): string {
    const cached = this.dirCache.get(runId);
    if (cached) return cached;
    // Legacy flat layout: <root>/<runId>/.
    const flat = join(this.root, runId);
    if (existsSync(join(flat, META))) {
      this.dirCache.set(runId, flat);
      return flat;
    }
    // Bucketed layout: <root>/<bucket>/<runId>/.
    if (existsSync(this.root)) {
      for (const entry of readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(this.root, entry.name, runId);
        if (existsSync(join(candidate, META))) {
          this.dirCache.set(runId, candidate);
          return candidate;
        }
      }
    }
    // Not found: the flat path, so existsSync(.../meta.json) stays false and the
    // caller's "no such run" handling is unchanged.
    return flat;
  }
  exists(runId: string): boolean {
    return existsSync(join(this.runDir(runId), META));
  }
  eventsPath(runId: string): string {
    return join(this.runDir(runId), EVENTS);
  }
  logPath(runId: string): string {
    return join(this.runDir(runId), LOG);
  }
  controlPath(runId: string): string {
    return join(this.runDir(runId), CONTROL);
  }

  // --- meta & status ---------------------------------------------------------

  readMeta(runId: string): Record<string, unknown> {
    return readJson(join(this.runDir(runId), META)) ?? {};
  }
  readStatus(runId: string): Record<string, unknown> {
    return readJson(join(this.runDir(runId), STATUS)) ?? {};
  }
  updateStatus(runId: string, fields: Record<string, unknown>): Record<string, unknown> {
    const status = { ...this.readStatus(runId), ...fields, updatedAt: now() };
    writeJson(join(this.runDir(runId), STATUS), status);
    return status;
  }

  // --- events ----------------------------------------------------------------

  readEvents(runId: string): WorkflowEvent[] {
    const path = this.eventsPath(runId);
    if (!existsSync(path)) return [];
    const out: WorkflowEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as WorkflowEvent);
      } catch {
        // JsonlSink appends without fsync, so a live reader can catch the final
        // line mid-write. Skip the torn line; the next read sees it whole.
      }
    }
    return out;
  }

  /**
   * Incremental read for live observers: return the events appended since
   * `cursor` and the cursor to pass next time. The cursor only ever advances to
   * a byte offset just past a complete `\n`-terminated line, so a torn tail
   * (mid-append) is simply left for the next poll and a multi-byte character
   * can never be split. Size, inode, and fixed windows of previously consumed
   * bytes guard log rotation. Inodes can be reused immediately, so changed
   * prefix/boundary bytes also reset the cursor. These bounded checks assume an
   * append-only log; they are not an integrity check for arbitrary middle edits.
   * Window validation reads at most 256 old bytes, not the whole growing log.
   */
  readEventsSince(
    runId: string,
    cursor: EventsCursor,
  ): { events: WorkflowEvent[]; cursor: EventsCursor } {
    const path = this.eventsPath(runId);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return { events: [], cursor }; // not written yet (or transiently unreadable)
    }
    try {
      const stat = fstatSync(fd);
      const size = stat.size;
      const sameFile = cursor.ino === undefined || cursor.ino === stat.ino;
      const windowSize = Math.min(cursor.offset, CURSOR_WINDOW_BYTES);
      const unchanged = sameFile && size >= cursor.offset &&
        (cursor.prefix === undefined || readWindow(fd, 0, windowSize) === cursor.prefix) &&
        (cursor.boundary === undefined ||
          readWindow(fd, cursor.offset - windowSize, windowSize) === cursor.boundary);
      const offset = unchanged ? cursor.offset : 0;
      const nextCursor = (nextOffset: number): EventsCursor => {
        const length = Math.min(nextOffset, CURSOR_WINDOW_BYTES);
        return {
          offset: nextOffset,
          ino: stat.ino,
          prefix: readWindow(fd, 0, length),
          boundary: readWindow(fd, nextOffset - length, length),
        };
      };
      if (size === offset) return { events: [], cursor: nextCursor(offset) };
      const buf = Buffer.alloc(size - offset);
      const read = readSync(fd, buf, 0, buf.length, offset);
      const chunk = buf.subarray(0, read);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) return { events: [], cursor: nextCursor(offset) }; // torn tail only
      const events: WorkflowEvent[] = [];
      for (const line of chunk.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as WorkflowEvent);
        } catch {
          // Complete but unparsable line — skip it, same tolerance as readEvents.
        }
      }
      return { events, cursor: nextCursor(offset + lastNl + 1) };
    } finally {
      closeSync(fd);
    }
  }

  // --- result & error --------------------------------------------------------

  writeResult(runId: string, value: unknown): void {
    writeJson(join(this.runDir(runId), RESULT), { value: value ?? null });
  }
  readResult(runId: string): unknown {
    const payload = readJson(join(this.runDir(runId), RESULT));
    return payload === null ? null : payload.value;
  }
  hasResult(runId: string): boolean {
    return existsSync(join(this.runDir(runId), RESULT));
  }
  writeError(runId: string, error: Record<string, unknown>): void {
    writeJson(join(this.runDir(runId), ERROR), error);
  }
  readError(runId: string): Record<string, unknown> | null {
    return readJson(join(this.runDir(runId), ERROR));
  }

  // --- control ---------------------------------------------------------------

  writeControl(runId: string, action: string): void {
    writeJson(this.controlPath(runId), { action, at: now() });
  }
  readControl(runId: string): string | null {
    const payload = readJson(this.controlPath(runId));
    return payload === null ? null : ((payload.action as string) ?? null);
  }

  // --- listing ---------------------------------------------------------------

  /**
   * Every known run, newest first. Walks at most two levels so it lists both the
   * bucketed layout (`<bucket>/<runId>/`) and any legacy flat run
   * (`<runId>/`) — a `meta.json` at level 1 marks a flat run, at level 2 a
   * bucketed one. Runs are sorted by runId descending (the id's timestamp prefix
   * makes that reverse-chronological).
   */
  listRuns(): RunRef[] {
    if (!existsSync(this.root)) return [];
    const out: RunRef[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const lvl1 = join(this.root, entry.name);
      if (existsSync(join(lvl1, META))) {
        // Legacy flat run: the directory name is the runId.
        this.dirCache.set(entry.name, lvl1);
        out.push({ runId: entry.name, workflowName: readWorkflowName(lvl1) });
        continue;
      }
      // A bucket: descend exactly one level.
      let subEntries;
      try {
        subEntries = readdirSync(lvl1, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        const dir = join(lvl1, sub.name);
        if (!existsSync(join(dir, META))) continue;
        this.dirCache.set(sub.name, dir);
        out.push({ runId: sub.name, workflowName: readWorkflowName(dir) ?? entry.name });
      }
    }
    out.sort(byRunIdDesc);
    return out;
  }

  /**
   * Runs for one workflow, newest first. Reads only that workflow's bucket — no
   * full-tree scan — so it stays cheap as the runs root grows.
   */
  listRunsForWorkflow(name: string): RunRef[] {
    const dir = join(this.root, slugify(name));
    if (!existsSync(dir)) return [];
    const out: RunRef[] = [];
    for (const sub of readdirSync(dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const runDir = join(dir, sub.name);
      if (!existsSync(join(runDir, META))) continue;
      this.dirCache.set(sub.name, runDir);
      out.push({ runId: sub.name, workflowName: readWorkflowName(runDir) ?? name });
    }
    out.sort(byRunIdDesc);
    return out;
  }
}

/** An {@link EventSink} that appends each event to events.jsonl. */
export class JsonlSink implements EventSink {
  constructor(private readonly path: string) {}
  emit(ev: WorkflowEvent): void {
    appendFileSync(this.path, JSON.stringify(ev) + "\n", { mode: PRIVATE_FILE_MODE });
  }
}

// --- module helpers ----------------------------------------------------------

/** Newest-first comparator on runId (its timestamp prefix orders chronologically). */
function byRunIdDesc(a: RunRef, b: RunRef): number {
  return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
}

/** The bucket a run lands in: its workflow name (else the script's stem), slugified. */
function bucketFor(workflowName: string | null | undefined, script: string): string {
  const name = workflowName && workflowName.trim() ? workflowName : stemOf(script);
  return slugify(name);
}

/** Filename stem of a script path (basename without its extension). */
function stemOf(script: string): string {
  return basename(script).replace(/\.[^.]*$/, "");
}

/**
 * A filesystem-safe bucket name. meta.name may contain spaces or slashes, so
 * anything outside `[A-Za-z0-9._-]` collapses to a dash; the true name is kept
 * in meta.json. Empty or all-punctuation names fall back to a fixed bucket.
 */
function slugify(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return s.length ? s : "_workflow";
}

/** The recorded workflowName from a run directory's meta.json, or null. */
function readWorkflowName(dir: string): string | null {
  const meta = readJson(join(dir, META));
  return meta && typeof meta.workflowName === "string" ? meta.workflowName : null;
}

function now(): number {
  return Date.now() / 1000;
}

function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0x1000000)
    .toString(16)
    .padStart(6, "0");
  return `${stamp}-${rand}`;
}

function writeJson(path: string, payload: unknown): void {
  const tmp = `${path}.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  replaceFile(tmp, path);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
