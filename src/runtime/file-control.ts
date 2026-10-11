/**
 * Cross-process run control backed by the run directory.
 *
 * Same contract as the in-process controls in `control.ts`, but the pause/stop
 * signal arrives through a file the CLI writes. The worker polls that file at
 * each safe point. Decoupled from the {@link RunStore} through callbacks so it
 * has no knowledge of the directory layout.
 */

import { PAUSED, RUNNING, STOPPED, type Control } from "../control.js";
import { RunStopped } from "../errors.js";

export interface FileControlOptions {
  readAction: () => string | null;
  onState?: (state: string) => void;
  pollIntervalMs?: number;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FileControl implements Control {
  private readonly poll: number;
  private reported = RUNNING;

  constructor(private readonly options: FileControlOptions) {
    this.poll = options.pollIntervalMs ?? 200;
  }

  async checkpoint(): Promise<void> {
    for (;;) {
      const action = this.options.readAction();
      if (action === "stop") {
        // Do not publish `stopped` here. An agent that is already running is
        // still ending its process tree, and `stopped` is terminal: an observer
        // would return before the tree is gone. The worker reports it once every
        // agent has settled.
        throw new RunStopped("run was stopped");
      }
      if (action === "pause") {
        this.report(PAUSED);
        await delay(this.poll);
        continue;
      }
      this.report(RUNNING);
      return;
    }
  }

  state(): string {
    const action = this.options.readAction();
    if (action === "stop") return STOPPED;
    if (action === "pause") return PAUSED;
    return RUNNING;
  }

  private report(state: string): void {
    if (state === this.reported) return;
    this.reported = state;
    this.options.onState?.(state);
  }
}
