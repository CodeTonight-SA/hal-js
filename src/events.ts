/**
 * HAPPI/1.3 events — the seven streaming event types, the two v1.1 record
 * terminators, and an async-iterator NDJSON parser that streams typed events
 * from a `ReadableStream<Uint8Array>`.
 *
 * Reference: happi.md §events — published at
 * https://gist.github.com/LaurieScheepers/2483d5c218c21ecc931130bcee7dee83
 *
 * Per axiom 2: seven event types are sufficient for streaming. All known
 * LLM-provider streaming semantics map onto them; provider-specific data
 * lives in sub-fields under `provider.*`. v1.1 adds two non-streaming
 * records — `idr` and `context` — emitted AFTER the outcome event.
 */

import {
  isAcceptedVersion,
  type HappiVersion,
  type Envelope,
} from "./envelope.js";

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

/**
 * Intent Decision Record — the audit receipt for one dispatch (v1.1).
 * `idr_ref.sha256` hashes (envelope JSON + event NDJSON), so it answers
 * "what exactly happened in this run?".
 */
export interface IdrEvent extends EventBase {
  readonly type: "idr";
  readonly idr_ref: IdrRef;
  readonly [k: string]: unknown;
}

export interface IdrRef {
  readonly sha256: string;
  readonly model_versions: ReadonlyArray<string>;
  readonly cid?: string | null;
  readonly block_anchor?: unknown;
  readonly [k: string]: unknown;
}

/**
 * Replayable memory-chain link — the structural twin of `idr` (v1.1).
 * `context_ref.sha256` content-addresses the decision BODY (excluding the
 * volatile id/ts/audit fields), so it answers "what is the identity of this
 * belief, regardless of when it was recorded?".
 */
export interface ContextEvent extends EventBase {
  readonly type: "context";
  readonly context_ref: ContextRef;
  readonly [k: string]: unknown;
}

export interface ContextRef {
  readonly sha256: string;
  readonly kind: ContextKind;
  readonly model_versions: ReadonlyArray<string>;
  readonly predecessor_context?: string | null;
  readonly snapshot_ref?: string | null;
  readonly [k: string]: unknown;
}

export const CONTEXT_KINDS = [
  "context-delta",
  "context-snapshot",
  "context-supersede",
] as const;

export type ContextKind = (typeof CONTEXT_KINDS)[number];

export type HappiEvent =
  | StartedEvent
  | DeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | SubRequestEvent
  | CompletedEvent
  | ErrorEvent
  | IdrEvent
  | ContextEvent;

/** The seven streaming event types (axiom 2). */
export const STREAMING_EVENT_TYPES = [
  "started",
  "delta",
  "tool_call",
  "tool_result",
  "sub_request",
  "completed",
  "error",
] as const;

/** Non-streaming records emitted after the outcome event (v1.1). */
export const POST_TERMINATOR_EVENT_TYPES = ["idr", "context"] as const;

/** Events reporting the outcome of a dispatch. Exactly one per stream. */
export const OUTCOME_EVENT_TYPES = ["completed", "error"] as const;

export const EVENT_TYPES = [
  ...STREAMING_EVENT_TYPES,
  ...POST_TERMINATOR_EVENT_TYPES,
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const OUTCOME_SET: ReadonlySet<string> = new Set(OUTCOME_EVENT_TYPES);
const POST_TERMINATOR_SET: ReadonlySet<string> = new Set(
  POST_TERMINATOR_EVENT_TYPES,
);

/**
 * True if the event reports the dispatch outcome.
 *
 * Note (v1.1+): the outcome is NOT always the LAST event. When
 * `flags.audit=true` the runtime appends an `idr` record after it, and
 * `cmd: "context.append"` appends a `context` record. Treating a trailing
 * record as a protocol violation is a bug.
 */
export function isOutcome(event: HappiEvent): boolean {
  return OUTCOME_SET.has(event.type);
}

/** True for records emitted after the outcome event (`idr` / `context`). */
export function isPostTerminator(event: HappiEvent): boolean {
  return POST_TERMINATOR_SET.has(event.type);
}

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
  // Accept the whole supported range, not just the version this build emits.
  // Pinning to one constant made the parser drop EVERY event from a newer
  // runtime — silently, because a rejected line returns null and is skipped.
  if (!isAcceptedVersion(v.v)) return null;
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
