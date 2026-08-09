/** Decode an adapter's stdout into the final assistant response. */

import { AdapterExecutionError } from "../errors.js";
import type { Adapter } from "./types.js";

/**
 * Plain-text adapters return stdout directly. JSONL adapters select the last
 * non-empty text from their declared event shape while preserving raw stdout on
 * CliResult for diagnostics.
 */
export function decodeAdapterOutput(adapter: Adapter, stdout: string): string {
  const output = adapter.output ?? { format: "text" as const };
  if (output.format === "text") return stdout.trim();

  let last: string | undefined;
  let matchingEvents = 0;
  const lines = stdout.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new AdapterExecutionError(
        `adapter '${adapter.name}' emitted malformed JSONL on stdout line ${index + 1}: ${(error as Error).message}`,
      );
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const eventRecord = event as Record<string, unknown>;
    if (eventRecord.type !== output.eventType) continue;
    matchingEvents++;

    let value: unknown = eventRecord;
    for (const segment of output.textPath) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !Object.prototype.hasOwnProperty.call(value, segment)
      ) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text) last = text;
  }

  if (last !== undefined) return last;
  const detail = matchingEvents
    ? `matching '${output.eventType}' events did not contain text at '${output.textPath.join(".")}'`
    : `no '${output.eventType}' event was found`;
  throw new AdapterExecutionError(`adapter '${adapter.name}' produced no final response: ${detail}`);
}
