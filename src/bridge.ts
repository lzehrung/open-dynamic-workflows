/**
 * Execution bridge (L2): turn one `agent` call into one CLI invocation.
 *
 * Given an {@link AgentRequest} it: resolves the adapter, composes a
 * self-contained prompt (independence framing + optional schema instructions),
 * runs the adapter in its workspace (the source tree by default, a throwaway
 * git worktree when isolation is requested), and — when a schema is requested —
 * extracts/validates the reply and retries with corrective feedback until it
 * conforms or the retry budget is spent.
 *
 * The command runner is injectable, so the bridge unit-tests with a fake runner
 * and no real agent account.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAdapter } from "./adapters/config.js";
import { expand, expandAll, type PlaceholderContext } from "./adapters/placeholders.js";
import { decodeAdapterOutput } from "./adapters/output.js";
import { runCommand, type CommandRunner } from "./adapters/runner.js";
import {
  adapterDisplayName,
  cliOk,
  type Adapter,
  type CliResult,
  type Config,
} from "./adapters/types.js";
import { AdapterExecutionError, RunStopped, SchemaValidationError } from "./errors.js";
import { LiteralRouter, type InvocationPlan, type OptionRouter } from "./router.js";
import { describeSchema, extractJson, validate, type JsonSchema } from "./schema.js";
import { withWorkspace } from "./workspace.js";

export const INDEPENDENCE_PREAMBLE =
  "You are one agent in an automated multi-agent workflow. Work independently " +
  "on the task below. Do not ask clarifying questions and do not assume other " +
  "agents exist. Produce your result directly.";

export interface AgentRequest {
  prompt: string;
  adapter?: string;
  schema?: JsonSchema;
  label?: string;
  /** Select a model; routed to the adapter's declared model flag (or noted). */
  model?: string;
  /** Persona to take on; injected into the prompt (universal, every CLI). */
  agentType?: string;
  /** `"worktree"`: run this agent in a throwaway git worktree (as in Claude Code). */
  isolation?: "worktree";
}

/** The persona framing injected for `agentType`, on top of the independence preamble. */
export function personaPreamble(agentType: string): string {
  return (
    `Take on the role of the "${agentType}" agent for this task. Bring the ` +
    `expertise, priorities, and conventions that role implies to the work below.`
  );
}

export interface AgentOutcome {
  /** Validated structured object, or the raw text when no schema. */
  value: unknown;
  /** The raw final reply. */
  text: string;
  /** Adapter name actually used. */
  adapter: string;
  /** How many CLI calls it took (>1 means schema retries happened). */
  attempts: number;
  /** Workspace diff (empty for inplace mode / no changes). */
  diff: string;
  cli: CliResult | null;
  /**
   * Notes from option routing: options accepted but not honoured natively, and
   * what was done instead. The caller surfaces these as LOG events so no option
   * is dropped silently. Empty when every set option mapped cleanly.
   */
  notes: string[];
}

export interface BridgeOptions {
  source?: string;
  runner?: CommandRunner;
  /** How `agent` options map to a CLI invocation; defaults to {@link LiteralRouter}. */
  router?: OptionRouter;
  /**
   * Aborting ends the running adapter process. The pending `run` then throws
   * {@link RunStopped}, and no further attempt starts.
   */
  signal?: AbortSignal;
}

export class Bridge {
  private readonly source: string;
  private readonly runner: CommandRunner;
  private readonly router: OptionRouter;
  private readonly signal: AbortSignal | undefined;
  private unverifiedCleanup = false;

  /**
   * True once any call of this bridge ended while its process tree could not be
   * confirmed gone. `parallel()` surfaces only the first stop, so the run reads
   * this to report the worst cleanup state across all its agents.
   */
  get hasUnverifiedCleanup(): boolean {
    return this.unverifiedCleanup;
  }

  constructor(
    private readonly config: Config,
    options: BridgeOptions = {},
  ) {
    this.source = options.source ?? process.cwd();
    this.runner = options.runner ?? runCommand;
    this.router = options.router ?? new LiteralRouter();
    this.signal = options.signal;
  }

  async run(request: AgentRequest): Promise<AgentOutcome> {
    const adapter = resolveAdapter(this.config, request.adapter);
    const settings = this.config.settings;
    const timeout = adapter.timeout ?? settings.timeout ?? undefined;
    // Plan the invocation once: workspace mode, the model token/flag, and the
    // routing notes do not change across schema retries — only the prompt does.
    const plan = this.router.plan({ request, adapter, settings });
    const basePrompt = this.composePrompt(request);
    const maxAttempts = request.schema ? settings.schemaRetries + 1 : 1;

    let problems: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // A stop that arrives between attempts must not start another one.
      if (this.signal?.aborted) throw new RunStopped("run was stopped");
      const prompt = problems.length ? `${basePrompt}\n\n${retryFeedback(problems)}` : basePrompt;
      const { cli, diff, keptWorktree } = await this.invoke(adapter, plan, prompt, timeout);
      const kept = cli.treeCleanup === "unverified" ? treeCleanupNote(keptWorktree) : "";
      // A cancelled attempt is never retried or reported as an adapter failure.
      if (cli.termination === "cancelled") {
        throw new RunStopped(`run was stopped${kept}`, cli.treeCleanup === "unverified" ? "unverified" : undefined);
      }
      if (!cliOk(cli)) throw new AdapterExecutionError(cliFailureMessage(adapter, cli) + kept);

      const text = decodeAdapterOutput(adapter, cli.stdout);
      if (!request.schema) {
        return { value: text, text, adapter: adapter.name, attempts: attempt, diff, cli, notes: plan.notes };
      }

      const value = extractJson(text);
      // `undefined` is extractJson's only "nothing parsed" sentinel; a parsed
      // JSON `null` is a real value — let validate() decide if the schema allows it.
      problems =
        value === undefined
          ? ["no JSON value found in the reply"]
          : validate(value, request.schema);
      if (problems.length === 0) {
        return { value, text, adapter: adapter.name, attempts: attempt, diff, cli, notes: plan.notes };
      }
    }

