import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

/** Candidate executable names under one platform's resolution rules. */
export function executableCandidates(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  pathext: string | undefined = process.env.PATHEXT,
): string[] {
  if (platform !== "win32" || extname(cmd)) return [cmd];
  const raw = pathext?.trim() || ".COM;.EXE;.BAT;.CMD";
  const seen = new Set<string>([cmd.toLowerCase()]);
  const candidates = [cmd];
  for (const value of raw.split(";")) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const suffix = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    const candidate = cmd + suffix;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

/** Resolve an executable exactly as the selected platform would search for it. */
export function resolveExecutable(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const generated = executableCandidates(cmd, platform, env.PATHEXT);
  // Windows tries PATHEXT before an extensionless shell script. This matters for
  // npm-style installs that contain both `tool` (POSIX shim) and `tool.cmd`.
  const candidates = platform === "win32" && generated.length > 1 ? [...generated.slice(1), generated[0]!] : generated;
  const explicit = cmd.includes("/") || cmd.includes("\\");
  const dirs = explicit ? [""] : (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter);
  for (const dir of dirs) {
    if (!explicit && !dir) continue;
    for (const candidate of candidates) {
      const path = explicit ? candidate : join(dir, candidate);
      try {
        if (platform === "win32") {
          if (existsSync(path)) return path;
        } else {
          accessSync(path, constants.X_OK);
          return path;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Whether an adapter executable resolves on the current PATH. */
export function isOnPath(cmd: string): boolean {
  return resolveExecutable(cmd) !== null;
}
