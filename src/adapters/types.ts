/**
 * Configuration model shapes (L1).
 *
 * A {@link Config} is the immutable description of *which* coding-agent CLIs
 * exist ({@link Adapter}) and *how* a run behaves ({@link Settings}). It is
 * loaded once at run start and then only read.
 */

/**
 * Which per-call options this CLI can carry, and the argv flag that carries
 * each. An option absent here is one this adapter does NOT support natively, so
 * the router routes it elsewhere (e.g. prompt injection) or logs that it could
 * not be honoured — it is never silently dropped. Declaring support is one line
 * of config; no code change adds a CLI's model flag.
 */
export interface AdapterFlags {
  /** The flag(s) that select a model, e.g. `["--model"]` or `["-m"]`. */
  model?: string[];
}

/** How stdout from an adapter becomes the agent's final response. */
export type AdapterOutput =
  | { format: "text" }
  | {
      /** Newline-delimited JSON events; the last matching text event wins. */
      format: "jsonl";
      eventType: string;
      textPath: string[];
      select: "last";
    };

/**
 * Which host environment variables an agent CLI receives. `inherit` passes every
 * variable except the names in `deny`. `allowlist` passes only the names in
 * `allow`. Names compare without case on Windows and exactly elsewhere. An
 * adapter's `env` values apply after the policy.
 */
export type EnvPolicy =
  | { mode: "inherit"; deny?: string[] }
  | { mode: "allowlist"; allow: string[] };

/** How to invoke one coding-agent CLI. */
export interface Adapter {
  name: string;
  /** Argument-vector template; `{placeholder}` tokens are expanded per call. */
  command: string[];
  /** Optional stdin template (e.g. `"{prompt}"`). */
  stdin?: string;
  /** Extra environment variables. They apply after {@link Adapter.envPolicy}. */
  env?: Record<string, string>;
  /** Which host variables this CLI receives; falls back to the run-wide `Settings.envPolicy`. */
  envPolicy?: EnvPolicy;
  /** Per-call timeout in seconds; falls back to the run-wide setting. */
  timeout?: number;
  /** Human-friendly label for progress display. */
  label?: string;
  /** Capability declaration: which per-call options this CLI carries natively. */
  flags?: AdapterFlags;
  /** Response decoding; omitted means trimmed plain text. */
  output?: AdapterOutput;
}

/** Run-wide knobs independent of any single adapter. */
export interface Settings {
  /** Which adapter `agent()` uses when a call does not name one. */
  defaultAdapter: string | null;
  /** Max agent CLIs running at once; `null` => auto from CPU count. */
  concurrency: number | null;
  /** Hard ceiling on total dispatches per run (runaway guard). */
  maxAgents: number;
  /** Per-agent CLI timeout in seconds; `null` => no timeout. */
  timeout: number | null;
  /** Extra attempts when a schema fails to validate. */
  schemaRetries: number;
  /** Directory runs are stored under; `null` => `~/.odw/runs`. */
  runsRoot: string | null;
  /** Directory workflows are resolved by name from; `null` => `~/.odw/workflows`. */
  workflowsRoot: string | null;
  /** Directory Claude Code saved workflows are read from; `null` => `~/.claude/workflows`. */
  claudeWorkflowsRoot: string | null;
  /**
   * Which Claude Code runs the Jobs tab surfaces: `"all"` aggregates every
   * project's runs (the observatory default, matching the global ODW runs root);
   * `"project"` narrows to the served repo and its git worktrees. `"all"` is
   * broader — it exposes other projects' run names/results on this loopback server.
   */
  claudeJobsScope: "all" | "project";
  /**
   * Which host environment variables every agent CLI and Chat Host's Codex
   * receive. An adapter's own `envPolicy` overrides it for that adapter.
   * Absent means `{ mode: "inherit" }`: the config loader fills it, and a
   * programmatic `Config` may leave it out.
   */
  envPolicy?: EnvPolicy;
}

export interface Config {
  adapters: Record<string, Adapter>;
  settings: Settings;
}

/** The outcome of a single CLI invocation. */
export interface CliResult {
  returncode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * Why ODW ended the process: `timeout`, `cancelled` (the caller aborted), or
   * `output_limit`. Absent when the process ended on its own.
   */
  termination?: "timeout" | "cancelled" | "output_limit";
  /**
   * Present when odw ended the process: whether it could verify that the whole
   * tree is gone. `"unverified"` means a detached descendant may still run (a
   * broken `ps`, a `taskkill` that failed).
   */
  treeCleanup?: "verified" | "unverified";
  /** Wall-clock seconds until the result resolves, including process-tree shutdown. */
  duration: number;
}

/** True when the process exited cleanly: no timeout, and ODW did not end it. */
export function cliOk(result: CliResult): boolean {
  return result.returncode === 0 && !result.timedOut && result.termination === undefined;
}

/** The label to show for an adapter (its `label`, else its name). */
export function adapterDisplayName(adapter: Adapter): string {
  return adapter.label ?? adapter.name;
}
