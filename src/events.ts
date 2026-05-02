/**
 * HAPPI/1.0 events — the seven canonical event types and an async-iterator
 * NDJSON parser that streams typed events from a `ReadableStream<Uint8Array>`.
 *
 * Reference: /Users/lauriescheepers/.hal/happi.md §events.
 * Per axiom 2: seven event types are sufficient. All known LLM-provider
 * streaming semantics map onto them; provider-specific data lives in
 * sub-fields under `provider.*`.
 */

import { HAPPI_VERSION, type HappiVersion, type Envelope } from "./envelope.js";

/* ─── 7 event types — discriminated union over `type` ─────────────────── */

export interface EventBase {
  readonly v: HappiVersion;
  readonly id: string;
  readonly ts: number;
}

export interface StartedEvent extends EventBase {
  readonly type: "started";
  readonly [k: string]: unknown;
}

export interface DeltaEvent extends EventBase {
  readonly type: "delta";
  readonly text: string;
  readonly [k: string]: unknown;
}

export interface ToolCallEvent extends EventBase {
  readonly type: "tool_call";
  readonly name: string;
  readonly input: unknown;
  readonly call_id: string;
  readonly [k: string]: unknown;
}

export interface ToolResultEvent extends EventBase {
  readonly type: "tool_result";
  readonly name: string;
  readonly output: unknown;
  readonly call_id: string;
  readonly [k: string]: unknown;
}

export interface SubRequestEvent extends EventBase {
  readonly type: "sub_request";
  readonly envelope: Envelope;
  readonly [k: string]: unknown;
}

export interface CompletedEvent extends EventBase {
  readonly type: "completed";
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly [k: string]: unknown;
}

export interface ErrorEvent extends EventBase {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly [k: string]: unknown;
}

export type HappiEvent =
  | StartedEvent
  | DeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | SubRequestEvent
  | CompletedEvent
  | ErrorEvent;

export const EVENT_TYPES = [
  "started",
  "delta",
  "tool_call",
  "tool_result",
  "sub_request",
  "completed",
  "error",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/* ─── NDJSON parser ──────────────────────────────────────────────────── */

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/**
 * Discriminator for already-parsed JSON. Returns the typed event or null.
 * Keeps validation cheap — only the four invariants from happi.md events
 * table (v, id, ts, type) are enforced. Sub-shape is trusted (the reference
 * runtime is the source of truth).
 */
export function decodeEvent(value: unknown): HappiEvent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (v.v !== HAPPI_VERSION) return null;
  if (typeof v.id !== "string") return null;
  if (typeof v.ts !== "number" || !Number.isFinite(v.ts)) return null;
  if (typeof v.type !== "string" || !EVENT_TYPE_SET.has(v.type)) return null;
  return v as unknown as HappiEvent;
}

/**
 * Async iterator yielding typed `HappiEvent`s from a UTF-8 byte stream.
 * Splits on `\n`, ignores blank lines, ignores malformed JSON (the reference
 * runtime never emits malformed JSON, but defence-in-depth is cheap).
 *
 * Cross-runtime: requires only Web-standard `ReadableStream<Uint8Array>`,
 * `TextDecoder`. Available natively on Node ≥18, Deno ≥1.0, Bun ≥1.0.
 */
export async function* parseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<HappiEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.length > 0) {
          const event = parseLine(buffer);
          if (event) yield event;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const event = parseLine(line);
        if (event) yield event;
        nl = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): HappiEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return decodeEvent(JSON.parse(trimmed));
  } catch {
    return null;
  }
}
