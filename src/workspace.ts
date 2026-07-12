/**
 * Workspace isolation via git worktrees (cross-cutting).
 *
 * Each `agent` call runs against a *workspace*. Two modes:
 *   - `inplace` (default): the agent runs directly in the source directory —
 *     the same semantics as Claude Code's Workflow tool subagents. No isolation,
 *     no diff.
 *   - `worktree` (per-agent opt-in via `isolation: "worktree"`): the agent runs
 *     in a throwaway `git worktree` of the source repository — again the same
 *     mechanism Claude Code uses. Worktrees share the repo's object store, so
 *     setup is near-free regardless of tree size. The agent's changes come back
 *     as a unified diff (`git add -N` first, so brand-new files appear too) and
 *     the worktree is removed afterwards; the diff is the artifact.
 *
 * Two consequences of the git mechanism worth knowing:
 *   - the source must be a git repository with at least one commit; asking for
 *     isolation elsewhere fails that agent call with an actionable error
 *   - the worktree is a clean checkout of HEAD — the agent sees the last
 *     commit, not any uncommitted edits in the source tree
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type WorkspaceMode = "inplace" | "worktree";

export interface Workspace {
  /** Directory the agent runs in. */
  path: string;
  /** The original source tree. */
  source: string;
  /** Unified diff of the agent's changes (empty for inplace). */
  diff(): Promise<string>;
}

/** Diffs can be large; give git plenty of stdout room (32 MiB). */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], { maxBuffer: GIT_MAX_BUFFER });
  return stdout;
}

/** Open a workspace, run `fn` inside it, then clean up (worktree mode only). */
export async function withWorkspace<T>(
  source: string,
  mode: WorkspaceMode,
  fn: (workspace: Workspace) => Promise<T>,
): Promise<T> {
  if (mode === "inplace") {
    return fn({ path: source, source, diff: async () => "" });
  }
  if (mode !== "worktree") {
    throw new Error(`unknown workspace mode '${mode}'; use 'inplace' or 'worktree'`);
  }

  const tmp = await mkdtemp(join(tmpdir(), "odw-wt-"));
  const work = join(tmp, basename(source));
  try {
    await git(source, ["worktree", "add", "--detach", work]);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new Error(
      `isolation "worktree" needs a git repository with at least one commit at '${source}' ` +
        `(agents are isolated via git worktrees, as in Claude Code). ` +
        `Run without isolation, or initialise the repo first. git said: ${detail}`,
    );
  }

  const ws: Workspace = {
    path: work,
    source,
    diff: async () => {
      // Intent-to-add stages the *paths* of brand-new files (respecting
      // .gitignore) so `git diff` shows their content alongside edits.
      await git(work, ["add", "--all", "--intent-to-add", "."]);
      return git(work, ["diff"]);
    },
  };
  try {
    return await fn(ws);
  } finally {
    // `remove --force` handles a dirty worktree; if git still refuses (or the
    // directory is already gone), fall back to deleting the tree and letting
    // `worktree prune` drop the stale registration.
    try {
      await git(source, ["worktree", "remove", "--force", work]);
    } catch {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      await git(source, ["worktree", "prune"]).catch(() => {});
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