    throw new SchemaValidationError(
      `adapter '${adapter.name}' did not satisfy the schema after ${maxAttempts} attempt(s); ` +
        `last problems: ${problems.join("; ")}`,
    );
  }

  // --- internals -------------------------------------------------------------

  private composePrompt(request: AgentRequest): string {
    const parts = [INDEPENDENCE_PREAMBLE];
    // Persona (agentType) is universal prompt text — it works on every CLI,
    // which native system-prompt flags do not. See LiteralRouter.noteAgentType.
    if (request.agentType) parts.push(personaPreamble(request.agentType));
    parts.push(request.prompt);
    if (request.schema) parts.push(describeSchema(request.schema));
    return parts.join("\n\n");
  }

  private async invoke(
    adapter: Adapter,
    plan: InvocationPlan,
    prompt: string,
    timeout: number | undefined,
  ): Promise<{ cli: CliResult; diff: string; keptWorktree: string | null }> {
    return withWorkspace(this.source, plan.workspaceMode, async (ws) => {
      let promptFile = "";
      let cleanup: (() => Promise<void>) | undefined;
      if (usesPromptFile(adapter)) {
        const dir = await mkdtemp(join(tmpdir(), "odw-prompt-"));
        promptFile = join(dir, "prompt.txt");
        await writeFile(promptFile, prompt, "utf8");
        cleanup = () => rm(dir, { recursive: true, force: true });
      }
      try {
        const context: PlaceholderContext = {
          prompt,
          prompt_file: promptFile,
          workspace: ws.path,
          source: ws.source,
          adapter: adapter.name,
          role: adapterDisplayName(adapter),
          // Option-derived tokens (the model token this phase) win over the base.
          ...plan.context,
        };
        const command = [...expandAll(adapter.command, context), ...plan.extraArgs];
        const stdin = adapter.stdin ? expand(adapter.stdin, context) : undefined;
        const env = adapter.env
          ? ({ ...process.env, ...adapter.env } as Record<string, string>)
          : undefined;
        const cli = await this.runner(command, { stdin, cwd: ws.path, env, timeout, signal: this.signal });
        // A leftover process may still use this tree, so removing it could
        // break that process and hide what it did. Keep it and say where. This
        // comes first: no later git step may fail into a removal.
        const unverified = cli.treeCleanup === "unverified";
        if (unverified) this.unverifiedCleanup = true;
        const keptWorktree = unverified ? ws.retain() : null;
        // A failed call is rejected and its diff is never read, so skip the git
        // work (it would also race a descendant that may still run).
        const diff = cliOk(cli) ? await ws.diff() : "";
        return { cli, diff, keptWorktree };
      } finally {
        if (cleanup) await cleanup();
      }
    });
  }
}

/** Say that the agent's process tree is not confirmed gone, and where a kept worktree is. */
function treeCleanupNote(keptWorktree: string | null): string {
  if (!keptWorktree) return "; the agent's process tree could not be confirmed gone, so a descendant may still run";
  return (
    `; the worktree was kept at '${keptWorktree}' because the agent's process tree could not be confirmed gone. ` +
    "Once nothing uses it, remove it with `git worktree remove --force` and that path"
  );
}

function usesPromptFile(adapter: Adapter): boolean {
  const token = "{prompt_file}";
  return adapter.command.some((part) => part.includes(token)) || (adapter.stdin?.includes(token) ?? false);
}

function retryFeedback(problems: string[]): string {
  const listed = problems
    .slice(0, 10)
    .map((p) => `- ${p}`)
    .join("\n");
  return (
    "Your previous reply did not satisfy the required schema:\n" +
    `${listed}\n` +
    "Return corrected JSON only, with no surrounding text."
  );
}

function cliFailureMessage(adapter: Adapter, cli: CliResult): string {
  const reason =
    cli.termination === "output_limit"
      ? "exceeded its output limit and was ended"
      : cli.timedOut
        ? "timed out"
        : `exited with code ${cli.returncode}`;
  const detail = (cli.stderr.trim() || cli.stdout.trim()).slice(0, 500);
  const suffix = detail ? `: ${detail}` : "";
  return `adapter '${adapter.name}' ${reason}${suffix}`;
}
