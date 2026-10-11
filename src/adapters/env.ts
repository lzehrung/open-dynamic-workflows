/**
 * Child environment policy (L1).
 *
 * Builds the whole environment of an agent CLI child process from the host
 * environment, an {@link EnvPolicy}, and an adapter's `env`. The function is
 * pure, so tests need no process. It adds no variable of its own: no `PATH`,
 * `HOME`, `SystemRoot`, proxy, or locale.
 */

import type { EnvPolicy } from "./types.js";

/**
 * The environment for one child process.
 *
 * 1. The policy filters `host`. `inherit` keeps every defined variable except
 *    the names in `deny`. `allowlist` keeps only the names in `allow`, with the
 *    host's spelling of each name.
 * 2. `set` (an adapter's `env`) applies last and wins.
 *
 * Names compare without case on Windows, where `Path` and `PATH` are one
 * variable, and exactly elsewhere. On Windows, `set` first removes any variable
 * that has the same name in another case. One key remains, so a host `PATH`
 * never shadows a configured `Path`.
 */
export function buildChildEnv(
  policy: EnvPolicy | undefined,
  set: Record<string, string> | undefined,
  host: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  // A config written before `envPolicy` existed keeps the documented default.
  const rule: EnvPolicy = policy ?? { mode: "inherit" };
  const windows = platform === "win32";
  const fold = (name: string): string => (windows ? name.toUpperCase() : name);
  const allowlist = rule.mode === "allowlist";
  const listed = new Set((allowlist ? rule.allow : (rule.deny ?? [])).map(fold));

  const env: Record<string, string> = {};
  // A plain assignment is not enough: a name like `__proto__` would set the
  // prototype instead of becoming an entry of its own.
  const put = (name: string, value: string): void => {
    Object.defineProperty(env, name, { value, enumerable: true, writable: true, configurable: true });
  };
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined) continue;
    const isListed = listed.has(fold(name));
    // An allowlist keeps the listed names. `inherit` keeps the names not listed.
    if (allowlist ? isListed : !isListed) put(name, value);
  }

  for (const [name, value] of Object.entries(set ?? {})) {
    if (windows) {
      const folded = fold(name);
      for (const existing of Object.keys(env)) {
        if (fold(existing) === folded) delete env[existing];
      }
    }
    put(name, value);
  }
  return env;
}
