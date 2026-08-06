import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeAdapterOutput } from "../src/adapters/output.js";
import type { Adapter } from "../src/adapters/types.js";
import { AdapterExecutionError } from "../src/errors.js";

const textAdapter: Adapter = { name: "text", command: ["agent"] };
const jsonlAdapter: Adapter = {
  name: "jsonl",
  command: ["agent"],
  output: {
    format: "jsonl",
    eventType: "text",
    textPath: ["part", "text"],
    select: "last",
  },
};

test("plain-text output is trimmed", () => {
  assert.equal(decodeAdapterOutput(textAdapter, "  final answer\r\n"), "final answer");
});

test("JSONL output selects the last non-empty completed text event", () => {
  const stdout = [
    JSON.stringify({ type: "step_start", part: { text: "ignored" } }),
    JSON.stringify({ type: "text", part: { text: "first response" } }),
    JSON.stringify({ type: "tool_use", part: { text: "tool output" } }),
    JSON.stringify({ type: "text", part: { text: "  final response  " } }),
    "",
  ].join("\r\n");
  assert.equal(decodeAdapterOutput(jsonlAdapter, stdout), "final response");
});

test("JSONL output rejects malformed transport with its line number", () => {
  assert.throws(
    () => decodeAdapterOutput(jsonlAdapter, '{"type":"step_start"}\nnot-json'),
    (error: unknown) =>
      error instanceof AdapterExecutionError && /malformed JSONL/.test(error.message) && /line 2/.test(error.message),
  );
});

test("JSONL output rejects a successful process with no final text event", () => {
  assert.throws(
    () => decodeAdapterOutput(jsonlAdapter, JSON.stringify({ type: "step_finish", part: {} })),
    (error: unknown) => error instanceof AdapterExecutionError && /no 'text' event/.test(error.message),
  );
});

test("JSONL output rejects matching events whose configured path is not text", () => {
  assert.throws(
    () => decodeAdapterOutput(jsonlAdapter, JSON.stringify({ type: "text", part: { text: 42 } })),
    (error: unknown) => error instanceof AdapterExecutionError && /part\.text/.test(error.message),
  );
});
